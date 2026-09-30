/**
 * #484 (the lead's call): a backup carries the owner's Trunks, and a restore brings each back cut down, the way a Trunk
 * brought in from a file is: paused, look-only, no tool servers, no chat apps or commands, the owner's own keys. One
 * owner-only card, "Give <Trunk> back what it had", lists what it would regain; giving it back needs the owner's separate
 * yes (confirmLoosening) and is refused under Lockdown. A replacing restore leaves this computer's Trunks as they are.
 * Temp folders, a scripted model, the real routes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, setLockdown } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };
const had = { permissions: ["files.read", "files.write", "shell.execute"], mcpServers: ["notes-server"],
  reach: { channels: ["telegram"], commands: true }, keys: { copyFromOwner: false, accounts: { openai: "work" } } };

async function branch(t, served = false) {
  const root = await mkdtemp(join(tmpdir(), "branch-restore-trunks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = served ? await startServer(app, { dataDir: join(root, "data"), port: 0 }) : null;
  t.after(async () => { await server?.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server?.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  return { app, call };
}

/** A backup of a Branch with two Trunks that could do a lot, a team (governance too) and one unreadable Trunk row. */
async function backupWithTrunks(t) {
  const { app } = await branch(t);
  const helper = app.trunks.create({ name: "Helper" }), second = app.trunks.create({ name: "Second" });
  await app.trunks.introduced();
  app.trunks.records.put({ ...app.trunks.records.get(helper.id), ...had });
  app.trunks.records.put({ ...app.trunks.records.get(second.id), ...had, permissions: [] }); // [] is the owner's whole set
  app.store.save("governance", app.runtime.owner, "team:00000000-0000-4000-8000-000000000001", { name: "Team from the backup" });
  const snapshot = app.store.backup(app.version);
  snapshot.tables.governance.push({ ...snapshot.tables.governance.find((row) => row.id.startsWith("trunk:")),
    id: "trunk:00000000-0000-4000-8000-0000000000ff", data: "not json" });
  return { snapshot, helper, second };
}

const record = (app, id) => app.store.get("governance", app.runtime.owner, `trunk:${id}`)?.data;

test("a backup carries the Trunks and nothing else of governance; a restore brings them back cut down", async (t) => {
  const { snapshot, helper } = await backupWithTrunks(t);
  assert.deepEqual(snapshot.tables.governance.map((row) => row.id.split(":")[0]), ["trunk", "trunk", "trunk"], "only Trunk rows travel");
  const { app, call } = await branch(t, true);
  const done = await call("/api/restore", snapshot);
  assert.equal(done.status, 200, done.text);
  assert.equal(app.store.get("governance", app.runtime.owner, "team:00000000-0000-4000-8000-000000000001"), undefined, "no other governance row");
  assert.equal(record(app, "00000000-0000-4000-8000-0000000000ff"), undefined, "an unreadable Trunk row is left out");
  const cut = record(app, helper.id);
  assert.equal(cut.name, "Helper");
  assert.deepEqual(cut.permissions, ["files.read"], "look-only: its own reads");
  assert.deepEqual([cut.mcpServers, cut.reach, cut.keys, cut.paused], [[], { channels: [], commands: false, sandboxed: false }, { copyFromOwner: true, accounts: {} }, true]);
  const whole = record(app, snapshot.tables.governance.find((row) => JSON.parse(row.data).name === "Second").id.slice("trunk:".length));
  assert.ok(whole.permissions.length > 1 && whole.permissions.every((p) => p.endsWith(".read")), "a Trunk that named none gets every look, never the whole set");
  for (const reach of ["web.read", "browser.read", "research.read", "history.read"]) assert.equal(whole.permissions.includes(reach), false, `${reach} reaches past this computer`);
  const card = await call("/api/restore/trunks");
  const one = card.body.trunks.find((trunk) => trunk.id === helper.id);
  assert.equal(one.title, "Give Helper back what it had");
  for (const words of [/files\.write, shell\.execute/, /notes-server/, /telegram/, /commands/, /own sign-ins/, /openai: work/, /start work again/])
    assert.ok(one.regains.some((line) => words.test(line)), `${words} is listed`);
  assert.ok(card.body.trunks.find((trunk) => trunk.name === "Second").regains.some((line) => /every tool you allow/.test(line)));
  assert.equal(JSON.stringify(app.store.backup(app.version)).includes("restore-trunks-held"), false, "what waits never travels");
});

test("giving a Trunk back needs the owner's separate yes, is refused under Lockdown, and puts back exactly what it had", async (t) => {
  const { snapshot, helper, second } = await backupWithTrunks(t);
  const { app, call } = await branch(t, true);
  await call("/api/restore", snapshot);
  const before = JSON.stringify(record(app, helper.id));
  const unconfirmed = await call("/api/restore/trunks", { id: helper.id, answer: "give" });
  assert.equal(unconfirmed.status, 409);
  assert.match(unconfirmed.body.error, /less careful: Helper would use files\.write/);
  setLockdown(app.store, app.runtime.owner, { on: true });
  const locked = await call("/api/restore/trunks", { id: helper.id, answer: "give", confirmLoosening: true });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Lockdown is on/);
  assert.equal(JSON.stringify(record(app, helper.id)), before, "nothing given back");
  setLockdown(app.store, app.runtime.owner, { on: false });
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope, minutes: 5 }).token;
    assert.equal((await call("/api/restore/trunks", undefined, key)).status, 401, `${scope} key read`);
    assert.equal((await call("/api/restore/trunks", { id: helper.id, answer: "give", confirmLoosening: true }, key)).status, 401, `${scope} key gave`);
  }
  const given = await call("/api/restore/trunks", { id: helper.id, answer: "give", confirmLoosening: true });
  assert.equal(given.status, 200, given.text);
  const back = record(app, helper.id);
  assert.deepEqual([back.permissions, back.mcpServers, back.reach, back.keys, back.paused], [had.permissions, had.mcpServers, { ...had.reach, sandboxed: false }, had.keys, false]);
  assert.ok(app.store.audit.list(app.runtime.owner, { limit: 50 }).some((entry) => entry.action === "policy.changed" && /Helper/.test(entry.subject) && /files\.write/.test(entry.reason)));
  const kept = await call("/api/restore/trunks", { id: second.id, answer: "keep" });
  assert.deepEqual(kept.body.trunks, [], "nothing waits any more");
  assert.equal(record(app, second.id).paused, true, "kept as the restore brought it back");
  assert.equal((await call("/api/restore/trunks", { id: second.id, answer: "give", confirmLoosening: true })).status, 404, "a kept Trunk is not given back later");
});

test("a household profile can neither read nor answer the card", async (t) => {
  const { snapshot, helper } = await backupWithTrunks(t);
  const { app, call } = await branch(t, true);
  await call("/api/restore", snapshot);
  const sam = (await call("/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  for (const [path, body] of [["/api/restore/trunks", undefined], ["/api/restore/trunks", { id: helper.id, answer: "give", confirmLoosening: true }]]) {
    const refused = await call(path, body);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /belongs to the owner/);
  }
  assert.equal(record(app, helper.id).paused, true);
});

test("a replacing restore leaves this computer's Trunks and governance as they are", async (t) => {
  const { snapshot } = await backupWithTrunks(t);
  const { app } = await branch(t);
  const mine = app.trunks.create({ name: "Mine" });
  await app.trunks.introduced();
  app.store.save("governance", app.runtime.owner, "team:00000000-0000-4000-8000-000000000002", { name: "My team" });
  const before = JSON.stringify(record(app, mine.id));
  app.store.restore(snapshot, { replaceExisting: true });
  assert.equal(JSON.stringify(record(app, mine.id)), before);
  assert.ok(app.store.get("governance", app.runtime.owner, "team:00000000-0000-4000-8000-000000000002"), "the rest of governance stays");
  assert.deepEqual(app.trunks.records.list().map((trunk) => trunk.name), ["Mine"], "the backup's Trunks are not added over them");
});
