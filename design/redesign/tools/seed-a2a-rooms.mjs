// Seeds a fresh engine data folder for verify-a2a-rooms.cjs: two Trunks and an agent elsewhere in one room, where the
// agent has really taken its turn. The agent is a stand-in on this computer that speaks A2A (a card at
// /.well-known/agent.json, JSON-RPC 2.0 message/send), connected through the engine's own RemoteAgents.add and seated
// through the engine's own routes (POST /api/trunks/rooms {agents}, POST /api/trunks/rooms/<id>/send). The running
// engine refuses an address on this computer, so this seed alone allows private addresses (as seed-parity-b4.mjs does)
// and the stand-in stops when it ends; the verify script then sees the engine refuse the next turn in its own words.
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-a2a-rooms.mjs
// then start the engine with the same two folders. Prints the room, its conversation and the agent as JSON.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";
import { startServer } from "../../../dist/server.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");

const scripted = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const last = String(request.messages.at(-1)?.content ?? "");
  if (/Introduce yourself/.test(last)) return { content: `Hello, I am ${/\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim() ?? "here"}.`, toolCalls: [] };
  return { content: "(pass)", toolCalls: [] };
} };

/* The stand-in agent: its card, and message/send answered with a message, as A2A has it. */
const json = (res, value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const agentServer = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const port = agentServer.address().port;
  if (req.method === "GET" && req.url === "/.well-known/agent.json")
    return json(res, { name: "Hermes Agent", description: "Research, coding and long tasks.", url: `http://127.0.0.1:${port}/a2a`, version: "1.0.0",
      provider: { organization: "KeepOak computer" }, capabilities: { streaming: false }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] });
  const rpc = JSON.parse(body || "{}");
  if (rpc.method !== "message/send") return json(res, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: "Method not found" } });
  json(res, { jsonrpc: "2.0", id: rpc.id, result: { kind: "message", role: "agent", messageId: randomUUID(), contextId: "seed-ctx",
    parts: [{ kind: "text", text: "I checked the statement against last month's ledger export. No duplicates." }] } });
});
await new Promise((done) => agentServer.listen(0, "127.0.0.1", done));

const app = await createBranch({ workspace, dataDir, provider: scripted, web: { allowPrivateAddresses: true } });
const server = await startServer(app, { dataDir, port: 0, host: "127.0.0.1" });
const call = async (path, body) => {
  const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const got = await response.json();
  if (!response.ok) throw new Error(`${path}: ${got.error ?? response.status}`);
  return got;
};
try {
  for (const part of ["trunks", "rooms"]) app.trunks.setMode(part, { mode: "on" });
  const [ledger, scout] = ["Ledger", "Scout"].map((name) => app.trunks.create({ name }));
  await app.trunks.introduced();
  const agent = await app.remoteAgents.add({ cardUrl: `http://127.0.0.1:${agentServer.address().port}` });
  const { room } = await call("/api/trunks/rooms", { name: "Month-end", members: [ledger.id, scout.id], agents: [agent.id] });
  await call(`/api/trunks/rooms/${room.id}/send`, { text: "@hermes-agent can you check the statement against last month's export?" });
  await app.trunks.rooms.settled(room.id);
  const view = await call(`/api/trunks/rooms/${room.id}`);
  console.log(JSON.stringify({ room: room.id, sessionId: room.sessionId, agent: agent.id, events: view.events.map((e) => [e.kind, e.memberId === agent.id]) }));
} finally {
  await server.close();
  await app.close();
  agentServer.closeAllConnections();
  agentServer.close();
}
