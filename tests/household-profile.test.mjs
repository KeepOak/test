/**
 * profile-audit: the app window switched to a household profile is that person.
 *
 * Every route tests/short-lived-key-routes.mjs calls "owner" (and every read it calls a secret) is
 * driven here with the window switched to somebody else's profile, and must meet the one sentence
 * src/server.ts answers at one place. The owner, switched back, must never meet it. A route added
 * later has to be put in that table first (tests/short-lived-keys.test.mjs fails until it is), and
 * then this file decides for it: "owner" is refused here without anybody writing a check, and
 * "other" fails here until src/household-routes.ts lists it as a person's own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, restoreBackup, offLimitsToHousehold, offLimitsToShortLivedKeys } from "../dist/server.js";
import { householdOwnRoutes, householdReads, householdRefusal, householdRefusalFor } from "../dist/household-routes.js";
import { runOrigin } from "../dist/key-context.js";
import { removalGuard, removePersonRefusal } from "../dist/remove-branch.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { ROUTES, SAMPLE_ID, entry } from "./short-lived-key-routes.mjs";

const concrete = (path) => path.replaceAll(":id", SAMPLE_ID);
const rows = Object.entries(ROUTES).map(([path, value]) => ({ path, ...entry(value) }));
/** The two ways out of a profile: they are "owner" rows, and a household person must still reach them.
    App lock: and unlocking with the PIN, the way back in, the PIN itself its guard (src/session-lock.ts). */
const WAYS_OUT = new Set(["POST /api/profiles/switch", "POST /api/lock", "POST /api/lock/unlock"]);
/** Reads a short-lived key is refused that answer a household person with a thinned view of their own. */
const VIEWS = new Set(["/api/voice/wake", "/api/voice/dictation", "/api/voice/dictation/listen"]);
/** Asked of the owner only through the rule, never over HTTP: they quit, restart, restore or remove Branch. */
const NOT_PRESSED_AS_OWNER = /quit|close|restart|remove-branch|restore|daemon|autostart|updates?\//;

/** Every change and secret read the table gives to the owner alone, as "METHOD path". */
function ownerOnly() {
  const found = [];
  for (const { path, kind, methods } of rows) {
    if (kind === "owner") for (const method of methods) found.push({ method, path });
    if (kind === "secret-read" && !VIEWS.has(path)) found.push({ method: "GET", path });
  }
  return found.filter(({ method, path }) => !WAYS_OUT.has(`${method} ${path}`));
}

test("the rule: every owner-only route in the table is refused to a household profile, in one sentence", () => {
  const through = ownerOnly().filter(({ method, path }) => offLimitsToHousehold(method, concrete(path)) !== householdRefusalFor(path))
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(through, [], "these owner-only routes are open to a household profile");
  for (const way of WAYS_OUT) {
    const [method, path] = way.split(" ");
    assert.equal(offLimitsToHousehold(method, path), null, `${way} is how a household person gets out`);
  }
  // A route nobody has written yet is the owner's too: the rule fails closed.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(offLimitsToHousehold(method, "/api/some-new-settings"), householdRefusal);
});

test("the rule: a household person keeps their own things and the task routes; every read fails closed (Q261)", () => {
  const refused = [], through = [];
  const listed = (at) => householdReads.some((entry) => entry.pattern.test(at));
  for (const { path, kind, methods } of rows) {
    if (kind === "prefix" || kind === "pre-auth") continue;
    const at = concrete(path);
    for (const method of methods.filter((one) => one !== "GET"))
      if ((kind === "other" || kind === "task") && offLimitsToHousehold(method, at) !== null
        && (kind === "other" || offLimitsToShortLivedKeys(method, at) === null)) refused.push(`${method} ${path} (${kind})`);
    // Q261: a read is a household person's only when src/household-routes.ts lists it; every other read, a plain
    // "look" included, meets the one sentence. HEAD is never listed.
    const answer = offLimitsToHousehold("GET", at);
    if (listed(at) ? answer !== null : answer !== householdRefusalFor(path)) through.push(`GET ${path} (${kind}) → ${answer}`);
    if (offLimitsToHousehold("HEAD", at) !== householdRefusalFor(path)) through.push(`HEAD ${path}`);
  }
  for (const path of VIEWS) if (offLimitsToHousehold("GET", path) !== null) refused.push(`GET ${path} (view)`);
  assert.deepEqual(refused, [], "a household person's own things are refused; list them in src/household-routes.ts");
  assert.deepEqual(through, [], "a read is answered unlike src/household-routes.ts says");
  // A read nobody has written yet is the owner's too.
  assert.equal(offLimitsToHousehold("GET", "/api/some-new-read"), householdRefusal);
  assert.equal(offLimitsToHousehold(undefined, "/api/some-new-read"), householdRefusal);
});

test("the list: nothing in src/household-routes.ts is an owner-only route, and nothing in it is stale", () => {
  const owners = ownerOnly();
  for (const route of householdOwnRoutes) {
    const theirs = rows.filter(({ path, kind, methods }) => route.pattern.test(concrete(path)) && methods.includes(route.method)
      && (kind === "other" || WAYS_OUT.has(`${route.method} ${path}`)));
    assert.ok(theirs.length, `${route.method} ${route.pattern} matches no "other" row in the table`);
    const owner = owners.find(({ method, path }) => method === route.method && route.pattern.test(concrete(path)));
    assert.equal(owner, undefined, `${route.method} ${route.pattern} lets a household person reach an owner-only route`);
  }
  // Q261: each listed read names at least one row of the table, and none is a secret read except the thinned views
  // and the household's signed events, which a short-lived key is refused but a household person reads as their own.
  for (const entry of householdReads) {
    const matched = rows.filter(({ path, kind }) => kind !== "prefix" && entry.pattern.test(concrete(path)));
    assert.ok(matched.length, `${entry.pattern} matches no row in the table`);
    for (const { path, kind } of matched)
      assert.ok(kind !== "secret-read" || VIEWS.has(path) || path === "/api/collab/events", `${entry.pattern} reads ${path}, a secret read`);
  }
});

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-household-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  const toSam = async () => assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const back = async () => assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  return { app, call, sam, toSam, back };
}

test("the restore operation carries its owner guard when it moves out of the HTTP dispatcher", async (t) => {
  const { app, toSam } = await served(t);
  const backup = app.store.backup(app.version);
  await toSam();

  await assert.rejects(
    restoreBackup(app, async () => backup, true),
    /belongs to the owner/,
  );
});

test("generated over HTTP: the window switched to a household profile meets the one sentence on every owner-only route", async (t) => {
  const { app, call, toSam, back } = await served(t);
  await toSam();
  const through = [];
  for (const { method, path } of ownerOnly()) {
    const answer = await call(method, concrete(path));
    if (answer.status !== 400 || answer.body.error !== householdRefusalFor(path)) through.push(`${method} ${path} → ${answer.status} ${answer.body.error ?? ""}`.slice(0, 160));
  }
  assert.deepEqual(through, [], "a household profile got through");
  assert.equal(app.store.profiles.isOwner(), false, "something switched the window back on the way");
  // The way out still works, with no PIN, and locking the window is still theirs.
  assert.equal((await call("POST", "/api/lock")).status, 200);
  await back();
  assert.equal(app.store.profiles.isOwner(), true);
});

test("generated over HTTP: the owner, switched back, never meets the household sentence", async (t) => {
  const { app, call, toSam, back } = await served(t);
  await toSam();
  await back();
  // The routes that quit, restart, restore or remove Branch are not pressed here. They cannot meet the
  // household sentence either: src/server.ts only asks offLimitsToHousehold while the window is not
  // the owner's, and it is the owner's again now.
  assert.equal(app.store.profiles.isOwner(), true);
  assert.ok(ownerOnly().some(({ path }) => NOT_PRESSED_AS_OWNER.test(path)), "the skip list still names real routes");
  const refused = [];
  for (const { method, path } of ownerOnly()) {
    if (NOT_PRESSED_AS_OWNER.test(path)) continue;
    const answer = await call(method, concrete(path));
    if (/belongs to the owner/.test(answer.body.error ?? "")) refused.push(`${method} ${path}`);
  }
  assert.deepEqual(refused, [], "the owner was refused their own routes");
});

test("a task the window starts for a household profile is written down as theirs, and removing Branch refuses it", async (t) => {
  const { app, call, sam, toSam, back } = await served(t);
  await toSam();
  const started = await call("POST", "/api/run", { prompt: "say hello" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await back();
  // Switching back does not make Sam's task the owner's: tools that ask where a task came from see Sam.
  assert.equal(runOrigin(app.store, started.body.id).personProfileId, sam.id);
  assert.equal(removalGuard(app.store, { runId: started.body.id }), removePersonRefusal);
  // The owner's own task is nobody else's.
  const own = await call("POST", "/api/run", { prompt: "say hello" });
  assert.equal(runOrigin(app.store, own.body.id).personProfileId, null);
  assert.equal(removalGuard(app.store, { source: "owner" }), null);
  // The window's switch, handed to the removal guard the way the server hands it, refuses.
  assert.equal(removalGuard(app.store, { source: "owner", person: sam.id }), removePersonRefusal);
});

/* ---------- household-followups ---------- */

/** A Branch whose model writes a.txt on its first round, after `midway` has run (a switch of the window). */
async function writer(t, midway) {
  const root = await mkdtemp(join(tmpdir(), "branch-household-task-"));
  let round = 0;
  const provider = { name: "scripted", async complete() {
    round += 1;
    if (round > 1) return { content: "Done.", toolCalls: [] };
    await midway();
    return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) }] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const written = () => readFile(join(root, "workspace", "a.txt"), "utf8").then(() => true, () => false);
  return { app, written, reset: () => { round = 0; } };
}

test("a task keeps its person's role when the window is switched back to the owner halfway through", async (t) => {
  let app;
  const { app: made, written } = await writer(t, async () => { app.store.profiles.switch({ profileId: null }); });
  app = made;
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "child" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const run = await runForCurrentPerson(app, { prompt: "write a.txt" });
  assert.equal(app.store.profiles.isOwner(), true, "the window was switched back during the task");
  assert.equal(runOrigin(app.store, run.id).personProfileId, sam.id);
  assert.equal(await written(), false, "the child's task wrote a file once the window was the owner's again");
  const refused = JSON.stringify(app.store.events(run.id));
  assert.match(refused, /Sam is set up as \\"Child\\" here/);
});

test("the owner's task is not held to a person's role when the window is switched to them halfway through", async (t) => {
  let app, sam;
  const { app: made, written } = await writer(t, async () => { app.store.profiles.switch({ profileId: sam.id, pin: "2468" }); });
  app = made;
  sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "child" });
  const run = await app.runtime.run({ prompt: "write a.txt" });
  assert.equal(app.store.profiles.isOwner(), false);
  assert.equal(runOrigin(app.store, run.id).personProfileId, null);
  assert.equal(await written(), true, "the owner's own task was held to the child's role");
});

test("a task whose person is removed while it runs is refused the rest of its tools", async (t) => {
  let app, sam;
  const { app: made, written } = await writer(t, async () => {
    app.store.profiles.switch({ profileId: null });
    app.store.profiles.remove(sam.id);
  });
  app = made;
  sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const run = await runForCurrentPerson(app, { prompt: "write a.txt" });
  assert.equal(await written(), false);
  assert.match(JSON.stringify(app.store.events(run.id)), /no longer on this computer/);
});

test("reclassified: a person's imports land in their own profile, and the owner's housekeeping is refused them", async (t) => {
  const { app, call, sam, toSam, back } = await served(t);
  await toSam();
  for (const path of ["/api/retention/prune", "/api/usage/metering/now", "/api/brief/send", "/api/history/restore"]) {
    const answer = await call("POST", path, {});
    assert.equal(answer.status, 400, path);
    assert.equal(answer.body.error, householdRefusal, path);
  }
  const imported = await call("POST", "/api/memory/import", { jsonl: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", data: { text: "Sam likes tea" } }) });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  await back();
  assert.equal(app.store.list("memory", app.runtime.owner).some((record) => /Sam likes tea/.test(JSON.stringify(record.data))), false,
    "a person's import reached the owner's memory");
  const theirs = app.store.list("memory", `profile:${sam.id}`);
  assert.ok(theirs.some((record) => /Sam likes tea/.test(JSON.stringify(record.data))), JSON.stringify(imported.body));
});

test("the owner's PIN for switching back: off by default, then checked like a person's PIN", async (t) => {
  const { app, call, toSam, back } = await served(t);
  assert.equal((await call("GET", "/api/profiles")).body.ownerPin, false, "it ships off");
  await toSam();
  await back(); // no PIN while it is off
  assert.equal((await call("POST", "/api/profiles/owner-pin", { pin: "12" })).status, 400, "four to eight digits");
  assert.deepEqual((await call("POST", "/api/profiles/owner-pin", { pin: "9753" })).body, { ownerPin: true });
  assert.equal((await call("GET", "/api/profiles")).body.ownerPin, true);

  await toSam();
  // A household person may not change it or switch it off.
  const change = await call("POST", "/api/profiles/owner-pin", { pin: null });
  assert.equal(change.status, 400);
  assert.equal(change.body.error, householdRefusal);
  // Going back now asks for it, in the same words a person's PIN uses, with the same lockout.
  const bare = await call("POST", "/api/profiles/switch", { profileId: null });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.error, "That PIN is not right");
  for (let i = 0; i < 4; i += 1) await call("POST", "/api/profiles/switch", { profileId: null, pin: "0000" });
  const held = await call("POST", "/api/profiles/switch", { profileId: null, pin: "9753" });
  assert.equal(held.body.error, "Too many wrong PINs. Wait a few minutes and try again.", "the right PIN during the wait");
  assert.equal(app.store.profiles.isOwner(), false);
  const later = app.store.profiles.now() + 300001;
  app.store.profiles.now = () => later;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null, pin: "9753" })).status, 200);
  assert.equal(app.store.profiles.isOwner(), true);
  // Switching to somebody asks for their PIN, never the owner's; switching off again needs none back.
  await toSam();
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null, pin: "9753" })).status, 200);
  assert.deepEqual((await call("POST", "/api/profiles/owner-pin", { pin: null })).body, { ownerPin: false });
  await toSam();
  await back();
});

test("the owner's PIN for switching back: a restart comes back on the person's profile, and only while it is set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-household-restart-"));
  t.after(() => discardTemp(root));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  let app = await open();
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  await app.close();
  app = await open();
  assert.equal(app.store.profiles.isOwner(), true, "with no owner PIN a restart is the owner, as it always was");
  app.store.profiles.setOwnerPin({ pin: "9753" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  await app.close();
  app = await open();
  assert.equal(app.store.profiles.active()?.id, sam.id, "closing and reopening Branch was a way back to the owner");
  assert.throws(() => app.store.profiles.switch({ profileId: null }), /That PIN is not right/);
  app.store.profiles.switch({ profileId: null, pin: "9753" });
  await app.close();
  app = await open();
  assert.equal(app.store.profiles.isOwner(), true);
  await app.close();
});
