import { z, ZodError } from "zod";
import { errorText } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import { ciSnippet } from "./ci.js";
import type { Coding } from "./index.js";
import { initPrompt } from "./init.js";
import { checksFolder } from "./review-checks.js";
import { rulesFolder, schedulesFolder } from "./path-rules.js";
import { CodingOffError, CodingPartSchema, codingLabels, codingParts, partSettings, requireCoding, savePartSettings } from "./settings.js";
import { WorktreeSettingsSchema } from "./worktrees.js";
import { validationText } from "../request-errors.js";

/**
 * The web side of bucket R17-D: the owner's routes under /api/coding/. They sit behind the same key
 * and host rules as everything else. Two may be sent with a short-lived "run" key, because they only
 * start or steer work (src/short-lived-keys.ts): running the review checks and forking a
 * conversation. Every tool a route runs goes through `Runtime.executeTool`, so the one tool gate
 * (src/tool-gate.ts) decides it.
 */
export const handlesCodingPath = (path: string): boolean => path === "/api/coding" || path.startsWith("/api/coding/");

export class CodingHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface CodingHttpDeps {
  coding: Coding;
  runtime: Runtime;
  method: string;
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
}

const SwitchSchema = z.object({ part: CodingPartSchema, mode: z.enum(["off", "when-needed", "on"]) }).strict();
const sessionPath = /^\/api\/coding\/checklist\/([a-f0-9-]{36})$/;

async function settingsRoute(deps: CodingHttpDeps, path: string): Promise<unknown> {
  const { coding, method } = deps, post = method === "POST";
  if (path === "/api/coding/format") return { format: post ? await coding.edits.save(await deps.readBody()) : coding.edits.settings() };
  if (path === "/api/coding/shell") {
    if (post) coding.snapshots.chooseShell(await deps.readBody());
    const { snapshot, shell } = coding.snapshots.settings();
    return { shell, snapshot, replayFile: snapshot ? coding.snapshots.replayFile() : null };
  }
  if (path === "/api/coding/shell/take" && post) return { snapshot: await coding.snapshots.take() };
  if (path === "/api/coding/shell/forget" && post) { coding.snapshots.forget(); return { forgotten: true }; }
  if (path === "/api/coding/rules") return { folder: rulesFolder, rules: await coding.rules.rules(), schedulesFolder, schedules: await coding.rules.scheduleFiles() };
  if (path === "/api/coding/rules/switch" && post) return coding.rules.setRule(await deps.readBody());
  if (path === "/api/coding/rules/schedule" && post) {
    const { name } = z.object({ name: z.string().min(1).max(120) }).strict().parse(await deps.readBody());
    return deps.runtime.executeTool("schedules.create", await coding.rules.scheduleInput(name), { mode: "owner" });
  }
  return undefined;
}

async function workRoute(deps: CodingHttpDeps, path: string): Promise<unknown> {
  const { coding, runtime, method } = deps, post = method === "POST";
  const { store, owner } = runtime;
  if (path === "/api/coding/mentions") {
    requireCoding(store, owner, "mentions");
    return { suggestions: await coding.mentions.suggest(deps.query.get("q") ?? "") };
  }
  if (path === "/api/coding/worktrees") {
    if (post) savePartSettings(store, owner, "worktrees", WorktreeSettingsSchema, await deps.readBody());
    return { forks: coding.worktrees.forks(), settings: partSettings(store, owner, "worktrees", WorktreeSettingsSchema) };
  }
  if (path === "/api/coding/worktrees/fork" && post) {
    const input = z.object({ sessionId: z.string().uuid(), messageId: z.number().int().positive() }).strict().parse(await deps.readBody());
    return { fork: await coding.worktrees.fork(input, AbortSignal.timeout(60_000)) };
  }
  if (path === "/api/coding/worktrees/remove" && post) {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).strict().parse(await deps.readBody());
    return coding.worktrees.remove(sessionId, AbortSignal.timeout(60_000));
  }
  if (path === "/api/coding/checks") return { folder: checksFolder, checks: await coding.checks.list() };
  if (path === "/api/coding/checks/run" && post) {
    requireCoding(store, owner, "review-checks");
    return runtime.executeTool("review.checks", await deps.readBody() ?? {}, { mode: "owner" });
  }
  if (path === "/api/coding/init") { requireCoding(store, owner, "init"); return { prompt: initPrompt }; }
  if (path === "/api/coding/ci" && post) { requireCoding(store, owner, "ci"); return ciSnippet(await deps.readBody()); }
  const checklist = sessionPath.exec(path);
  if (checklist) return { checklist: post ? coding.checklists.saveByOwner({ ...(await deps.readBody() as object), sessionId: checklist[1] }) : coding.checklists.get(checklist[1]!) };
  return undefined;
}

async function route(deps: CodingHttpDeps, path: string): Promise<unknown> {
  if (path === "/api/coding") return { modes: deps.coding.modes(), labels: codingLabels, parts: codingParts };
  if (path === "/api/coding/switch" && deps.method === "POST") {
    const { part, mode } = SwitchSchema.parse(await deps.readBody());
    return { part, mode: deps.coding.setMode(part, mode) };
  }
  return (await settingsRoute(deps, path)) ?? workRoute(deps, path);
}

/** Answers one request under /api/coding/, or throws a CodingHttpError with a status and a sentence. */
export async function codingApi(deps: CodingHttpDeps, path: string): Promise<unknown> {
  try {
    const answer = await route(deps, path);
    if (answer === undefined) throw new CodingHttpError(404, "Endpoint not found");
    return answer;
  } catch (error) {
    if (error instanceof CodingHttpError) throw error;
    const status = error instanceof CodingOffError ? 409 : error instanceof ZodError ? 400
      : /not found|no .* with that/i.test(errorText(error)) ? 404 : 400;
    const message = error instanceof ZodError ? validationText(error) : errorText(error);
    throw new CodingHttpError(status, deps.runtime.hideSecrets(message));
  }
}
