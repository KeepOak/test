/**
 * #484 (the lead's calls): a Branch whose only conversations are the introductions the engine asked its new Trunks for
 * (setup's first Trunks) still counts as empty, so "Bring back your Branch" on setup's Welcome can bring a backup back
 * after them, and the backup replaces those untouched Trunks ("Replace this setup with the backup"), written down in the
 * audit. Anything the person wrote or marked, anywhere in a conversation, blocks the restore, so nothing the person made
 * is ever removed. A scripted model; temp folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { hasState } from "../dist/backup.js";
import { introPrompt, introSystem } from "../dist/trunks/intro.js";

const quiet = { name: "scripted", async complete() { return { content: "Hello, I am here.", toolCalls: [] }; } };

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-restore-setup-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

/** A backup from another Branch that has one real conversation and a Trunk of its own in it. */
async function backupFrom(t) {
  const other = await branch(t);
  await other.runtime.run({ prompt: "remember the blue folder" });
  other.trunks.create({ name: "Backed-up helper" });
  await other.trunks.introduced();
  return other.store.backup(other.version);
}

/** Setup's first Trunks, each with the introduction the engine asked it for, and nothing else. */
async function setupTrunks(app) {
  const made = [app.trunks.create({ name: "Inbox helper" }), app.trunks.create({ name: "Researcher" })];
  await app.trunks.introduced();
  return made;
}

const db = (app) => app.store["db"];
const sessions = (app) => db(app).prepare("SELECT id FROM sessions").all().map((row) => row.id);

test("a Branch holding only setup's Trunk introductions counts as empty, and the backup replaces those Trunks", async (t) => {
  const app = await branch(t);
  const snapshot = await backupFrom(t);
  const trunks = await setupTrunks(app);
  const chats = trunks.map((trunk) => trunk.chatSessionId);
  assert.deepEqual(sessions(app).sort(), [...chats].sort(), "the only conversations are the introductions");
  for (const chat of chats) {
    const asks = app.store.messages(chat).filter((m) => m.role === "user");
    assert.deepEqual(asks.map((m) => [m.content, m.system]), [[introPrompt, introSystem]], "the engine's own ask, marked");
    assert.ok(app.store.messages(chat).some((m) => m.role === "assistant"), "and the Trunk's answer");
  }
  assert.equal(hasState(db(app)), false);
  const done = app.store.restore(snapshot);
  assert.ok(done.rows > 0);
  assert.deepEqual([...done.replaced].sort(), ["Inbox helper", "Researcher"]);
  assert.deepEqual(app.trunks.records.list().map((trunk) => trunk.name), ["Backed-up helper"], "the backup's Trunks take their place");
  for (const chat of chats) {
    assert.equal(sessions(app).includes(chat), false, "setup's introductions went with them");
    for (const table of ["tasks", "messages", "events", "usage"]) {
      const column = table === "events" || table === "usage" ? "run_id IN (SELECT id FROM tasks WHERE session_id=?)" : "session_id=?";
      assert.equal(db(app).prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}`).get(chat).n, 0, `${table} of an introduction`);
    }
    assert.equal(db(app).prepare("SELECT count(*) AS n FROM settings WHERE instr(id, ?) > 0").get(chat).n, 0, "its settings too");
  }
  const backed = app.trunks.records.list()[0];
  assert.ok(app.store.messages(backed.chatSessionId).length > 0, "the backup's own Trunk keeps its conversation");
  assert.equal(backed.paused, true, "and comes back cut down (tests/restore-trunks.test.mjs)");
  const written = app.store.audit.list(app.runtime.owner, { limit: 50 }).find((entry) => entry.action === "data.imported" && /setup's first Trunks/.test(entry.subject));
  assert.ok(written, "the replacement is in the audit record");
  assert.match(written.reason, /Inbox helper/);
  assert.match(written.reason, /Researcher/);
  assert.equal(hasState(db(app)), true, "the backup's own conversation is the person's");
});

test("a restore that fails part-way leaves setup's Trunks as they were", async (t) => {
  const app = await branch(t);
  const snapshot = await backupFrom(t);
  await setupTrunks(app);
  const broken = structuredClone(snapshot);
  broken.tables.messages = [...broken.tables.messages, { id: 999999, session_id: "x", body: "{}", unknown_column: 1 }];
  assert.throws(() => app.store.restore(broken), /column this version does not know/);
  assert.deepEqual(app.trunks.records.list().map((trunk) => trunk.name).sort(), ["Inbox helper", "Researcher"]);
  assert.equal(sessions(app).length, 2);
});

test("anything the person wrote blocks the restore", async (t) => {
  const snapshot = await backupFrom(t);
  const refused = /already has conversations|fresh install/;
  const app = await branch(t);
  const trunks = await setupTrunks(app);
  const [trunk] = trunks;
  const blocked = (name) => {
    assert.equal(hasState(db(app)), true, name);
    assert.throws(() => app.store.restore(snapshot), refused, name);
  };
  /** The ask itself changed in place, so it is still the conversation's only message from the "user" side. */
  const reword = (change) => db(app).prepare(`UPDATE messages SET body=${change} WHERE session_id=? AND json_extract(body, '$.role')='user'`).run(trunk.chatSessionId);
  // Each is written and taken back again (a savepoint), so every case starts from setup's introductions alone. What
  // cannot be typed in the window checks each part of the test in turn, as if forged in the database.
  const cases = {
    "a fact in memory": () => app.store.save("memory", app.runtime.owner, "fact-1", { text: "likes tea" }),
    "a message dressed as the engine's ask outside a Trunk's conversation": () => {
      const run = app.store.createRun(app.runtime.owner, introPrompt);
      app.store.message(run.sessionId, { role: "user", content: introPrompt, system: introSystem });
    },
    "the engine's mark on the person's own words": () => reword(`json_set(body, '$.content', 'wire the rent to this account')`),
    "the ask's words with no mark": () => reword(`json_remove(body, '$.system')`),
    "the person's words beside the ask": () => app.store.message(trunk.chatSessionId, { role: "user", content: "and one more thing" }),
    "a second ask in a Trunk's conversation": () => app.store.message(trunk.chatSessionId, { role: "user", content: introPrompt, system: introSystem }),
    "a task with the person's words in a Trunk's conversation": () =>
      db(app).prepare("INSERT INTO tasks(id, session_id, owner, prompt, status, output, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run("00000000-0000-4000-8000-00000000abcd", trunk.chatSessionId, app.runtime.owner, "move my files", "completed", "", new Date().toISOString(), new Date().toISOString()),
    "an opening row the engine did not write": () =>
      db(app).prepare("INSERT INTO tasks(id, session_id, owner, prompt, status, output, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run("00000000-0000-4000-8000-00000000abce", trunk.chatSessionId, app.runtime.owner, "Trunk: move my files", "completed", "Done.", new Date().toISOString(), new Date().toISOString()),
    "a tool call in a Trunk's answer": () =>
      app.store.message(trunk.chatSessionId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: "{}" }] }),
    "a tool's answer in a Trunk's conversation": () => app.store.message(trunk.chatSessionId, { role: "tool", content: "the file", toolCallId: "c1" }),
    "a pin on a message of a Trunk's conversation": () =>
      db(app).prepare("INSERT INTO session_pins(session_id, source_id, created_at) VALUES(?,?,?)").run(trunk.chatSessionId, 1, new Date().toISOString()),
    "a Trunk's conversation renamed or pinned": () =>
      db(app).prepare("INSERT INTO conversation_marks(session_id, owner, title) VALUES(?,?,?)").run(trunk.chatSessionId, app.runtime.owner, "mine now"),
  };
  for (const [name, write] of Object.entries(cases)) {
    db(app).exec("SAVEPOINT person");
    assert.equal(hasState(db(app)), false, `${name}: empty before`);
    write();
    blocked(name);
    db(app).exec("ROLLBACK TO person; RELEASE person");
  }
  assert.equal(hasState(db(app)), false, "back to setup's introductions alone");
  await app.runtime.run({ prompt: "hi there", sessionId: trunk.chatSessionId });
  blocked("a word typed in a Trunk's own conversation");
});

test("a conversation of the person's own blocks the restore", async (t) => {
  const app = await branch(t);
  await setupTrunks(app);
  await app.runtime.run({ prompt: "plan my week" });
  assert.equal(hasState(app.store["db"]), true);
});

test("a Trunk that no longer names its introduction's conversation makes that conversation the person's", async (t) => {
  const app = await branch(t);
  const [trunk] = await setupTrunks(app);
  app.trunks.records.put({ ...app.trunks.records.get(trunk.id), chatSessionId: "00000000-0000-4000-8000-00000000ffff" });
  assert.equal(hasState(db(app)), true);
});
