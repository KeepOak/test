/* wire-greyed: Settings › Advanced › Archive facts unused for (90 days, 180 days, never) was greyed ("Branch never
   archives a fact on its own"). The engine keeps the choice (GET/POST /api/memory/auto-archive), and a daily beat sets
   aside facts nobody drew on or changed for that long: into the archive with a note, versions kept, restorable. It starts
   at never. A fact a conversation drew on recently stays. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { autoArchiveApi, autoArchiveTick, autoArchiveSettings } from "../dist/memory-auto-archive.js";
import { discardTemp } from "./temp-dir.mjs";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const day = 86_400_000;

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-auto-archive-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

/** Three facts, all last changed 200 days ago; one of them drawn on by a conversation 10 days ago. */
function seed(app) {
  const owner = app.runtime.owner, old = new Date(Date.now() - 200 * day).toISOString();
  const ids = ["tower", "bees", "shed"].map((word) => app.store.save("memory", owner, `fact-${word}`, { text: `The ${word} note`, source: "test" }).id);
  app.store.sqlite.prepare("UPDATE memory SET updated_at=?, created_at=? WHERE owner=?").run(old, old, owner);
  app.store.sqlite.prepare("INSERT INTO memory_uses VALUES(?,?,3,?)").run(owner, ids[1], new Date(Date.now() - 10 * day).toISOString());
  return ids;
}

test("it starts at never and sets nothing aside; 180 days sets aside only the facts nobody used", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  const [tower, bees, shed] = seed(app);
  assert.equal(autoArchiveSettings(app.store, owner).afterDays, null);
  assert.equal(autoArchiveTick(app.store, app.memory.retrieval, owner), 0, "never: nothing moves");

  const chose = await call("/api/memory/auto-archive", { afterDays: 180 });
  assert.equal(chose.status, 200);
  assert.equal(chose.body.wouldSetAside, 2);
  assert.equal(autoArchiveTick(app.store, app.memory.retrieval, owner), 2);
  const kept = app.store.list("memory", owner).map((record) => record.id);
  assert.deepEqual(kept, [bees], "the fact drawn on 10 days ago stays");
  const archived = app.store.archivedMemory(owner);
  assert.deepEqual(archived.map((record) => record.id).sort(), [shed, tower].sort());
  assert.match(archived[0].note, /Unused for 180 days/);
  assert.equal(autoArchiveTick(app.store, app.memory.retrieval, owner), 0, "at most once a day");

  // Nothing is lost: an archived fact comes back.
  await call(`/api/memory/archive/${tower}/restore`, {});
  assert.ok(app.store.list("memory", owner).some((record) => record.id === tower));
});

test("only 90, 180 or never can be chosen", async (t) => {
  const { call } = await served(t);
  assert.equal((await call("/api/memory/auto-archive", { afterDays: 3 })).status, 400);
  assert.equal((await call("/api/memory/auto-archive", { afterDays: null })).body.settings.afterDays, null);
});

test("a change is refused when the owner switched away or Branch locked while its body was being read", async (t) => {
  const { app } = await served(t);
  const owner = app.runtime.owner;
  for (const late of ["switched", "locked"]) {
    let now = "owner";
    const deps = { store: app.store, owner, retrieval: app.memory.retrieval,
      requireOwner: () => { if (now === "switched") throw new Error("Only the owner can do this."); },
      requireUnlocked: () => { if (now === "locked") throw new Error("Unlock Branch first."); } };
    const body = async () => { now = late; return { afterDays: 90 }; };
    await assert.rejects(autoArchiveApi(deps, "POST", body), late === "locked" ? /Unlock/ : /Only the owner/);
    assert.equal(autoArchiveSettings(app.store, owner).afterDays, null, `${late} mid-request: the choice is not kept`);
  }
});
