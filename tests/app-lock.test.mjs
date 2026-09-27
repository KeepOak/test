/**
 * App lock: the PIN that opens a locked Branch (src/session-lock.ts, the gate in src/server.ts).
 * A scripted model; no provider, no window. Each case names the change to the engine that turns it red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { agentSections, openAgent } from "../dist/agent-export.js";

/** Distinctive, so a search for it cannot hit an id, a time or a count by chance. */
const PIN = "730461";
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function open(root) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const raw = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const call = (method, path, body, key) => raw(method, path, body, key).then(async (response) => {
    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = {}; }
    return { status: response.status, body: json, text };
  });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await server.close(); await app.close(); };
  return { app, server, call, close };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-app-lock-"));
  const opened = await open(root);
  const all = [opened];
  let clock = Date.now();
  opened.app.sessionLock.now = () => clock;
  t.after(async () => { for (const one of all) await one.close(); await discardTemp(root); });
  /** Quits this Branch and opens the same saved work again, as reopening the app does. */
  const reopen = async () => { await opened.close(); const again = await open(root); all.push(again); return again; };
  return { ...opened, reopen, step: (ms) => { clock += ms; }, at: () => clock };
}

async function withPin(t) {
  const it = await served(t);
  assert.equal((await it.call("POST", "/api/lock/pin", { pin: PIN })).status, 200);
  return it;
}

// Mutation: in SessionLock.checkPin, make the hash comparison always true (accept any PIN) → the wrong PIN unlocks, red.
test("a wrong PIN is refused, and the right one unlocks", async (t) => {
  const { call } = await withPin(t);
  assert.equal((await call("POST", "/api/lock")).body.locked, true);
  const wrong = await call("POST", "/api/lock/unlock", { pin: "111111" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, "That PIN is not right");
  const none = await call("POST", "/api/lock/unlock", {});
  assert.equal(none.status, 400, "no PIN at all is refused too");
  assert.equal((await call("GET", "/api/lock")).body.locked, true, "still locked after the wrong tries");
  const right = await call("POST", "/api/lock/unlock", { pin: PIN });
  assert.equal(right.status, 200);
  assert.equal(right.body.locked, false);
  assert.equal((await call("GET", "/api/state")).status, 200);
});

// Mutation: change `wrong % maximumUnlockTries !== 0` to `true` (never wait) → the sixth try is not 429, red.
// Mutation: make the `wait_until > now` check never hold → the right PIN unlocks during the wait, red.
test("rate limiting: the fifth wrong try starts a wait that holds the right PIN too, grows, and outlives a restart", async (t) => {
  const it = await withPin(t);
  await it.call("POST", "/api/lock");
  for (let i = 1; i <= 4; i++) assert.equal((await it.call("POST", "/api/lock/unlock", { pin: "000000" })).status, 403, `try ${i}`);
  const fifth = await it.call("POST", "/api/lock/unlock", { pin: "000000" });
  assert.equal(fifth.status, 429);
  assert.match(fifth.body.error, /^Too many wrong PINs\. Wait 5 minutes and try again\.$/);
  const held = await it.call("POST", "/api/lock/unlock", { pin: PIN });
  assert.equal(held.status, 429, "the right PIN waits as well");
  const audit = await it.app.store.audit.list(it.app.runtime.owner, {});
  assert.ok(audit.some((e) => e.action === "auth.refused" && e.subject === "the App lock PIN"), "the wait is on the record");
  // Quitting and reopening does not start the count again.
  const again = await it.reopen();
  const clock = it.at();
  again.app.sessionLock.now = () => clock;
  await again.call("POST", "/api/lock");
  assert.equal((await again.call("POST", "/api/lock/unlock", { pin: PIN })).status, 429, "the wait outlived the restart");
  // After the wait, five more wrong tries wait twice as long.
  let later = clock + 5 * 60_000 + 1;
  again.app.sessionLock.now = () => later;
  for (let i = 1; i <= 4; i++) assert.equal((await again.call("POST", "/api/lock/unlock", { pin: "000000" })).status, 403);
  assert.match((await again.call("POST", "/api/lock/unlock", { pin: "000000" })).body.error, /Wait 10 minutes/);
  later += 10 * 60_000 + 1;
  assert.equal((await again.call("POST", "/api/lock/unlock", { pin: PIN })).status, 200);
});

// Mutation: delete the `lockedOut` check in src/server.ts → GET /api/state answers 200 while locked, red.
// Mutation: delete both `if (refusedLocked()) return;` lines in the upgrade handler → the task socket opens (101), red.
test("owner routes are refused while locked; only the lock's status and unlock are answered", async (t) => {
  const { call, server } = await withPin(t);
  const run = await call("POST", "/api/run", { prompt: "hello" });
  assert.equal(run.status, 200);
  const runId = run.body.id ?? run.body.run?.id;
  assert.match(runId, /^[a-f0-9-]{36}$/);
  await call("POST", "/api/lock");
  const refused = [];
  for (const [method, path, body] of [["GET", "/api/state"], ["GET", "/api/sessions"], ["GET", "/api/backup"], ["GET", "/api/audit"],
    ["POST", "/api/lock/settings", { idleMinutes: 0, secretsWhileLocked: true, lockOnOpen: false }], ["POST", "/api/lock/pin", { pin: null, current: PIN }],
    ["POST", "/api/profiles/switch", { profileId: null }], ["POST", "/api/run", { prompt: "hello" }], ["POST", "/api/tokens", { name: "x", scope: "run", minutes: 5 }]]) {
    const answer = await call(method, path, body);
    if (answer.status !== 423 || answer.body.error !== "Branch is locked. Unlock it with your PIN first.") refused.push(`${method} ${path} → ${answer.status}`);
  }
  assert.deepEqual(refused, [], "these answered while locked");
  const status = await call("GET", "/api/lock");
  assert.equal(status.status, 200);
  assert.equal(status.body.locked, true);
  assert.equal(status.body.pinSet, true);
  assert.equal((await call("GET", "/api/alive")).status, 200, "alive answers, for the update's self-test");
  assert.equal((await call("GET", "/api/health")).status, 200, "health answers, for the update's self-test");
  // Closing loosens nothing: both closing routes reach their own checks (this computer's own key, and
  // here no quit handler and no background engine), rather than the lock.
  for (const path of ["/api/deployment/quit", "/api/deployment/close"]) assert.notEqual((await call("POST", path, {})).status, 423, path);
  // A task's socket is refused as well, once its key has passed.
  const upgrade = await new Promise((resolve, reject) => {
    const req = request(server.url + `/api/runs/${runId}/ws`, {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
        "sec-websocket-protocol": `bearer, ${server.token}` },
    });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("upgrade", () => resolve(101));
    req.on("error", reject);
    req.end();
  });
  assert.equal(upgrade, 423);
});

// Mutation: make touch() `if (this.lockedAt === null) this.lastActive = this.now();` for a PIN too, and move the gate after it
// → the first POST after the quiet period restarts it and is answered, red.
test("the quiet period locks by itself, and a request after it cannot start it again", async (t) => {
  const { call, step } = await withPin(t);
  assert.equal((await call("POST", "/api/lock/settings", { idleMinutes: 15, secretsWhileLocked: false, lockOnOpen: false })).status, 200);
  step(14 * 60_000);
  assert.equal((await call("POST", "/api/lock/settings", { idleMinutes: 15, secretsWhileLocked: false, lockOnOpen: false })).status, 200, "still awake at 14 minutes");
  step(15 * 60_000);
  const after = await call("POST", "/api/lock/settings", { idleMinutes: 0, secretsWhileLocked: true, lockOnOpen: false });
  assert.equal(after.status, 423);
  assert.equal((await call("GET", "/api/lock")).body.idleMinutes, 15, "the refused change was not made");
});

// Mutation: make the stream's scopeNow `() => app.store.profiles.scope()` again → the open stream keeps going, red.
test("a stream opened before the lock ends when Branch locks", async (t) => {
  const { call, server } = await withPin(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(server.url + "/api/events/stream", { headers: { authorization: `Bearer ${server.token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  await call("POST", "/api/lock");
  const reader = response.body.getReader();
  let text = "", done = false;
  const until = Date.now() + 10_000;
  while (!done && Date.now() < until) ({ done } = await reader.read().then((r) => { if (r.value) text += Buffer.from(r.value).toString(); return r; }));
  assert.equal(done, true, "the stream ended");
});

// Mutation: add "/api/lock/unlock" to the task allowlist in src/short-lived-keys.ts → a run key unlocks, red.
test("a short-lived key cannot unlock, set or remove the lock", async (t) => {
  const { app, call } = await withPin(t);
  const keys = ["read", "run"].map((scope) => app.sessionTokens.create(app.runtime.owner, { name: scope, scope, minutes: 5 }).token);
  await call("POST", "/api/lock");
  for (const key of keys) {
    for (const [path, body] of [["/api/lock/unlock", { pin: PIN }], ["/api/lock/pin", { pin: "1234", current: PIN }], ["/api/lock/pin", { pin: null, current: PIN }]]) {
      const answer = await call("POST", path, body, key);
      assert.equal(answer.status, 401, `${path} with a key`);
      assert.match(answer.body.error, /short-lived key/);
    }
  }
  assert.equal((await call("GET", "/api/lock")).body.locked, true);
  assert.equal(app.sessionLock.pinSet(), true);
  // And unlocked, a key still cannot change it.
  await call("POST", "/api/lock/unlock", { pin: PIN });
  for (const key of keys) assert.equal((await call("POST", "/api/lock/pin", { pin: null, current: PIN }, key)).status, 401);
  assert.equal(app.sessionLock.pinSet(), true);
});

// Mutation: store the PIN beside its settings (`this.store.save("settings", …, { pin })`) or echo it in state()
// → the search below finds it, red.
test("the PIN is absent from every answer, the record, the backup and the saved rows", async (t) => {
  const { app, call } = await withPin(t);
  const texts = [];
  const bad = await call("POST", "/api/lock/pin", { pin: `${PIN}x`, current: PIN });
  assert.equal(bad.status, 400);
  texts.push(bad.text);
  texts.push((await call("POST", "/api/lock/pin", { pin: "4826", current: PIN })).text);
  texts.push((await call("POST", "/api/lock/pin", { pin: PIN, current: "4826" })).text);
  const exports = ["/api/lock", "/api/state", "/api/backup", "/api/audit", "/api/audit/export.csv", "/api/logs", "/api/diagnostics/log", "/api/settings-kit",
    "/api/settings-kit/export", "/api/log/export", "/api/memory/export", "/api/usage/export.csv", "/api/prompts/export", "/api/skill-installs/export", "/api/knowledge/export"];
  const answered = [];
  for (const path of exports) {
    const answer = await call("GET", path);
    texts.push(answer.text);
    if (answer.status === 200) answered.push(path);
  }
  for (const path of ["/api/backup", "/api/settings-kit/export", "/api/audit/export.csv", "/api/log/export", "/api/memory/export"])
    assert.ok(answered.includes(path), `${path} answered, so its absence of the PIN means something`);
  texts.push((await call("POST", "/api/diagnostics/report", {})).text);
  // The whole-assistant file (Settings › Export all), every part ticked, opened as the app opens it.
  const whole = await call("POST", "/api/agent-export", { sections: [...agentSections] });
  assert.equal(whole.status, 200, whole.text.slice(0, 200));
  texts.push(JSON.stringify([...openAgent(Buffer.from(whole.body.data, "base64")).files]));
  texts.push(JSON.stringify(app.store.backup(app.version)));
  texts.push(JSON.stringify(app.store.sqlite.prepare("SELECT * FROM settings").all()));
  texts.push(JSON.stringify(app.store.sqlite.prepare("SELECT owner, salt, hex(pin_hash) AS h FROM app_lock_pin").all()));
  for (const [i, text] of texts.entries()) {
    assert.equal(text.includes(PIN), false, `answer ${i} carries the PIN`);
    assert.equal(text.includes("4826"), false, `answer ${i} carries the second PIN`);
  }
  const reasons = app.store.audit.list(app.runtime.owner, {}).filter((e) => e.action === "lock.changed").map((e) => e.reason).sort();
  assert.deepEqual(reasons, ["An App lock PIN was set", "The App lock PIN was changed", "The App lock PIN was changed"], "set, changed and changed back are on the record");
  assert.equal(Object.keys(app.store.backup(app.version).tables).includes("app_lock_pin"), false, "the hash's table is not in a backup");
});

// Mutation: drop the `if (had) { … checkPin(current) }` block in setPin → removing without the PIN succeeds, red.
test("removing or changing the lock needs the current PIN, and wrong ones count towards the same wait", async (t) => {
  const { app, call } = await withPin(t);
  const missing = await call("POST", "/api/lock/pin", { pin: null });
  assert.equal(missing.status, 400);
  assert.equal(app.sessionLock.pinSet(), true);
  for (let i = 1; i <= 4; i++) assert.equal((await call("POST", "/api/lock/pin", { pin: null, current: "999999" })).status, 403);
  assert.equal((await call("POST", "/api/lock/pin", { pin: "1234", current: "999999" })).status, 429, "the fifth wrong one waits");
  assert.equal(app.sessionLock.pinSet(), true);
  await call("POST", "/api/lock");
  assert.equal((await call("POST", "/api/lock/unlock", { pin: PIN })).status, 429, "the wait holds unlocking too");
  app.sessionLock.now = () => Date.now() + 6 * 60_000;
  assert.equal((await call("POST", "/api/lock/unlock", { pin: PIN })).status, 200);
  const removed = await call("POST", "/api/lock/pin", { pin: null, current: PIN });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.pinSet, false);
  assert.equal(app.sessionLock.pinSet(), false);
});

// Mutation: take `...own("/api/lock/unlock")` out of src/household-routes.ts → a household window stays shut, red.
test("a window left on a household profile is let back in by the PIN, and only by it", async (t) => {
  const { app, call } = await withPin(t);
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  assert.equal((await call("POST", "/api/lock/pin", { pin: null, current: PIN })).status, 400, "removing it stays the owner's");
  await call("POST", "/api/lock");
  assert.equal((await call("POST", "/api/lock/unlock", { pin: "2468" })).status, 403, "the person's own PIN does not open it");
  assert.equal((await call("POST", "/api/lock/unlock", { pin: PIN })).status, 200);
  assert.equal(app.store.profiles.isOwner(), false, "still on the household profile");
});

// Mutation: make refusal() ignore pinSet() → a locked Branch without a PIN refuses GET /api/state, red.
test("without a PIN nothing changes: locking closes only the locker, and unlocking asks nothing", async (t) => {
  const { call } = await served(t);
  assert.equal((await call("POST", "/api/lock")).body.locked, true);
  assert.equal((await call("GET", "/api/state")).status, 200);
  const unlocked = await call("POST", "/api/lock/unlock", {});
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.body.locked, false);
  assert.equal(unlocked.body.pinSet, false);
});

// Mutation: make touch() call locked() first with no PIN too (`if (!this.locked()) …`) → the request after the
// quiet period locks Branch instead of starting the quiet period again, red.
test("without a PIN, a request after the quiet period starts it again, as before App lock", async (t) => {
  const { app, call, step } = await served(t);
  assert.equal((await call("POST", "/api/lock/settings", { idleMinutes: 15, secretsWhileLocked: false, lockOnOpen: false })).status, 200);
  step(16 * 60_000);
  // A change that is not the lock's own (those reset the quiet period themselves).
  const answer = await call("POST", "/api/firewall/test", { address: "https://example.com" });
  assert.equal(answer.status, 200, answer.text.slice(0, 200));
  const now = (await call("GET", "/api/lock")).body;
  assert.equal(now.locked, false, "the request restarted the quiet period");
  assert.equal(now.idleSeconds, 0);
  assert.doesNotThrow(() => app.sessionLock.require(), "the locker stays open");
  // With nothing done for the whole quiet period, it still locks by itself on a look, as before.
  step(16 * 60_000);
  assert.equal((await call("GET", "/api/lock")).body.locked, true);
  assert.equal((await call("GET", "/api/state")).status, 200, "and without a PIN the window is still answered");
});

// Mutation: drop the lockOnOpen line in the SessionLock constructor → the reopened Branch starts unlocked, red.
test("Always: with a PIN and lock-on-open, Branch opens locked", async (t) => {
  const it = await withPin(t);
  assert.equal((await it.call("POST", "/api/lock/settings", { idleMinutes: 0, secretsWhileLocked: false, lockOnOpen: true })).status, 200);
  const again = await it.reopen();
  assert.equal((await again.call("GET", "/api/state")).status, 423);
  assert.equal((await again.call("GET", "/api/lock")).body.lockOnOpen, true);
  assert.equal((await again.call("POST", "/api/lock/unlock", { pin: PIN })).status, 200);
  assert.equal((await again.call("GET", "/api/state")).status, 200);
});
