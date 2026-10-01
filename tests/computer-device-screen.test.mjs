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

async function world(t, { input = false } = {}) {
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
  const offers = input ? ["screen", "input"] : ["screen"];
  const pairing = pairNode(dir, invite.link, invite.code, { platform: "linux", offers, name: "Tower", intervalMs: 25 });
  let request;
  await until(async () => (request = (await call("devices")).requests[0]), "the pairing request");
  await call(`devices/requests/${request.id}`, { approve: true, codeMatches: true });
  await pairing;
  let shots = 0;
  const inputs = [];
  // The second computer's notice, a stand-in that shows nothing: its owner, whether it is up, and a Stop to press.
  const notices = [];
  const startNotice = (owner) => {
    let press;
    const notice = { owner, open: true, shown: Promise.resolve(!notices.failing), stopped: new Promise((done) => { press = done; }),
      close() { notice.open = false; }, press: (why = "Stop was pressed on this computer.") => { notice.open = false; press(why); } };
    if (notices.failing) notice.press("This computer could not show on top of its screen that it is being used, so it was not used.");
    notices.push(notice);
    return notice;
  };
  const actions = { available: async () => offers, prepare: async () => undefined, startNotice,
    perform: async (capability, args) => {
      // The second computer's stand-in: it keeps each owner input instead of moving a pointer.
      if (capability === "input") { inputs.push(args); return { value: { done: args.action } }; }
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
  return { app, server, call, device, run, open, shots: () => shots, client, inputs, notices };
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
  await assert.rejects(w.app.devices.hub.invoke(w.device.id, "notify", { title: "x" }, { ownerView: true }), /only looks at a device's screen and uses it/);
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
    allows: () => true, paceMs: 10, inputRefusal: () => null, drive: () => undefined, driving: () => false, stoppedHere: () => false, input: async () => undefined, capture: async (device) => { asked.push(device); if (asked.length > 2) throw new Error("Tower has been asked too often in the last minute. Wait a little."); return { bytes: Buffer.from("x"), mime: "image/png" }; } });
  const written = [];
  const response = { destroyed: false, writeHead() {}, once() {}, write(line) { written.push(JSON.parse(line)); return true; }, end() { this.destroyed = true; } };
  await screen.stream({ owner: "o", sessionId: "s", viaDoor: false, shortKey: false, keyValid: () => true }, "0123456789abcdef", response);
  assert.equal(written.filter((line) => line.frame).length, 2);
  assert.match(written.at(-1).refusal, /asked too often/, "the device socket's limit is said, and the view ends");
  assert.throws(() => screen.guard({ owner: "o", sessionId: "s", viaDoor: true, shortKey: false, keyValid: () => true }, "0123456789abcdef"), /only in Branch's own window/);
  assert.throws(() => screen.guard({ owner: "o", sessionId: "s", viaDoor: false, shortKey: false, keyValid: () => true }, "../etc"), /not a paired computer/);
});

test("a view that stops reading gets no more pictures (none is even asked for) until it has taken the last one", async () => {
  let asked = 0;
  const screen = new DeviceScreen({ owner: () => "o", isOwner: () => true, owns: () => true, lockdown: () => false, locked: () => null,
    allows: () => true, paceMs: 10, inputRefusal: () => null, drive: () => undefined, driving: () => false, stoppedHere: () => false,
    input: async () => undefined, capture: async () => { asked += 1; return { bytes: Buffer.from("x"), mime: "image/png" }; } });
  const written = [];
  // Like a real response whose window stopped reading: each write fills it until the window drains it.
  const response = { destroyed: false, writableNeedDrain: false, writeHead() {}, once() {},
    write(line) { written.push(line); this.writableNeedDrain = true; return false; }, end() { this.destroyed = true; } };
  const streaming = screen.stream({ owner: "o", sessionId: "s", viaDoor: false, shortKey: false, keyValid: () => true }, "0123456789abcdef", response);
  try {
    await wait(150);
    assert.equal(written.length, 1, "one picture waits in the response; no more pile up behind it");
    assert.equal(asked, 1, "that computer is not asked for pictures nobody will read");
    response.writableNeedDrain = false;
    await until(() => written.length >= 2, "the next picture once the window reads again", 2000);
  } finally {
    screen.close();
    await streaming;
  }
});

test("the owner clicks and types on a paired computer from the view: only through its own switch, only while driving, only on the picture seen", async (t) => {
  const w = await world(t, { input: true });
  const post = async (path, body, key = w.server.token) => {
    const response = await fetch(`${w.server.url}/api/panels/screen/device/${path}`, { method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ session: w.run.sessionId, device: w.device.id, ...body }) });
    return { status: response.status, ...(await response.json()) };
  };
  await w.call("devices/pick", { sessionId: w.run.sessionId, deviceId: w.device.id });
  await w.call(`devices/${w.device.id}/switch`, { capability: "screen", on: true });
  await until(() => w.client.switchedOn().includes("screen"), "the screen switch to reach the second computer");
  const view = w.open();
  const frames = () => view.lines.filter((line) => line.frame);
  await until(() => frames().length >= 1, "a picture", 12000);
  assert.equal(frames()[0].driving, false);
  assert.match(frames()[0].inputNote, /Switch on "Let you use its screen and keyboard from Branch" for Tower/, "the view says why Take over is greyed");
  // The second computer's own switch is off: no take-over, and a task can never send input at all.
  assert.match((await post("drive", { on: true })).error, /Switch on/);
  assert.equal(w.app.devices.hub.driving(w.device.id), false);
  await assert.rejects(w.app.devices.hub.invoke(w.device.id, "input", { action: "type", text: "x" }), /Only the owner uses a device's screen and keyboard/);
  assert.ok(w.app.registry.names().includes("device.screen") && !w.app.registry.names().includes("device.input"), "there is no task tool for it");
  await w.call(`devices/${w.device.id}/switch`, { capability: "input", on: true });
  await until(() => w.client.switchedOn().includes("input"), "the input switch to reach the second computer");
  const seen = frames().length;
  await until(() => frames().length > seen, "a picture after the switch", 6000);
  assert.equal(frames().at(-1).inputNote, null);
  // Not driving yet: refused before anything reaches the second computer.
  assert.match((await post("input", { frameId: frames().at(-1).frameId, input: { action: "click", x: 0.5, y: 0.5 } })).error, /Take over/);
  await assert.rejects(w.app.devices.hub.invoke(w.device.id, "input", { action: "type", text: "x" }, { ownerView: true }), /Take over Tower/,
    "the device socket itself refuses input while nobody has taken over");
  // A short-lived key cannot take over.
  const key = w.app.sessionTokens.create(w.app.runtime.owner, { name: "script", scope: "read", minutes: 5 }).token;
  assert.equal((await post("drive", { on: true }, key)).status, 401);
  assert.deepEqual(await post("drive", { on: true }), { status: 200, driving: true });
  assert.equal(w.app.devices.hub.driving(w.device.id), true);
  // Q1: the second computer shows a notice on top, naming the owner, while the owner holds it.
  await until(() => w.client.held(), "the second computer to put its notice up");
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].owner, "the owner", "the owner's own name when they gave one, else \"the owner\"");
  assert.equal(w.notices[0].open, true);
  // You're driving: a task cannot act on that computer; it may still look.
  await assert.rejects(w.app.devices.hub.invoke(w.device.id, "notify", { title: "x" }), /You're driving Tower/);
  await w.app.devices.hub.invoke(w.device.id, "screen", {}, { timeoutMs: 5000 });
  const count = frames().length;
  await until(() => frames().length > count && frames().at(-1).driving === true, "a picture that says the owner drives", 6000);
  const shown = frames().at(-1);
  assert.match((await post("input", { frameId: "0123456789abcdef", input: { action: "click", x: 0.5, y: 0.5 } })).error, /picture moved on/, "a press aimed at another picture is refused");
  assert.equal((await post("input", { frameId: shown.frameId, input: { action: "click", x: 2, y: 0.5 } })).status, 400, "a spot off the picture is refused");
  assert.deepEqual(await post("input", { frameId: shown.frameId, input: { action: "click", x: 0.5, y: 0.25, button: "right", count: 1 } }), { status: 200, done: true });
  assert.match((await post("input", { frameId: shown.frameId, input: { action: "click", x: 0.5, y: 0.25 } })).error, /picture moved on/, "the next click waits for the next picture");
  assert.match((await post("input", { frameId: shown.frameId, input: { action: "scroll", x: 0.5, y: 0.25, steps: 1 } })).error, /picture moved on/, "and so does the wheel");
  assert.equal((await post("input", { frameId: shown.frameId, input: { action: "type", text: "hello (world)" } })).status, 200, "text may follow the click on the same picture");
  await until(() => frames().at(-1).frameId !== shown.frameId, "the next picture", 6000);
  assert.equal((await post("input", { frameId: frames().at(-1).frameId, input: { action: "key", chord: "ctrl+s" } })).status, 200);
  assert.deepEqual(w.inputs, [
    { action: "click", x: 0.5, y: 0.25, button: "right", count: 1 },
    { action: "type", text: "hello (world)", button: "left", count: 1 },
    { action: "key", chord: "ctrl+s", button: "left", count: 1 },
  ], "exactly the owner's three inputs reached the second computer");
  // Switching it off ends the hold at once; switching it on again needs a new Take over.
  await w.call(`devices/${w.device.id}/switch`, { capability: "input", on: false });
  await until(() => !w.client.switchedOn().includes("input"), "the switch to reach the second computer");
  await until(() => frames().at(-1).inputNote !== null, "a picture that says it is off", 6000);
  assert.match((await post("input", { frameId: frames().at(-1).frameId, input: { action: "type", text: "x" } })).error, /Take over that computer first/);
  assert.equal(w.inputs.length, 3);
  assert.equal(w.app.devices.hub.driving(w.device.id), false, "switching it off ended the hold");
  assert.equal(w.notices[0].open, false, "and took the notice down");
  await w.call(`devices/${w.device.id}/switch`, { capability: "input", on: true });
  await until(() => w.client.switchedOn().includes("input"), "the switch to reach the second computer");
  await until(() => frames().at(-1).inputNote === null, "a picture that says it is on", 6000);
  assert.deepEqual(await post("drive", { on: true }), { status: 200, driving: true });
  await until(() => w.client.held() && w.notices.length === 2, "the notice to go up again");
  // Hand back, then Lockdown: both stop it.
  assert.deepEqual(await post("drive", { on: false }), { status: 200, driving: false });
  await until(() => !w.client.held() && !w.notices[1].open, "the notice to come down");
  await w.app.devices.hub.invoke(w.device.id, "notify", { title: "x" }).catch((error) => assert.doesNotMatch(error.message, /driving/));
  assert.deepEqual(await post("drive", { on: true }), { status: 200, driving: true });
  await w.call("lockdown", { on: true });
  assert.equal((await post("input", { frameId: frames().at(-1).frameId, input: { action: "type", text: "x" } })).status, 403);
  assert.equal(w.inputs.length, 3, "nothing more reached the second computer");
  view.close();
  await view.done;
  await until(() => !w.app.devices.hub.driving(w.device.id), "closing the view to hand the computer back");
});

test("Stop on the paired computer's own notice ends the owner's hold there and then; no notice, no input", async (t) => {
  const w = await world(t, { input: true });
  const post = async (path, body) => {
    const response = await fetch(`${w.server.url}/api/panels/screen/device/${path}`, { method: "POST",
      headers: { authorization: `Bearer ${w.server.token}`, "content-type": "application/json" }, body: JSON.stringify({ session: w.run.sessionId, device: w.device.id, ...body }) });
    return { status: response.status, ...(await response.json()) };
  };
  await w.call("devices/pick", { sessionId: w.run.sessionId, deviceId: w.device.id });
  await w.call(`devices/${w.device.id}/switch`, { capability: "screen", on: true });
  await w.call(`devices/${w.device.id}/switch`, { capability: "input", on: true });
  await until(() => w.client.switchedOn().includes("input"), "the switches to reach the second computer");
  const view = w.open();
  const frames = () => view.lines.filter((line) => line.frame);
  await until(() => frames().length >= 1, "a picture", 12000);
  assert.equal((await post("drive", { on: true })).driving, true);
  await until(() => w.client.held(), "the notice");
  // Someone at that computer presses Stop.
  w.notices[0].press();
  await until(() => !w.app.devices.hub.driving(w.device.id), "Branch to hear the Stop");
  assert.equal(w.app.devices.hub.stoppedHere(w.device.id), true);
  const count = frames().length;
  await until(() => frames().length > count, "the next picture", 6000);
  assert.equal(frames().at(-1).stoppedHere, true, "the view says someone there pressed Stop");
  assert.equal(frames().at(-1).driving, false);
  assert.match((await post("input", { frameId: frames().at(-1).frameId, input: { action: "type", text: "x" } })).error, /Take over/);
  // A notice that cannot show ends the hold at once.
  w.notices.failing = true;
  w.app.devices.hub.drive(w.device.id, true, "the owner");
  await until(() => !w.app.devices.hub.driving(w.device.id), "a notice that could not show to end the hold");
  assert.equal(w.inputs.length, 0, "nothing was typed on that computer without its notice up");
  view.close();
  await view.done;
});
