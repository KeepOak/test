/**
 * unhold/people: the window's person controls (switching person, PINs, roles, invites, pinned settings) are live now,
 * so this shows the engine's guards still stand behind them, over HTTP, exactly as the window calls them:
 *   - switching to a person needs that person's PIN, and back to the owner needs the owner's PIN once it is set;
 *   - a household person at the window cannot invite, change a role, set anybody's PIN, pin a setting, change who may
 *     sign in from other devices or confirm a waiting account;
 *   - a short-lived key can do none of these, nor switch;
 *   - a waiting account is confirmed once, and one that is not waiting never (the engine sets no time limit on them);
 *   - a PIN never comes back in a response, the audit record, the engine's output or the data folder.
 * Each test names the mutation that turns it red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const SAM_PIN = "80417263", KID_PIN = "61937045", OWNER_PIN = "59302718", NEW_PIN = "47182930";
const PINS = [SAM_PIN, KID_PIN, OWNER_PIN, NEW_PIN];

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-unhold-people-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const bodies = [];
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => {
    const text = await response.text();
    bodies.push(`${method} ${path} → ${text}`);
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed };
  });
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: SAM_PIN, role: "adult" })).body;
  const kid = (await call("POST", "/api/profiles", { name: "Kid", pin: KID_PIN, role: "child" })).body;
  const active = async () => (await call("GET", "/api/profiles")).body.active?.id ?? null;
  // An account found by its email, waiting for the owner (what an identity service's sign-in leaves, src/people/index.ts).
  const waiting = { provider: "family-sso", profileId: kid.id, subject: "sub-kid-1", email: "kid@example.com" };
  app.store.save("settings", app.runtime.owner, "people-oidc-waiting", { waiting: [{ ...waiting, at: new Date().toISOString() }] });
  return { app, server, call, sam, kid, active, bodies, dataDir, waiting };
}

/* Mutation: src/profiles.ts switch() without `this.verifyPin(...)` (switching straight in) → red. */
test("switching to a person without their PIN, or with a wrong one, is refused and nobody is switched", async (t) => {
  const { call, sam, active } = await served(t);
  for (const body of [{ profileId: sam.id }, { profileId: sam.id, pin: "0000" }, { profileId: sam.id, pin: KID_PIN }]) {
    const refused = await call("POST", "/api/profiles/switch", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.body.error, /PIN is not right/);
    assert.equal(await active(), null, "the window stayed the owner's");
  }
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: SAM_PIN })).status, 200);
  assert.equal(await active(), sam.id);
});

/* Mutation: src/profiles.ts switch() without the `verifyOwnerPin(...)` line → red. */
test("with the owner's PIN set, going back to the owner needs it, and five wrong tries lock it", async (t) => {
  const { call, sam, active } = await served(t);
  assert.equal((await call("POST", "/api/profiles/owner-pin", { pin: OWNER_PIN })).body.ownerPin, true);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: SAM_PIN })).status, 200);
  for (const body of [{ profileId: null }, { profileId: null, pin: SAM_PIN }]) {
    const refused = await call("POST", "/api/profiles/switch", body);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /PIN is not right/);
    assert.equal(await active(), sam.id, "still Sam");
  }
  for (let i = 0; i < 3; i++) await call("POST", "/api/profiles/switch", { profileId: null, pin: "1111" });
  const locked = await call("POST", "/api/profiles/switch", { profileId: null, pin: OWNER_PIN });
  assert.match(locked.body.error, /Too many wrong PINs/, "the right PIN waits out the lockout too");
  assert.equal(await active(), sam.id);
});

/* Review 2 (#353): the lockout guards a person's PIN too, not only the owner's. Mutation: src/profiles.ts
   checkNotLockedOut() never locks → red. */
test("five wrong tries at a person's PIN lock switching to them, even with the right PIN", async (t) => {
  const { call, sam, active } = await served(t);
  for (let i = 0; i < 5; i++) await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "0000" });
  const locked = await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: SAM_PIN });
  assert.equal(locked.status, 400);
  assert.match(locked.body.error, /Too many wrong PINs/, "the right PIN waits out the lockout too");
  assert.equal(await active(), null, "the window stayed the owner's");
});

/* What the household person and the short-lived key both try: every owner-only person control the window has. */
function attempts(sam, kid, waiting) {
  return [
    ["POST", "/api/people/settings", { mode: "on" }],
    ["POST", "/api/people/settings", { chain: ["passkey"], sessionMinutes: 60 }],
    ["POST", "/api/people/links/confirm", { provider: waiting.provider, profileId: waiting.profileId, subject: waiting.subject }],
    ["POST", "/api/profiles", { name: "Intruder", pin: NEW_PIN, role: "adult" }],
    ["POST", `/api/profiles/${kid.id}/role`, { role: "adult" }],
    ["POST", `/api/profiles/${sam.id}/role`, { role: "owner" }],
    ["POST", "/api/profiles/owner-pin", { pin: NEW_PIN }],
    ["POST", "/api/profiles/owner-pin", { pin: null }],
    ["POST", `/api/profiles/${kid.id}/remove`, {}],
    ["POST", `/api/people/${kid.id}/reset-code`, {}],
    ["POST", `/api/people/${kid.id}/sign-out`, {}],
    ["POST", "/api/people/me/pin", { current: SAM_PIN, pin: NEW_PIN }],
    ["POST", "/api/settings-kit/pins", { key: "loop_guard", field: "mode", pinned: true }],
  ];
}

/* Everything the attempts could have changed, read as the owner. */
async function snapshot(app) {
  const p = app.store.profiles;
  return JSON.stringify({ list: p.list().map((x) => [x.id, x.name]), ownerPin: p.ownerPinOn(),
    roles: app.runtime.roles.all(p.list().map((x) => x.id)).map((r) => [r.profileId, r.grant.role]),
    signIn: app.people.settings(), waiting: app.people.suggestions().map((w) => w.subject) });
}

/* Every one of these routes has two locks: the household table (src/household-routes.ts) and the route's own requireOwner.
   Mutation: list own("/api/profiles/owner-pin") in householdOwnRoutes AND drop setOwnerPin's requireOwner → red.
   (Either lock alone keeps this green; listing own("/api/settings-kit/pins") alone is caught by settings-kit's own check.) */
test("a household person at the window can't invite, change roles, set anybody's PIN, pin a setting, change who may sign in or confirm a link", async (t) => {
  const { app, call, sam, kid, active, waiting } = await served(t);
  const kitBefore = JSON.stringify((await call("GET", "/api/settings-kit")).body.pins);
  const before = await snapshot(app);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: SAM_PIN })).status, 200);
  const through = [];
  for (const [method, path, body] of attempts(sam, kid, waiting)) {
    const answer = await call(method, path, body);
    if (answer.status < 400 || !/belongs to the owner/.test(answer.body.error ?? "")) through.push(`${method} ${path} → ${answer.status} ${answer.body.error ?? ""}`);
  }
  assert.deepEqual(through, [], "a household person got through");
  // Sam can't step into Kid's profile without Kid's PIN either.
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: kid.id, pin: SAM_PIN })).status, 400);
  assert.equal(await active(), sam.id);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  assert.equal(await snapshot(app), before, "nothing changed");
  assert.equal(JSON.stringify((await call("GET", "/api/settings-kit")).body.pins), kitBefore, "no setting was pinned");
  // Kid's PIN is still the one the owner set.
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: kid.id, pin: KID_PIN })).status, 200);
});

/* Mutation: src/short-lived-keys.ts adding { method: "POST", pattern: /^\/api\/profiles\/switch$/ } to the task routes
   (or /^\/api\/profiles$/) → red. */
test("a short-lived key can't switch person, invite, change roles, set a PIN, pin a setting, change who may sign in or confirm a link", async (t) => {
  const { app, call, sam, kid, active, waiting } = await served(t);
  const keys = [app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token,
    app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token];
  const before = await snapshot(app);
  const through = [];
  for (const key of keys) {
    const tries = [...attempts(sam, kid, waiting), ["POST", "/api/profiles/switch", { profileId: sam.id, pin: SAM_PIN }]];
    for (const [method, path, body] of tries) {
      const answer = await call(method, path, body, key);
      if (answer.status !== 401) through.push(`${method} ${path} → ${answer.status}`);
    }
  }
  assert.deepEqual(through, [], "a short-lived key got through");
  assert.equal(await active(), null, "the window is still the owner's");
  assert.equal(await snapshot(app), before, "nothing changed");
});

/* Mutation: src/people/index.ts confirmSuggestion() without its writeSuggestions(...) line (the account stays waiting) → red. */
test("a waiting account is confirmed once by the owner, and one that is not waiting never", async (t) => {
  const { app, call, waiting } = await served(t);
  const body = { provider: waiting.provider, profileId: waiting.profileId, subject: waiting.subject };
  const made = await call("POST", "/api/people/links/confirm", { ...body, subject: "sub-somebody-else" });
  assert.equal(made.status, 400);
  assert.match(made.body.error, /Nothing like that is waiting/);
  const first = await call("POST", "/api/people/links/confirm", body);
  assert.equal(first.status, 200);
  assert.ok(first.body.settings.links.some((l) => l.subject === waiting.subject && l.profileId === waiting.profileId), "linked");
  assert.deepEqual(first.body.waiting, [], "no longer waiting");
  const again = await call("POST", "/api/people/links/confirm", body);
  assert.equal(again.status, 400, "the same account cannot be confirmed twice");
  assert.equal(app.people.settings().links.filter((l) => l.subject === waiting.subject).length, 1);
});

async function everyFile(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) found.push(...await everyFile(full));
    else found.push(full);
  }
  return found;
}

/* Mutations: src/collab-server.ts writing the PIN into the "added" audit subject (`${made.name} ${person.pin}`) → red;
   the role route without its audit() call → red. */
test("adding somebody and changing a role are recorded, and a PIN never appears in any response, the audit record, the engine's output or the data folder", async (t) => {
  const written = [];
  const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return out(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return err(chunk, ...rest); };
  t.after(() => { process.stdout.write = out; process.stderr.write = err; });
  const { app, call, sam, kid, bodies, dataDir } = await served(t);
  await call("POST", "/api/profiles/owner-pin", { pin: OWNER_PIN });
  await call("POST", `/api/profiles/${kid.id}/role`, { role: "adult" });
  await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "0000" });
  await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: SAM_PIN });
  await call("POST", "/api/profiles/switch", { profileId: null, pin: "1234" });
  await call("POST", "/api/profiles/switch", { profileId: null, pin: OWNER_PIN });
  await call("POST", "/api/profiles", { name: "Kid", pin: NEW_PIN }); // refused: the name is taken
  for (const path of ["/api/profiles", "/api/collab", "/api/people/settings", "/api/audit?limit=1000", "/api/state"]) await call("GET", path);
  const audit = (await call("GET", "/api/audit?limit=1000")).body.entries;
  // The record says who was added, whose role changed and every switch, in words.
  const subjects = audit.map((e) => `${e.action} ${e.subject} ${e.outcome}`);
  assert.ok(subjects.some((s) => /policy\.changed Sam's profile added/.test(s)), "adding somebody is recorded");
  assert.ok(subjects.some((s) => /policy\.changed Kid's role saved/.test(s)), "a role change is recorded");
  assert.ok(subjects.some((s) => /profile\.switched/.test(s)), "a switch is recorded");
  app.store.backup?.(app.version);
  const files = [];
  for (const file of await everyFile(dataDir)) files.push([file, (await readFile(file)).toString("latin1")]);
  const leaks = [];
  for (const pin of PINS) {
    bodies.forEach((b) => { if (b.includes(pin)) leaks.push(`response: ${b.slice(0, 120)}`); });
    if (JSON.stringify(audit).includes(pin)) leaks.push(`audit: ${pin}`);
    written.forEach((w) => { if (w.includes(pin)) leaks.push(`output: ${w.slice(0, 120)}`); });
    for (const [file, text] of files) if (text.includes(pin)) leaks.push(`file: ${file}`);
  }
  assert.deepEqual(leaks, [], "a PIN leaked");
});
