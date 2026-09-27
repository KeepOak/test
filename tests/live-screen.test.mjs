/* parity-b2: the owner's live view of this computer's screen (GET /api/panels/screen, src/live-screen.ts, and
   DesktopControl.liveFrame). A frame is taken only when it is asked for, only for the owner at this computer's own
   window, never while Lockdown or the app lock is on, never through a door (a paired phone), and never while the
   owner's screen switch is off or a password window is showing. The capture is a stand-in that counts: every refused
   caller leaves the count where it was. design/redesign/tools/mutate-live-screen.mjs drops each guard in turn and
   expects this file to go red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { liveScreen, liveScreenDoorRefusal } from "../dist/live-screen.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-screen-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  // The capture itself is a stand-in that counts, slow enough that two reads at once overlap.
  const taken = { count: 0 };
  app.desktop.liveFrame = async () => { taken.count += 1; await pause(150); return { bytes: JPEG, type: "image/jpeg", width: 1280, height: 800 }; };
  const get = (token = server.token) => fetch(new URL("/api/panels/screen", server.url), { headers: { authorization: `Bearer ${token}` } });
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, server, taken, get, post };
}

test("nothing is captured until the owner asks, one frame per read, and two reads at once share one", async (t) => {
  const { taken, get } = await world(t);
  await pause(400);
  assert.equal(taken.count, 0, "no read, no capture: the engine runs nothing between reads");
  const one = await get();
  assert.equal(one.status, 200);
  const frame = await one.json();
  assert.equal(frame.frame, `data:image/jpeg;base64,${JPEG.toString("base64")}`);
  assert.deepEqual([frame.width, frame.height], [1280, 800]);
  assert.equal(taken.count, 1);
  const both = await Promise.all([get(), get()]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(taken.count, 2, "two reads at once took one frame");
  await pause(300);
  assert.equal(taken.count, 2, "and nothing after the reads stopped");
});

test("a short-lived key, a household person, Lockdown and the app lock are refused before anything is captured", async (t) => {
  const { app, taken, get, post } = await world(t);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await get(key)).status, 401, "a short-lived key");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await get();
  assert.ok([400, 403].includes(household.status), `a household person (${household.status})`);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await post("/api/lockdown", { on: true })).status, 200);
  const locked = await get();
  assert.equal(locked.status, 403, "Lockdown");
  assert.match((await locked.json()).error, /Lockdown is on/);
  assert.equal((await post("/api/lockdown", { on: false })).status, 200);
  assert.equal((await post("/api/lock/pin", { pin: "2468" })).status, 200);
  assert.equal((await post("/api/lock", {})).status, 200);
  assert.equal((await get()).status, 423, "the app lock");
  assert.equal((await post("/api/lock/unlock", { pin: "2468" })).status, 200);
  assert.equal(taken.count, 0, "none of them was shown, or cost, a frame");
  assert.equal((await get()).status, 200, "the owner, unlocked, is");
  assert.equal(taken.count, 1);
});

test("a paired phone or any caller through a door, and anyone but the owner, is refused without a capture", async (t) => {
  const { app } = await world(t);
  let count = 0;
  const desktop = { liveFrame: async () => { count += 1; return { bytes: JPEG, type: "image/jpeg", width: 1, height: 1 }; } };
  const base = { store: app.store, owner: app.runtime.owner, desktop };
  await assert.rejects(liveScreen({ ...base, profiles: { isOwner: () => true }, viaDoor: true }), (error) => error.status === 403 && error.message === liveScreenDoorRefusal);
  await assert.rejects(liveScreen({ ...base, profiles: { isOwner: () => false }, viaDoor: false }), (error) => error.status === 403 && /owner/.test(error.message));
  assert.equal(count, 0);
  assert.equal((await liveScreen({ ...base, profiles: { isOwner: () => true }, viaDoor: false })).width, 1);
  assert.equal(count, 1);
});

test("the frame follows the screen's own rules: the switch, a password window, and nothing kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-live-frame-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const calls = [];
  let windows = [{ handle: "1", title: "Notes", className: "", program: "notepad", processId: 1, minimised: false }];
  const runner = {
    async temporaryPng(name) { return join(root, `${name}.png`); },
    async run(action, payload) {
      calls.push([action, payload]);
      if (action === "windows") return { windows };
      await writeFile(payload.outPath, JPEG);
      return { width: 1280, height: 720, format: "jpeg", title: "Screen 1" };
    },
  };
  const desktop = new DesktopControl(app.store, { runner, banner: { visible: false, show: async () => undefined, hide: async () => undefined } });
  await assert.rejects(desktop.liveFrame(app.runtime.owner), /switch|turn|off/i, "the owner's switch for the screen is off");
  assert.equal(calls.length, 0, "nothing reached the screen");
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  windows = [...windows, { handle: "2", title: "Bitwarden", className: "", program: "Bitwarden", processId: 2, minimised: false }];
  await assert.rejects(desktop.liveFrame(app.runtime.owner), /handles passwords/);
  assert.deepEqual(calls.map(([action]) => action), ["windows"], "with a password window showing, no picture is taken");
  windows = windows.slice(0, 1);
  const shot = await desktop.liveFrame(app.runtime.owner);
  assert.equal(shot.type, "image/jpeg");
  assert.deepEqual([...shot.bytes], [...JPEG]);
  const [, asked] = calls.at(-1);
  assert.equal(asked.maxWidth, 1280, "asked for a frame no wider than 1280");
  await assert.rejects(access(asked.outPath), "the temporary file is gone: nothing is kept");
});
