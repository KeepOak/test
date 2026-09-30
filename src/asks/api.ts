import { z, ZodError } from "zod";
import { validationText } from "../request-errors.js";
import { errorText } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { Asks } from "./index.js";
import { exampleFile, mcpExamples } from "./mcp-examples.js";
import { AskOffError, AskPartSchema, askLabels, askParts, requireAsk, type AskPart } from "./settings.js";
import { byCard, inCatalogue, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48

/**
 * The web side of bucket 23: the owner's routes under /api/asks/. They sit behind the same key and
 * host rules as everything else, and every change here is the owner's (a short-lived key is refused
 * by the fail-closed rule in src/short-lived-keys.ts). A route that runs one of these parts' tools
 * runs it through `Runtime.executeTool`, so the one tool gate (src/tool-gate.ts) decides it.
 */
export const handlesAsksPath = (path: string): boolean => path === "/api/asks" || path.startsWith("/api/asks/");

export class AsksHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AsksHttpDeps {
  asks: Asks;
  runtime: Runtime;
  method: string;
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
  /** Hook for the parts added in later groups; answers undefined when it does not own the path. */
  more?: (path: string) => Promise<unknown>;
}

const SwitchSchema = z.object({ part: AskPartSchema, mode: z.enum(["off", "when-needed", "on"]) }).strict();
const pageId = /^\/api\/asks\/pages\/([a-f0-9-]{36})(\/export|\/remove)?$/;

/** A tool of one of these parts, pressed by the owner: the part must be on, and the gate decides. */
async function runPartTool(deps: AsksHttpDeps, part: AskPart, tool: string): Promise<unknown> {
  requireAsk(deps.runtime.store, deps.runtime.owner, part);
  return deps.runtime.executeTool(tool, await deps.readBody(), { mode: "owner" });
}

async function pagesRoute(deps: AsksHttpDeps, path: string): Promise<unknown> {
  const { asks, method } = deps;
  if (path === "/api/asks/pages") {
    if (method === "POST") return { page: asks.pages.save(await deps.readBody()) };
    return { pages: asks.pages.list() };
  }
  const match = pageId.exec(path);
  if (!match) return undefined;
  if (match[2] === "/export") return await asks.pages.exportPage(match[1]!);
  if (match[2] === "/remove" && method === "POST") return asks.pages.remove(match[1]!);
  return { page: await asks.pages.open(match[1]!) }; // SELF-309: a live page is read from its file as it is opened
}

async function analyticsRoute(deps: AsksHttpDeps, path: string): Promise<unknown> {
  const { analytics } = deps.asks, post = deps.method === "POST";
  if (path === "/api/asks/analytics") {
    if (post) return { analytics: analytics.save(await deps.readBody()) };
    return { analytics: analytics.settings(), counting: analytics.counting(), counts: analytics.counts() };
  }
  if (!post) return undefined;
  if (path === "/api/asks/analytics/event") return { counted: analytics.track((await deps.readBody() as { event?: unknown } | null)?.event) };
  if (path === "/api/asks/analytics/send") return analytics.send();
  if (path === "/api/asks/analytics/erase") return { erased: analytics.erase() };
  return undefined;
}

const surfaceId = /^\/api\/asks\/surfaces\/([a-f0-9-]{36})\/(refresh|remove)$/;
async function surfacesRoute(deps: AsksHttpDeps, path: string): Promise<unknown> {
  const { surfaces } = deps.asks;
  if (path === "/api/asks/surfaces")
    return deps.method === "POST" ? { surface: await surfaces.add(await deps.readBody()) } : { surfaces: surfaces.list() };
  const match = surfaceId.exec(path);
  if (!match || deps.method !== "POST") return undefined;
  if (match[2] === "remove") return surfaces.remove(match[1]!);
  requireAsk(deps.runtime.store, deps.runtime.owner, "live-surfaces");
  await surfaces.refresh(match[1]!, { manual: true });
  return { surface: surfaces.list().find((s) => s.id === match[1]) };
}

/** Group 2: bringing items in, the Hindsight server, steps for other apps and the MCP examples. */
async function integrationsRoute(deps: AsksHttpDeps, path: string): Promise<unknown> {
  const { asks } = deps, post = deps.method === "POST";
  if (path === "/api/asks/sources") return post ? { sources: asks.sources.save(await deps.readBody()) } : { sources: asks.sources.sources(), status: asks.sources.status() };
  if (path === "/api/asks/sources/sync" && post) return runPartTool(deps, "source-sync", "sources.sync");
  if (path === "/api/asks/hindsight") return { hindsight: post ? asks.hindsight.save(await deps.readBody()) : asks.hindsight.settings() };
  if (path === "/api/asks/hindsight/recall" && post) return runPartTool(deps, "hindsight", "hindsight.recall");
  if (path === "/api/asks/blocks") return { blocks: asks.blocks.list() };
  if (path === "/api/asks/blocks/key" && post) {
    const { block, secret } = z.object({ block: z.string().max(40), secret: z.string().max(80).nullable() }).strict().parse(await deps.readBody());
    return { keys: asks.blocks.setKey(block, secret) };
  }
  if (path === "/api/asks/blocks/run" && post) return runPartTool(deps, "app-blocks", "blocks.run");
  if (path === "/api/asks/runtimes") return { runtimes: await asks.runtimes.list() };
  if (/^\/api\/asks\/runtimes\/(add|remove)$/.test(path) && post) {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).strict().parse(await deps.readBody());
    return path.endsWith("/add") ? asks.runtimes.add(id) : asks.runtimes.remove(id);
  }
  if (path === "/api/asks/leads") { const all = asks.leads.list(); return { count: all.length, top: all.slice(0, 5).map((lead) => ({ name: lead.name, company: lead.company, score: lead.score })) }; }
  if (path === "/api/asks/forecasts") return { ...asks.forecasts.score(), open: asks.forecasts.list("open").slice(0, 20) };
  if (path === "/api/asks/nodes") return post ? { nodes: asks.nodes.save(await deps.readBody()) } : { nodes: asks.nodes.nodes() };
  if (path === "/api/asks/nodes/check" && post) return runPartTool(deps, "nodes", "nodes.status");
  if (path === "/api/asks/nodes/ask" && post) return runPartTool(deps, "nodes", "nodes.ask");
  if (path.startsWith("/api/asks/surfaces")) return surfacesRoute(deps, path);
  if (path === "/api/asks/mcp-examples")
    return { examples: mcpExamples.map((example) => ({ ...example, file: exampleFile(example.id) })) };
  return deps.more?.(path);
}

async function route(deps: AsksHttpDeps, path: string): Promise<unknown> {
  const { asks, method } = deps, post = method === "POST";
  if (path === "/api/asks") return { modes: asks.modes(), labels: askLabels, parts: askParts };
  if (path === "/api/asks/switch" && post) {
    const { part, mode } = SwitchSchema.parse(await deps.readBody());
    return { part, mode: recordedWrite(deps.runtime.store, deps.runtime.owner, byCard(`asks-${part}`), inCatalogue(`asks-${part}`),
      () => asks.setMode(part, { mode })) };
  }
  if (path === "/api/asks/projects/board") return asks.boards.board(deps.query.get("project") ?? undefined);
  if (path === "/api/asks/projects/assign" && post) return asks.boards.assign(await deps.readBody());
  if (path === "/api/asks/intents") return post ? { pipeline: asks.intents.save(await deps.readBody()) } : { pipeline: asks.intents.settings() };
  if (path === "/api/asks/intents/decide" && post) {
    const { request } = z.object({ request: z.string().trim().min(1).max(4000) }).strict().parse(await deps.readBody());
    return asks.intents.decide(request);
  }
  if (path === "/api/asks/answer" && post) return runPartTool(deps, "answer-engine", "answer.ask");
  if (path === "/api/asks/article" && post) return runPartTool(deps, "article-writer", "research.article");
  if (path.startsWith("/api/asks/pages")) return pagesRoute(deps, path);
  if (path.startsWith("/api/asks/analytics")) return analyticsRoute(deps, path);
  return integrationsRoute(deps, path);
}

/** Answers one request under /api/asks/, or throws an AsksHttpError with a status and a sentence. */
export async function asksApi(deps: AsksHttpDeps, path: string): Promise<unknown> {
  try {
    const answer = await route(deps, path);
    if (answer === undefined) throw new AsksHttpError(404, "Endpoint not found");
    return answer;
  } catch (error) {
    if (error instanceof AsksHttpError) throw error;
    const status = error instanceof AskOffError ? 409 : error instanceof ZodError ? 400
      : /not found|no .* with that id/i.test(errorText(error)) ? 404 : 400;
    const message = error instanceof ZodError ? validationText(error) : errorText(error);
    throw new AsksHttpError(status, deps.runtime.hideSecrets(message));
  }
}
