/**
 * computer-control (SCREEN-077): a paired computer's screen, live in the owner's computer view, end to end on this
 * computer's loopback address: a real Branch server and a second Branch "computer" (a `branch node` with its own
 * identity folder) paired the way a person pairs one, its screen switched on by the owner, and the pictures travelling
 * over the real device socket into GET /api/panels/screen/device. The node's screen is a stand-in that makes a new
 * picture each time: nothing on this computer's real screen is captured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { loadIdentity, NodeClient, pairNode } from "../dist/devices/node/client.js";
import { DeviceScreen } from "../dist/device-screen.js";

const scripted = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const picture = (n) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`frame ${n}`)]);

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  assert.fail(`timed out waiting for ${what}`);
}

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-device-screen-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const stop = new AbortController();
  t.after(async () => { stop.abort(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  await call("devices/mode", { mode: "on" });
  // The second computer: its own identity folder, paired by invitation and the owner's yes.
  const dir = join(root, "second-computer");
  const invite = await call("devices/invite", {});
  const pairing = pairNode(dir, invite.link, invite.code, { platform: "linux", offers: ["screen"], name: "Tower", intervalMs: 25 });
  let request;
  await until(async () => (request = (await call("devices")).requests[0]), "the pairing request");
  await call(`devices/requests/${request.id}`, { approve: true, codeMatches: true });
  await pairing;
  let shots = 0;
  const actions = { available: async () => ["screen"], prepare: async () => undefined,
    perform: async (capability) => {
      assert.equal(capability, "screen", "the view only ever asks for the screen");
      shots += 1;
      return { value: { captured: "screen" }, media: { mime: "image/png", name: "screen.png", data: picture(shots) } };
    } };
  const client = new NodeClient({ identity: await loadIdentity(dir), platform: "linux", actions, backoffBase: 20 });
  void client.run(stop.signal);
  const [device] = (await call("devices")).devices;
  await until(() => app.devices.hub.connected(device.id), "the second computer to connect");
  const run = app.store.createRun(app.runtime.owner, "Look at the tower");
  const open = (session = run.sessionId, key = server.token) => {
    const controller = new AbortController();
    const lines = [];
    const done = fetch(`${server.url}/api/panels/screen/device?session=${session}&device=${device.id}`,
      { headers: { authorization: `Bearer ${key}` }, signal: controller.signal }).then(async (response) => {
      if (!response.ok) { lines.push({ status: response.status, ...(await response.json()) }); return; }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const { done: end, value } = await reader.read(); if (end) break;
        buffer += decoder.decode(value, { stream: true });
        let at; while ((at = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
      }
    }).catch(() => undefined);
    return { lines, close: () => controller.abort(), done };
  };
  return { app, server, call, device, run, open, shots: () => shots, client };
}

test("the paired computer's screen streams into the view, picture after picture, and stops when the view goes", async (t) => {
  const w = await world(t);
  let view = w.open();
  await until(() => view.lines.length >= 1, "a refusal");
  assert.match(view.lines[0].error ?? "", /cannot use that computer/, "a conversation that does not use that computer is refused");
  assert.equal(w.shots(), 0);
  await w.call("devices/pick", { sessionId: w.run.sessionId, deviceId: w.device.id });
  view = w.open();
  await until(() => view.lines.some((line) => line.refusal), "the screen switch refusal");
  assert.match(view.lines.find((line) => line.refusal).refusal, /switched off for Tower/, "its screen is off until the owner switches it on");
  await w.call(`devices/${w.device.id}/switch`, { capability: "screen", on: true });
  await until(() => w.client.switchedOn().includes("screen"), "the switch to reach the second computer");
  view = w.open();
  await until(() => view.lines.filter((line) => line.frame).length >= 2, "two pictures", 12000);
  const frames = view.lines.filter((line) => line.frame);
  assert.ok(frames.every((line) => line.frame.startsWith("data:image/png;base64,") && line.device === w.device.id));
  assert.notEqual(frames[0].frame, frames[1].frame, "each picture is a new one");
  const gap = Date.parse(frames[1].at) - Date.parse(frames[0].at);
  assert.ok(gap >= 2000, `about one picture every two and a half seconds (${gap} ms)`);
  view.close();
  await view.done;
  const after = w.shots();
  await wait(3000);
  assert.equal(w.shots(), after, "the view went: no more pictures are asked for");
  // The view's pictures came from their own budget: a task still has all thirty of its turns this minute.
  for (let i = 0; i < 30; i++) await w.app.devices.hub.invoke(w.device.id, "screen", {}, { timeoutMs: 5000 });
  await assert.rejects(w.app.devices.hub.invoke(w.device.id, "screen", {}, { timeoutMs: 5000 }), /asked too often/, "and no more than that");
  await assert.rejects(w.app.devices.hub.invoke(w.device.id, "notify", { title: "x" }, { ownerView: true }), /only looks at a device's screen/);
});

test("only the owner's window sees it: a short-lived key, a stranger's conversation and Lockdown are refused before anything is asked", async (t) => {
  const w = await world(t);
  await w.call("devices/pick", { sessionId: w.run.sessionId, deviceId: w.device.id });
  await w.call(`devices/${w.device.id}/switch`, { capability: "screen", on: true });
  await until(() => w.client.switchedOn().includes("screen"), "the switch to reach the second computer");
  const key = w.app.sessionTokens.create(w.app.runtime.owner, { name: "script", scope: "read", minutes: 5 }).token;
  const short = w.open(w.run.sessionId, key);
  await short.done;
  assert.equal(short.lines[0].status, 401);
  const foreign = w.open("not-a-conversation");
  await foreign.done;
  assert.equal(foreign.lines[0].status, 403);
  await w.call("lockdown", { on: true });
  const locked = w.open();
  await locked.done;
  assert.equal(locked.lines[0].status, 403);
  assert.equal(w.shots(), 0, "nothing was asked of the second computer");
});

test("the view keeps to its own budget on the device socket, so a task's turns are untouched", async () => {
  const asked = [];
  const screen = new DeviceScreen({ owner: () => "o", isOwner: () => true, owns: () => true, lockdown: () => false, locked: () => null,
    allows: () => true, paceMs: 10, capture: async (device) => { asked.push(device); if (asked.length > 2) throw new Error("Tower has been asked too often in the last minute. Wait a little."); return { bytes: Buffer.from("x"), mime: "image/png" }; } });
  const written = [];
  const response = { destroyed: false, writeHead() {}, once() {}, write(line) { written.push(JSON.parse(line)); return true; }, end() { this.destroyed = true; } };
  await screen.stream({ owner: "o", sessionId: "s", viaDoor: false, shortKey: false, keyValid: () => true }, "0123456789abcdef", response);
  assert.equal(written.filter((line) => line.frame).length, 2);
  assert.match(written.at(-1).refusal, /asked too often/, "the device socket's limit is said, and the view ends");
  assert.throws(() => screen.guard({ owner: "o", sessionId: "s", viaDoor: true, shortKey: false, keyValid: () => true }, "0123456789abcdef"), /only in Branch's own window/);
  assert.throws(() => screen.guard({ owner: "o", sessionId: "s", viaDoor: false, shortKey: false, keyValid: () => true }, "../etc"), /not a paired computer/);
});
