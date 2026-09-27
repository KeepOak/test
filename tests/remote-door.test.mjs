/**
 * The door to the phone (src/remote/remote-access.ts, POST /api/deployment/remote): one door however many switch-ons
 * arrive together, shut when the owner switches it off or Branch closes (even while Tailscale is still being asked),
 * and never opened under Lockdown, while switching it off always works.
 *
 * No real Tailscale is asked: the engine is handed a stand-in that answers when the test says so. The stand-in's
 * address is in Tailscale's range, which this computer does not have, so each door that asks for it is opened on
 * 127.0.0.1 instead and counted; everything else listens where it asked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { RemoteAccess } from "../dist/remote/remote-access.js";
import { setLockdown } from "../dist/lockdown.js";

const TAILNET = "100.101.102.103";
const doors = [];
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function listen(...args) {
  if (args[1] === TAILNET) { args[1] = "127.0.0.1"; doors.push(this); }
  return realListen.apply(this, args);
};
/** Doors on the Tailscale address that are listening right now. */
const openDoors = () => doors.filter((server) => server.listening).length;
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Tailscale that answers only when told, and counts how often it was asked. */
function tailscale() {
  const waiting = [];
  const probe = () => { probe.calls++; return new Promise((resolve) => waiting.push(resolve)); };
  probe.calls = 0;
  probe.answer = () => { for (const resolve of waiting.splice(0))
    resolve({ present: true, running: true, address: TAILNET, hostname: null, message: "Tailscale is running." }); };
  probe.asked = async () => { for (let i = 0; i < 200 && !waiting.length; i++) await tick(5); assert.ok(waiting.length, "Tailscale was asked"); };
  return probe;
}

async function engine(t, probe) {
  doors.length = 0;
  const root = await mkdtemp(join(tmpdir(), "branch-door-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, tailscale: probe });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); } };
  t.after(async () => { probe.answer(); await close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  return { app, server, call, close };
}

test("two switch-ons at once open one door, and the switch-off leaves none", async (t) => {
  const probe = tailscale();
  const { call } = await engine(t, probe);
  const first = call("/api/deployment/remote", { enabled: true });
  const second = call("/api/deployment/remote", { enabled: true });
  await probe.asked();
  await tick();
  probe.answer();
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map((a) => [a.status, a.body.enabled]), [[200, true], [200, true]]);
  assert.equal(probe.calls, 1, "Tailscale is asked once for both");
  assert.equal(openDoors(), 1, "one door, not two");
  const off = await call("/api/deployment/remote", { enabled: false });
  assert.deepEqual([off.status, off.body.enabled], [200, false]);
  await tick();
  assert.equal(openDoors(), 0, "switching off leaves no door behind");
});

test("a switch-off sent while the switch-on waits on Tailscale wins: the door never opens", async (t) => {
  const probe = tailscale();
  const { call } = await engine(t, probe);
  const on = call("/api/deployment/remote", { enabled: true });
  await probe.asked();
  const off = await call("/api/deployment/remote", { enabled: false });
  assert.deepEqual([off.status, off.body.enabled], [200, false]);
  probe.answer();
  assert.equal((await on).body.enabled, false, "the earlier switch-on answers with the door still off");
  await tick();
  assert.equal(openDoors(), 0);
  assert.equal((await call("/api/deployment")).body.remote.enabled, false);
});

test("closing Branch closes the door, and a door still waiting on Tailscale never opens", async (t) => {
  const probe = tailscale();
  const { call, close } = await engine(t, probe);
  assert.equal((await Promise.all([call("/api/deployment/remote", { enabled: true }), (async () => { await probe.asked(); probe.answer(); })()]))[0].body.enabled, true);
  assert.equal(openDoors(), 1);
  const late = new RemoteAccess("k".repeat(64), probe);
  const waiting = late.enable(() => {});
  await probe.asked();
  const closing = late.close();
  probe.answer();
  await Promise.all([waiting, closing, close()]);
  await tick();
  assert.equal(openDoors(), 0, "no door is left listening once Branch is closed");
  const after = late.enable(() => {});
  await tick();
  probe.answer();
  assert.equal((await after).enabled, false, "a switch-on after closing opens nothing");
  assert.equal(probe.calls, 2, "nor asks Tailscale again");
  await tick();
  assert.equal(openDoors(), 0);
});

test("under Lockdown the door is refused and a door already open is closed; switching it off always works", async (t) => {
  const probe = tailscale();
  const { app, call } = await engine(t, probe);
  const on = call("/api/deployment/remote", { enabled: true });
  await probe.asked();
  probe.answer();
  assert.equal((await on).body.enabled, true);
  setLockdown(app.store, app.runtime.owner, { on: true });
  await tick();
  assert.equal(openDoors(), 0, "Lockdown closes the open door");
  const asking = call("/api/deployment/remote", { enabled: true });
  await tick(100);
  probe.answer();
  const refused = await asking;
  assert.equal(refused.status, 409);
  assert.match(refused.body.error ?? JSON.stringify(refused.body), /Lockdown is on/);
  assert.equal(probe.calls, 1, "Tailscale is not even asked");
  const off = await call("/api/deployment/remote", { enabled: false });
  assert.deepEqual([off.status, off.body.enabled], [200, false]);
  assert.equal(openDoors(), 0);

  setLockdown(app.store, app.runtime.owner, { on: false });
  const pending = call("/api/deployment/remote", { enabled: true });
  await probe.asked();
  setLockdown(app.store, app.runtime.owner, { on: true });
  probe.answer();
  assert.equal((await pending).body.enabled, false, "Lockdown turning on while Tailscale is asked keeps the door shut");
  await tick();
  assert.equal(openDoors(), 0);
});

/** A request straight to the phone door, as a phone on the private network sends it; `hold` sends the head only. */
function viaDoor(port, method, path, headers, body, hold = false) {
  const request = http.request({ host: "127.0.0.1", port, method, path,
    headers: { host: `${TAILNET}:${port}`, ...headers, ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }) } });
  const answer = new Promise((resolve) => {
    request.on("response", (response) => { let text = ""; response.on("data", (c) => { text += c; }); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", () => resolve("cut"));
  });
  if (hold) request.flushHeaders(); else request.end(body);
  return { request, answer };
}

test("a phone let in through the door can neither switch it nor hold it open once the owner switches it off", async (t) => {
  const probe = tailscale();
  const { call } = await engine(t, probe);
  const on = call("/api/deployment/remote", { enabled: true });
  await probe.asked();
  probe.answer();
  assert.equal((await on).body.enabled, true);
  const port = doors.find((server) => server.listening).address().port;
  const invitation = (await call("/api/deployment/remote/invite", {})).body;
  const pair = viaDoor(port, "POST", "/api/pair", {}, JSON.stringify({ id: new URL(invitation.url).searchParams.get("id"), code: invitation.code }));
  let phone = "";
  pair.request.on("response", (response) => response.on("data", (c) => { phone += c; }));
  assert.equal(await pair.answer, 200);
  const { token, deviceId, deviceKey } = JSON.parse(phone);
  const key = { authorization: `Bearer ${token}`, "x-branch-device": deviceId, "x-branch-device-key": deviceKey };
  assert.equal(await viaDoor(port, "GET", "/api/deployment", key).answer, 200, "the phone is let in");
  assert.equal(await viaDoor(port, "POST", "/api/deployment/remote", key, JSON.stringify({ enabled: false })).answer, 403, "the phone cannot switch the door");

  const held = viaDoor(port, "POST", "/api/deployment/remote", key, JSON.stringify({ enabled: true }), true);
  await tick(100);
  const off = await Promise.race([call("/api/deployment/remote", { enabled: false }), tick(3000).then(() => null)]);
  assert.ok(off, "switching off answers while a phone still holds a connection");
  assert.equal(off.body.enabled, false);
  held.request.end(JSON.stringify({ enabled: true }));
  assert.ok([403, "cut"].includes(await held.answer), "the held switch-on is refused or cut with the door");
  await tick(100);
  probe.answer();
  await tick(100);
  assert.equal(openDoors(), 0, "nothing reopened the door");
  assert.equal((await call("/api/deployment")).body.remote.enabled, false);
});
