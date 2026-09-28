/**
 * defaulttrunk (migration): on a copy of a seeded database from before threads, every conversation with no Trunk is
 * put with the default Trunk, one a Trunk already answered in with that Trunk, a choice the owner made is kept, and a
 * chat app's earlier conversations join that chat's thread. Nothing is deleted, moved, re-dated or marked read; a second
 * start changes nothing; and it is written down once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { chatThread, chatThreadKey } from "../dist/channels/threads.js";
import { saveOnboarding } from "../dist/onboarding.js";
import { discardTemp } from "./temp-dir.mjs";
import { brain } from "./trunks-helpers.mjs";
import { fixture } from "./trunks-helpers.mjs";

test("migration rolls every claim back when its audit cannot be recorded", async (t) => {
  const { app } = await fixture(t);
  app.trunks.ensureDefault(true);
  const session = app.store.createSession(app.runtime.owner), before = snapshot(app);
  app.store.sqlite.exec("CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END");
  try { assert.throws(() => app.trunks.settle(), /test audit unavailable/); }
  finally { app.store.sqlite.exec("DROP TRIGGER test_audit_failure"); }
  assert.equal(app.trunks.threads.get(session), undefined);
  assert.deepEqual(snapshot(app), before);
  assert.equal(app.trunks.settle().toDefault, 1);
  assert.ok(app.trunks.threads.get(session));
});

const open = (root, data, provider) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, data), provider });
/** Everything a person would notice about their conversations: which exist, their words and times, and what is unread. */
function snapshot(app) {
  const db = app.store.sqlite, owner = app.runtime.owner;
  const sessions = db.prepare("SELECT id, created_at FROM sessions ORDER BY id").all().map((row) => ({ ...row }));
  const messages = db.prepare("SELECT id, session_id, body, created_at FROM messages ORDER BY id").all().map((row) => ({ ...row }));
  const reads = db.prepare("SELECT * FROM message_reads ORDER BY message_id").all().map((row) => ({ ...row }));
  const marks = db.prepare("SELECT owner, kind, item, read_through, unread, updated_at FROM read_marks ORDER BY item").all().map((row) => ({ ...row }));
  const unread = Object.fromEntries(sessions.map((s) => [s.id, app.store.readMarks.unread(owner, s.id)]));
  return { sessions, messages, reads, marks, unread };
}
const threads = (app) => Object.fromEntries(app.store.sqlite.prepare("SELECT session_id, trunk_id, how FROM trunk_threads ORDER BY session_id").all()
  .map((row) => [row.session_id, `${row.trunk_id}:${row.how}`]));

test("the migration puts every conversation with a Trunk, keeps everything else as it was, and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-default-migration-"));
  t.after(() => discardTemp(root));
  const provider = brain();
  // ---- the seeded database, as a Branch from before threads left it ----
  const app = await open(root, "data", provider);
  const owner = app.runtime.owner;
  saveOnboarding(app.store, owner, { done: true });
  app.trunks.setMode("trunks", { mode: "on" });
  const plainA = await app.runtime.run({ prompt: "plain one" });
  const plainB = await app.runtime.run({ prompt: "plain two" });
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { reach: { channels: ["chat"], commands: false } });
  await app.trunks.introduced();
  const routine = await app.runtime.run({ prompt: "Bo's routine", trunkId: bo.id });
  const chosen = await app.runtime.run({ prompt: "for Bo" });
  app.trunks.conversations.choose(chosen.sessionId, { trunkId: bo.id });
  app.store.readMarks.mark(owner, { conversation: plainA.sessionId, unread: false }, () => true);
  app.store.readMarks.mark(owner, { conversation: plainB.sessionId, unread: true }, () => true);
  // A chat that said "/new" once: two conversations from one chat.
  app.channels.mergeWindowMs = 0;
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send() { return "1"; } }, { activation: "always", pairing: false, allowlist: ["sam"] });
  const say = (text, n) => app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "sam", senderName: "Sam", text, addressed: true, messageId: `m${n}` });
  await say("first", 1); await say("/new", 2); await say("second", 3);
  const chatNow = chatThread(app.store, owner, "chat", "c1");
  const chatSessions = app.store.sqlite.prepare("SELECT DISTINCT t.session_id AS s FROM events e JOIN tasks t ON t.id=e.run_id WHERE e.kind='channel.inbound'").all().map((r) => r.s);
  assert.equal(chatSessions.length, 2);
  await app.channels.detachAll();
  // What a Branch from before threads did not have: no thread rows, no pick, nothing on the chat's record.
  app.store.sqlite.exec("DELETE FROM trunk_threads; DELETE FROM governance WHERE id='trunk-default'");
  const { trunkId: _t, earlier: _e, ...oldChat } = chatNow;
  app.store.save("settings", owner, chatThreadKey("chat", "c1"), oldChat);
  const before = snapshot(app);
  await app.close();

  // ---- a copy of it, opened by this build ----
  cpSync(join(root, "data"), join(root, "copy"), { recursive: true });
  const copy = await open(root, "copy", provider);
  const firstStart = threads(copy);
  assert.equal(firstStart[plainA.sessionId], `${ada.id}:migrated`, "a conversation with nobody goes to the default (setup's first Trunk)");
  assert.equal(firstStart[plainB.sessionId], `${ada.id}:migrated`);
  assert.equal(firstStart[routine.sessionId], `${bo.id}:claimed`, "a conversation a Trunk answered in stays with that Trunk");
  assert.equal(firstStart[chosen.sessionId], `${bo.id}:chosen`, "the owner's choice is kept");
  assert.equal(firstStart[ada.chatSessionId], undefined, "a Trunk's own chat is its own, never a thread");
  for (const s of chatSessions) assert.equal(firstStart[s], `${ada.id}:migrated`);
  const chat = chatThread(copy.store, owner, "chat", "c1");
  assert.equal(chat.sessionId, chatNow.sessionId);
  assert.equal(chat.trunkId, ada.id);
  assert.deepEqual(chat.earlier, chatSessions.filter((s) => s !== chatNow.sessionId), "the chat's earlier conversation joins its thread");
  assert.deepEqual(snapshot(copy), before, "no conversation, message, time or read mark changed");
  const written = copy.store.audit.list(owner, { action: "trunk.default" }).length;
  await copy.close();

  // ---- a second start changes nothing ----
  const again = await open(root, "copy", provider);
  assert.deepEqual(threads(again), firstStart);
  assert.deepEqual(chatThread(again.store, owner, "chat", "c1"), chat);
  assert.deepEqual(snapshot(again), before);
  assert.equal(again.store.audit.list(owner, { action: "trunk.default" }).length, written, "written down once");
  await again.close();
});

test("thousands of conversations are put with a Trunk in one step, and the Trunks stay in sight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-default-many-"));
  const app = await open(root, "data", brain());
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  app.trunks.setMode("trunks", { mode: "on" });
  const insert = app.store.sqlite.prepare("INSERT INTO sessions(id,owner,created_at,temporary) VALUES(?,?,?,0)");
  app.store.atomically(() => { for (let i = 0; i < 3000; i++) insert.run(crypto.randomUUID(), app.runtime.owner, new Date().toISOString()); });
  const started = Date.now();
  const ada = app.trunks.create({ name: "Ada" });
  const took = Date.now() - started;
  assert.equal(app.trunks.threads.of(ada.id).length, 3000);
  assert.equal(app.trunks.records.list().length, 1, "3000 threads never push the Trunk records out of the governance list");
  assert.ok(took < 10_000, `took ${took} ms`);
  await app.trunks.introduced();
});
