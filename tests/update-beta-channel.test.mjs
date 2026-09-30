/* The two update channels as the engine keeps them (Stable, and Beta which builds every merged change on this
   computer), and the copy of the data folder taken before each update (src/install/data-copy.ts). Security tier: Beta
   builds and runs code no release has published, so only the owner, in the app window on this computer, may choose
   it: never a household person, a short-lived key, a paired phone or the assistant's tools. Nothing here touches an
   installed app: every engine runs on a fresh temporary folder. */
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
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

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
  const root = await mkdtemp(join(tmpdir(), "branch-beta-channel-"));
  const running = [];
  t.after(async () => { for (const one of running) await one.close().catch(() => undefined); await discardTemp(root); });
  const start = async () => { const one = await engine(t, root); running.push(one); return one; };
  return { root, start };
}

test("two channels: the owner picks Stable or Beta in the window, a saved Dev reads as Beta, nothing else is kept", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  const owner = app.runtime.owner;
  assert.equal((await call("GET", "/api/comfort/update-readiness")).body.channel, "stable", "Stable until picked");
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta" } })).status, 200);
  // The ship-on rule: updating by itself ships "install"; picking the channel leaves it as it ships.
  assert.deepEqual((await call("GET", "/api/comfort/update-readiness")).body, { channel: "beta", busyTasks: 0, workingTasks: 0, autoUpdate: "install" });
  for (const bad of ["nightly", "redesign/window", "--upload-pack=touch /tmp/x", ""]) {
    const refused = await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: bad } });
    assert.equal(refused.status, 400, bad);
  }
  assert.equal(readComfort(app.store, owner, "notify").releaseChannel, "beta", "nothing refused was kept");
  // Dev was the source build before it became Beta: a record from then reads, and is kept, as Beta.
  app.store.save("settings", owner, "comfort-notify", { autoUpdate: "install", releaseChannel: "dev" });
  assert.deepEqual((await call("GET", "/api/comfort/update-readiness")).body, { channel: "beta", busyTasks: 0, workingTasks: 0, autoUpdate: "install" });
  assert.equal((await call("GET", "/api/comfort")).body.values.notify.releaseChannel, "beta");
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { sound: "chime" } })).status, 200);
  assert.equal(app.store.get("settings", owner, "comfort-notify").data.releaseChannel, "beta", "the next save writes Beta");
});

test("a short-lived key cannot change the channel, nor put the card back, nor read what the updater reads", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  const keys = [
    app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token,
    app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token,
  ];
  for (const key of keys) {
    const moved = await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta" } }, key);
    assert.equal(moved.status, 401);
    assert.match(moved.body.error, /short-lived key cannot change shortcuts, notifications, updates/);
    assert.equal((await call("POST", "/api/comfort", { card: "notify", reset: true }, key)).status, 401);
    assert.equal((await call("GET", "/api/comfort/update-readiness", undefined, key)).status, 401);
    assert.equal((await call("GET", "/api/updates/data-copies", undefined, key)).status, 401);
    assert.equal((await call("POST", "/api/updates/data-copies", { name: null }, key)).status, 401);
  }
  assert.equal(readComfort(app.store, app.runtime.owner, "notify").releaseChannel, "stable");
});

test("a household person cannot change the channel or put back a copy; the owner's own key still can", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta" } })).status, 200);
  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "stable" } })).status, 400);
  assert.equal((await call("POST", "/api/comfort", { card: "notify", reset: true })).status, 400, "putting the card back would change the channel too");
  assert.equal((await call("GET", "/api/updates/data-copies")).status, 400);
  app.store.profiles.switch({ profileId: null });
  assert.equal(readComfort(app.store, app.runtime.owner, "notify").releaseChannel, "beta");
});

test("the assistant's settings tools can neither change the channel nor turn update by itself on", async (t) => {
  const { start } = await fresh(t);
  const { app } = await start();
  assert.equal(classify("comfort-notify", "releaseChannel"), "blocked");
  assert.equal(classify("comfort-notify", "autoUpdate"), "blocked", "the control: update by itself is not the tools' either");
  const planned = changesFor(app.store, app.runtime.owner, [{ key: "comfort-notify", field: "releaseChannel", value: "beta" }]);
  assert.deepEqual(planned.changes, []);
  assert.match(planned.refused[0], /comfort-notify\.releaseChannel: not a setting that can be changed from here/);
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, "switch to beta");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  const answer = await app.registry.execute("settings.change", { changes: [{ setting: "comfort-notify.releaseChannel", value: "beta" }] }, context)
    .catch((error) => ({ error: error.message }));
  assert.equal(answer.changed?.length ?? 0, 0, JSON.stringify(answer));
  assert.equal(readComfort(app.store, owner, "notify").releaseChannel, "stable");
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

test("the models Branch downloaded are neither copied before an update nor moved aside when a copy is put back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-data-copy-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "models", "ollama"), { recursive: true });
  await mkdir(join(dataDir, "local-models", "gguf"), { recursive: true });
  await writeFile(join(dataDir, "models", "ollama", "blob"), "weights");
  await writeFile(join(dataDir, "local-models", "gguf", "small.gguf"), "weights");
  await writeFile(join(dataDir, "locker.key"), "before");
  const { name, path } = await takeDataCopy({ dataDir, version: "1.0.0" });
  assert.equal(await exists(join(path, "locker.key")), true, "control: the work is in the copy");
  assert.equal(await exists(join(path, "models")), false, "downloaded models are not copied");
  assert.equal(await exists(join(path, "local-models")), false, "downloaded models are not copied");
  await writeFile(join(dataDir, "locker.key"), "after");
  await askDataRestore(dataDir, name);
  const done = await applyDataRestore(dataDir);
  assert.equal(done?.restored, name, JSON.stringify(done));
  assert.equal(await readFile(join(dataDir, "locker.key"), "utf8"), "before", "the work is put back");
  assert.equal(await readFile(join(dataDir, "models", "ollama", "blob"), "utf8"), "weights", "the models stay where they are");
  assert.equal(await readFile(join(dataDir, "local-models", "gguf", "small.gguf"), "utf8"), "weights", "the models stay where they are");
  assert.equal(await exists(join(done.aside, "models")), false, "and are not moved aside");
});

/* A paired phone holds a key of its own, never the window's (aae58bdb); what is refused is the paired door (src/server.ts
   pairedDoorRequests). The same request with the window's key on this computer's door is the control. */
async function pairedPhone(t) {
  const { start } = await fresh(t);
  const one = await start();
  const host = new URL(one.server.url).host;
  const door = createServer((request, response) => { request.headers.host = host; one.server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(async () => { door.closeAllConnections?.(); await new Promise((done) => door.close(done)); });
  const base = `http://127.0.0.1:${door.address().port}`;
  const offer = one.server.remote.pairing.create();
  const session = await (await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: offer.id, code: offer.code, name: "Pixel" }) })).json();
  const headers = { authorization: `Bearer ${session.token}`, "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey, "content-type": "application/json" };
  const phone = (method, path, body) => fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  assert.notEqual(session.token, one.server.token, "the phone holds a key of its own, not the window's");
  return { ...one, phone };
}

test("a paired phone cannot choose the channel, put the card back over it, or touch the data copies; the window can", async (t) => {
  const { call, phone, app } = await pairedPhone(t);
  const owner = app.runtime.owner;
  const moved = await phone("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta" } });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.match(moved.body.error, /update channel is chosen only in the app window on this computer, not from a paired phone/);
  assert.equal(readComfort(app.store, owner, "notify").releaseChannel, "stable");
  assert.equal((await phone("POST", "/api/comfort", { card: "notify", values: { sound: "chime" } })).status, 200, "control: the phone keeps its other notification choices");
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta" } })).status, 200, "control: the window");
  assert.equal((await phone("POST", "/api/comfort", { card: "notify", reset: true })).status, 403, "putting the card back would choose the channel too");
  assert.equal((await phone("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta", sound: "knock" } })).status, 403, "naming the channel at all");
  assert.equal(readComfort(app.store, owner, "notify").releaseChannel, "beta");
  for (const [method, body] of [["GET"], ["POST", { name: null }]]) {
    const copies = await phone(method, "/api/updates/data-copies", body);
    assert.equal(copies.status, 403, `${method} ${JSON.stringify(copies.body)}`);
    assert.equal((await call(method, "/api/updates/data-copies", body)).status, 200, `control: ${method} in the window`);
  }
  assert.equal((await phone("GET", "/api/comfort/update-readiness")).status, 200, "reading what the updater reads is unchanged");
});

/* Lockdown and updates: Lockdown does not take over the notify card, and the window's update choices are not refused
   under it. The channel keeps exactly the rules update by itself already had, measured side by side here. */
test("under Lockdown the channel follows the existing update rules exactly, and Lockdown leaves the card as it was", async (t) => {
  const { start } = await fresh(t);
  const { call, app } = await start();
  const owner = app.runtime.owner;
  assert.equal((await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "beta", autoUpdate: "install" } })).status, 200);
  const before = readComfort(app.store, owner, "notify");
  const planBefore = (await call("POST", "/api/comfort/update-plan", { updaterPhase: "available" })).body;
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  assert.deepEqual(readComfort(app.store, owner, "notify"), before, "turning Lockdown on leaves the card");
  assert.equal((await call("GET", "/api/comfort/update-readiness")).body.channel, "beta");
  const planDuring = (await call("POST", "/api/comfort/update-plan", { updaterPhase: "available" })).body;
  assert.equal(planBefore.step, "install", "before Lockdown, the ready version installs by itself");
  // PLAT-148: under Lockdown nothing installs by itself, on the beta channel exactly as on stable (src/comfort/auto-update.ts).
  assert.deepEqual([planDuring.step, planDuring.until], ["nothing", "Lockdown is off"], "held by Lockdown as every channel is");
  await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "stable" } });
  const stableDuring = (await call("POST", "/api/comfort/update-plan", { updaterPhase: "available" })).body;
  assert.deepEqual([stableDuring.step, stableDuring.reason], [planDuring.step, planDuring.reason], "the channel changes nothing about it");
  const byItself = await call("POST", "/api/comfort", { card: "notify", values: { autoUpdate: "check" } });
  const channel = await call("POST", "/api/comfort", { card: "notify", values: { releaseChannel: "stable" } });
  assert.equal(channel.status, byItself.status, "the channel is refused or kept exactly as update by itself is");
  const run = app.store.createRun(owner, "switch the channel");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  const tool = async (setting, value) => JSON.stringify(await app.registry.execute("settings.change", { changes: [{ setting, value }] }, context)
    .catch((error) => ({ error: error.message })));
  assert.match(await tool("comfort-notify.releaseChannel", "beta"), /Lockdown is on|not a setting that can be changed/);
  assert.match(await tool("comfort-notify.autoUpdate", "install"), /Lockdown is on|not a setting that can be changed/);
  const during = readComfort(app.store, owner, "notify");
  assert.deepEqual([during.releaseChannel, during.autoUpdate], ["stable", "check"]);
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.deepEqual(readComfort(app.store, owner, "notify"), during, "turning it off puts nothing back over the owner's choice");
});

test("the update's copy fails, and so does the update, when a database in the data folder cannot be copied whole", async (t) => {
  const { start } = await fresh(t);
  const one = await start();
  await writeFile(join(one.dataDir, "broken.sqlite"), "this is not a database");
  const backup = await one.call("POST", "/api/deployment/backup");
  assert.notEqual(backup.status, 200, JSON.stringify(backup.body));
  assert.match(backup.body.error, /copy of the data folder could not be made/);
  assert.deepEqual(await listDataCopies(one.dataDir), [], "no half copy is offered");
  assert.equal((await readdir(join(one.dataDir, "update-backups"))).some((name) => name.endsWith(".partial")), false);
});

test("a copied database that does not pass SQLite's check is not a good copy, so none is kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-data-copy-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const dataDir = join(root, "data");
  const journal = app.neverBreak.journal.database;
  // The open connection is asked to copy, and what lands is not a database (a disk that wrote garbage, say).
  const target = (sql) => /^VACUUM INTO '(.*)'$/s.exec(sql)[1].split("''").join("'");
  const garbage = { exec(sql) { writeFileSync(target(sql), "garbage"); } };
  await assert.rejects(takeDataCopy({ dataDir, version: "1.0.0", open: { "branch.sqlite": garbage, "journal.sqlite": journal } }),
    /copy of the data folder could not be made/);
  // Nothing written at all is as bad as garbage.
  await assert.rejects(takeDataCopy({ dataDir, version: "1.0.0", open: { "branch.sqlite": { exec() {} }, "journal.sqlite": journal } }),
    /copy of the data folder could not be made/);
  assert.deepEqual(await listDataCopies(dataDir), []);
  const good = await takeDataCopy({ dataDir, version: "1.0.0", open: { "branch.sqlite": app.store.sqlite, "journal.sqlite": journal } });
  assert.deepEqual((await listDataCopies(dataDir)).map((copy) => copy.name), [good.name], "control: the real connection makes a good copy");
});

test("a copy is never put back under a Branch that has the data folder open; it waits for the real next start", async (t) => {
  const { start } = await fresh(t);
  const one = await start();
  const backup = await one.call("POST", "/api/deployment/backup");
  assert.equal((await one.call("POST", "/api/updates/data-copies", { name: backup.body.dataCopy })).status, 200);
  const early = await applyDataRestore(one.dataDir);
  assert.match(early?.failed ?? "", /Branch is running with this data folder/);
  assert.equal(await pendingDataRestore(one.dataDir), backup.body.dataCopy, "still asked for");
  assert.ok(await exists(join(one.dataDir, "branch.sqlite")), "nothing was moved from under it");
  assert.equal((await readdir(join(one.dataDir, "update-backups"))).some((name) => name.startsWith("replaced-")), false);
  await one.close();
  const two = await start();
  assert.equal((await two.call("GET", "/api/updates/data-copies")).body.last.name, backup.body.dataCopy, "put back at the real next start");
});
