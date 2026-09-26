/**
 * A project's conversations (src/session-library.ts projectOf): a conversation is in the project its latest task ran
 * under. GET /api/projects counts them beside the projects (never inside one, which is saved back whole) and
 * GET /api/projects/<id>/conversations lists them. Both are the owner's: a household person is refused. A scripted
 * model; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { projectOf } from "../dist/session-library.js";

async function served(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-project-chats-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  const server = await startServer(app, { dataDir: join(base, "data"), port: 0 });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discardTemp(base).catch(() => undefined);
  });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (path, body) => {
    const response = await fetch(server.url + path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, call };
}

test("each project counts and lists the conversations whose latest task ran under it", async (t) => {
  const { app, call } = await served(t);
  const empty = await call("/api/projects");
  assert.deepEqual(empty.body.conversations, {}, "nothing counted before any conversation");
  assert.ok(empty.body.all.every((p) => !("conversations" in p)), "no count inside a project, which is saved back whole");

  const first = await app.runtime.run({ prompt: "in the default project" });
  assert.equal((await call("/api/projects", { id: "garden", name: "Garden" })).status, 200);
  assert.equal((await call("/api/projects/active", { active: "garden" })).status, 200);
  const second = await app.runtime.run({ prompt: "in the garden" });

  const counted = await call("/api/projects");
  assert.deepEqual(counted.body.conversations, { default: 1, garden: 1 });
  const garden = await call("/api/projects/garden/conversations");
  assert.equal(garden.body.project, "garden");
  assert.deepEqual(garden.body.sessions.map((s) => s.sessionId), [second.sessionId]);
  assert.equal(garden.body.sessions[0].opening, "in the garden");
  assert.deepEqual((await call("/api/projects/default/conversations")).body.sessions.map((s) => s.sessionId), [first.sessionId]);

  // Continued while Garden is active, the default project's conversation is now Garden's: its latest task ran there.
  await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.deepEqual((await call("/api/projects")).body.conversations, { garden: 2 });

  // Saving a project back whole, as the window does, keeps working with the counts beside it.
  const saved = counted.body.all.find((p) => p.id === "garden");
  assert.equal((await call("/api/projects", { ...saved, instructions: "Ask first" })).status, 200);

  assert.equal((await call("/api/projects/nowhere/conversations")).status, 404);
  // Removing the project leaves its conversations where they are.
  assert.equal((await call("/api/projects/garden/remove", {})).status, 200);
  assert.equal((await call("/api/sessions")).body.sessions.length, 2);
});

test("a household person is refused the projects and their conversations", async (t) => {
  const { app, call } = await served(t);
  await app.runtime.run({ prompt: "the owner's own" });
  const made = await call("/api/profiles", { name: "Sam", pin: "4321" });
  assert.equal((await call("/api/profiles/switch", { profileId: made.body.id, pin: "4321" })).status, 200);
  for (const path of ["/api/projects", "/api/projects/default/conversations"]) {
    const refused = await call(path);
    assert.notEqual(refused.status, 200, path);
    assert.match(refused.body.error, /belongs to the owner/, path);
  }
});

/* The plan SQLite makes for each conversation's project: the latest task is found through the index, never a scan. */
const plan = (db) => db.prepare(`EXPLAIN QUERY PLAN SELECT ${projectOf} AS project, COUNT(*) FROM sessions s WHERE s.owner=? GROUP BY 1`)
  .all("local").map((row) => row.detail);

test("a conversation's project is read through an index on its tasks, also in a store made before the index", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "branch-project-index-"));
  t.after(() => discardTemp(base).catch(() => undefined));
  const path = join(base, "branch.db");
  let store = new Store(path);
  const fresh = plan(store.db);
  assert.ok(fresh.some((d) => /^SEARCH t USING (COVERING )?INDEX tasks_session_created \(session_id=\?\)/.test(d)), fresh.join(" | "));
  assert.ok(!fresh.some((d) => d === "SCAN t" || /TEMP B-TREE FOR ORDER BY/.test(d)), fresh.join(" | "));
  // A store saved before the index existed gets it when it next opens.
  store.db.exec("DROP INDEX tasks_session_created");
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.ok(plan(store.db).some((d) => d.includes("INDEX tasks_session_created")), "the index is made again on opening");
});
