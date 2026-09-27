/**
 * Conversations like iMessage (src/conversation-actions.ts): pin, rename, archive, Recently Deleted, restore, Delete now,
 * Delete all and the 30-day removal, the running-task question, a household person's own conversations only, and a
 * phone that may put away but never delete for good.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { phoneSessionText } from "../dist/devices/book.js";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-conv-actions-"));
  const dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0, authLimits: { attempts: 1_000_000 } });
  const host = new URL(server.url).host;
  const door = createServer((request, response) => { request.headers.host = host; server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(async () => {
    door.closeAllConnections?.();
    await new Promise((done) => door.close(done));
    await server.close(); await app.close(); await discardTemp(root);
  });
  const doorBase = `http://127.0.0.1:${door.address().port}`;
  const call = (method, path, body, base = server.url, key = server.token, extra = {}) => fetch(base + path, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }), ...extra },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  assert.equal((await call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  return { app, call, doorBase };
}
/** A phone paired from the window's "Pair a phone" code, as tests/phone-key-rotate.test.mjs pairs one. */
async function pairedPhone(call) {
  const invite = (await call("POST", "/api/devices/invite", { phone: true })).body;
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const { requestId } = (await call("POST", "/api/devices/pair",
    { offer: invite.id, code: invite.code, name: "Phone", platform: "android", publicKey, offers: [] }, undefined, null)).body;
  await call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true });
  const signature = sign(null, Buffer.from(phoneSessionText(requestId)), pair.privateKey).toString("base64");
  const session = (await call("POST", "/api/devices/pair/session", { requestId, signature }, undefined, null)).body;
  return { token: session.token, headers: { "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey } };
}
function seed(store, words, owner = "local") {
  const run = store.createRun(owner, words);
  store.message(run.sessionId, { role: "user", content: words });
  store.message(run.sessionId, { role: "assistant", content: `Noted: ${words}` });
  store.finish(run.id, "completed", "Noted");
  return { sessionId: run.sessionId, runId: run.id };
}
const recentIds = async (call) => (await call("GET", "/api/sessions?limit=50")).body.sessions.map((s) => s.sessionId);
const searchIds = async (call, query) => (await call("POST", "/api/sessions/search", { query })).body.sessions.map((s) => s.sessionId);

test("pin and rename are kept by the engine, pinned first in the order pinned", async (t) => {
  const { app, call } = await served(t);
  const a = seed(app.store, "alpha plan").sessionId, b = seed(app.store, "bravo plan").sessionId, c = seed(app.store, "charlie plan").sessionId;
  assert.equal((await call("POST", `/api/sessions/${a}/pin`, { pinned: true })).status, 200);
  assert.equal((await call("POST", `/api/sessions/${b}/pin`, { pinned: true })).status, 200);
  assert.equal((await call("POST", `/api/sessions/${c}/rename`, { title: "Charlie's trip" })).status, 200);
  const list = (await call("GET", "/api/sessions?limit=50")).body.sessions;
  assert.deepEqual(list.slice(0, 2).map((s) => s.sessionId), [a, b], "pinned first, in the order pinned");
  assert.equal(list.find((s) => s.sessionId === a).pinned, true);
  assert.equal(list.find((s) => s.sessionId === c).pinned, undefined);
  assert.equal(list.find((s) => s.sessionId === c).title, "Charlie's trip");
  assert.equal((await call("POST", `/api/sessions/${a}/pin`, { pinned: false })).status, 200);
  assert.equal((await call("GET", "/api/sessions?limit=50")).body.sessions.find((s) => s.sessionId === a).pinned, undefined);
  assert.equal((await call("POST", `/api/sessions/${c}/rename`, { title: null })).status, 200);
  assert.equal((await call("GET", "/api/sessions?limit=50")).body.sessions.find((s) => s.sessionId === c).title, undefined);
});

test("archive hides from Recent and lists under Archived, still found by search; unarchive brings it back", async (t) => {
  const { app, call } = await served(t);
  const a = seed(app.store, "quartz archive words").sessionId;
  assert.equal((await call("POST", `/api/sessions/${a}/archive`, { archived: true })).status, 200);
  assert.ok(!(await recentIds(call)).includes(a));
  const away = (await call("GET", "/api/sessions/put-away")).body;
  assert.deepEqual(away.archived.map((r) => r.sessionId), [a]);
  assert.equal((await call("GET", "/api/sessions?limit=50")).body.archived, 1);
  assert.ok((await searchIds(call, "quartz")).includes(a), "an archived conversation is found by search");
  assert.equal((await call("POST", `/api/sessions/${a}/archive`, { archived: false })).status, 200);
  assert.ok((await recentIds(call)).includes(a));
  assert.equal((await call("GET", "/api/sessions/put-away")).body.archived.length, 0);
});

test("delete moves to Recently Deleted: out of Recent, search, history and memory; restore brings all of it back", async (t) => {
  const { app, call } = await served(t);
  const { sessionId: a, runId } = seed(app.store, "zircon secret recipe");
  seed(app.store, "another conversation");
  app.store.save("memory", "local", "fact-zircon", { text: "zircon recipe uses lime", source: "a task", originRunId: runId });
  assert.equal((await call("POST", `/api/sessions/${a}/pin`, { pinned: true })).status, 200);
  assert.equal((await call("POST", `/api/sessions/${a}/rename`, { title: "Zircon" })).status, 200);
  const before = app.store.memories.search("local", "zircon").length;
  assert.equal(before, 1, "the fact is recalled before");

  const deleted = await call("POST", `/api/sessions/${a}/delete`, {});
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.daysLeft, 30);
  assert.ok(!(await recentIds(call)).includes(a), "not in Recent");
  assert.ok(!(await searchIds(call, "zircon")).includes(a), "not in search");
  assert.equal(app.store.searchHistory("local", { query: "zircon" }).length, 0, "not in the history tools");
  assert.throws(() => app.store.readHistory("local", { sessionId: a, messageId: 1 }), /not found/);
  assert.equal(app.store.memories.search("local", "zircon").length, 0, "memory does not recall what it taught");
  assert.ok(!app.store.runs("local").some((r) => r.sessionId === a), "its tasks are out of the task lists");
  const away = (await call("GET", "/api/sessions/put-away")).body;
  assert.deepEqual(away.deleted.map((r) => [r.sessionId, r.daysLeft, r.title]), [[a, 30, "Zircon"]]);
  assert.equal((await call("GET", `/api/sessions/${a}/export`)).status >= 400, true, "export refuses it");
  assert.ok(app.store.messages(a).length > 0, "but kept");

  assert.equal((await call("POST", `/api/sessions/${a}/restore`, {})).status, 200);
  const back = (await call("GET", "/api/sessions?limit=50")).body.sessions.find((s) => s.sessionId === a);
  assert.equal(back.pinned, true, "pin kept");
  assert.equal(back.title, "Zircon", "name kept");
  assert.ok((await searchIds(call, "zircon")).includes(a));
  assert.equal(app.store.searchHistory("local", { query: "zircon" }).length, 2);
  assert.equal(app.store.memories.search("local", "zircon").length, 1);
});

test("the 30 days are counted by the engine's clock, and then it is removed for good", async (t) => {
  const { app, call } = await served(t);
  const a = seed(app.store, "old conversation").sessionId, b = seed(app.store, "newer one").sessionId;
  const start = Date.now();
  app.store.clock = () => start;
  await call("POST", `/api/sessions/${a}/delete`, {});
  app.store.clock = () => start + 10 * 86_400_000;
  await call("POST", `/api/sessions/${b}/delete`, {});
  app.store.clock = () => start + 29 * 86_400_000;
  const away = (await call("GET", "/api/sessions/put-away")).body.deleted;
  assert.deepEqual(away.map((r) => [r.sessionId, r.daysLeft]), [[b, 11], [a, 1]]);
  app.store.clock = () => start + 30 * 86_400_000 + 1;
  assert.equal(app.store.purgeExpiredConversations(), 1);
  assert.equal(app.store.ownsSession("local", a), false, "the 30th day's is gone");
  assert.equal(app.store.ownsSession("local", b), true, "the other still waits");
});

test("Delete now removes the conversation and everything naming it; Delete all empties Recently Deleted", async (t) => {
  const { app, call } = await served(t);
  const { sessionId: a, runId } = seed(app.store, "delete me for good");
  const b = seed(app.store, "and me").sessionId, keep = seed(app.store, "keep me").sessionId;
  await call("POST", `/api/sessions/${a}/pin`, { pinned: true });
  await call("POST", `/api/sessions/${a}/rename`, { title: "Gone" });
  assert.equal((await call("POST", `/api/sessions/${a}/delete-now`, {})).status, 400, "only from Recently Deleted");
  await call("POST", `/api/sessions/${a}/delete`, {});
  const preview = (await call("GET", `/api/sessions/${a}/delete-now`)).body;
  assert.deepEqual([preview.messages, preview.tasks], [2, 1]);
  const gone = await call("POST", `/api/sessions/${a}/delete-now`, {});
  assert.equal(gone.status, 200);
  // Nothing anywhere in the database names the conversation or its task, but the append-only records.
  const db = app.store.sqlite, kept = new Set(["audit", "activity_chain"]);
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
    if (kept.has(name) || name.includes("_search") || name.startsWith("sqlite_")) continue;
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((c) => c.name);
    for (const column of columns) {
      let found;
      try { found = db.prepare(`SELECT 1 AS hit FROM "${name}" WHERE CAST("${column}" AS TEXT) LIKE ? OR CAST("${column}" AS TEXT) LIKE ? LIMIT 1`).get(`%${a}%`, `%${runId}%`); }
      catch { continue; } // a virtual table's hidden column cannot be read this way
      assert.equal(found, undefined, `${name}.${column} still names the deleted conversation`);
    }
  }
  await call("POST", `/api/sessions/${b}/delete`, {});
  const emptied = await call("POST", "/api/sessions/put-away/empty", {});
  assert.deepEqual(emptied.body, { deleted: 1, kept: 0 });
  assert.equal(app.store.ownsSession("local", b), false);
  assert.equal(app.store.ownsSession("local", keep), true);
});

test("a conversation with a task still running asks to stop it first; nothing is stopped by itself", async (t) => {
  const { app, call } = await served(t);
  const run = app.store.createRun("local", "still going");
  const refused = await call("POST", `/api/sessions/${run.sessionId}/delete`, {});
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Stop it first, then delete/);
  assert.match((await call("POST", `/api/sessions/${run.sessionId}/archive`, { archived: true })).body.error, /Stop it first, then archive/);
  assert.equal(app.store.run(run.id).status, "running", "nothing was stopped");
  app.store.finish(run.id, "completed", "done");
  assert.equal((await call("POST", `/api/sessions/${run.sessionId}/delete`, {})).status, 200);
});

test("a new message in an archived or deleted conversation brings it back to Recent", async (t) => {
  const { app, call } = await served(t);
  const a = seed(app.store, "come back").sessionId;
  await call("POST", `/api/sessions/${a}/delete`, {});
  app.store.finish(app.store.createRun("local", "hello again", a).id, "completed", "ok");
  assert.ok((await recentIds(call)).includes(a));
});

test("a household person acts on their own conversations only; the owner's are refused to them", async (t) => {
  const { app, call } = await served(t);
  const mine = seed(app.store, "owner's conversation").sessionId;
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const theirs = seed(app.store, "Sam's own", app.store.profiles.scope()).sessionId;
  for (const [action, body] of [["pin", { pinned: true }], ["rename", { title: "x" }], ["archive", { archived: true }], ["delete", {}]])
    assert.equal((await call("POST", `/api/sessions/${mine}/${action}`, body)).status >= 400, true, `${action} on the owner's is refused`);
  assert.equal((await call("POST", `/api/sessions/${theirs}/pin`, { pinned: true })).status, 200);
  assert.equal((await call("POST", `/api/sessions/${theirs}/delete`, {})).status, 200);
  assert.deepEqual((await call("GET", "/api/sessions/put-away")).body.deleted.map((r) => r.sessionId), [theirs]);
  assert.equal((await call("POST", `/api/sessions/${theirs}/delete-now`, {})).status, 200);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  assert.equal(app.store.ownsSession("local", mine), true);
  assert.equal(app.store.conversations.inBin(mine), false);
});

test("a phone may pin, rename, archive and delete, but deleting for good is only this computer's window", async (t) => {
  const { app, call, doorBase } = await served(t);
  const a = seed(app.store, "from the phone").sessionId;
  const phone = await pairedPhone(call);
  const byPhone = (path, body) => call("POST", path, body, doorBase, phone.token, phone.headers);
  assert.equal((await byPhone(`/api/sessions/${a}/pin`, { pinned: true })).status, 200);
  assert.equal((await byPhone(`/api/sessions/${a}/rename`, { title: "On the go" })).status, 200);
  assert.equal((await byPhone(`/api/sessions/${a}/archive`, { archived: true })).status, 200);
  assert.equal((await byPhone(`/api/sessions/${a}/delete`, {})).status, 200);
  const now = await byPhone(`/api/sessions/${a}/delete-now`, {});
  assert.equal(now.status, 403);
  assert.match(now.body.error, /only be done in the app on this computer/);
  assert.equal((await byPhone("/api/sessions/put-away/empty", {})).status, 403);
  assert.equal(app.store.ownsSession("local", a), true);
  assert.equal((await call("POST", `/api/sessions/${a}/delete-now`, {})).status, 200);
});
