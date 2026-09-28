import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { A2aError, SendParamsSchema, a2aError } from "./a2a.js";
import type { A2aServer } from "./a2a.js";
import type { RemoteAgent, RemoteAgents } from "./a2a-client.js";
import type { IssuedToken } from "./session-tokens.js";
import { agentBadge } from "./trunks/room-outside.js"; // a2a-rooms

/**
 * The web side of talking to other assistants: the card that says who this one is, the JSON-RPC
 * endpoint that takes work from another assistant, and the owner's own routes for adding assistants
 * elsewhere, looking for them on addresses they type in, and sharing a pairing link. All of it sits
 * behind the same local key as the rest of the app.
 */
const JsonRpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

/** Which outside assistant is calling, for the allowance and for the record; a name only, not a key. */
export function callerName(request: IncomingMessage): string {
  const header = request.headers["x-branch-agent"];
  const name = String((Array.isArray(header) ? header[0] : header) ?? "").trim();
  return /^[\w .-]{1,60}$/.test(name) ? name : "an unnamed assistant";
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
};

/**
 * `/.well-known/agent.json` and `/a2a`. Both are gone entirely — not merely refused — while the
 * owner has answering other assistants switched off, so nothing advertises itself by accident.
 */
export async function handleA2a(
  a2a: A2aServer,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  body: () => Promise<unknown>,
): Promise<boolean> {
  const base = `http://${request.headers.host ?? "127.0.0.1:3210"}`;
  if (path === "/.well-known/agent.json") {
    if (request.method !== "GET") return false;
    if (!a2a.enabled()) { json(response, 404, { error: "This assistant is not answering other assistants" }); return true; }
    json(response, 200, a2a.card(base));
    return true;
  }
  if (path !== "/a2a") return false;
  if (request.method !== "POST") { json(response, 405, { error: "Send JSON-RPC with POST" }); return true; }
  if (!a2a.enabled()) { json(response, 404, { error: "This assistant is not answering other assistants" }); return true; }
  let id: string | number | null = null;
  try {
    const message = JsonRpcSchema.parse(await body());
    id = message.id;
    const agent = callerName(request);
    if (message.method === "tasks/sendSubscribe") {
      await a2a.sendSubscribe(SendParamsSchema.parse(message.params), agent, message.id, response);
      return true;
    }
    // The trace the calling assistant already had open, so the work joins it rather than starting anew.
    const traceparent = String(request.headers["traceparent"] ?? "") || null;
    json(response, 200, { jsonrpc: "2.0", id, result: await answer(a2a, message.method, message.params, agent, traceparent) });
  } catch (error) {
    if (response.headersSent) response.end();
    else json(response, error instanceof A2aError && error.code === -32003 ? 429 : 200, a2aError(id, error));
  }
  return true;
}

async function answer(
  a2a: A2aServer, method: string, params: Record<string, unknown>, agent: string, traceparent: string | null,
): Promise<unknown> {
  if (method === "tasks/send") return a2a.send(SendParamsSchema.parse(params), agent, traceparent);
  if (method === "tasks/get") return a2a.get(params);
  if (method === "tasks/cancel") return a2a.cancel(params);
  throw new A2aError(-32601, `Branch does not know the method "${method}"`);
}

const PairSchema = z.object({ link: z.string().trim().min(1).max(4000) }).strict();
const AddSchema = z.object({ cardUrl: z.string().trim().min(1).max(2000), key: z.string().trim().max(400).optional() }).strict();
const RemoveSchema = z.object({ agent: z.string().trim().min(1).max(200) }).strict();
const withoutKey = ({ key: _key, ...rest }: RemoteAgent): Omit<RemoteAgent, "key"> => rest;

/** The owner's own screens for assistants elsewhere. Keys they were given are never handed back. */
export async function remoteAgentsApi(
  agents: RemoteAgents,
  request: IncomingMessage,
  path: string,
  body: () => Promise<unknown>,
  connection: { base: string; pairingKey: () => IssuedToken },
): Promise<unknown> {
  // a2a-rooms: with the badge a room draws for each ("A2A · " and where it runs), for the room's member picker.
  if (request.method === "GET" && path === "/api/agents/remote") return { agents: agents.list().map((agent) => ({ ...withoutKey(agent), badge: agentBadge(agent) })) };
  if (request.method === "GET" && path === "/api/agents/discover") {
    const targets = new URL(request.url ?? "/", "http://local").searchParams.get("targets") ?? "";
    const list = targets.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!list.length) throw new Error("Type one or more addresses to look at, such as 127.0.0.1:3211");
    return agents.discover(list);
  }
  if (request.method !== "POST") throw new Error("Endpoint not found");
  if (path === "/api/agents/remote") return withoutKey(await agents.add(AddSchema.parse(await body())));
  if (path === "/api/agents/remote/remove") return agents.remove(RemoveSchema.parse(await body()).agent);
  if (path === "/api/agents/pair") return withoutKey(await agents.pair(PairSchema.parse(await body()).link));
  // Making a link makes a key, so it is a change and the owner's alone (a key that may only look cannot mint one).
  if (path === "/api/agents/pairing") {
    z.object({}).strict().parse(await body());
    const key = connection.pairingKey();
    return { ...agents.pairing(connection.base, key.token), expiresAt: key.entry.expiresAt, keyId: key.entry.id };
  }
  throw new Error("Endpoint not found");
}
