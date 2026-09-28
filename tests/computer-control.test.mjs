/**
 * computer-control: the whole pointer for a task (desktop.click with button and count, desktop.move, desktop.drag,
 * desktop.scroll, desktop.zoom, desktop.wait, desktop.key repeat), element refs and the frame binding of a picture's
 * points (src/integrations/desktop.ts), bound by the same switch, Stop, "You're driving", Lockdown and allowance as every
 * screen action. Every screen here is a stand-in: an injected runner answers as the Windows script does and writes each
 * request down, so nothing reaches this computer's real screen, keyboard or windows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { saveDesktopSettings, DesktopClickSchema, DesktopDragSchema, DesktopScrollSchema, DesktopZoomSchema, DesktopWaitSchema } from "../dist/integrations/desktop-config.js";
import { desktopScript, DesktopScriptRunner } from "../dist/integrations/desktop-script.js";
import { screenTools } from "../dist/feature-switches.js";
import { lockdownToolRefusal, setLockdown } from "../dist/lockdown.js";

const quietBanner = { visible: false, show: async () => undefined, hide: async () => undefined };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const notepad = { title: "notes.txt - Notepad", program: "notepad", handle: "7", processId: 4242, minimised: false };
const branchWindow = { title: "Branch Agent", program: "Branch Agent", handle: "9", processId: process.pid, minimised: false };
const launcher = { title: "Terminal", program: "WindowsTerminal", handle: "11", processId: process.ppid, minimised: false };

/** A screen that is not there: every request is written down and answered as the Windows script answers it. */
function standIn(root) {
  const calls = [];
  const state = { bounds: { x: 100, y: 50, w: 800, h: 600 }, method: "window" };
  const runner = {
    calls, state,
    liveProcess: () => null,
    async temporaryPng(name) { return join(root, `${name}.png`); },
    async run(action, payload) {
      calls.push([action, payload]);
      if (action === "windows") return { windows: [notepad, branchWindow, launcher] };
      if (action === "screenshot") { await writeFile(payload.outPath, PNG); return { width: 800, height: 600, method: "window", title: notepad.title, bounds: state.bounds }; }
      if (action === "read") return { nodes: [{ role: "Button", name: "Save", value: "", enabled: true, ref: "42.7.1", box: [10, 20, 60, 24] },
        { role: "List", name: "Files", value: "", enabled: true, ref: "not a ref", box: [1, 2] }], more: false, title: notepad.title, bounds: state.bounds };
      if (action === "click") return payload.name ? { how: "invoke", name: payload.name, at: [140, 90] } : { how: "point", name: "", at: [100 + payload.x, 50 + payload.y] };
      if (action === "pointer") return { how: payload.kind === "scroll" && payload.at?.name ? "scroll-pattern" : payload.kind, at: [300, 200], title: notepad.title };
      if (action === "zoom") { await writeFile(payload.outPath, PNG); return { width: payload.region.width * payload.scale, height: payload.region.height * payload.scale, scale: payload.scale, method: state.method, title: notepad.title }; }
      if (action === "key") return { sent: payload.keys };
      return {};
    },
    async close() {},
  };
  return runner;
}
async function world(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-computer-control-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true, ...settings });
  const runner = standIn(root);
  const desktop = new DesktopControl(app.store, { runner, banner: quietBanner });
  desktop.artifacts = app.runtime.artifacts ?? desktop.artifacts;
  const run = app.store.createRun(app.runtime.owner, "use the screen");
  const context = (extra = {}) => ({ ...app.runtime.context({ runId: run.id }), signal: new AbortController().signal, trunk: "trunk-ada", ...extra });
  const acted = () => runner.calls.filter(([action]) => action !== "windows");
  return { app, root, runner, desktop, run, context, acted };
}

test("every verb of the pointer reaches the Windows script as its own request, and a plain named click keeps UI Automation", async (t) => {
  const { desktop, context, acted, run } = await world(t);
  await desktop.click({ window: "Notepad", name: "Save" }, context());
  await desktop.click({ window: "Notepad", name: "Save", button: "right" }, context());
  await desktop.click({ window: "Notepad", point: { x: 5, y: 6 }, count: 2, modifiers: ["ctrl"] }, context());
  await desktop.click({ window: "Notepad", ref: "42.7.1", count: 3 }, context());
  await desktop.move({ window: "Notepad", name: "Save", hoverMs: 300 }, context());
  await desktop.drag({ window: "Notepad", from: { name: "Save" }, to: { point: { x: 400, y: 300 } } }, context());
  await desktop.scroll({ window: "Notepad", name: "Files", direction: "down", amount: 4 }, context());
  await desktop.scroll({ window: "Notepad", direction: "left" }, context());
  await desktop.key({ window: "Notepad", chord: "down", repeat: 3 }, context());
  const sent = acted().map(([action, payload]) => ({ action, ...payload }));
  assert.deepEqual(sent[0], { action: "click", handle: "7", name: "Save" }, "a plain left click on a name is pressed, not pointed at");
  assert.deepEqual(sent[1], { action: "pointer", handle: "7", kind: "click", at: { name: "Save" }, button: "right", count: 1, modifiers: [] });
  assert.deepEqual(sent[2], { action: "pointer", handle: "7", kind: "click", at: { point: { x: 5, y: 6 } }, button: "left", count: 2, modifiers: ["ctrl"] });
  assert.deepEqual(sent[3], { action: "pointer", handle: "7", kind: "click", at: { ref: "42.7.1" }, button: "left", count: 3, modifiers: [] });
  assert.deepEqual(sent[4], { action: "pointer", handle: "7", kind: "move", at: { name: "Save" }, hoverMs: 300 });
  assert.deepEqual(sent[5], { action: "pointer", handle: "7", kind: "drag", from: { name: "Save" }, to: { point: { x: 400, y: 300 } }, button: "left", modifiers: [] });
  assert.deepEqual(sent[6], { action: "pointer", handle: "7", kind: "scroll", at: { name: "Files" }, direction: "down", amount: 4, modifiers: [] });
  assert.deepEqual(sent[7], { action: "pointer", handle: "7", kind: "scroll", at: {}, direction: "left", amount: 3, modifiers: [] });
  assert.deepEqual(sent[8], { action: "key", handle: "7", keys: "{DOWN}{DOWN}{DOWN}" });
  // Each one is written down, and the Trunk's cursor is where the newest landed, for the owner's live view.
  const actions = desktop["store"].events(run.id).filter((e) => e.kind === "desktop.action").map((e) => [e.data.tool, e.data.how ?? ""]);
  assert.deepEqual(actions.slice(0, 4), [["desktop.click", "invoke"], ["desktop.click", "right-click"], ["desktop.click", "double-click"], ["desktop.click", "triple-click"]]);
  assert.deepEqual(actions.slice(4, 8).map(([tool]) => tool), ["desktop.move", "desktop.drag", "desktop.scroll", "desktop.scroll"]);
  assert.deepEqual([desktop.pointer().x, desktop.pointer().y, desktop.pointer().trunk], [300, 200, "trunk-ada"]);
});

test("a point taken from a picture is bound to where the window was: another window's or another task's picture is refused", async (t) => {
  const { desktop, context, runner, app } = await world(t);
  const shot = await desktop.screenshot({ window: "Notepad" }, context());
  assert.match(shot.shot, /^[a-f0-9]{16}$/);
  await desktop.click({ window: "Notepad", point: { x: 20, y: 30 }, shot: shot.shot }, context());
  const [, payload] = runner.calls.findLast(([action]) => action === "pointer");
  assert.deepEqual(payload.expect, { x: 100, y: 50, w: 800, h: 600 }, "the script refuses once the window is no longer there");
  const reading = await desktop.read({ window: "Notepad" }, context());
  assert.deepEqual(reading.parts.map((p) => [p.ref ?? null, p.box ?? null]), [["42.7.1", [10, 20, 60, 24]], [null, null]], "a ref that is not one is dropped");
  await desktop.zoom({ window: "Notepad", region: { x: 0, y: 0, width: 100, height: 40 }, shot: reading.shot }, context());
  assert.deepEqual(runner.calls.findLast(([action]) => action === "zoom")[1].expect, { x: 100, y: 50, w: 800, h: 600 });
  await assert.rejects(desktop.click({ window: "Notepad", point: { x: 1, y: 1 }, shot: "0123456789abcdef" }, context()), /not one this task took/);
  const other = app.store.createRun(app.runtime.owner, "another task");
  await assert.rejects(desktop.click({ window: "Notepad", point: { x: 1, y: 1 }, shot: shot.shot }, { ...context(), runId: other.id }), /not one this task took/);
  const before = runner.calls.length;
  await desktop.closeRun({ runId: context().runId });
  await assert.rejects(desktop.move({ window: "Notepad", point: { x: 1, y: 1 }, shot: shot.shot }, context()), /not one this task took/, "a finished task's pictures are forgotten");
  assert.equal(runner.calls.slice(before).filter(([action]) => action === "pointer").length, 0, "nothing was sent for a refused point");
});

test("Branch's own windows (this program's and its parent's, the desktop app's main process) are never a target", async (t) => {
  const { desktop, context, acted } = await world(t);
  await assert.rejects(desktop.click({ window: "Branch Agent", name: "Allow" }, context()), /Branch's own/);
  await assert.rejects(desktop.drag({ window: "Terminal", from: { point: { x: 1, y: 1 } }, to: { point: { x: 9, y: 9 } } }, context()), /Branch's own/);
  await assert.rejects(desktop.type({ window: "Branch Agent", text: "yes" }, context()), /Branch's own/);
  assert.deepEqual(acted(), [], "nothing reached either window");
});

test("the switch, Stop and the allowance bind every new verb; wait ends at once on Stop and uses no allowance", async (t) => {
  const { desktop, context, app, acted } = await world(t, { maxActionsPerRun: 3 });
  await desktop.wait({ seconds: 0.1 }, context());
  await desktop.move({ window: "Notepad", point: { x: 1, y: 1 } }, context());
  await desktop.scroll({ window: "Notepad", direction: "up" }, context());
  await desktop.wait({ seconds: 0.1 }, context());
  await desktop.drag({ window: "Notepad", from: { point: { x: 1, y: 1 } }, to: { point: { x: 2, y: 2 } } }, context());
  await assert.rejects(desktop.zoom({ window: "Notepad", region: { x: 0, y: 0, width: 10, height: 10 } }, context()), /used the screen 3 times/);
  assert.equal(acted().length, 3, "three screen actions, the waits not counted");
  const waiting = desktop.wait({ seconds: 30 }, context());
  const started = Date.now();
  desktop.stop(context().runId);
  await assert.rejects(waiting, /stopped/);
  assert.ok(Date.now() - started < 2000, "Stop ended the wait at once");
  await assert.rejects(desktop.wait({ seconds: 0.1 }, context()), /Stop/);
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: false });
  const fresh = app.store.createRun(app.runtime.owner, "again");
  await assert.rejects(desktop.move({ window: "Notepad", point: { x: 1, y: 1 } }, { ...context(), runId: fresh.id }), /switched off|Settings/i);
  await assert.rejects(desktop.wait({ seconds: 0.1 }, { ...context(), runId: fresh.id }), /switched off|Settings/i);
});

test("while the owner drives, a drag waits and happens only after Hand back; a wait that saw the owner take over says so", async (t) => {
  const { desktop, context, acted } = await world(t);
  desktop.takeOver();
  let done = false;
  const drag = desktop.drag({ window: "Notepad", from: { point: { x: 1, y: 1 } }, to: { point: { x: 5, y: 5 } } }, context()).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(done, false);
  assert.deepEqual(acted(), [], "nothing moved while the owner drove");
  desktop.handBack();
  await drag;
  assert.equal(acted().length, 1);
  const waiting = desktop.wait({ seconds: 0.3 }, context());
  desktop.takeOver();
  await assert.rejects(waiting, /took over/);
  desktop.handBack();
});

test("Lockdown refuses every screen tool, the new ones included, and each is under the screen switch", async (t) => {
  const { app } = await world(t);
  const names = ["desktop.move", "desktop.drag", "desktop.scroll", "desktop.zoom", "desktop.wait"];
  for (const name of names) {
    assert.ok(screenTools.includes(name), `${name} goes with the screen switch`);
    assert.ok(app.registry.names().includes(name), `${name} is registered`);
    assert.equal(lockdownToolRefusal(app.store, app.runtime.owner, name, app.registry.permissionOf(name)), null);
  }
  setLockdown(app.store, app.runtime.owner, { on: true });
  for (const name of [...names, "desktop.click", "desktop.key"])
    assert.match(lockdownToolRefusal(app.store, app.runtime.owner, name, app.registry.permissionOf(name)) ?? "", /Lockdown is on/, name);
  assert.deepEqual(names.map((name) => app.registry.permissionOf(name)), ["desktop.control", "desktop.control", "desktop.control", "desktop.view", "desktop.view"]);
});

test("the tools' inputs: one spot each, bounded amounts, and refs only as desktop.read gives them", () => {
  assert.throws(() => DesktopClickSchema.parse({ window: "a", name: "x", point: { x: 1, y: 1 } }));
  assert.throws(() => DesktopClickSchema.parse({ window: "a" }));
  assert.throws(() => DesktopClickSchema.parse({ window: "a", ref: "1.2; rm" }));
  assert.throws(() => DesktopClickSchema.parse({ window: "a", name: "x", count: 4 }));
  assert.throws(() => DesktopClickSchema.parse({ window: "a", name: "x", modifiers: ["win"] }));
  assert.deepEqual(DesktopClickSchema.parse({ window: "a", ref: "-5.12.3" }), { window: "a", ref: "-5.12.3", button: "left", count: 1 });
  assert.throws(() => DesktopDragSchema.parse({ window: "a", from: { name: "x" }, to: {} }));
  assert.throws(() => DesktopScrollSchema.parse({ window: "a", direction: "down", amount: 11 }));
  assert.throws(() => DesktopScrollSchema.parse({ window: "a", direction: "down", name: "x", ref: "1" }));
  assert.throws(() => DesktopZoomSchema.parse({ window: "a", region: { x: 0, y: 0, width: 2, height: 2 } }));
  assert.throws(() => DesktopWaitSchema.parse({ seconds: 31 }));
  assert.throws(() => DesktopWaitSchema.parse({ seconds: 0 }));
});

test("a whole-screen picture hides Branch's own windows through the host's lease, and still works without a host", async (t) => {
  const { app, root } = await world(t);
  const calls = [];
  const host = { acquire: async (id) => { calls.push(["acquire", id]); return { processId: 77, handles: ["101"] }; }, release: async (id) => { calls.push(["release", id]); } };
  const runner = standIn(root);
  runner.run = async (action, payload) => { calls.push([action]); if (action === "windows") return { windows: [notepad] }; await writeFile(payload.outPath, PNG); return { width: 10, height: 10 }; };
  const desktop = new DesktopControl(app.store, { runner, banner: quietBanner, nativeCaptureLease: host });
  desktop.artifacts = app.runtime.artifacts;
  const run = app.store.createRun(app.runtime.owner, "look");
  const context = () => ({ ...app.runtime.context({ runId: run.id }), signal: new AbortController().signal });
  await desktop.screenshot({}, context());
  assert.deepEqual(calls.map(([what]) => what).filter((what) => what !== "windows"), ["acquire", "screenshot", "release"], "hidden before the picture, shown again after");
  assert.equal(calls.find(([what]) => what === "acquire")[1], calls.find(([what]) => what === "release")[1]);
  host.acquire = async () => { throw new Error("Excluding Branch from this view needs Windows 10 version 2004 or newer."); };
  calls.length = 0;
  await desktop.screenshot({}, context());
  assert.deepEqual(calls.map(([what]) => what).filter((what) => what !== "windows"), ["screenshot"], "no host proof: taken as before, nothing released");
});

test("a close-up is enlarged when small, says how to map it back, and one copied off the screen is checked for password windows", async (t) => {
  const { desktop, context, runner } = await world(t);
  const small = await desktop.zoom({ window: "Notepad", region: { x: 40, y: 10, width: 100, height: 50 } }, context());
  assert.equal(small.scale, 4);
  assert.match(small.points, /\(40 \+ a\/4, 10 \+ b\/4\)/);
  const large = await desktop.zoom({ window: "Notepad", region: { x: 0, y: 0, width: 700, height: 500 } }, context());
  assert.equal(large.scale, 1);
  runner.state.method = "screen";
  const windowsBefore = runner.calls.filter(([action]) => action === "windows").length;
  await desktop.zoom({ window: "Notepad", region: { x: 0, y: 0, width: 50, height: 50 } }, context());
  assert.ok(runner.calls.filter(([action]) => action === "windows").length > windowsBefore + 1, "the screen was checked for password windows again");
});

test("the Windows script: DPI aware, refs searched inside the window, nothing clicked where another window covers it, held keys always let go", () => {
  assert.match(desktopScript, /SetProcessDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/, "per-monitor aware before any window is read");
  assert.match(desktopScript, /RuntimeIdProperty, \$ids\)\n  return \$root\.FindFirst\(\[System\.Windows\.Automation\.TreeScope\]::Subtree/);
  const pointer = /'pointer' \{([\s\S]*?)\n  'zoom' \{/.exec(desktopScript)?.[1] ?? "";
  assert.ok(pointer, "the pointer verb is there");
  const covered = pointer.indexOf("Assert-Uncovered $handle $from"), first = Math.min(...["::Press(", "::Drag(", "::WheelAt(", "SetCursorPos($from"].map((call) => pointer.indexOf(call)).filter((at) => at >= 0));
  assert.ok(covered > 0 && covered < first, "the spot is checked before anything is pressed, dragged, turned or moved");
  assert.ok(pointer.indexOf("Assert-Uncovered $handle $to") < pointer.indexOf("::Drag("), "a drag's end is checked too");
  assert.match(pointer, /\} finally \{\n      \[BranchDesktop\]::Hold\(\$mods, \$false\)/, "held keys are let go even when the action fails");
  assert.ok(pointer.indexOf("Assert-Seen $handle") < pointer.indexOf("Bring-Forward"), "a moved window is refused before it is even brought forward");
  assert.match(desktopScript, /if \(\[BranchDesktop\]::RootAt\(\$at\.x, \$at\.y\) -ne \$handle\) \{ throw/);
  assert.match(desktopScript, /mouse_event\(Down\(button\), 0, 0, 0, IntPtr\.Zero\);\n    try \{[^\n]*\}\n    finally \{ mouse_event\(Up\(button\)/, "a drag always lets the button go");
  assert.doesNotMatch(pointer, /\$home\b/, "PowerShell's read-only $HOME is never assigned");
  // The old click and the owner's wheel through the view check what is on top too, before every press of the pointer.
  const click = /'click' \{([\s\S]*?)\n  'scroll' \{/.exec(desktopScript)?.[1] ?? "";
  const presses = click.split("[BranchDesktop]::Click(").length - 1;
  const checked = click.split(/Assert-Uncovered \$handle [^\n]*\n\s*\[BranchDesktop\]::Click\(/).length - 1;
  assert.deepEqual([presses, checked], [3, 3], "every pointer press of desktop.click");
  assert.match(desktopScript, /Assert-Uncovered \$handle \$point\n    \[BranchDesktop\]::Wheel\(/);
});

test("off Windows: Linux takes the pointer verbs through xdotool, a Mac says it cannot yet, and close-ups are Windows only", async () => {
  const mac = new DesktopScriptRunner(undefined, { platform: "darwin", enabled: true });
  await assert.rejects(mac.run("pointer", { handle: "1", kind: "click" }, AbortSignal.timeout(1000)), /Windows and on Linux/);
  await assert.rejects(mac.run("hold-key", { handle: "1" }, AbortSignal.timeout(1000)), /Windows and on Linux/);
  const linux = new DesktopScriptRunner(undefined, { platform: "linux", enabled: true, env: {} });
  await assert.rejects(linux.run("zoom", { handle: "1" }, AbortSignal.timeout(1000)), /Close-ups work on Windows/);
  await assert.rejects(linux.run("pointer", { handle: "1", kind: "click" }, AbortSignal.timeout(1000)), /no desktop session/, "on Linux the pointer goes to xdotool, which says what it needs");
});

test("reading a window takes each part in one round trip and keeps to a time budget", () => {
  const read = /function Read-Tree\(\$root, \$limit\) \{([\s\S]*?)\n\}\n/.exec(desktopScript)?.[1] ?? "";
  assert.match(desktopScript, /New-Object System\.Windows\.Automation\.CacheRequest/, "a cache request gathers each part's properties at once");
  assert.match(read, /\$clock\.ElapsedMilliseconds -gt 8000/, "the walk stops at its budget and says there is more");
  assert.match(read, /FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Children/, "children come in one call, not one per sibling");
  assert.doesNotMatch(read, /GetNextSibling/, "no walk sibling by sibling");
  const node = /function Read-Node\(\$node\) \{([\s\S]*?)\n\}\n/.exec(desktopScript)?.[1] ?? "";
  assert.doesNotMatch(node, /\.Current\.|TryGetCurrentPattern/, "a part's properties come from the cache, never one call each");
});

test("a spot off every screen is refused before the pointer moves, and a name finds the part that can be pressed", () => {
  const uncovered = /function Assert-Uncovered\(\$handle, \$at\) \{([\s\S]*?)\n\}/.exec(desktopScript)?.[1] ?? "";
  assert.ok(uncovered.indexOf("AllScreens") >= 0 && uncovered.indexOf("AllScreens") < uncovered.indexOf("RootAt"), "on a screen first, then on top");
  const named = /function Find-Named\(\$root, \$name\) \{([\s\S]*?)\n\}/.exec(desktopScript)?.[1] ?? "";
  assert.match(named, /IsInvokePatternAvailableProperty/, "the pressable part with that name is preferred to its container");
});
