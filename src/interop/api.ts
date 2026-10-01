import type { IncomingMessage, ServerResponse } from "node:http";
import { z, ZodError } from "zod";
import { errorText } from "../contracts.js";
import type { Store } from "../store.js";
import { ApError, apRoute } from "./agent-protocol.js";
import { fleetStatus, fleetStop, StopSchema } from "./fleet.js";
import { FlowSearchSchema, flowSearchParts, searchFlows } from "./flow-search.js";
import { HandoffSchema, handOff } from "./handoff.js";
import type { Interop } from "./index.js";
import { InteropOffError, InteropPartSchema, interopLabels, interopParts, requireInterop } from "./settings.js";
import { validationText } from "../request-errors.js";

/**
 * The web side of bucket 20: the Agent Protocol under /ap/v1/agent/tasks, and the owner's routes
 * under /api/interop/. Both sit behind the same key and host rules as everything else; the server
 * checks those before it gets here. This file writes its own answers, so the Agent Protocol's status
 * codes and its one plain-text download come out exactly as the specification says.
 */
export interface InteropHttpDeps {
  interop: Interop;
  store: Store;
  owner: string;
  runtime: Parameters<typeof flowSearchParts>[0];
  flows: Parameters<typeof flowSearchParts>[1];
  fleet: Parameters<typeof fleetStatus>[0];
  readBody: () => Promise<unknown>;
  /** The address another device should open: the paired one when it is on, otherwise this one. */
  baseUrl: string;
  requireOwner: (what: string) => void;
}

/** The Redis queue's settings are answered by the server's own owner-window route (src/server.ts), not here. */
const redisQueuePaths = new Set(["/api/interop/redis-queue", "/api/interop/redis-queue/control"]);
export const handlesInteropPath = (path: string): boolean => !redisQueuePaths.has(path)
  && (path === "/ap/v1/agent/tasks" || path.startsWith("/ap/v1/agent/tasks/") || path === "/api/interop" || path.startsWith("/api/interop/"));

/** Changes a short-lived key may not make here: they widen what Branch may do or who may reach it. */
export function interopOffLimits(method: string | undefined, path: string): string | null {
  if (method === "GET" || !path.startsWith("/api/interop")) return null;
  // Integration review: "route" can switch the active project, "flow-search" can save a flow, and
  // "fleet" can stop every task; all three are the owner's too.
  if (/^\/api\/interop\/(switch|handoff|market|modes|routes|route|flow-search|fleet)(\/|$)/.test(path))
    return "A short-lived key cannot change how Branch works with other agents, switch the project, save a flow, stop tasks, bring an assistant in, or hand a conversation on. Do that in the app window.";
  return null;
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
};

/** Which outside program is calling, for its allowance and for the record; a name only. */
function callerOf(request: IncomingMessage): string {
  const header = request.headers["x-branch-agent"] ?? request.headers["user-agent"];
  const name = String((Array.isArray(header) ? header[0] : header) ?? "").trim().slice(0, 60);
  return /^[\w ./()-]{1,60}$/.test(name) ? name : "an unnamed program";
}

export async function handleInterop(deps: InteropHttpDeps, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (!handlesInteropPath(path)) return false;
  const ap = path.startsWith("/ap/");
  try {
    if (ap) await agentProtocolRoute(deps, request, response, path);
    else json(response, 200, await ownerRoute(deps, request.method ?? "GET", path));
  } catch (error) {
    const status = error instanceof ApError ? error.status : error instanceof InteropOffError ? (ap ? 404 : 409)
      : error instanceof ZodError ? 400 : /not known|not found|no mode called/i.test(errorText(error)) ? 404 : 400;
    const message = error instanceof ZodError ? validationText(error) : errorText(error);
    json(response, status, { error: deps.runtime.hideSecrets(message) });
  }
  return true;
}

async function agentProtocolRoute(deps: InteropHttpDeps, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const route = apRoute(request.method ?? "GET", path);
  if (!route) throw new ApError(405, "That method is not part of the Agent Protocol here");
  const ap = deps.interop.agentProtocol, query = new URL(request.url ?? "/", "http://local").searchParams;
  const caller = callerOf(request);
  switch (route.name) {
    case "create": return json(response, 200, ap.create(await deps.readBody(), caller));
    case "list": return json(response, 200, ap.list(query));
    case "get": return json(response, 200, ap.get(route.taskId!));
    case "steps": return json(response, 200, ap.steps(route.taskId!, query));
    case "step": return json(response, 200, ap.step(route.taskId!, route.subId!));
    case "execute": return json(response, 200, await ap.execute(route.taskId!, await deps.readBody(), caller));
    case "artifacts": return json(response, 200, ap.artifacts(route.taskId!, query));
    case "artifact": {
      const file = ap.artifact(route.taskId!, route.subId!);
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="${file.name}"` });
      response.end(file.text);
      return;
    }
    default:
      ap.get(route.taskId!);
      throw new ApError(415, "Branch takes written instructions only; files sent to a task are not read");
  }
}

const body = async <T>(deps: InteropHttpDeps, schema: z.ZodType<T>): Promise<T> => schema.parse(await deps.readBody());

async function ownerRoute(deps: InteropHttpDeps, method: string, path: string): Promise<unknown> {
  const { interop } = deps;
  if (method === "GET" && path === "/api/interop") {
    return { parts: interopParts.map((part) => ({ part, label: interopLabels[part], mode: interop.modesOf()[part] })),
      programs: interop.clients.list() };
  }
  if (method === "POST" && path === "/api/interop/switch") {
    deps.requireOwner("How Branch works with other agents");
    const { part, mode } = await body(deps, z.object({ part: InteropPartSchema, mode: z.unknown() }).strict());
    return { part, mode: interop.setMode(part, { mode }) };
  }
  if (path.startsWith("/api/interop/modes")) return modesRoute(deps, method, path);
  if (path === "/api/interop/routes" || path === "/api/interop/route") return routesRoute(deps, method, path);
  if (path.startsWith("/api/interop/fleet")) return fleetRoute(deps, method, path);
  if (method === "POST" && path === "/api/interop/handoff") {
    deps.requireOwner("Handing a conversation on");
    return handOff(interop.handoffParts, await body(deps, HandoffSchema), deps.baseUrl);
  }
  if (method === "POST" && path === "/api/interop/flow-search") {
    requireInterop(deps.store, deps.owner, "flow-search");
    return searchFlows(flowSearchParts(deps.runtime, deps.flows), await body(deps, FlowSearchSchema));
  }
  if (path.startsWith("/api/interop/market")) return marketRoute(deps, method, path);
  throw new Error("Endpoint not found");
}

async function modesRoute(deps: InteropHttpDeps, method: string, path: string): Promise<unknown> {
  const modes = deps.interop.modes;
  if (method === "GET" && path === "/api/interop/modes") return { modes: modes.list() };
  deps.requireOwner("Ways of working");
  requireInterop(deps.store, deps.owner, "modes");
  if (method === "POST" && path === "/api/interop/modes") return modes.save(await deps.readBody());
  const slug = /^\/api\/interop\/modes\/([a-z][a-z0-9-]{0,30})$/.exec(path)?.[1];
  if (method === "DELETE" && slug) return modes.remove(slug);
  throw new Error("Endpoint not found");
}

async function routesRoute(deps: InteropHttpDeps, method: string, path: string): Promise<unknown> {
  const router = deps.interop.router;
  if (method === "GET" && path === "/api/interop/routes") return { keywords: router.keywords() };
  if (method === "POST" && path === "/api/interop/routes") {
    deps.requireOwner("Choosing the project for a request");
    const { projectId, keywords } = await body(deps, z.object({ projectId: z.string().min(1).max(64), keywords: z.array(z.string()) }).strict());
    return { keywords: router.setKeywords(projectId, keywords) };
  }
  if (method === "POST" && path === "/api/interop/route") {
    const { request, switch: doSwitch } = await body(deps, z.object({ request: z.string().trim().min(1).max(4000), switch: z.boolean().default(false) }).strict());
    if (doSwitch) deps.requireOwner("Switching project");
    return router.routeAndSwitch(request, doSwitch);
  }
  throw new Error("Endpoint not found");
}

async function fleetRoute(deps: InteropHttpDeps, method: string, path: string): Promise<unknown> {
  requireInterop(deps.store, deps.owner, "fleet");
  if (method === "GET" && path === "/api/interop/fleet") return fleetStatus(deps.fleet);
  if (method === "POST" && path === "/api/interop/fleet/stop") return fleetStop(deps.fleet.runtime, await body(deps, StopSchema));
  throw new Error("Endpoint not found");
}

async function marketRoute(deps: InteropHttpDeps, method: string, path: string): Promise<unknown> {
  const market = deps.interop.market;
  if (method === "GET" && path === "/api/interop/market") return { indexes: market.indexes() };
  deps.requireOwner("Sharing and bringing in assistants");
  requireInterop(deps.store, deps.owner, "agent-market");
  const input = await deps.readBody() as Record<string, unknown> | null;
  const url = z.url().max(2000);
  const id = z.string().min(1).max(61);
  if (method === "POST" && path === "/api/interop/market/indexes") return { indexes: market.setIndexes(input?.urls) };
  if (method === "POST" && path === "/api/interop/market/browse") return market.browse(url.parse(input?.url));
  if (method === "POST" && path === "/api/interop/market/preview") return market.preview(url.parse(input?.url), id.parse(input?.id));
  if (method === "POST" && path === "/api/interop/market/install") return market.install(url.parse(input?.url), id.parse(input?.id), input?.sections);
  if (method === "POST" && path === "/api/interop/market/publish") return market.publish(input);
  throw new Error("Endpoint not found");
}
