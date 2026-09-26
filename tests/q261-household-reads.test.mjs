/**
 * Q261: a household person at the window (the window switched to their profile) reads only what is theirs, shared
 * with them, or public. Reading fails closed the way changing already did (src/household-routes.ts householdReads,
 * decided in src/server.ts offLimitsToHousehold): any GET or HEAD not listed answers the one sentence before the
 * route's own code runs, and a socket is refused the same way.
 *
 * - The list is pinned here, entry by entry, so it cannot grow without this file changing in the same review.
 * - Generated over the route table (tests/short-lived-key-routes.mjs), by the rule and over HTTP: every row's GET is
 *   refused unless listed, every HEAD is refused, and a read nobody has written yet is refused too.
 * - Every listed read, asked with the owner's and the person's own task and conversation ids, carries none of the
 *   owner's seeded words, while the owner's own answer does (so the check is not empty) and the person's own
 *   records do reach them.
 * - POST /api/models/switch takes the person's own conversation only: the owner's reads exactly like one that does
 *   not exist, the owner's settings for it are unchanged, and a wrong name does not list the owner's connections
 *   (the /model command included).
 *
 * Mutations (each applied to dist/, this file run, the file put back by hash), and the case each turns red:
 *   R1  offLimitsToHousehold: a GET not listed falls back to the old rule (every plain read open)   → "fails closed"
 *   R2  isRead: HEAD is not a read                                                                → "fails closed"
 *   R3  householdReads: /api/mcp/servers added                                                     → "pinned list"
 *   R4  householdMaySend: a GET matches by prefix (any /api/sessions/... read)                     → "fails closed"
 *   R5  upgrade: the household check on sockets removed                                           → "sockets"
 *   R6  conversation-mode: another conversation's id read for a household person                  → "own data"
 *   R7  models/switch: the conversation check removed                                             → "models/switch"
 *   R8  models/switch: the owner's connection names listed to a household person                  → "models/switch"
 *   R9  /model command: the owner's connection names listed to a household person                 → "models/switch"
 *   R10 models/switch: the person's own conversation looked up under the owner (not switched)     → "models/switch"
 * Run them all: node design/redesign/tools/mutate-q261.mjs (after npx tsc -p .).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToHousehold } from "../dist/server.js";
import { householdReads, householdRefusal, householdRefusalFor } from "../dist/household-routes.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { savePolicy } from "../dist/policy.js";
import { audit } from "../dist/audit.js";
import { savePrompt, savePromptLibrarySettings } from "../dist/prompt-library.js";
import { saveAssistantIdentity } from "../dist/identity.js";
import { ROUTES, SAMPLE_ID, entry } from "./short-lived-key-routes.mjs";

/** The reviewed list, as the table writes each address. Adding a read means adding it here, in the same review. */
const REVIEWED = [
  "/api/state", "/api/profiles", "/api/lock", "/api/look", "/api/events/stream", "/api/activity", "/api/commands",
  "/api/policy", "/api/conversation-mode", "/api/conversation-mode/settings", "/api/usage/glance", "/api/delight",
  "/api/deployment/suggestion", "/api/accounts", "/api/adapt", "/api/read-marks", "/api/voice/wake",
  "/api/voice/dictation", "/api/voice/dictation/listen",
  "/api/sessions", "/api/sessions/:id", "/api/sessions/:id/context", "/api/sessions/:id/export",
  "/api/sessions/:id/followups", "/api/sessions/:id/goal", "/api/sessions/:id/model", "/api/sessions/:id/paths",
  "/api/sessions/:id/pins", "/api/sessions/:id/rewind",
  "/api/runs/:id", "/api/runs/:id/inspect", "/api/runs/:id/steps", "/api/runs/:id/plan", "/api/runs/:id/receipts", "/api/runs/:id/recording",
  "/api/audit", "/api/audit/export.csv", "/api/usage", "/api/prompts", "/api/approvals/categories",
  "/api/trunks", "/api/trunks/rooms/:id", "/api/trunks/conversations/:id", "/api/collab/events", "/api/teams/:id/handoffs",
  "/api/memory/tidy", "/api/memory/archive", "/api/memory/checkpoints", "/api/memory/export", "/api/memory/learned",
  "/api/memory/proposals", "/api/memory/versions", "/api/labels",
  "/api/connections/catalog", "/api/mcp/catalogue", "/api/release-notes",
];
/** Reads that never end: asked by the rule, not over HTTP. */
const STREAMS = new Set(["/api/events/stream"]);
/**
 * Rows the server answers before it asks for a key, so the household rule never sees them: files and pages served
 * as they are, and addresses that bring their own proof. Each is named, not matched, so a new one fails here.
 */
const BEFORE_THE_KEY = new Set([]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sourceOf = (path) => new RegExp(`^${path.split(":id").map(escape).join("[a-f0-9-]{36}")}$`).source;
const concrete = (path) => path.replaceAll(":id", SAMPLE_ID);
/** The table's pattern rows, given a concrete key the way the Q259 sweep gives them one. */
const asked = (path) => concrete(path).replace("[A-Za-z0-9_.:-]{3,160}", "policy.preset")
  .replace("[a-f0-9]{16}", "0".repeat(16)).replace("[a-f0-9]{32}", "0".repeat(32));
const rows = Object.entries(ROUTES).map(([path, value]) => ({ path, ...entry(value) }))
  .filter(({ kind }) => kind !== "prefix" && kind !== "pre-auth");
const listed = (at) => householdReads.some((one) => one.pattern.test(at));

test("pinned list: householdReads is exactly the reviewed list, each entry with its reason", () => {
  assert.deepEqual(householdReads.map((one) => one.pattern.source).sort(), REVIEWED.map(sourceOf).sort());
  for (const one of householdReads) assert.ok(one.why.length > 10, `${one.pattern} says why`);
});

test("fails closed, by the rule: every GET in the table is refused unless listed, and every HEAD is refused", () => {
  const wrong = [];
  for (const { path, kind } of rows) {
    const at = asked(path);
    const answer = offLimitsToHousehold("GET", at);
    if (listed(at) ? answer !== null : answer !== householdRefusalFor(path)) wrong.push(`GET ${path} (${kind}) → ${answer}`);
    if (offLimitsToHousehold("HEAD", at) !== householdRefusalFor(path)) wrong.push(`HEAD ${path}`);
  }
  assert.deepEqual(wrong, []);
  for (const path of ["/api/some-new-read", "/api/sessions/x", `/api/sessions/${SAMPLE_ID}/summary`, "/api/mcp/servers", "/api/comfort"])
    assert.equal(offLimitsToHousehold("GET", path), householdRefusalFor(path), path);
  for (const path of REVIEWED.map(concrete)) {
    assert.equal(offLimitsToHousehold("GET", path), null, path);
    assert.equal(offLimitsToHousehold("HEAD", path), householdRefusalFor(path), `HEAD ${path}`);
    assert.equal(offLimitsToHousehold("GET", `${path}/more`), householdRefusalFor(`${path}/more`), `${path}/more`);
  }
});

/* ---------- a served Branch with the owner's and Sam's marked records ---------- */

/** Writes one marked file when asked to, then answers with a marked sentence naming whose task it was. */
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1), text = String(last?.content ?? "");
  if (last?.role === "user" && /write /.test(text))
    return { content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path: "zqowner-file.txt", content: "zqowner-content" }) }] };
  return { content: /zqsam/.test(JSON.stringify(request.messages)) ? "zqsam-answer" : "zqowner-answer", toolCalls: [] };
} };

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-q261-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "workspace" });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const ownerRun = await app.runtime.run({ prompt: "zqowner-prompt please write the file" });
  app.store.save("memory", owner, "zqowner-fact-id", { text: "zqowner-fact", source: "owner" });
  audit(app.store, owner, { action: "secret.used", actor: owner, subject: "zqowner-audit", reason: "zqowner-audit-reason", outcome: "used", runId: ownerRun.id });
  app.store.review.propose(owner, { kind: "put", text: "zqowner-proposal", source: "zqowner-proposal-source", runId: ownerRun.id });
  savePromptLibrarySettings(app.store, owner, { mode: "on" });
  savePrompt(app.store, owner, { title: "zqowner-prompt-title", body: "zqowner-saved-body", command: "zqownercmd" }, () => false);
  saveAssistantIdentity(app.store, owner, { name: "Branch Agent", instructions: "zqowner-instructions", expectedRevision: 0 });
  for (const table of ["schedules", "triggers", "webhooks", "procedures", "workflows", "specialists"])
    app.store.save(table, owner, `zqowner-${table}`, { name: `zqowner-${table}`, prompt: `zqowner-${table}`, status: "pending", dueAt: new Date().toISOString() });
  // The owner's connection, named apart from the zqowner- words: GET /api/state still lists the connections for the
  // composer's model picker (Q258), so they are not among the words that must never reach Sam.
  app.runtime.models.register({ id: "zqconn", name: "Zqconn Connection", provider: writer, model: "zqconn-model" });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const asOwner = () => app.store.profiles.switch({ profileId: null });
  const asSam = () => app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  asSam();
  const samRun = await runForCurrentPerson(app, { prompt: "zqsam-prompt hello", onTextDelta: () => undefined });
  app.store.save("memory", `profile:${sam.id}`, "zqsam-fact-id", { text: "zqsam-fact", source: "sam" });
  asOwner();
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method, headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, text, body: json };
  };
  return { app, server, call, asOwner, asSam, ownerRun, samRun, sam };
}

test("fails closed, over HTTP: as Sam every unlisted GET in the table meets the one sentence", async (t) => {
  const { call, asSam } = await served(t);
  asSam();
  const through = [];
  for (const { path, kind } of rows) {
    const at = asked(path);
    if (listed(at) || BEFORE_THE_KEY.has(path)) continue;
    const answer = await call("GET", at);
    if (answer.status !== 400 || answer.body.error !== householdRefusalFor(path)) through.push(`GET ${path} (${kind}) → ${answer.status} ${answer.text.slice(0, 80)}`);
  }
  assert.deepEqual(through, [], "unlisted reads answered a household person");
});

test("fails closed, over HTTP: a HEAD and a read nobody has written are refused; a listed read is answered", async (t) => {
  const { server, call, asSam } = await served(t);
  asSam();
  const heads = await fetch(`${server.url}/api/profiles`, { method: "HEAD", headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(heads.status, 400, "HEAD of a listed read");
  const fresh = await call("GET", "/api/some-new-read");
  assert.deepEqual([fresh.status, fresh.body.error], [400, householdRefusal]);
  for (const path of ["/api/state", "/api/profiles", "/api/sessions", "/api/lock", "/api/look"])
    assert.equal((await call("GET", path)).status, 200, path);
});

/** Opens a socket to `path` and resolves with the status the server answered (101 when it upgraded). */
function socketStatus(server, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const asking = httpRequest({ host: url.hostname, port: url.port, path, headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
      "sec-websocket-protocol": `bearer, ${server.token}`, origin: server.url,
    } });
    asking.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    asking.on("response", (response) => { response.resume(); resolve(response.statusCode); });
    asking.on("error", reject);
    asking.end();
  });
}

test("sockets: a household person's socket is refused like any unlisted read; the owner's still opens", async (t) => {
  const { server, asOwner, asSam, ownerRun, samRun, app } = await served(t);
  asSam();
  assert.equal(app.store.run(samRun.id).owner, app.store.profiles.scope(), "Sam's finished task is filed under Sam");
  assert.equal(await socketStatus(server, `/api/runs/${samRun.id}/ws`), 400, "Sam's own task socket");
  asOwner();
  assert.equal(await socketStatus(server, `/api/runs/${ownerRun.id}/ws`), 101, "control: the owner's socket opens");
});

test("own data: every listed read, asked as Sam with anybody's ids, carries nothing of the owner's", async (t) => {
  const { call, asOwner, asSam, ownerRun, samRun } = await served(t);
  const ids = [ownerRun.id, ownerRun.sessionId, samRun.id, samRun.sessionId];
  const paths = [];
  for (const path of REVIEWED) {
    if (STREAMS.has(path)) continue;
    if (path.includes(":id")) for (const id of ids) paths.push(path.replaceAll(":id", id));
    else paths.push(path);
  }
  paths.push(`/api/conversation-mode?sessionId=${ownerRun.sessionId}`, `/api/conversation-mode?sessionId=${samRun.sessionId}`,
    "/api/memory/versions?id=zqowner-fact-id", `/api/sessions/${ownerRun.sessionId}/export?format=markdown`,
    "/api/usage?range=7d&by=day", "/api/audit?limit=1000", "/api/commands?surface=window", "/api/activity?waiting=1");
  asOwner();
  assert.equal((await call("POST", "/api/conversation-mode", { sessionId: ownerRun.sessionId, mode: "ask" })).status, 200);
  const ownerSees = new Set();
  for (const path of paths) if (/zqowner/.test((await call("GET", path)).text)) ownerSees.add(path);
  asSam();
  const leaks = [];
  for (const path of paths) {
    const answer = await call("GET", path);
    if (answer.body.error === householdRefusal) leaks.push(`${path} is listed but refused`);
    const marks = [...new Set(answer.text.match(/zqowner-[a-z-]+/g) ?? [])];
    if (marks.length) leaks.push(`${path} → ${marks.join(",")}`);
  }
  assert.deepEqual(leaks, [], "the owner's records reached Sam");
  // The check is not empty: the owner's own answers carry the owner's words on these.
  for (const path of ["/api/sessions", `/api/sessions/${ownerRun.sessionId}`, "/api/memory/export", "/api/audit", `/api/runs/${ownerRun.id}/inspect`, "/api/prompts"])
    assert.ok(ownerSees.has(path), `control: the owner's ${path} carries the owner's words`);
  // And Sam's own records do reach him.
  for (const path of ["/api/sessions", `/api/sessions/${samRun.sessionId}`, "/api/memory/export", `/api/runs/${samRun.id}/inspect`])
    assert.match((await call("GET", path)).text, /zqsam/, `${path} carries Sam's own`);
  const mode = (id) => call("GET", `/api/conversation-mode?sessionId=${id}`).then((answer) => answer.body);
  assert.deepEqual([(await mode(ownerRun.sessionId)).sessionId, (await mode(ownerRun.sessionId)).mode], [null, null], "the owner's conversation reads as none");
  assert.equal((await mode(samRun.sessionId)).sessionId, samRun.sessionId, "his own conversation's chip");
  asOwner();
  assert.deepEqual([(await mode(ownerRun.sessionId)).sessionId, (await mode(ownerRun.sessionId)).mode], [ownerRun.sessionId, "ask"], "control");
});

test("models/switch: the owner's conversation reads like a missing one; his own is switched; no connection names", async (t) => {
  const { app, call, asOwner, asSam, ownerRun, samRun } = await served(t);
  const owner = app.runtime.owner;
  app.runtime.models.configureSession(owner, ownerRun.sessionId, { preset: "zqconn", reasoning: "high" });
  const before = JSON.stringify(app.runtime.models.session(owner, ownerRun.sessionId));
  asSam();
  const theirs = await call("POST", "/api/models/switch", { sessionId: ownerRun.sessionId, model: "default" });
  const missing = await call("POST", "/api/models/switch", { sessionId: randomUUID(), model: "default" });
  assert.deepEqual([theirs.status, theirs.body], [404, { error: "Conversation not found" }], "the owner's conversation");
  assert.deepEqual([missing.status, missing.body], [theirs.status, theirs.body], "exactly like a conversation that does not exist");
  assert.equal(JSON.stringify(app.runtime.models.session(owner, ownerRun.sessionId)), before, "the owner's conversation is unchanged");
  const own = await call("POST", "/api/models/switch", { sessionId: samRun.sessionId, model: "default" });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.sessionId, samRun.sessionId);
  const wrong = await call("POST", "/api/models/switch", { sessionId: samRun.sessionId, model: "no-such-connection" });
  assert.equal(wrong.body.error, 'There is no connection called "no-such-connection".', wrong.text);
  assert.doesNotMatch(wrong.text, /Zqconn/, "no connection names for Sam");
  // The same answer to /model typed at the window.
  asOwner();
  assert.equal((await call("POST", "/api/commands/settings", { mode: "on" })).status, 200);
  asSam();
  const typed = await call("POST", "/api/commands/run", { surface: "window", line: "/model no-such-connection", sessionId: samRun.sessionId });
  assert.doesNotMatch(typed.text, /Zqconn/, `the /model command: ${typed.text.slice(0, 160)}`);
  assert.match(typed.text, /There is no connection called/);
  asOwner();
  // Control: the owner is still told the names, and switches their own conversation.
  const told = await call("POST", "/api/models/switch", { sessionId: ownerRun.sessionId, model: "no-such-connection" });
  assert.match(told.body.error, /You have: .*Zqconn Connection/, told.text);
  assert.equal((await call("POST", "/api/models/switch", { sessionId: ownerRun.sessionId, model: "zqconn" })).status, 200);
});
