/**
 * unhold-pairing: the window now pairs, lets in, refuses, stops lending and removes devices
 * (public/app/flows/pair.js, public/app/settings/pages/computer.js). These are the engine guards the
 * window must go through, pinned so that making the buttons work can never have loosened them:
 *
 *   1. a short-lived key cannot pair, answer a request, switch a device or unpair it;
 *   2. a household person cannot either;
 *   3. a device that typed the right number still waits: only the owner's yes, with the owner's word
 *      that the check codes match, lets it in;
 *   4. a wrong number, a sixth try or an expired invitation makes no request at all.
 *
 * Each case names the mutation that turns it red; design/redesign/tools/mutate-unhold-pairing.mjs runs them all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { householdRefusalFor } from "../dist/household-routes.js";
import { DeviceBook, pairingRefused, offerAttempts, offerLifetimeMs } from "../dist/devices/book.js";
import { codeNotConfirmed } from "../dist/devices/api.js";
import { pairText } from "../dist/devices/protocol.js";

function deviceKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-unhold-pairing-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  assert.equal((await call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  return { app, server, call };
}

/** The owner makes an invitation; a stand-in phone answers it over the open pairing door. */
async function waitingRequest(call, name = "Stand-in phone") {
  const invite = await call("POST", "/api/devices/invite", {});
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const key = deviceKey();
  const redeemed = await call("POST", "/api/devices/pair",
    { offer: invite.body.id, code: invite.body.code, name, platform: "ios", publicKey: key.publicKey }, null);
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  return { key, requestId: redeemed.body.requestId, invite: invite.body };
}

/** A device already let in by the owner, with one capability switched on. */
async function pairedDevice(call) {
  const { requestId } = await waitingRequest(call, "Paired phone");
  const decided = await call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const id = decided.body.request.deviceId;
  assert.equal((await call("POST", `/api/devices/${id}/switch`, { capability: "camera", on: true })).status, 200);
  return id;
}

/** What only the owner may do from the window's pairing and device controls. */
const guarded = (requestId, deviceId) => [
  ["POST", "/api/devices/invite", {}],
  ["POST", "/api/devices/invite/cancel", {}],
  ["POST", "/api/devices/mode", { mode: "on" }],
  ["POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true }],
  ["POST", `/api/devices/${deviceId}/switch`, { capability: "camera", on: false }],
  ["POST", `/api/devices/${deviceId}/revoke`, {}],
];

async function nothingChanged(app, requestId, deviceId) {
  const book = app.devices.book;
  assert.equal(book.requests().find((r) => r.id === requestId)?.status, "waiting", "the request is still waiting");
  assert.ok(book.device(deviceId), "the device is still paired");
  assert.deepEqual(book.device(deviceId).enabled, ["camera"], "nothing was switched on or off");
  assert.equal(book.devices().length, 1, "nobody was let in");
}

// Mutations that turn this red: M1, a task route in src/short-lived-keys.ts that lets POST /api/devices/* through;
// M2, removing `/^\/api\/devices(\/.*)?$/` from its owner-only reads.
test("a short-lived key cannot pair, let a device in, switch it or unpair it, nor read the list", async (t) => {
  const { app, call } = await served(t);
  const deviceId = await pairedDevice(call);
  const { requestId } = await waitingRequest(call);
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: `unhold-${scope}`, scope, minutes: 5 }).token;
    for (const [method, path, body] of guarded(requestId, deviceId)) {
      const answer = await call(method, path, body, key);
      assert.equal(answer.status, 401, `${scope} key: ${method} ${path} → ${answer.status} ${answer.body.error ?? ""}`);
      assert.match(answer.body.error ?? "", /short-lived key/);
    }
    assert.equal((await call("GET", "/api/devices", undefined, key)).status, 401, "the list (with the check code) is not read");
  }
  await nothingChanged(app, requestId, deviceId);
});

// Mutation that turns this red: M3, src/household-routes.ts householdMaySend answering yes for /api/devices.
test("a household person cannot pair, let a device in, switch it or unpair it", async (t) => {
  const { app, call } = await served(t);
  const deviceId = await pairedDevice(call);
  const { requestId } = await waitingRequest(call);
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  for (const [method, path, body] of guarded(requestId, deviceId)) {
    const answer = await call(method, path, body);
    assert.equal(answer.status, 400, `${method} ${path} → ${answer.status} ${answer.body.error ?? ""}`);
    assert.equal(answer.body.error, householdRefusalFor(path));
  }
  assert.equal((await call("GET", "/api/devices")).status, 400, "the list is the owner's too");
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  await nothingChanged(app, requestId, deviceId);
});

// Mutation that turns this red: M4, dropping `if (body.approve && body.codeMatches !== true) throw ...` in src/devices/api.ts.
test("the right number is not a yes: the request waits for the owner, who must say the check codes match", async (t) => {
  const { app, call } = await served(t);
  const { key, requestId } = await waitingRequest(call);
  const view = (await call("GET", "/api/devices")).body;
  assert.deepEqual(view.devices, [], "typing the number let nothing in");
  const waiting = view.requests.find((r) => r.id === requestId);
  assert.equal(waiting?.status, "waiting");
  assert.match(waiting.check, /^[0-9A-F]{4} [0-9A-F]{4}$/, "the window has a check code to show beside the request");
  assert.equal(waiting.publicKey, undefined, "never the key itself");
  for (const body of [{ approve: true }, { approve: true, codeMatches: false }]) {
    const refused = await call("POST", `/api/devices/requests/${requestId}`, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, codeNotConfirmed);
  }
  // The device asking after itself learns it waits; its signed question changes nothing.
  const status = await call("POST", "/api/devices/pair/status", { requestId, signature: key.sign(pairText(requestId, "status")) }, null);
  assert.deepEqual(status.body, { status: "waiting", deviceId: null });
  assert.equal(app.devices.book.devices().length, 0, "still nobody let in");
  const yes = await call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true });
  assert.equal(yes.status, 200);
  assert.deepEqual(app.devices.book.device(yes.body.request.deviceId).enabled, [], "let in with everything off");
  // A refusal needs no code, and an answered request cannot be answered again.
  const again = await call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true });
  assert.equal(again.status, 400);
});

// Mutation that turns this red: M5, skipping `if (!rightCode) { ... throw }` in DeviceBook.redeem.
test("over the pairing door, a wrong number makes no request", async (t) => {
  const { app, call } = await served(t);
  const invite = (await call("POST", "/api/devices/invite", {})).body;
  const wrong = invite.code === "000000" ? "111111" : "000000";
  const answer = await call("POST", "/api/devices/pair", { offer: invite.id, code: wrong, platform: "ios", publicKey: deviceKey().publicKey }, null);
  assert.equal(answer.status, 403);
  assert.equal(answer.body.error, pairingRefused);
  assert.deepEqual(app.devices.book.requests(), [], "nothing waits for the owner's yes");
  assert.deepEqual((await call("GET", "/api/devices")).body.requests, [], "and the window has nothing to let in");
});

// Mutations that turn this red: M6, `offer.attempts > offerAttempts + 1` (a sixth try), and M7, an invitation
// that never expires in DeviceBook.liveOffer.
test("the sixth try and an expired invitation are refused even with the right number", async (t) => {
  const { app } = await served(t);
  let clock = Date.now();
  const book = new DeviceBook(app.store, app.runtime.owner, () => clock);
  const body = (offer, code) => ({ offer: offer.id, code, platform: "android", publicKey: deviceKey().publicKey });

  const burned = book.invite();
  const wrong = burned.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < offerAttempts; i++) assert.throws(() => book.redeem(body(burned, wrong), `100.64.0.${i}`), { message: pairingRefused });
  assert.throws(() => book.redeem(body(burned, burned.code), "100.64.1.1"), { message: pairingRefused }, "five wrong numbers burn the invitation");
  assert.equal(book.invitation(), null);

  const late = book.invite();
  clock += offerLifetimeMs + 1;
  assert.throws(() => book.redeem(body(late, late.code), "100.64.2.1"), { message: pairingRefused }, "an expired invitation is refused");
  assert.equal(book.invitation(), null);
  assert.deepEqual(book.requests(), [], "neither left a request to let in");
});
