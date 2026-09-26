/* The Dev channel's line of work (src/dev-lines.ts) as the engine keeps it, and the copy of the data folder taken
   before each update (src/install/data-copy.ts). Security tier: the line becomes a git argument, so only the owner,
   in the app window, may change it, only to one of Branch's own lines, and never through the assistant's tools or a
   short-lived key. Nothing here touches an installed app: every engine runs on a fresh temporary folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readComfort } from "../dist/comfort/settings.js";
import { classify } from "../dist/settings-kit/catalogue.js";
import { changesFor } from "../dist/settings-kit/changes.js";
import { applyDataRestore, askDataRestore, listDataCopies, pendingDataRestore, takeDataCopy } from "../dist/install/data-copy.js";

const exists = (path) => access(path).then(() => true, () => false);

async function engine(t, root) {
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const close = async () => { await server.close(); await app.close(); };
  return { app, server, call, close, dataDir };
}

async function fresh(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-dev-line-"));
  const running = [];
  t.after(async () => { for (const one of running) await one.close().catch(() => undefined); await discardTemp(root); });
  const start = async () => { const one = await engine(t, root); running.push(one); return one; };
  return { root, start };
}

test("the owner picks the line in the app window, only one of Branch's own, and the updater hears it", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  assert.equal((await call("GET", "/api/comfort/update-readiness")).body.devLine, "mac/cross-platform", "the main line until picked");
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "dev", devLine: "redesign/window" } })).status, 200);
  assert.equal((await call("GET", "/api/comfort/update-readiness")).body.devLine, "redesign/window");
  for (const bad of ["main", "refs/heads/redesign/window", "--upload-pack=touch /tmp/x", "https://example.com/other.git", "../redesign/window"]) {
    const refused = await call("POST", "/api/comfort", { card: "notify", values: { devLine: bad } });
    assert.equal(refused.status, 400, bad);
  }
  assert.equal(readComfort(app.store, app.runtime.owner, "notify").devLine, "redesign/window", "nothing refused was kept");
  // A record written wrongly by anything else reads as the main line, never as what it says.
  app.store.save("settings", app.runtime.owner, "comfort-notify", { releaseChannel: "dev", devLine: "--upload-pack=x" });
  assert.equal((await call("GET", "/api/comfort/update-readiness")).body.devLine, "mac/cross-platform");
});

test("a short-lived key cannot change the line, nor put the card back, nor read what the updater reads", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  const keys = [
    app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token,
    app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token,
  ];
  for (const key of keys) {
    const moved = await call("POST", "/api/comfort", { card: "notify", values: { devLine: "redesign/window" } }, key);
    assert.equal(moved.status, 401);
    assert.match(moved.body.error, /short-lived key cannot change shortcuts, notifications, updates/);
    assert.equal((await call("POST", "/api/comfort", { card: "notify", reset: true }, key)).status, 401);
    assert.equal((await call("GET", "/api/comfort/update-readiness", undefined, key)).status, 401);
    assert.equal((await call("GET", "/api/updates/data-copies", undefined, key)).status, 401);
    assert.equal((await call("POST", "/api/updates/data-copies", { name: null }, key)).status, 401);
  }
  assert.equal(readComfort(app.store, app.runtime.owner, "notify").devLine, "mac/cross-platform");
});

test("a household person cannot change the line or put back a copy; the owner's own key still can", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { devLine: "redesign/window" } })).status, 200);
  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { devLine: "mac/cross-platform" } })).status, 400);
  assert.equal((await call("POST", "/api/comfort", { card: "notify", reset: true })).status, 400, "putting the card back would change the line too");
  assert.equal((await call("GET", "/api/updates/data-copies")).status, 400);
  app.store.profiles.switch({ profileId: null });
  assert.equal(readComfort(app.store, app.runtime.owner, "notify").devLine, "redesign/window");
});

test("the assistant's settings tools can neither list nor change the line", async (t) => {
  const { start } = await fresh(t);
  const { app } = await start();
  assert.equal(classify("comfort-notify", "devLine"), "blocked");
  assert.equal(classify("comfort-notify", "releaseChannel"), "blocked", "the control: the channel is not the tools' either");
  const planned = changesFor(app.store, app.runtime.owner, [{ key: "comfort-notify", field: "devLine", value: "redesign/window" }]);
  assert.deepEqual(planned.changes, []);
  assert.match(planned.refused[0], /comfort-notify\.devLine: not a setting that can be changed from here/);
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, "follow the redesign");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  const answer = await app.registry.execute("settings.change", { changes: [{ setting: "comfort-notify.devLine", value: "redesign/window" }] }, context)
    .catch((error) => ({ error: error.message }));
  assert.equal(answer.changed?.length ?? 0, 0, JSON.stringify(answer));
  const listed = await app.registry.execute("settings.list", {}, context).catch(() => ({}));
  assert.equal(JSON.stringify(listed).includes("devLine"), false, "the tools are never shown it");
  assert.equal(readComfort(app.store, owner, "notify").devLine, "mac/cross-platform");
});

test("the copy of the data folder holds the databases whole and the folder's files, never the updater's own, newest three", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-data-copy-"));
  t.after(() => discardTemp(root));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const dataDir = join(root, "data");
  app.store.save("settings", app.runtime.owner, "comfort-notify", { sound: "chime" });
  await mkdir(join(dataDir, "kept"), { recursive: true });
  await writeFile(join(dataDir, "kept", "note.txt"), "a note");
  // The engine holds its saved work open for itself alone, so the copy goes through the connections it has open.
  const open = { "branch.sqlite": app.store.sqlite, "journal.sqlite": app.neverBreak.journal.database };
  const first = await takeDataCopy({ dataDir, version: "0.19.3-dev.1-gabc", open, at: new Date("2026-09-26T10:00:00.000Z") });
  const inside = await readdir(first.path);
  for (const name of ["branch.sqlite", "journal.sqlite", "holidays.json", "kept"]) assert.ok(inside.includes(name), `${name} is in the copy: ${inside}`);
  for (const name of ["update-backups", "updates", "running.json"]) assert.equal(inside.includes(name), false, name);
  assert.equal(inside.some((name) => /\.sqlite-(wal|shm|journal)$/.test(name)), false, "no live side file");
  assert.equal(await readFile(join(first.path, "kept", "note.txt"), "utf8"), "a note");
  for (const hour of [11, 12, 13]) await takeDataCopy({ dataDir, version: "0.19.3", open, at: new Date(`2026-09-26T${hour}:00:00.000Z`) });
  const copies = await listDataCopies(dataDir);
  assert.equal(copies.length, 3, "the newest three are kept");
  assert.equal(copies[0].savedAt, "2026-09-26T13:00:00.000Z");
  assert.equal(copies.some((copy) => copy.name === first.name), false, "the oldest went");
  await app.close();
});

test("a copy is put back at the next start, before the saved work is opened, and what was there is kept", async (t) => {
  const { start } = await fresh(t);
  const one = await start();
  one.app.store.save("settings", one.app.runtime.owner, "comfort-notify", { sound: "chime" });
  // The update's safety copy, as the updater asks for it just before a swap.
  const backup = await one.call("POST", "/api/deployment/backup");
  assert.equal(backup.status, 200, JSON.stringify(backup.body));
  assert.match(backup.body.dataCopy, /^data-/);
  one.app.store.save("settings", one.app.runtime.owner, "comfort-notify", { sound: "knock" });
  const listed = await one.call("GET", "/api/updates/data-copies");
  assert.equal(listed.body.copies.length, 1);
  assert.equal(listed.body.pending, null);
  assert.equal((await one.call("POST", "/api/updates/data-copies", { name: "data-2026-01-01T00-00-00-000Z-v1" })).status, 400, "only a copy that is there");
  assert.equal((await one.call("POST", "/api/updates/data-copies", { name: "../../etc" })).status, 400);
  const asked = await one.call("POST", "/api/updates/data-copies", { name: backup.body.dataCopy });
  assert.equal(asked.body.pending, backup.body.dataCopy);
  assert.match(asked.body.message, /put back the next time Branch starts/);
  await one.close();
  const two = await start();
  assert.equal(readComfort(two.app.store, two.app.runtime.owner, "notify").sound, "chime", "the work is as it was when copied");
  const after = await two.call("GET", "/api/updates/data-copies");
  assert.equal(after.body.pending, null, "asked once, done once");
  assert.equal(after.body.last.name, backup.body.dataCopy);
  const aside = join(two.dataDir, "update-backups", after.body.last.aside);
  assert.ok(await exists(join(aside, "branch.sqlite")), "what was there before is kept beside the copies");
  await two.close();
});

test("a request to put back a copy can be taken back, and one whose copy is gone changes nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-data-copy-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "locker.key"), "key");
  await assert.rejects(askDataRestore(dataDir, "data-2026-01-01T00-00-00-000Z-v1"), /not a copy of the data folder this app made/);
  const { name, path } = await takeDataCopy({ dataDir, version: "1.0.0" });
  await askDataRestore(dataDir, name);
  assert.equal(await pendingDataRestore(dataDir), name);
  await askDataRestore(dataDir, null);
  assert.equal(await pendingDataRestore(dataDir), null);
  assert.equal(await applyDataRestore(dataDir), null, "nothing asked, nothing done");
  await askDataRestore(dataDir, name);
  await discardTemp(path);
  const gone = await applyDataRestore(dataDir);
  assert.match(gone.failed, /no longer there, so nothing was changed/);
  assert.equal(await readFile(join(dataDir, "locker.key"), "utf8"), "key");
  assert.equal(await pendingDataRestore(dataDir), null, "never tried again at every start");
});
