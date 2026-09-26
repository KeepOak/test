/**
 * B6: a new phone pairs from the window's "Pair a phone" code (public/app/flows/pair.js) and collects its session over
 * the open door, POST /api/devices/pair/session (src/devices/book.ts collectPhoneSession). The session is the one the
 * Tailscale invitation (POST /api/pair) hands over: the window's key, plus the phone's own "this exact phone" secret.
 * Pinned here, so the one pairing flow can never hand that session to anything else:
 *
 *   1. only a phone the owner let in, after saying the check codes match, from a "Pair a phone" invitation, gets it;
 *   2. once: a replay, a wrong signature, a status signature, a computer, a computer invitation, a refused or waiting
 *      request, Devices off or Lockdown on get the same pairingRefused 403;
 *   3. a household person and a short-lived key can neither make the invitation nor let the phone in;
 *   4. the code works once, five tries per invitation, and it expires;
 *   5. the session is exactly the /api/pair session on the paired door: no wider (the door's chain still holds, a task
 *      socket and quit stay refused there) and no narrower; removing the device forgets its door secret;
 *   6. two phones racing one code: one request; two collects racing one request: one session;
 *   7. a paired phone (on the paired door) and Lockdown cannot make a phone invitation;
 *   8. a restart mid-pairing leaves nothing open: the code is gone, a waiting phone is not offered, a phone let in but
 *      not yet collected never collects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { householdRefusalFor } from "../dist/household-routes.js";
import { DeviceBook, pairingRefused, offerAttempts, offerLifetimeMs, offLine, phoneSessionText } from "../dist/devices/book.js";
import { codeNotConfirmed, phoneInviteHereOnly } from "../dist/devices/api.js";
import { keyCheck, pairText } from "../dist/devices/protocol.js";
import { saveGatewayAuth } from "../dist/remote/gateway-auth.js";
import { pairPhoneSession } from "../apps/mobile/web/phone-node.js";

function phoneKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}

/** An engine on loopback, plus its paired door on a spare loopback port (as tests/mobile-contract.test.mjs does). */
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-pairing-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const host = new URL(server.url).host;
  const door = createServer((request, response) => { request.headers.host = host; server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(async () => {
    door.closeAllConnections?.();
    await new Promise((done) => door.close(done));
    await server.close(); await app.close(); await discardTemp(root);
  });
  const doorBase = `http://127.0.0.1:${door.address().port}`;
  const call = (method, path, body, key = server.token, base = server.url, extra = {}) => fetch(base + path, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }), ...extra },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  assert.equal((await call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  return { app, server, call, doorBase };
}

/** The owner shows "Pair a phone"; a stand-in phone answers it with the code and its own key, and waits. */
async function phoneWaits(call, { platform = "ios", phone = true, name = "Stand-in phone" } = {}) {
  const invite = await call("POST", "/api/devices/invite", phone ? { phone: true } : {});
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const key = phoneKey();
  const redeemed = await call("POST", "/api/devices/pair",
    { offer: invite.body.id, code: invite.body.code, name, platform, publicKey: key.publicKey, offers: [] }, null);
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  return { key, requestId: redeemed.body.requestId, invite: invite.body };
}
const letIn = (call, requestId) => call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true });
const collect = (call, requestId, signature) => call("POST", "/api/devices/pair/session", { requestId, signature }, null);
const refusedAs403 = (answer, why) => { assert.equal(answer.status, 403, `${why}: ${answer.status} ${JSON.stringify(answer.body)}`); assert.equal(answer.body.error, pairingRefused, why); };

test("a phone pairs end to end with the window's code and collects the /api/pair session, once", async (t) => {
  const { app, server, call } = await served(t);
  const { key, requestId } = await phoneWaits(call);
  const waiting = (await call("GET", "/api/devices")).body.requests.find((r) => r.id === requestId);
  assert.equal(waiting.phone, true, "the window is told this request will collect a phone session");
  assert.equal(waiting.check, keyCheck(key.publicKey), "the window's check code is the one the phone shows");
  refusedAs403(await collect(call, requestId, key.sign(phoneSessionText(requestId))), "nothing before the owner's yes");
  for (const body of [{ approve: true }, { approve: true, codeMatches: false }]) {
    const refused = await call("POST", `/api/devices/requests/${requestId}`, body);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, codeNotConfirmed, "the check code must be said to match");
  }
  assert.equal((await letIn(call, requestId)).status, 200);
  const status = await call("POST", "/api/devices/pair/status", { requestId, signature: key.sign(pairText(requestId, "status")) }, null);
  assert.equal(status.body.status, "approved");
  const session = await collect(call, requestId, key.sign(phoneSessionText(requestId)));
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.deepEqual(Object.keys(session.body).sort(), ["deviceId", "deviceKey", "token"], "the /api/pair shape");
  assert.equal(session.body.token, server.token, "the window's key, exactly as /api/pair hands it over");
  assert.match(session.body.deviceId, /^[a-f0-9]{16}$/);
  assert.equal((await call("GET", "/api/state", undefined, session.body.token)).status, 200);
  refusedAs403(await collect(call, requestId, key.sign(phoneSessionText(requestId))), "a replay of the same request");
  const listed = (await call("GET", "/api/devices")).body.devices[0];
  assert.equal(listed.platform, "ios");
  assert.equal(listed.gatewayId, undefined, "the door secret's id stays in the engine");
  assert.equal(listed.publicKey, undefined);
  assert.equal(app.devices.book.devices()[0].gatewayId, session.body.deviceId);
});

test("a wrong signature, a status signature and another key's signature collect nothing", async (t) => {
  const { app, call } = await served(t);
  const { key, requestId } = await phoneWaits(call);
  assert.equal((await letIn(call, requestId)).status, 200);
  refusedAs403(await collect(call, requestId, key.sign(pairText(requestId, "status"))), "a status signature");
  refusedAs403(await collect(call, requestId, phoneKey().sign(phoneSessionText(requestId))), "another key");
  refusedAs403(await collect(call, requestId, "A".repeat(88)), "a made-up signature");
  refusedAs403(await collect(call, "f".repeat(32), key.sign(phoneSessionText("f".repeat(32)))), "a request nobody made");
  refusedAs403(await call("GET", "/api/devices/pair/session", undefined, null), "a GET");
  assert.equal(app.devices.book.requests()[0].collected, false, "none of them used it up");
  assert.equal((await collect(call, requestId, key.sign(phoneSessionText(requestId)))).status, 200, "the phone itself still can");
});

test("a computer, a computer invitation, a refused request and a waiting one collect nothing", async (t) => {
  const { call } = await served(t);
  const computer = await phoneWaits(call, { platform: "linux", name: "Desk" });
  assert.equal((await call("GET", "/api/devices")).body.requests.find((r) => r.id === computer.requestId).phone, false);
  assert.equal((await letIn(call, computer.requestId)).status, 200);
  refusedAs403(await collect(call, computer.requestId, computer.key.sign(phoneSessionText(computer.requestId))), "a non-phone platform");

  const fromComputerDialog = await phoneWaits(call, { phone: false, name: "Phone on a computer invitation" });
  assert.equal((await letIn(call, fromComputerDialog.requestId)).status, 200);
  refusedAs403(await collect(call, fromComputerDialog.requestId, fromComputerDialog.key.sign(phoneSessionText(fromComputerDialog.requestId))),
    "a phone that answered a computer invitation");

  const refused = await phoneWaits(call, { name: "Refused phone" });
  assert.equal((await call("POST", `/api/devices/requests/${refused.requestId}`, { approve: false })).status, 200);
  refusedAs403(await collect(call, refused.requestId, refused.key.sign(phoneSessionText(refused.requestId))), "a refused request");

  const waiting = await phoneWaits(call, { platform: "android", name: "Waiting phone" });
  refusedAs403(await collect(call, waiting.requestId, waiting.key.sign(phoneSessionText(waiting.requestId))), "an unapproved request");
});

test("Devices switched off, Lockdown on, or the device removed before collecting hand nothing over", async (t) => {
  const { call } = await served(t);
  const off = await phoneWaits(call, { name: "Off phone" });
  assert.equal((await letIn(call, off.requestId)).status, 200);
  assert.equal((await call("POST", "/api/devices/mode", { mode: "off" })).status, 200);
  refusedAs403(await collect(call, off.requestId, off.key.sign(phoneSessionText(off.requestId))), "Devices off");
  assert.equal((await call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);

  const locked = await phoneWaits(call, { name: "Locked phone" });
  assert.equal((await letIn(call, locked.requestId)).status, 200);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  refusedAs403(await collect(call, locked.requestId, locked.key.sign(phoneSessionText(locked.requestId))), "Lockdown on");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);

  const removed = await phoneWaits(call, { name: "Removed phone" });
  const deviceId = (await letIn(call, removed.requestId)).body.request.deviceId;
  assert.equal((await call("POST", `/api/devices/${deviceId}/revoke`, {})).status, 200);
  refusedAs403(await collect(call, removed.requestId, removed.key.sign(phoneSessionText(removed.requestId))), "a removed device");
});

test("a household person and a short-lived key can neither make the phone invitation nor let the phone in", async (t) => {
  const { app, call } = await served(t);
  const { requestId } = await phoneWaits(call);
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: `b6-${scope}`, scope, minutes: 5 }).token;
    for (const [path, body] of [["/api/devices/invite", { phone: true }], [`/api/devices/requests/${requestId}`, { approve: true, codeMatches: true }]]) {
      const answer = await call("POST", path, body, key);
      assert.equal(answer.status, 401, `${scope} key: ${path} → ${answer.status}`);
      assert.match(answer.body.error ?? "", /short-lived key/);
    }
  }
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  for (const [path, body] of [["/api/devices/invite", { phone: true }], [`/api/devices/requests/${requestId}`, { approve: true, codeMatches: true }]]) {
    const answer = await call("POST", path, body);
    assert.equal(answer.status, 400, `household: ${path} → ${answer.status}`);
    assert.equal(answer.body.error, householdRefusalFor(path));
  }
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  assert.equal(app.devices.book.requests().find((r) => r.id === requestId).status, "waiting", "nobody let the phone in");
  assert.equal(app.devices.book.devices().length, 0);
});

test("the phone invitation's code works once, five tries per invitation, and it expires", async (t) => {
  const { app, call } = await served(t);
  const { invite } = await phoneWaits(call);
  const again = await call("POST", "/api/devices/pair",
    { offer: invite.id, code: invite.code, name: "Second phone", platform: "ios", publicKey: phoneKey().publicKey }, null);
  refusedAs403(again, "the same code a second time");

  let clock = Date.now();
  const book = new DeviceBook(app.store, app.runtime.owner, () => clock);
  const body = (offer, code) => ({ offer: offer.id, code, platform: "android", publicKey: phoneKey().publicKey });
  const burned = book.invite({ phone: true });
  const wrong = burned.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < offerAttempts; i++) assert.throws(() => book.redeem(body(burned, wrong), `100.64.0.${i}`), { message: pairingRefused });
  assert.throws(() => book.redeem(body(burned, burned.code), "100.64.1.1"), { message: pairingRefused }, "the sixth try, even right, is refused");
  const late = book.invite({ phone: true });
  clock += offerLifetimeMs + 1;
  assert.throws(() => book.redeem(body(late, late.code), "100.64.2.1"), { message: pairingRefused }, "an expired invitation is refused");
  assert.equal(book.requests().filter((r) => r.name !== "Stand-in phone").length, 0, "neither left a request to let in");
});

test("on the paired door the session is exactly the /api/pair one: the chain holds, and removing the device forgets its secret", async (t) => {
  const { app, server, call, doorBase } = await served(t);
  const { key, requestId } = await phoneWaits(call);
  assert.equal((await letIn(call, requestId)).status, 200);
  const session = (await collect(call, requestId, key.sign(phoneSessionText(requestId)))).body;
  const deviceHeaders = { "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
  saveGatewayAuth(app.store, app.runtime.owner, { chain: ["token", "pairing", "device"] });
  assert.equal((await call("GET", "/api/state", undefined, session.token, doorBase, deviceHeaders)).status, 200, "this exact phone is let through the door");
  assert.equal((await call("GET", "/api/state", undefined, session.token, doorBase)).status, 401, "the key alone is not enough when the owner asks for the device");
  assert.equal((await call("POST", "/api/deployment/quit", {}, session.token, doorBase, deviceHeaders)).status, 403, "quit stays this computer's alone");
  const socket = await fetch(`${doorBase}/api/runs/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/ws`, {
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...deviceHeaders },
  }).catch((error) => ({ status: 0, error }));
  assert.notEqual(socket.status, 101, "a task socket is never opened on the door");
  const deviceId = app.devices.book.devices()[0].id;
  assert.equal((await call("POST", `/api/devices/${deviceId}/revoke`, {})).status, 200);
  assert.equal((await call("GET", "/api/state", undefined, session.token, doorBase, deviceHeaders)).status, 401, "removed from the list, its door secret no longer works");
  assert.equal(server.token, session.token);
});

test("two phones racing one code: only one is let wait; two collects racing one request: only one gets the session", async (t) => {
  const { app, call } = await served(t);
  const invite = (await call("POST", "/api/devices/invite", { phone: true })).body;
  const keys = [phoneKey(), phoneKey()];
  const answers = await Promise.all(keys.map((key, i) => call("POST", "/api/devices/pair",
    { offer: invite.id, code: invite.code, name: `Racing phone ${i}`, platform: i ? "android" : "ios", publicKey: key.publicKey }, null)));
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 403], JSON.stringify(answers));
  refusedAs403(answers.find((a) => a.status === 403), "the phone that lost the race");
  assert.equal(app.devices.book.requests().length, 1, "one request to let in, never two");
  const winner = keys[answers.findIndex((a) => a.status === 200)];
  const { requestId } = answers.find((a) => a.status === 200).body;
  assert.equal((await letIn(call, requestId)).status, 200);
  const signature = winner.sign(phoneSessionText(requestId));
  const collects = await Promise.all([collect(call, requestId, signature), collect(call, requestId, signature)]);
  assert.deepEqual(collects.map((a) => a.status).sort(), [200, 403], JSON.stringify(collects.map((a) => a.status)));
  refusedAs403(collects.find((a) => a.status === 403), "the second collect of one request");
});

test("a paired phone on the paired door and Lockdown cannot make a phone invitation", async (t) => {
  const { app, call, doorBase } = await served(t);
  const { key, requestId } = await phoneWaits(call);
  assert.equal((await letIn(call, requestId)).status, 200);
  const session = (await collect(call, requestId, key.sign(phoneSessionText(requestId)))).body;
  const deviceHeaders = { "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
  for (const chain of [["token"], ["token", "pairing", "device"]]) {
    saveGatewayAuth(app.store, app.runtime.owner, { chain });
    const onDoor = await call("POST", "/api/devices/invite", { phone: true }, session.token, doorBase, deviceHeaders);
    assert.equal(onDoor.status, 403, `the paired phone (${chain.join(", ")}): ${onDoor.status} ${JSON.stringify(onDoor.body)}`);
    assert.equal(onDoor.body.error, phoneInviteHereOnly);
    assert.equal(app.devices.book.invitation(), null, "no invitation was made");
  }
  assert.equal((await call("POST", "/api/devices/invite", { phone: true }, null)).status, 401, "a device with no key of the window's");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const locked = await call("POST", "/api/devices/invite", { phone: true });
  assert.equal(locked.status, 400, `Lockdown: ${locked.status} ${JSON.stringify(locked.body)}`);
  assert.equal(locked.body.error, offLine);
  assert.equal(app.devices.book.invitation(), null, "Lockdown made no invitation");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal((await call("POST", "/api/devices/invite", { phone: true })).status, 200, "the owner at this computer still can");
});

test("a restart mid-pairing leaves nothing open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-restart-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const open = async () => {
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
    const call = (method, path, body, key = server.token) => fetch(server.url + path, {
      method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
    return { app, server, call, close: async () => { await server.close(); await app.close(); } };
  };
  let running = await open();
  t.after(async () => { await running?.close(); await discardTemp(root); });
  assert.equal((await running.call("POST", "/api/devices/mode", { mode: "when-needed" })).status, 200);
  const letInBefore = await phoneWaits(running.call, { name: "Let in before" });
  assert.equal((await letIn(running.call, letInBefore.requestId)).status, 200);
  const waitingBefore = await phoneWaits(running.call, { name: "Waiting before" });
  const pending = (await running.call("POST", "/api/devices/invite", { phone: true })).body;
  await running.close();
  running = null;

  running = await open();
  const { call } = running;
  assert.equal(running.app.devices.book.invitation(), null, "no invitation survives");
  refusedAs403(await call("POST", "/api/devices/pair",
    { offer: pending.id, code: pending.code, name: "After restart", platform: "ios", publicKey: phoneKey().publicKey }, null), "the old code");
  const view = (await call("GET", "/api/devices")).body;
  assert.equal(view.requests.some((r) => r.id === waitingBefore.requestId), false, "the waiting phone is not offered to be let in");
  assert.equal((await letIn(call, waitingBefore.requestId)).status, 400, "nor can it be let in");
  refusedAs403(await collect(call, letInBefore.requestId, letInBefore.key.sign(phoneSessionText(letInBefore.requestId))),
    "a phone let in before the restart");
  refusedAs403(await collect(call, waitingBefore.requestId, waitingBefore.key.sign(phoneSessionText(waitingBefore.requestId))),
    "a phone waiting before the restart");
  assert.equal(running.app.devices.book.requests().some((r) => r.collected), false, "nothing was handed over");
});

test("the phone's own protocol (phone-node.js) connects from the window's Pair a phone code, as the native side does", async (t) => {
  const { app, server, call } = await served(t);
  const kept = new Map();
  const env = { crypto: globalThis.crypto, fetch, platform: "android", say: (_key, english) => english,
    store: { get: async (key) => kept.get(key) ?? null, set: async (key, value) => void kept.set(key, value) },
    wait: () => new Promise((done) => setTimeout(done, 20)), tries: 400 };
  const invite = (await call("POST", "/api/devices/invite", { phone: true })).body;
  const pairing = pairPhoneSession(env, invite.link, invite.code, "Pixel");
  let request;
  for (let i = 0; i < 400 && !request; i++) {
    request = (await call("GET", "/api/devices")).body.requests[0];
    if (!request) await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(request?.phone, true, "the window is told this phone will collect a session");
  assert.equal((await letIn(call, request.id)).status, 200);
  const session = await pairing;
  assert.equal(session.token, server.token);
  assert.equal(app.devices.book.devices()[0].gatewayId, session.deviceId);
  // Both native apps sign the same words and ask the same route (BranchPhonePlugin.swift, BranchNode.java).
  for (const file of ["apps/mobile/ios/App/App/BranchPhonePlugin.swift", "apps/mobile/android/app/src/main/java/com/keepoak/branchagent/BranchNode.java"]) {
    const native = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(native.includes(String.raw`"branch-phone-session-v1\n`) && native.includes("/api/devices/pair/session"), `${file} collects the phone session`);
  }
  assert.equal(phoneSessionText("x"), "branch-phone-session-v1\nx");
});
