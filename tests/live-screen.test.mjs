/* parity-b2: the owner's live view of this computer's screen (GET /api/panels/screen, src/live-screen.ts, and
   DesktopControl.liveFrames). Frames stream down one request only while a view holds it open, from one reader shared by
   every open view, and only for the owner at this computer's own window: never while Lockdown or the app lock is on,
   never through a door (a paired phone), never while a sign-in is under way, and never while the owner's screen switch
   is off or a password window is showing. The reader is a stand-in that counts its frames and whether it was let go:
   every refused caller leaves the count where it was, and every way a view ends lets it go.
   design/redesign/tools/mutate-live-screen.mjs drops each guard in turn and expects this file to go red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { liveScreenRefusal, liveScreenDoorRefusal, nextFrameIn, liveScreenViews } from "../dist/live-screen.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { desktopScript, LiveScreenProcess } from "../dist/integrations/desktop-script.js";
import { whileSignInShows } from "../dist/sign-in-showing.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await pause(20); }
}

/* A reader that counts: frames taken, readers opened and let go, and the widths asked for. */
function standIn(takeMs = 0) {
  const seen = { opened: 0, closed: 0, taken: 0, widths: [], aborted: 0, slow: null };
  const liveFrames = () => {
    seen.opened += 1;
    let closed = false;
    return {
      async next(width, signal) {
        if (closed) throw new Error("next after close");
        seen.widths.push(width);
        const wait = seen.slow ?? takeMs;
        if (wait) await new Promise((done, fail) => {
          const timer = setTimeout(done, wait);
          signal.addEventListener("abort", () => { clearTimeout(timer); seen.aborted += 1; fail(new Error("stopped")); }, { once: true });
        });
        seen.taken += 1;
        return { bytes: JPEG, type: "image/jpeg", width: 1280, height: 800 };
      },
      close() { closed = true; seen.closed += 1; },
    };
  };
  return { seen, liveFrames };
}

async function world(t, takeMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-screen-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await server.close(); } };
  t.after(async () => { await stop(); await app.close(); await discardTemp(root); });
  const { seen, liveFrames } = standIn(takeMs);
  app.desktop.liveFrames = liveFrames;
  /* Opens a view: its lines as they come, and a way to let it go. */
  const view = async (token = server.token, extra = {}, width) => {
    const controller = new AbortController();
    const response = await fetch(new URL(`/api/panels/screen${width ? `?width=${width}` : ""}`, server.url), { headers: { authorization: `Bearer ${token}`, ...extra }, signal: controller.signal });
    const lines = [];
    let ended = false;
    if (response.ok) (async () => {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at;
          while ((at = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
        }
      } catch { /* let go */ }
      ended = true;
    })();
    return { response, lines, frames: () => lines.filter((l) => l.frame), ended: () => ended, close: () => controller.abort() };
  };
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, server, seen, view, post, stop };
}

test("nothing is read until a view opens; frames stream while it is open, shared by every view, and stop when the last goes", async (t) => {
  const { seen, view } = await world(t);
  await pause(300);
  assert.equal(seen.opened + seen.taken, 0, "no view, no reader and no frame");
  const one = await view();
  assert.equal(one.response.status, 200);
  assert.match(one.response.headers.get("content-type"), /ndjson/);
  assert.equal(one.response.headers.get("cache-control"), "no-store");
  await until(() => one.frames().length >= 3);
  assert.equal(one.frames()[0].frame, `data:image/jpeg;base64,${JPEG.toString("base64")}`);
  const two = await view();
  await until(() => two.frames().length >= 2);
  assert.equal(seen.opened, 1, "two views share one reader");
  assert.equal(liveScreenViews(), 2);
  one.close();
  await until(() => liveScreenViews() === 1);
  const still = two.frames().length;
  await until(() => two.frames().length > still);
  assert.equal(seen.closed, 0, "the other view still has its frames");
  two.close();
  await until(() => seen.closed === 1);
  const taken = seen.taken;
  await pause(400);
  assert.equal(seen.taken, taken, "and nothing after the last view went");
  assert.equal(liveScreenViews(), 0);
});

test("the pace: about ten frames a second for a large view, five for a small one, and fewer when frames are slow", async (t) => {
  assert.equal(nextFrameIn(1280, 10), 90);
  assert.equal(nextFrameIn(480, 10), 190);
  assert.equal(nextFrameIn(1280, 200), 400, "a slow frame: the reader works a third of the time");
  assert.equal(nextFrameIn(1280, 1500), 0, "never slower than the frame itself");
  const { seen, view } = await world(t);
  const large = await view(undefined, {}, 1280);
  await pause(1000);
  const fast = large.frames().length;
  large.close();
  await until(() => seen.closed === 1);
  assert.ok(fast >= 6 && fast <= 12, `a large view: ${fast} frames in a second`);
  const small = await view(undefined, {}, 400);
  await pause(1000);
  const slow = small.frames().length;
  small.close();
  assert.ok(slow >= 3 && slow <= 6, `a small view: ${slow} frames in a second`);
  assert.ok(seen.widths.includes(1280) && seen.widths.includes(400), "each asked for its own width");
});

test("a short-lived key, a household person, Lockdown and the app lock are refused before anything is read", async (t) => {
  const { app, seen, view, post } = await world(t);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await view(key)).response.status, 401, "a short-lived key");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await view();
  assert.ok([400, 403].includes(household.response.status), `a household person (${household.response.status})`);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await post("/api/lockdown", { on: true })).status, 200);
  const locked = await view();
  assert.equal(locked.response.status, 403, "Lockdown");
  assert.match((await locked.response.json()).error, /Lockdown is on/);
  assert.equal((await post("/api/lockdown", { on: false })).status, 200);
  assert.equal((await post("/api/lock/pin", { pin: "2468" })).status, 200);
  assert.equal((await post("/api/lock", {})).status, 200);
  assert.equal((await view()).response.status, 423, "the app lock");
  assert.equal((await post("/api/lock/unlock", { pin: "2468" })).status, 200);
  assert.equal(seen.opened + seen.taken, 0, "none of them was shown, or cost, a frame");
  const owner = await view();
  assert.equal(owner.response.status, 200, "the owner, unlocked, is");
  await until(() => owner.frames().length >= 1);
  owner.close();
});

test("Lockdown or the app lock turned on while a view is open ends it at the next frame, and lets the reader go", async (t) => {
  const { seen, view, post } = await world(t);
  const open = await view();
  await until(() => open.frames().length >= 1);
  assert.equal((await post("/api/lockdown", { on: true })).status, 200);
  await until(() => open.ended());
  assert.match(open.lines.at(-1).refusal, /Lockdown is on/);
  assert.equal(open.lines.at(-1).status, 403);
  assert.equal(seen.closed, 1);
  assert.equal((await post("/api/lockdown", { on: false })).status, 200);
  const again = await view();
  await until(() => again.frames().length >= 1);
  assert.equal((await post("/api/lock/pin", { pin: "2468" })).status, 200);
  assert.equal((await post("/api/lock", {})).status, 200);
  await until(() => again.ended());
  assert.equal(again.lines.at(-1).status, 423, "the app lock");
  assert.equal(seen.closed, 2);
  const taken = seen.taken;
  await pause(300);
  assert.equal(seen.taken, taken);
});

test("a paired phone or any caller through a door, and anyone but the owner, is refused", async (t) => {
  const { app, seen, view } = await world(t);
  const base = { store: app.store, owner: app.runtime.owner, locked: () => null };
  assert.equal(liveScreenRefusal({ ...base, profiles: { isOwner: () => true }, viaDoor: true })?.message, liveScreenDoorRefusal);
  assert.equal(liveScreenRefusal({ ...base, profiles: { isOwner: () => true }, viaDoor: true })?.status, 403);
  assert.match(liveScreenRefusal({ ...base, profiles: { isOwner: () => false }, viaDoor: false })?.message ?? "", /owner/);
  assert.equal(liveScreenRefusal({ ...base, profiles: { isOwner: () => true }, viaDoor: false }), null);
  assert.equal(liveScreenRefusal({ ...base, locked: () => "Branch is locked.", profiles: { isOwner: () => true }, viaDoor: false })?.status, 423);
  const door = await view(undefined, { "x-branch-tunnel": "1" });
  assert.ok([401, 403].includes(door.response.status), `through the tunnel door (${door.response.status})`);
  assert.equal(seen.opened, 0);
});

test("over HTTP: a person's own key is refused without a frame", async (t) => {
  const { app, seen, view, post } = await world(t);
  assert.equal((await post("/api/people/settings", { mode: "on" })).status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const samsKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const person = await view(samsKey);
  assert.ok(person.response.status >= 400 && person.response.status < 500, `a person's own key (${person.response.status})`);
  assert.equal(seen.opened, 0);
});

test("no frame while Branch handles a sign-in, nor one taken as it began; the frames come back when it ends", async (t) => {
  const { seen, view } = await world(t, 150);
  let finish;
  const holding = whileSignInShows(() => new Promise((done) => { finish = done; }));
  const during = await view();
  assert.equal(during.response.status, 409, "while a sign-in is under way");
  assert.match((await during.response.json()).error, /sign-in/);
  assert.equal(seen.opened, 0, "nothing was read");
  finish();
  await holding;
  const open = await view();
  await until(() => open.frames().length >= 1);
  // A sign-in that begins while a frame is being taken: that frame is dropped, and none is sent until it ends.
  await until(() => seen.widths.length > seen.taken);
  let again;
  const second = whileSignInShows(() => new Promise((done) => { again = done; }));
  const before = open.frames().length;
  await until(() => open.lines.some((l) => /sign-in/.test(l.refusal ?? "")));
  await pause(400);
  assert.equal(open.frames().length, before, "no frame while it lasts");
  again();
  await second;
  await until(() => open.frames().length > before);
  open.close();
});

test("a frame under way is stopped when its view goes, and Branch stopping ends every view", async (t) => {
  const { seen, view, stop } = await world(t);
  const open = await view();
  await until(() => open.frames().length >= 1);
  seen.slow = 5000;
  await until(() => seen.widths.length > seen.taken);
  open.close();
  await until(() => seen.aborted === 1);
  assert.equal(seen.closed, 1, "the reader was let go with it");
  seen.slow = null;
  const other = await view();
  await until(() => other.frames().length >= 1);
  await stop();
  await until(() => other.ended());
  assert.equal(seen.closed, 2, "Branch stopping let the reader go");
});

test("the frame follows the screen's own rules: the switch, a password window before or after it, and nothing kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-live-frame-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const calls = [];
  const notes = [{ title: "Notes", program: "notepad", minimised: false }], vault = { title: "Bitwarden", program: "Bitwarden", minimised: false };
  let before = notes, after = notes, closed = 0;
  const reader = { running: true, async frame(maxWidth) { calls.push(["live", maxWidth]); return { width: 640, height: 400, data: JPEG.toString("base64"), windows: before, after }; }, close() { closed += 1; } };
  const runner = {
    liveProcess: () => reader,
    async temporaryPng(name) { return join(root, `${name}.png`); },
    async run(action, payload) { calls.push([action, payload]); if (action === "windows") return { windows: before }; await writeFile(payload.outPath, JPEG); return { width: 1280, height: 720 }; },
    async close() {},
  };
  const desktop = new DesktopControl(app.store, { runner, banner: { visible: false, show: async () => undefined, hide: async () => undefined } });
  const frames = desktop.liveFrames(app.runtime.owner);
  const signal = new AbortController().signal;
  await assert.rejects(frames.next(1280, signal), /switch|turn|off/i, "the owner's switch for the screen is off");
  assert.equal(calls.length, 0, "nothing reached the screen");
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  before = [...notes, vault];
  await assert.rejects(frames.next(1280, signal), /handles passwords/, "open as the frame was taken: dropped");
  before = notes; after = [...notes, vault];
  await assert.rejects(frames.next(1280, signal), /handles passwords/, "opened while it was taken: dropped");
  after = notes;
  const shot = await frames.next(640, signal);
  assert.deepEqual([...shot.bytes], [...JPEG]);
  assert.equal(shot.type, "image/jpeg");
  assert.deepEqual(calls.map(([action]) => action), ["live", "live", "live"], "one program, no file and no second run");
  assert.equal(calls.at(-1)[1], 640, "asked for the view's width");
  await desktop.close();
  assert.equal(closed, 1, "Branch stopping lets the program go");
  // Where there is no such program (a Mac), each frame is one run of the screen tool, whose file goes at once.
  const mac = new DesktopControl(app.store, { runner: { ...runner, liveProcess: () => null }, banner: { visible: false, show: async () => undefined, hide: async () => undefined } });
  calls.length = 0;
  before = [...notes, vault];
  await assert.rejects(mac.liveFrames(app.runtime.owner).next(1280, signal), /handles passwords/);
  assert.deepEqual(calls.map(([action]) => action), ["screenshot", "windows"]);
  await assert.rejects(access(calls[0][1].outPath), "the dropped frame is not kept either");
});

test("the Windows program: one for the whole view, every frame in its answer, and it ends when let go or stopped", async (t) => {
  const live = /'live' \{([\s\S]*?)\n  default/.exec(desktopScript)?.[1] ?? "";
  assert.match(live, /MemoryStream/);
  assert.doesNotMatch(live, /\.Save\([^)]*(path|Path|\.jpg|\.png)/, "it writes no file");
  assert.match(live, /\[Console\]::In\.ReadLine\(\)/, "it waits on its input between frames");
  assert.match(live, /if \(\$line -eq \$null\) \{ break \}/, "and ends when its input goes");
  assert.equal((live.match(/Windows\(answer\)/g) ?? []).length, 2, "the windows are listed before and after each frame");
  // The same process handling, with a stand-in program that answers each line the way the script does.
  const script = `const rl=require("readline").createInterface({input:process.stdin});rl.on("line",(w)=>{if(w==="9999")return;process.stdout.write(JSON.stringify({width:+w,height:1,data:"${JPEG.toString("base64")}",windows:[],after:[]})+"\\n")});`;
  let starts = 0;
  const pids = [];
  const reader = new LiveScreenProcess(async () => { starts += 1; return { executable: process.execPath, args: ["-e", script] }; });
  t.after(() => reader.close());
  const signal = new AbortController().signal;
  assert.equal((await reader.frame(640, signal)).width, 640);
  assert.equal((await reader.frame(320, signal)).width, 320);
  assert.equal(starts, 1, "one program for every frame");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  pids.push(reader.child?.pid ?? 0);
  // A frame whose request drops: the frame and its program are stopped.
  const drop = new AbortController();
  const stuck = reader.frame(9999, drop.signal);
  await pause(100);
  drop.abort();
  await assert.rejects(stuck, /stopped/);
  assert.equal(reader.running, false);
  assert.equal((await reader.frame(800, signal)).width, 800, "the next frame starts a new one");
  assert.equal(starts, 2);
  pids.push(reader.child?.pid ?? 0);
  reader.close();
  await assert.rejects(reader.frame(800, signal), /closed/, "nothing runs after it is let go");
  for (const pid of pids.filter(Boolean)) await until(() => !alive(pid), 5000);
});
