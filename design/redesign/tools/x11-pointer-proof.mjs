// computer-control: Branch's Linux pointer path (xdotool) against real X11 windows on a hidden virtual display (Xvfb :93
// inside WSL, never WSLg and never the owner's screen). Run by x11-proof.sh.
import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
const { DesktopScriptRunner } = await import(new URL("../../../dist/integrations/desktop-script.js", import.meta.url).href);

const runner = new DesktopScriptRunner(undefined, { platform: "linux", enabled: true, env: { DISPLAY: ":93" },
  locate: (name) => (name === "xdotool" ? "/tmp/bx/xdotool" : name === "xwininfo" ? "/tmp/bx/xwininfo" : null) });
const signal = () => AbortSignal.timeout(20000);
const log = (what, value) => console.log(`${what}: ${JSON.stringify(value)}`);
const events = (file) => readFileSync(file, "utf8");
const count = (text, pattern) => (text.match(pattern) ?? []).length;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const { windows } = await runner.run("windows", {}, signal());
log("windows", windows.map((w) => [w.handle, w.title]));
const tester = windows.find((w) => w.title === "Branch proof A");
check(!!tester, "the test window is listed by xdotool");
const handle = tester.handle;

const before = events("/tmp/bx/a.log");
log("right double click", await runner.run("pointer", { handle, kind: "click", at: { point: { x: 50, y: 60 } }, button: "right", count: 2, modifiers: [] }, signal()));
await wait(400);
let now = events("/tmp/bx/a.log").slice(before.length);
check(count(now, /ButtonPress event[\s\S]*?button 3,/g) === 2, "two right-button presses reached the window");
check(/ButtonPress event[\s\S]*?\(50,60\)/.test(now), "at the window point asked for (50, 60)");

let mark = events("/tmp/bx/a.log").length;
log("scroll down 2", await runner.run("pointer", { handle, kind: "scroll", at: {}, direction: "down", amount: 2, modifiers: [] }, signal()));
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(count(now, /ButtonPress event[\s\S]*?button 5,/g) === 2, "two wheel-down steps");

mark = events("/tmp/bx/a.log").length;
log("ctrl+click", await runner.run("pointer", { handle, kind: "click", at: { point: { x: 10, y: 10 } }, button: "left", count: 1, modifiers: ["ctrl"] }, signal()));
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(/KeyPress event[\s\S]*?Control_L[\s\S]*?ButtonPress event[\s\S]*?button 1,[\s\S]*?KeyRelease event[\s\S]*?Control_L/.test(now), "ctrl held around the click, then let go");

mark = events("/tmp/bx/a.log").length;
log("drag", await runner.run("pointer", { handle, kind: "drag", from: { point: { x: 20, y: 20 } }, to: { point: { x: 200, y: 150 } }, button: "left", modifiers: [] }, signal()));
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(/ButtonPress event[\s\S]*?\(20,20\)[\s\S]*?MotionNotify[\s\S]*?ButtonRelease event[\s\S]*?\(200,150\)/.test(now), "pressed at (20, 20), moved, let go at (200, 150)");

mark = events("/tmp/bx/a.log").length;
await runner.run("pointer", { handle, kind: "down", at: { point: { x: 30, y: 40 } }, button: "left" }, signal());
await runner.run("pointer", { handle, kind: "up", at: { point: { x: 90, y: 40 } }, button: "left" }, signal());
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(/ButtonPress event[\s\S]*?\(30,40\)[\s\S]*?ButtonRelease event[\s\S]*?\(90,40\)/.test(now), "left_mouse_down at (30, 40), left_mouse_up at (90, 40)");

mark = events("/tmp/bx/a.log").length;
await runner.run("hold-key", { handle, chord: "shift", ms: 300 }, signal());
await wait(300);
now = events("/tmp/bx/a.log").slice(mark);
check(/KeyPress event[\s\S]*?Shift_L[\s\S]*?KeyRelease event[\s\S]*?Shift_L/.test(now), "shift held, then let go");

const where = await runner.run("cursor", { handle }, signal());
log("cursor", where);
check(where.inside === true && where.window?.[0] === 90 && where.window?.[1] === 40, "the pointer's place, in the window's pixels (where mouse_up let go)");

// A second window: pointing into it brings it in front first (xdotool windowactivate, then the active window is checked).
const other = (await runner.run("windows", {}, signal())).windows.find((w) => w.title === "Branch proof B");
check(!!other, "a second window is open");
await runner.run("pointer", { handle: other.handle, kind: "move", at: { point: { x: 5, y: 5 } }, hoverMs: 0 }, signal());
const active = await runner.run("cursor", { handle: other.handle }, signal());
check(active.inside === true, "the pointer rests inside the second window after it was brought in front");
// Outside the window: refused before anything is pressed.
mark = events("/tmp/bx/a.log").length;
let refused = "";
try { await runner.run("pointer", { handle, kind: "click", at: { point: { x: 900, y: 10 } }, button: "left", count: 1, modifiers: [] }, signal()); } catch (error) { refused = error.message; }
await wait(300);
check(/outside the window/.test(refused) && !/ButtonPress/.test(events("/tmp/bx/a.log").slice(mark)), "a spot outside the window is refused, nothing pressed");
// A paired computer (`branch node` on Linux) doing the owner's clicks and keys from Branch's view: a spot is a share
// of the whole screen (1280 x 800 here), so it is checked by the root position xev reports.
const { NodeActions } = await import(new URL("../../../dist/devices/node/actions.js", import.meta.url).href);
const node = new NodeActions({ os: "linux", env: { DISPLAY: ":93" }, identityDir: "/nowhere" });
mark = events("/tmp/bx/a.log").length;
log("node click", await node.perform("input", { action: "click", x: 251.5 / 1280, y: 200.5 / 800 }, null));
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(/ButtonPress event[\s\S]*?button 1,[\s\S]*?root:\(251,200\)|ButtonPress event[\s\S]*?root:\(251,200\)[\s\S]*?button 1,/.test(now), "the node's click landed at the screen spot asked for (251, 200)");
mark = events("/tmp/bx/a.log").length;
await node.perform("input", { action: "scroll", x: 251.5 / 1280, y: 200.5 / 800, steps: 2 }, null);
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(count(now, /ButtonPress event[\s\S]*?button 5,/g) === 2, "the node's two wheel-down steps");
mark = events("/tmp/bx/a.log").length;
await node.perform("input", { action: "type", text: "hi" }, null);
await node.perform("input", { action: "key", chord: "ctrl+s" }, null);
await wait(400);
now = events("/tmp/bx/a.log").slice(mark);
check(/KeyPress event[\s\S]*?keysym 0x68, h\)[\s\S]*?KeyPress event[\s\S]*?keysym 0x69, i\)/.test(now), "the node typed h, i into the window under the click");
check(/KeyPress event[\s\S]*?Control_L[\s\S]*?KeyPress event[\s\S]*?keysym 0x73, s\)[\s\S]*?KeyRelease event[\s\S]*?Control_L/.test(now), "and pressed ctrl+s");
// Q1: while the owner holds it, the paired computer shows a notice on top with Stop; Stop there ends the hold.
const { execFileSync } = await import("node:child_process");
const notice = node.startNotice("Taofik");
check(await notice.shown === true, "the notice is up and kept above by wmctrl");
const noticeWindow = execFileSync("/tmp/bx/xdotool", ["search", "--name", "^Branch: being used$"], { env: process.env }).toString().trim().split(/\s+/)[0];
const state = execFileSync("/tmp/bx/xprop", ["-id", noticeWindow, "_NET_WM_STATE"], { env: process.env }).toString();
log("notice state", state.trim());
check(/_NET_WM_STATE_ABOVE/.test(state), "the notice is marked above every other window");
let stoppedWith = null;
void notice.stopped.then((why) => { stoppedWith = why; });
execFileSync("/tmp/bx/xdotool", ["windowactivate", "--sync", noticeWindow, "key", "Return"], { env: process.env });
for (let i = 0; i < 40 && !stoppedWith; i++) await wait(50);
check(stoppedWith === "Stop was pressed on this computer.", "pressing Stop on it ends the hold here");
const handedBack = node.startNotice("Taofik");
await handedBack.shown;
let saidBack = null; void handedBack.stopped.then((why) => { saidBack = why; });
handedBack.close();
await wait(400);
const left = (() => { try { return execFileSync("/tmp/bx/xdotool", ["search", "--name", "^Branch: being used$"], { env: process.env }).toString().trim(); } catch { return ""; } })();
check(left === "" && saidBack === null, "handing back takes the notice down, and that is not a Stop");
console.log("done", failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
