/**
 * computer-control: the rest of Anthropic's computer tool (hold_key, left_mouse_down/up, cursor_position) and the whole
 * tool in Anthropic's own shape (desktop.computer), plus the same verbs on Linux through xdotool. Every screen is a
 * stand-in: an injected runner, or a fake xdotool, writes each request down, so nothing reaches a real screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { saveDesktopSettings, holdKeyCodes, computerModifiers, DesktopComputerSchema } from "../dist/integrations/desktop-config.js";
import { desktopScript } from "../dist/integrations/desktop-script.js";
import { linuxPointer, xdotoolPointerArgs, xdotoolHoldChord, parseShellGeometry } from "../dist/integrations/desktop-script-posix.js";
import { screenTools } from "../dist/feature-switches.js";
import { lockdownToolRefusal, setLockdown } from "../dist/lockdown.js";

const quietBanner = { visible: false, show: async () => undefined, hide: async () => undefined };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const notepad = { title: "notes.txt - Notepad", program: "notepad", handle: "7", processId: 4242, minimised: false };
const paint = { title: "Untitled - Paint", program: "mspaint", handle: "8", processId: 4343, minimised: false };

function standIn(root) {
  const calls = [];
  const runner = {
    calls, fail: null,
    liveProcess: () => null,
    async temporaryPng(name) { return join(root, `${name}.png`); },
    async run(action, payload) {
      calls.push([action, payload]);
      if (runner.fail?.(action, payload)) throw new Error("That was stopped before it finished.");
      if (action === "windows") return { windows: [notepad, paint] };
      if (action === "screenshot") { await writeFile(payload.outPath, PNG); return { width: 800, height: 600, method: "window", title: notepad.title, bounds: { x: 100, y: 50, w: 800, h: 600 } }; }
      if (action === "zoom") { await writeFile(payload.outPath, PNG); return { width: 40, height: 40, scale: payload.scale, method: "window" }; }
      if (action === "pointer") return { how: payload.kind, at: [300, 200] };
      if (action === "cursor") return payload.handle ? { at: [300, 200], window: [200, 150], inside: true, onTop: true } : { at: [300, 200] };
      if (action === "click") return { how: "point", name: "", at: [1, 1] };
      if (action === "type") return { how: "keys", into: "", value: "" };
      return {};
    },
    async close() {},
  };
  return runner;
}
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-computer-anthropic-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const runner = standIn(root);
  const desktop = new DesktopControl(app.store, { runner, banner: quietBanner });
  desktop.artifacts = app.runtime.artifacts;
  const run = app.store.createRun(app.runtime.owner, "use the screen");
  const context = (extra = {}) => ({ ...app.runtime.context({ runId: run.id }), signal: new AbortController().signal, trunk: "trunk-ada", ...extra });
  const sent = (action) => runner.calls.filter(([name]) => name === action).map(([, payload]) => payload);
  return { app, runner, desktop, run, context, sent };
}

test("a held button is let go by mouse_up, and by Stop, the task ending and the owner taking over, never left held", async (t) => {
  const { app, desktop, context, sent, run } = await world(t);
  await desktop.mouseDown({ window: "Notepad", point: { x: 10, y: 20 } }, context());
  assert.deepEqual(sent("pointer").at(-1), { handle: "7", kind: "down", at: { point: { x: 10, y: 20 } }, atCurrent: false, button: "left", modifiers: [] });
  await assert.rejects(desktop.mouseDown({ window: "Notepad" }, context()), /already holds/);
  const other = app.store.createRun(app.runtime.owner, "another");
  await assert.rejects(desktop.mouseDown({ window: "Notepad" }, { ...context(), runId: other.id }), /Another task is holding/);
  await assert.rejects(desktop.mouseUp({ window: "Paint" }, context()), /pressed in another window/);
  const up = await desktop.mouseUp({ window: "Notepad", point: { x: 50, y: 60 } }, context());
  assert.equal(up.released, "left");
  assert.deepEqual(sent("pointer").at(-1), { handle: "7", kind: "up", at: { point: { x: 50, y: 60 } }, button: "left", pressedAt: [300, 200] });
  await assert.rejects(desktop.mouseUp({ window: "Notepad" }, context()), /holds no mouse button/);

  await desktop.mouseDown({ window: "Notepad" }, context());
  assert.equal(sent("pointer").at(-1).atCurrent, true, "no spot: pressed where the pointer is (Anthropic's left_mouse_down)");
  desktop.takeOver();
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(sent("release").at(-1), { buttons: ["left"] }, "the owner took over: let go at once");
  desktop.handBack();
  await desktop.mouseDown({ window: "Notepad" }, context({ trunk: "trunk-bo" }));
  desktop.stop(run.id);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(sent("release").length, 2, "Stop let go");
  const again = app.store.createRun(app.runtime.owner, "third");
  await desktop.mouseDown({ window: "Notepad" }, { ...context(), runId: again.id });
  await desktop.closeRun({ runId: again.id });
  assert.equal(sent("release").length, 3, "the task ending let go");
  assert.ok(app.store.events(again.id).some((e) => e.kind === "desktop.released" && e.data.why === "the task ended"));
});

test("hold_key sends the checked key codes, and lets go itself when the hold is cut short", async (t) => {
  const { desktop, context, sent, runner } = await world(t);
  await desktop.holdKey({ window: "Notepad", chord: "shift", seconds: 0.5 }, context());
  assert.deepEqual(sent("hold-key").at(-1), { handle: "7", keys: [0x10], chord: "shift", ms: 500 });
  await desktop.holdKey({ window: "Notepad", chord: "ctrl+a", seconds: 2 }, context());
  assert.deepEqual(sent("hold-key").at(-1).keys, [0x11, 0x41]);
  runner.fail = (action) => action === "hold-key";
  await assert.rejects(desktop.holdKey({ window: "Notepad", chord: "down", seconds: 3 }, context()), /stopped/);
  assert.deepEqual(sent("release").at(-1), { keys: [0x28], chords: ["down"] });
  assert.deepEqual(holdKeyCodes("f5"), [0x74]);
  assert.throws(() => holdKeyCodes("win+l"), /Branch knows/);
  assert.throws(() => holdKeyCodes("ctrl+alt+shift+ctrl+a"), /Branch knows/);
});

test("cursor_position says where the pointer is, on the screen and in the window, and moves nothing", async (t) => {
  const { desktop, context, sent } = await world(t);
  assert.deepEqual(await desktop.cursor({}, context()), { screen: [300, 200] });
  assert.deepEqual(await desktop.cursor({ window: "Notepad" }, context()), { window: notepad.title, screen: [300, 200], inWindow: [200, 150], inside: true, onTop: true });
  assert.deepEqual(sent("pointer"), []);
});

test("desktop.computer takes Anthropic's actions as they are and hands each to the matching tool", async (t) => {
  const { desktop, context, sent } = await world(t);
  const act = (input) => desktop.computer(DesktopComputerSchema.parse({ window: "Notepad", ...input }), context());
  await act({ action: "left_click", coordinate: [5, 6] });
  assert.equal(sent("click").length, 1, "a plain left click keeps the plain click");
  await act({ action: "right_click", coordinate: [5, 6], text: "shift" });
  assert.deepEqual(sent("pointer").at(-1), { handle: "7", kind: "click", at: { point: { x: 5, y: 6 } }, button: "right", count: 1, modifiers: ["shift"] });
  await act({ action: "triple_click", coordinate: [7, 8] });
  assert.equal(sent("pointer").at(-1).count, 3);
  await act({ action: "double_click", coordinate: [7, 8] });
  assert.equal(sent("pointer").at(-1).count, 2);
  await act({ action: "middle_click", coordinate: [7, 8] });
  assert.equal(sent("pointer").at(-1).button, "middle");
  await act({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [30, 40] });
  assert.deepEqual([sent("pointer").at(-1).from, sent("pointer").at(-1).to], [{ point: { x: 1, y: 2 } }, { point: { x: 30, y: 40 } }]);
  await act({ action: "mouse_move", coordinate: [9, 9] });
  assert.deepEqual([sent("pointer").at(-1).kind, sent("pointer").at(-1).hoverMs], ["move", 0]);
  await act({ action: "left_mouse_down", coordinate: [3, 3] });
  await act({ action: "left_mouse_up" });
  assert.deepEqual(sent("pointer").slice(-2).map((p) => p.kind), ["down", "up"]);
  await act({ action: "scroll", coordinate: [10, 10], scroll_direction: "down", scroll_amount: 5 });
  assert.deepEqual([sent("pointer").at(-1).direction, sent("pointer").at(-1).amount], ["down", 5]);
  await act({ action: "type", text: "hello" });
  await act({ action: "key", text: "Return", repeat: 2 });
  assert.equal(sent("key").at(-1).keys, "{ENTER}{ENTER}");
  await act({ action: "hold_key", text: "shift", duration: 1 });
  assert.equal(sent("hold-key").at(-1).ms, 1000);
  await act({ action: "zoom", region: [10, 20, 110, 70] });
  assert.deepEqual(sent("zoom").at(-1).region, { x: 10, y: 20, width: 100, height: 50 });
  const shot = await act({ action: "screenshot" });
  assert.match(shot.shot, /^[a-f0-9]{16}$/);
  assert.deepEqual((await act({ action: "cursor_position" })).inWindow, [200, 150]);
  assert.deepEqual(await act({ action: "wait", duration: 0.1 }), { waited: 0.1 });
  await assert.rejects(act({ action: "left_click" }), /needs a coordinate/);
  await assert.rejects(desktop.computer(DesktopComputerSchema.parse({ action: "left_click", coordinate: [1, 1] }), context()), /needs a window/);
  assert.throws(() => computerModifiers("super"), /ctrl, shift or alt/);
  assert.throws(() => DesktopComputerSchema.parse({ window: "a", action: "open_the_door" }));
});

test("every new tool is under the screen switch and refused under Lockdown", async (t) => {
  const { app } = await world(t);
  const names = ["desktop.mouse_down", "desktop.mouse_up", "desktop.hold_key", "desktop.cursor", "desktop.computer"];
  for (const name of names) {
    assert.ok(screenTools.includes(name), name);
    assert.ok(app.registry.names().includes(name), name);
  }
  setLockdown(app.store, app.runtime.owner, { on: true });
  for (const name of names) assert.match(lockdownToolRefusal(app.store, app.runtime.owner, name, app.registry.permissionOf(name)) ?? "", /Lockdown is on/, name);
});

test("the Windows script: held keys and buttons are always let go, and a press with no spot is checked to be over the window", () => {
  assert.match(desktopScript, /try \{\n      foreach \(var k in keys\) \{ keybd_event\(k, 0, 0u, IntPtr\.Zero\); pressed\+\+; \}\n      System\.Threading\.Thread\.Sleep\(ms\);\n    \} finally \{ for \(int i = pressed - 1/);
  const release = /'release' \{([\s\S]*?)\n  'zoom' \{/.exec(desktopScript)?.[1] ?? "";
  assert.doesNotMatch(release, /Get-Handle/, "letting go needs no window");
  const pointer = /'pointer' \{([\s\S]*?)\n  'zoom' \{/.exec(desktopScript)?.[1] ?? "";
  assert.match(pointer, /\$request\.atCurrent[\s\S]*?throw 'The pointer is not over that window/);
  assert.ok(pointer.indexOf("Assert-Uncovered $handle $from") < pointer.indexOf("ButtonDown("), "a press is checked before the button goes down");
  assert.match(pointer, /catch \{ \$spot = @\{ x = \[int\]\$request\.pressedAt\[0\]/, "a covered let-go spot lets go where it was pressed");
});

/* A fake xdotool: every call written down, the window in front unless a test says otherwise. */
function fakeX(options = {}) {
  const calls = [];
  const exec = async (_program, args) => {
    calls.push(args);
    if (args[0] === "getactivewindow") return { status: "completed", exitCode: 0, stdout: `${options.active ?? "42"}\n`, stderr: "" };
    if (args[0] === "getwindowgeometry") return { status: "completed", exitCode: 0, stdout: "WINDOW=42\nX=100\nY=50\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n", stderr: "" };
    if (args[0] === "getmouselocation") return { status: "completed", exitCode: 0, stdout: "X=300\nY=200\nSCREEN=0\nWINDOW=42\n", stderr: "" };
    return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

test("Linux: pointer verbs are xdotool argument lists, pressed only once the window is in front, inside the window", async () => {
  const box = { width: 800, height: 600 };
  assert.deepEqual(xdotoolPointerArgs({ kind: "click", at: { point: { x: 5, y: 6 } }, button: "right", count: 2, modifiers: ["ctrl"] }, "42", box),
    ["mousemove", "--window", "42", "5", "6", "keydown", "ctrl", "click", "--repeat", "2", "--delay", "80", "3", "keyup", "ctrl"]);
  assert.deepEqual(xdotoolPointerArgs({ kind: "scroll", at: {}, direction: "up", amount: 4, modifiers: [] }, "42", box),
    ["mousemove", "--window", "42", "400", "300", "click", "--repeat", "4", "--delay", "30", "4"]);
  assert.deepEqual(xdotoolPointerArgs({ kind: "down", atCurrent: true, button: "left" }, "42", box), ["mousedown", "1"]);
  assert.throws(() => xdotoolPointerArgs({ kind: "click", at: { point: { x: 900, y: 6 } } }, "42", box), /outside the window/);
  assert.throws(() => xdotoolPointerArgs({ kind: "click", at: { name: "Save" } }, "42", box), /not available on Linux/);
  const good = fakeX();
  const answer = await linuxPointer(good.exec, "xdotool", "pointer", { handle: "42", kind: "click", at: { point: { x: 5, y: 6 } }, button: "left", count: 1 }, AbortSignal.timeout(5000));
  assert.deepEqual(answer.at, [105, 56]);
  assert.deepEqual(good.calls.map((args) => args[0]), ["windowactivate", "getactivewindow", "getwindowgeometry", "mousemove"]);
  const covered = fakeX({ active: "99" });
  await assert.rejects(linuxPointer(covered.exec, "xdotool", "pointer", { handle: "42", kind: "click", at: {} }, AbortSignal.timeout(5000)), /in front of that one/);
  assert.equal(covered.calls.some((args) => args.includes("click") || args.includes("mousedown")), false, "nothing pressed");
});

test("Linux: hold_key always lets go, release needs no window, and the pointer's place is read without moving it", async () => {
  const x = fakeX();
  await linuxPointer(x.exec, "xdotool", "hold-key", { handle: "42", chord: "ctrl+a", ms: 100 }, AbortSignal.timeout(5000));
  assert.deepEqual(x.calls.filter((args) => args[0] === "keydown" || args[0] === "keyup"), [["keydown", "ctrl+a"], ["keyup", "ctrl+a"]]);
  const y = fakeX();
  await linuxPointer(y.exec, "xdotool", "release", { buttons: ["left"], chords: ["shift"] }, AbortSignal.timeout(5000));
  assert.deepEqual(y.calls, [["mouseup", "1", "keyup", "shift"]]);
  const z = fakeX();
  assert.deepEqual(await linuxPointer(z.exec, "xdotool", "cursor", { handle: "42" }, AbortSignal.timeout(5000)), { at: [300, 200], window: [200, 150], inside: true });
  assert.equal(z.calls.some((args) => args[0] === "mousemove"), false);
  assert.equal(xdotoolHoldChord("Ctrl+Enter"), "ctrl+Return");
  assert.throws(() => xdotoolHoldChord("super"), /Branch knows/);
  assert.deepEqual(parseShellGeometry("X=-5\nY=7\nWIDTH=10\nHEIGHT=20\n"), { x: -5, y: 7, width: 10, height: 20 });
});

test("the owner's own screenshot hides Branch through the host's lease and is refused while a password window shows", async (t) => {
  const { app } = await world(t);
  const root = await mkdtemp(join(tmpdir(), "branch-owner-shot-"));
  t.after(() => discardTemp(root));
  const calls = [], runner = standIn(root);
  let windows = [notepad];
  runner.run = async (action, payload) => { calls.push(action); if (action === "windows") return { windows }; await writeFile(payload.outPath, PNG); return { width: 1, height: 1 }; };
  const host = { acquire: async () => { calls.push("hide"); return { processId: 77, handles: ["101"] }; }, release: async () => { calls.push("show"); } };
  const desktop = new DesktopControl(app.store, { runner, banner: quietBanner, nativeCaptureLease: host });
  assert.deepEqual(await desktop.ownerShot(AbortSignal.timeout(5000)), PNG);
  assert.deepEqual(calls, ["windows", "hide", "screenshot", "show", "windows"]);
  windows = [notepad, { title: "Bitwarden", program: "Bitwarden", handle: "9", processId: 1, minimised: false }];
  await assert.rejects(desktop.ownerShot(AbortSignal.timeout(5000)), /handles passwords/);
});

test("Linux: a framed window's own area comes from xwininfo when there is one (xdotool counts the frame twice)", async () => {
  const { parseXwininfo } = await import("../dist/integrations/desktop-script-posix.js");
  assert.deepEqual(parseXwininfo("  Absolute upper-left X:  101\n  Absolute upper-left Y:  120\n  Relative upper-left X:  1\n"), { x: 101, y: 120 });
  assert.equal(parseXwininfo("nothing"), null);
  const calls = [];
  const exec = async (program, args) => {
    calls.push([program, args[0]]);
    if (program === "xwininfo") return { status: "completed", exitCode: 0, stdout: "Absolute upper-left X:  101\nAbsolute upper-left Y:  120\n", stderr: "" };
    if (args[0] === "getactivewindow") return { status: "completed", exitCode: 0, stdout: "42\n", stderr: "" };
    if (args[0] === "getwindowgeometry") return { status: "completed", exitCode: 0, stdout: "X=102\nY=140\nWIDTH=400\nHEIGHT=300\n", stderr: "" };
    if (args[0] === "getmouselocation") return { status: "completed", exitCode: 0, stdout: "X=191\nY=160\n", stderr: "" };
    return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual((await linuxPointer(exec, "xdotool", "cursor", { handle: "42" }, AbortSignal.timeout(5000), "xwininfo")).window, [90, 40]);
  const clicked = await linuxPointer(exec, "xdotool", "pointer", { handle: "42", kind: "click", at: { point: { x: 50, y: 60 } }, button: "left", count: 1 }, AbortSignal.timeout(5000), "xwininfo");
  assert.deepEqual(clicked.at, [151, 180]);
});
