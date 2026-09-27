/**
 * POST /api/privacy (the checks on personal details in messages that leave this computer, and the content check) is held
 * to the same rules as every other setting that can make Branch less careful (src/policy-change-guard.ts): a change that
 * turns a check down needs the owner's separate yes, `confirmLoosening`, and under Lockdown nothing here changes at all.
 * It stays the owner's alone: a household person at the window, the owner's short-lived key and a person's own key are
 * refused whatever they send. (A paired phone holds the window's own key, so it meets the owner's rules above.)
 *
 * Mutations, and the case each turns red:
 *   P1  privacyChangeRefusal: `if (confirmLoosening) return null;` moved above the Lockdown check     → "Lockdown"
 *   P2  privacyChangeRefusal answers null always (the route as it was: one ungated POST)            → "masking off", "Lockdown", "each way"
 *   P3  server.ts: configure called without confirmLoosening passed through (always false)          → "masking off" (the yes never saves)
 *   P4  privacyLooser: the outbound ranking dropped (only kinds and the content check compared)      → "masking off", "each way"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const tick = 'Tick "Yes, make it less careful" to go ahead.';
const lockdownWords = "Lockdown is on, so settings cannot be changed from here. Turn it off first.";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-privacy-guard-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, route, body, key = server.token) => fetch(server.url + route, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const saved = async () => (await call("GET", "/api/privacy")).body;
  return { app, server, call, saved };
}
const withPii = (pii, moderation = {}) => ({ pii: { outbound: "mask", inbound: "off", kinds: ["email", "phone", "card", "iban", "national-id"], ...pii }, moderation });

test("masking off: refused without the owner's yes in the engine's words, saved with it", async (t) => {
  const { call, saved } = await served(t);
  assert.equal((await saved()).pii.outbound, "mask", "masking ships on");
  const refused = await call("POST", "/api/privacy", withPii({ outbound: "off" }));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, `This makes Branch less careful: personal details in messages sent out would be let through unchecked. ${tick}`);
  assert.equal((await saved()).pii.outbound, "mask", "nothing saved without the yes");
  const confirmed = await call("POST", "/api/privacy", { ...withPii({ outbound: "off" }), confirmLoosening: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal((await saved()).pii.outbound, "off", "read back: the owner's yes saved it");
});

test("each way a check can be turned down asks; tightening and an unchanged save do not", async (t) => {
  const { call, saved } = await served(t);
  assert.equal((await call("POST", "/api/privacy", withPii({ outbound: "block", inbound: "mask" }))).status, 200, "tightening needs no yes");
  assert.equal((await call("POST", "/api/privacy", withPii({ outbound: "block", inbound: "mask" }))).status, 200, "saving what is saved needs no yes");
  const looser = [
    withPii({ outbound: "mask", inbound: "mask" }),
    withPii({ outbound: "warn", inbound: "mask" }),
    withPii({ outbound: "block", inbound: "off" }),
    withPii({ outbound: "block", inbound: "mask", kinds: ["email"] }),
    withPii({ outbound: "block", inbound: "mask" }, { enabled: true, endpoint: "https://checks.invalid/v1/moderations" }),
  ];
  for (const body of looser) {
    const answer = await call("POST", "/api/privacy", body);
    assert.equal(answer.status, 409, JSON.stringify(body));
    assert.match(answer.body.error, /^This makes Branch less careful: /);
  }
  assert.deepEqual((await saved()).pii, { outbound: "block", inbound: "mask", kinds: ["email", "phone", "card", "iban", "national-id"] });
  assert.equal((await saved()).moderation.enabled, false);
  assert.notEqual((await call("POST", "/api/privacy", { ...withPii({ outbound: "off" }), confirmLoosening: "yes" })).status, 200, "confirmLoosening is true or false");
  assert.equal((await saved()).pii.outbound, "block");
});

test("under Lockdown nothing here changes, even with the owner's yes", async (t) => {
  const { call, saved } = await served(t);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  for (const body of [{ ...withPii({ outbound: "off" }), confirmLoosening: true }, withPii({ outbound: "block" })]) {
    const locked = await call("POST", "/api/privacy", body);
    assert.equal(locked.status, 409, JSON.stringify(body));
    assert.equal(locked.body.error, lockdownWords);
  }
  assert.equal((await saved()).pii.outbound, "mask", "Lockdown kept masking");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal((await call("POST", "/api/privacy", { ...withPii({ outbound: "off" }), confirmLoosening: true })).status, 200, "control: unlocked, the yes saves it");
});

test("a household person, the owner's short-lived key and a person's own key are refused, even with the yes", async (t) => {
  const { app, call, saved } = await served(t);
  assert.equal((await call("POST", "/api/people/settings", { mode: "on" })).status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const ownersKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const samsKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const loosen = { ...withPii({ outbound: "off" }), confirmLoosening: true };
  for (const [who, key] of [["the owner's short-lived key", ownersKey], ["Sam's own key", samsKey]]) {
    const answer = await call("POST", "/api/privacy", loosen, key);
    assert.ok(answer.status >= 400 && answer.status < 500, `${who}: ${answer.status}`);
  }
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const atWindow = await call("POST", "/api/privacy", loosen);
  assert.ok(atWindow.status >= 400 && atWindow.status < 500, `Sam at the window: ${atWindow.status}`);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await saved()).pii.outbound, "mask", "none of them changed the owner's checks");
});
