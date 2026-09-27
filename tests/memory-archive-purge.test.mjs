/**
 * Purge all, for archived facts (POST /api/memory/archive/purge): the owner's alone, with a confirm step
 * (the word "purge" and how many archived facts the owner was shown). Every archived fact goes for good,
 * with the earlier versions kept of it, so nothing can put it back. Temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("purge all removes every archived fact and its versions, only when the owner confirms how many they saw", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-memory-purge-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const owner = app.runtime.owner, db = app.store.sqlite;
  const versions = (id) => Number(db.prepare("SELECT count(*) AS n FROM memory_versions WHERE owner=? AND memory_id=?").get(owner, id).n);
  const keepVersion = (id) => db.prepare("INSERT INTO memory_versions(owner,memory_id,revision,data,reason,created_at) VALUES(?,?,?,?,?,?)")
    .run(owner, id, 1, JSON.stringify({ text: "earlier " + id }), "edited", new Date().toISOString());
  for (const id of ["old-a", "old-b", "back"]) { app.store.save("memory", owner, id, { text: "Fact " + id, source: "owner" }); keepVersion(id); }
  app.store.save("memory", owner, "live", { text: "A fact still in use", source: "owner" });
  app.store.memoryHygiene(owner, { olderThanDays: 1, action: "archive" }, Date.now() + 3 * 86_400_000);
  assert.equal((await call("/api/memory/archive")).body.total, 4);
  await call(`/api/memory/archive/back/restore`, {});
  const shown = (await call("/api/memory/archive")).body;
  assert.deepEqual([shown.archived.length, shown.total], [3, 3]);

  assert.equal((await call("/api/memory/archive/purge", { count: 3 })).status, 400, "no confirm word, nothing purged");
  const stale = await call("/api/memory/archive/purge", { confirm: "purge", count: 2 });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /There are 3 archived facts now, not 2, so nothing was purged/);
  assert.equal((await call("/api/memory/archive")).body.total, 3);
  const key = app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("/api/memory/archive/purge", { confirm: "purge", count: 3 }, key)).status, 401);
  const person = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: person.id, pin: "2468" });
  assert.equal((await call("/api/memory/archive/purge", { confirm: "purge", count: 3 })).status, 400, "a household person is refused");
  app.store.profiles.switch({ profileId: null });

  const purged = await call("/api/memory/archive/purge", { confirm: "purge", count: 3 });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.deepEqual(purged.body, { purged: 3 });
  assert.deepEqual((await call("/api/memory/archive")).body, { archived: [], total: 0 });
  assert.deepEqual([versions("old-a"), versions("old-b")], [0, 0], "no earlier version is left to put it back");
  assert.ok(versions("back") >= 1, "a fact restored to memory keeps its versions");
  assert.equal(app.store.get("memory", owner, "back").data.text, "Fact back");
  assert.equal((await call("/api/memory/archive/old-a/restore", {})).status, 400, "a purged fact cannot be restored");
});
