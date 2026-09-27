/**
 * Removing a phone that was handed the window's key takes the key away (src/remote/window-key.ts).
 *
 *   1. the removed phone's key is refused on every route, on this computer's listener and on the paired door;
 *   2. a phone that still belongs collects the new key over its paired door with its own secret; the removed one cannot;
 *   3. the owner's window keeps working without typing the key again: the browser window that asks is handed the new
 *      key, and the desktop app reads it again from the data folder, where it replaced the old one;
 *   4. the window's key is never handed over as plain HTTP from beyond this computer that is not Tailscale.
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
import { pairingRefused, phoneSessionText } from "../dist/devices/book.js";
import { windowKeyReader } from "../dist/desktop/signed-headers.js";
import { keyMayTravel } from "../dist/remote/window-key.js";
import { ROUTES, SAMPLE_ID, entry } from "./short-lived-key-routes.mjs";

function phoneKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}

/** An engine on loopback, plus its paired door on a spare loopback port (as tests/phone-pairing.test.mjs does). */
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-key-rotate-"));
  const dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  // Hundreds of refused keys from one place in a row; the wait they would earn is tested elsewhere.
  const server = await startServer(app, { dataDir, port: 0, authLimits: { attempts: 1_000_000 } });
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
  return { app, server, call, doorBase, dataDir };
}

/** A phone paired from the window's "Pair a phone" code, let in, holding its session: { deviceId, session, headers }. */
async function pairedPhone(call, name, extra = {}) {
  const invite = (await call("POST", "/api/devices/invite", { phone: true })).body;
  const key = phoneKey();
  const { requestId } = (await call("POST", "/api/devices/pair",
    { offer: invite.id, code: invite.code, name, platform: "android", publicKey: key.publicKey, offers: [] }, null)).body;
  const deviceId = (await call("POST", `/api/devices/requests/${requestId}`, { approve: true, codeMatches: true })).body.request.deviceId;
  const collected = await call("POST", "/api/devices/pair/session", { requestId, signature: key.sign(phoneSessionText(requestId)) }, null, undefined, extra);
  return { deviceId, requestId, key, collected, session: collected.body,
    headers: { "x-branch-device": collected.body.deviceId, "x-branch-device-key": collected.body.deviceKey } };
}

/** Every address in the route table a key is asked for, made concrete, with the method that reaches it. */
function keyedRoutes() {
  return Object.entries(ROUTES).map(([path, value]) => ({ path, ...entry(value) }))
    .filter(({ kind, path }) => kind !== "prefix" && kind !== "pre-auth" && !/[[\]{}()\\|?*+^$]/.test(path))
    .map(({ path, methods }) => ({ path: path.replaceAll(":id", SAMPLE_ID), method: methods[0] ?? "GET" }));
}

test("the removed phone's key is refused on every route, on this computer's listener and on the paired door", async (t) => {
  const { server, call, doorBase } = await served(t);
  const removed = await pairedPhone(call, "Removed phone");
  assert.equal(removed.collected.status, 200);
  const old = removed.session.token;
  assert.equal(old, server.token);
  assert.equal((await call("POST", `/api/devices/${removed.deviceId}/revoke`, {})).status, 200);
  assert.notEqual(server.token, old, "a new key replaced the one the phone was handed");
  const routes = keyedRoutes();
  assert.ok(routes.length > 300, `every route: ${routes.length}`);
  const let_through = [];
  for (const { path, method } of routes)
    for (const base of [server.url, doorBase]) {
      const answer = await call(method, path, method === "GET" ? undefined : {}, old, base, removed.headers);
      if (answer.status !== 401) let_through.push(`${method} ${path} on ${base === doorBase ? "the door" : "this computer"}: ${answer.status}`);
    }
  assert.deepEqual(let_through, [], "the old key opens nothing");
  assert.equal((await call("GET", "/api/state")).status, 200, "the new key does");
});

test("a phone that still belongs collects the new key over its paired door; the removed one cannot", async (t) => {
  const { server, call, doorBase } = await served(t);
  const staying = await pairedPhone(call, "Staying phone");
  const removed = await pairedPhone(call, "Removed phone");
  assert.equal((await call("POST", `/api/devices/${removed.deviceId}/revoke`, {})).status, 200);
  assert.equal((await call("GET", "/api/state", undefined, staying.session.token, doorBase, staying.headers)).status, 401, "its old key is old");
  const renewed = await call("POST", "/api/pair/renew", {}, null, doorBase, staying.headers);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(renewed.body.token, server.token);
  assert.equal((await call("GET", "/api/state", undefined, renewed.body.token, doorBase, staying.headers)).status, 200, "it keeps working");
  for (const [why, headers] of [["the removed phone", removed.headers], ["no secret", {}],
    ["another phone's id with a wrong secret", { ...staying.headers, "x-branch-device-key": "0".repeat(48) }]]) {
    const refused = await call("POST", "/api/pair/renew", {}, null, doorBase, headers);
    assert.equal(refused.status, 401, `${why}: ${refused.status}`);
    assert.equal(refused.body.token, undefined, why);
  }
  const plain = await call("POST", "/api/pair/renew", {}, null, undefined, { ...staying.headers, "x-branch-tunnel": "1" });
  assert.equal(plain.status, 401, "never as plain HTTP from beyond this computer");
});

test("the owner's window keeps working after the key is replaced, without typing it again", async (t) => {
  const { server, call, doorBase, dataDir } = await served(t);
  const first = server.token;
  const desktop = windowKeyReader(dataDir, first);
  assert.equal(desktop(), first);
  const phone = await pairedPhone(call, "Removed phone");
  const answer = await call("POST", `/api/devices/${phone.deviceId}/revoke`, { keepKey: true });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.key, server.token, "the browser window that asked is handed the new key");
  assert.equal((await call("GET", "/api/state", undefined, answer.body.key)).status, 200);
  assert.equal((await call("GET", "/api/state", undefined, first)).status, 401);
  assert.equal((await readFile(join(dataDir, "session-token"), "utf8")).trim(), server.token, "saved where the first one was");
  assert.equal(desktop(), server.token, "the desktop app reads the new key again");
  assert.equal((await call("GET", "/api/state", undefined, desktop())).status, 200);

  const second = await pairedPhone(call, "Second phone");
  const unasked = await call("POST", `/api/devices/${second.deviceId}/revoke`, {});
  assert.equal(unasked.status, 200);
  assert.equal(unasked.body.key, undefined, "a window that did not ask (the desktop app holds none) is not handed it");
  assert.equal(desktop(), server.token);
  const third = await pairedPhone(call, "Third phone");
  const staying = await pairedPhone(call, "Staying phone");
  const fromDoor = await call("POST", `/api/devices/${third.deviceId}/revoke`, { keepKey: true }, staying.session.token, doorBase, staying.headers);
  assert.equal(fromDoor.status, 200, JSON.stringify(fromDoor.body));
  assert.equal(fromDoor.body.key, undefined, "only this computer's own window is handed the key in the answer");
});

test("the window's key is never collected as plain HTTP from beyond this computer", async (t) => {
  const { call, server } = await served(t);
  const lan = await pairedPhone(call, "Phone on the home network", { "x-branch-tunnel": "1" });
  assert.equal(lan.collected.status, 403, JSON.stringify(lan.collected.body));
  assert.equal(lan.collected.body.error, pairingRefused);
  assert.equal(lan.collected.body.token, undefined);
  const again = await call("POST", "/api/devices/pair/session", { requestId: lan.requestId, signature: lan.key.sign(phoneSessionText(lan.requestId)) }, null);
  assert.equal(again.status, 200, "the same phone on this computer's own address still can");
  assert.equal(again.body.token, server.token);

  const socket = (localAddress, remoteAddress) => ({ socket: { localAddress, remoteAddress }, headers: {} });
  assert.equal(keyMayTravel(socket("192.168.1.20", "192.168.1.30"), false), false, "a home network");
  assert.equal(keyMayTravel(socket("::ffff:10.0.0.2", "::ffff:10.0.0.9"), false), false);
  assert.equal(keyMayTravel(socket("192.168.1.20", "100.100.1.2"), false), false, "a Tailscale-looking caller at a home address");
  assert.equal(keyMayTravel(socket("100.100.1.1", "100.100.1.2"), false), true, "Tailscale to this computer's Tailscale address");
  assert.equal(keyMayTravel(socket("::ffff:100.100.1.1", "::ffff:100.100.1.2"), false), true);
  assert.equal(keyMayTravel(socket("127.0.0.1", "127.0.0.1"), false), true, "this computer");
  assert.equal(keyMayTravel({ socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" }, headers: { "x-branch-tunnel": "1" } }, false), false, "the webhook door");
  assert.equal(keyMayTravel(socket("192.168.1.20", "192.168.1.30"), true), true, "the paired door");
});
