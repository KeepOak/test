/* parity-b2: the frames behind the owner's live view of this computer's screen (DesktopControl.liveFrames and the Windows
   reader). Who may open a view, and what it shows, is src/local-screen.ts (tests/local-screen*.test.mjs); the old
   first-monitor stream these tests once drove through GET /api/panels/screen was replaced by it. Here: a person's own
   key is refused without a frame, every frame follows the screen's own rules (the switch, a password window before or
   after it, nothing kept), and the Windows program is one per view and ends when let go. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { desktopScript, LiveScreenProcess } from "../dist/integrations/desktop-script.js";
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

test("over HTTP: a person's own key is refused without a frame", async (t) => {
  const { app, seen, view, post } = await world(t);
  assert.equal((await post("/api/people/settings", { mode: "on" })).status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const samsKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const person = await view(samsKey);
  assert.ok(person.response.status >= 400 && person.response.status < 500, `a person's own key (${person.response.status})`);
  assert.equal(seen.opened, 0);
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
  // The switch turned off while the frame was being taken: dropped.
  const taking = reader.frame;
  reader.frame = async (maxWidth) => { const got = await taking(maxWidth); saveDesktopSettings(app.store, app.runtime.owner, { enabled: false }); return got; };
  await assert.rejects(frames.next(1280, signal), /switch|turn|off/i, "turned off as the frame was taken: dropped");
  reader.frame = taking;
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const shot = await frames.next(640, signal);
  assert.deepEqual([...shot.bytes], [...JPEG]);
  assert.equal(shot.type, "image/jpeg");
  assert.deepEqual(calls.map(([action]) => action), ["live", "live", "live", "live"], "one program, no file and no second run");
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
