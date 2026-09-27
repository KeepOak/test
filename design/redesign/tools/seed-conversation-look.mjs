// Seeds a fresh engine data folder for verify-conversation-look.cjs with a room only a model can fill: three Trunks and
// one household person in one room; the owner's message one Trunk passes on (the engine's "pass" outcome); the person's
// message that one Trunk answers by bringing another in by @name (the engine's later rounds, Trunks talking it through),
// ending with a Trunk asking for the owner (@you, the room's needs-you). Everything goes through the engine's own routes
// (POST /api/trunks/rooms, POST /api/trunks/rooms/<id>/send), with the model scripted as the engine's own tests script it
// (tests/trunks-helpers.mjs). Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-conversation-look.mjs
// then start the engine with the same two folders. Prints the room's id, its conversation and the person as JSON.
import { resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";
import { startServer } from "../../../dist/server.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const PIN = "4826";

/* Each Trunk's turn in the room, by who it is and what it has seen. */
const scripted = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const last = String(request.messages.at(-1)?.content ?? "");
  if (/Introduce yourself/.test(last)) return { content: `Hello, I am ${/\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim() ?? "here"}.`, toolCalls: [] };
  const me = /You are @([a-z0-9-]+)/.exec(last)?.[1];
  const said = {
    fieldnotes: "(pass)",
    scout: "Found both receipts in the mail and filed them. @ledger over to you.",
    ledger: /Found both/.test(last) ? "All sixteen match now. @you shall I send the report?" : "Fourteen of sixteen receipts match. @scout can you find the two that are missing?",
  }[me];
  return { content: said ?? "Done.", toolCalls: [] };
} };

const app = await createBranch({ workspace, dataDir, provider: scripted });
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
  const [ledger, scout, fieldnotes] = ["Ledger", "Scout", "Fieldnotes"].map((name) => app.trunks.create({ name }));
  await app.trunks.introduced();
  const dana = app.store.profiles.create({ name: "Dana", pin: PIN });
  const { room } = await call("/api/trunks/rooms", { name: "Month-end", members: [ledger.id, scout.id, fieldnotes.id], people: [dana.id] });
  await call(`/api/trunks/rooms/${room.id}/send`, { text: "@fieldnotes anything from the notes before we close?" });
  await app.trunks.rooms.settled(room.id);
  app.store.profiles.switch({ profileId: dana.id, pin: PIN });
  await call(`/api/trunks/rooms/${room.id}/send`, { text: "@ledger can we close September today?" });
  await app.trunks.rooms.settled(room.id);
  app.store.profiles.switch({ profileId: null });
  const view = await call(`/api/trunks/rooms/${room.id}`);
  console.log(JSON.stringify({ room: room.id, sessionId: room.sessionId, person: dana.id, pin: PIN, needsYou: view.needsYou,
    events: view.events.map((e) => [e.kind, e.round ?? null]) }));
} finally {
  await server.close();
  await app.close();
}
