/**
 * computer-control: the commands a paired computer (`branch node`) runs for the owner's clicks and keys from Branch's
 * view. Nothing here moves a pointer: the commands are checked as argument lists, and on Windows the fixed script is
 * started once with an input it does nothing with, to prove it compiles and reads the screen's size.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  linuxInputCommand, parseScreenSize, sendKeysText, windowsInputCommand, windowsInputScript,
} from "../dist/devices/node/commands.js";
import { NodeActions, spawnRunner } from "../dist/devices/node/actions.js";
import { capabilityInfo, deviceTools } from "../dist/devices/capabilities.js";
import { parseDeviceArgs } from "../dist/devices/args.js";

const click = { action: "click", x: 0.5, y: 0.25, button: "right", count: 2 };

test("Linux: a spot is a share of the screen in pixels, and text and keys are their own arguments", () => {
  assert.deepEqual(linuxInputCommand(click, { width: 1920, height: 1080 }, null).args,
    ["mousemove", "--sync", "960", "270", "click", "--repeat", "2", "3"]);
  assert.deepEqual(linuxInputCommand({ action: "click", x: 1, y: 1, button: "left", count: 1 }, { width: 800, height: 600 }, null).args.slice(2, 4),
    ["799", "599"], "the far edge stays on the screen");
  assert.deepEqual(linuxInputCommand({ action: "scroll", x: 0, y: 0, steps: -3, button: "left", count: 1 }, { width: 10, height: 10 }, null).args.slice(4),
    ["click", "--repeat", "3", "4"], "up is button 4");
  assert.deepEqual(linuxInputCommand({ action: "type", text: "--help; rm -rf /", button: "left", count: 1 }, null, null).args,
    ["type", "--delay", "12", "--", "--help; rm -rf /"], "typed text is never read as an option");
  assert.deepEqual(linuxInputCommand({ action: "key", chord: "ctrl+s", button: "left", count: 1 }, null, "ctrl+s").args, ["key", "--clearmodifiers", "--", "ctrl+s"]);
  assert.throws(() => linuxInputCommand(click, null, null), /size of this computer's screen/);
  assert.deepEqual(parseScreenSize("1920 1080\n"), { width: 1920, height: 1080 });
  assert.equal(parseScreenSize("nonsense"), null);
});

test("Windows: the input travels in one environment value to a fixed, encoded script", () => {
  const command = windowsInputCommand({ action: "type", text: "a+b {x}\n", button: "left", count: 1 }, []);
  assert.equal(command.executable, "powershell.exe");
  assert.equal(command.args[2], "-EncodedCommand");
  assert.equal(Buffer.from(command.args[3], "base64").toString("utf16le"), windowsInputScript, "the script is the fixed one");
  assert.ok(!windowsInputScript.includes("a+b"), "the owner's words are not in the script");
  assert.equal(JSON.parse(command.env.BRANCH_NODE_INPUT).sendKeys, "a{+}b {{}x{}}{ENTER}");
  assert.equal(sendKeysText("100% ^_^ ~(ok)[1]\tx"), "100{%} {^}_{^} {~}{(}ok{)}{[}1{]}{TAB}x");
});

test("the arguments are checked before either computer acts, and only the owner's view can send them", async () => {
  assert.throws(() => parseDeviceArgs("input", { action: "click", x: 1.5, y: 0 }), /./);
  assert.throws(() => parseDeviceArgs("input", { action: "type" }), /missing what it needs/);
  assert.throws(() => parseDeviceArgs("input", { action: "key", chord: "ctrl+s; calc" }), /Name a key/);
  assert.throws(() => parseDeviceArgs("input", { action: "click", x: 0, y: 0, extra: 1 }), /./);
  assert.equal(capabilityInfo.input.ownerOnly, true);
  assert.ok(!deviceTools.includes("device.input"), "no task tool is registered for it");
  const ran = [];
  const node = (os, env = {}) => new NodeActions({ os, env, identityDir: "/nowhere", find: async () => true,
    runner: async (command) => { ran.push(command); return { code: 0, stdout: Buffer.from("1000 500"), stderr: "" }; } });
  await assert.rejects(node("linux", { WAYLAND_DISPLAY: "wayland-0" }).perform("input", { action: "click", x: 0.1, y: 0.1 }, null), /Wayland/);
  await assert.rejects(node("darwin").perform("input", { action: "click", x: 0.1, y: 0.1 }, null), /Windows and Linux/);
  assert.equal(ran.length, 0, "nothing ran for a computer that cannot");
  await node("linux").perform("input", { action: "click", x: 0.1, y: 0.2 }, null);
  assert.deepEqual(ran.map((command) => command.args.slice(0, 4)), [["getdisplaygeometry"], ["mousemove", "--sync", "100", "100"]]);
  assert.ok((await node("linux").available()).includes("input"), "offered on Linux where xdotool is found");
});

test("Windows: the fixed script compiles and reads the screen, with an input it does nothing with", { skip: process.platform !== "win32" }, async () => {
  const command = windowsInputCommand({ action: "none", button: "left", count: 1 }, []);
  const out = await spawnRunner(command, { timeoutMs: 60_000, maxBytes: 4096 });
  assert.equal(out.code, 0, out.stderr);
});

test("the paired computer's notice: the owner's name is its only text, and Stop or a notice that cannot show ends it", { timeout: 60000 }, async () => {
  const { noticeCommand, noticeText, noticeTitle, windowsNoticeScript, linuxNoticeAboveCommand } = await import("../dist/devices/node/commands.js");
  assert.equal(noticeText("Taofik\n\u0007"), "Being used from Branch by Taofik");
  assert.equal(noticeText(""), "Being used from Branch by its owner");
  const linux = noticeCommand("linux", "Taofik");
  assert.deepEqual([linux.executable, linux.args.at(-2), linux.args.at(-1), linux.input], ["xmessage", "-file", "-", "Being used from Branch by Taofik"], "the words come in as data");
  assert.deepEqual(linuxNoticeAboveCommand.args, ["-r", noticeTitle, "-b", "add,above"]);
  const windows = noticeCommand("win32", "O'Brien; Remove-Item");
  assert.equal(Buffer.from(windows.args[3], "base64").toString("utf16le"), windowsNoticeScript);
  assert.ok(windowsNoticeScript.includes("$f.TopMost=$true") && !windowsNoticeScript.includes("O'Brien"));
  assert.equal(windows.env.BRANCH_NODE_NOTICE, "Being used from Branch by O'Brien; Remove-Item");
  assert.equal(noticeCommand("darwin", "x"), null);

  const fakeProcess = () => { let exit, show; const p = { killed: false, exited: new Promise((d) => { exit = d; }), shown: new Promise((d) => { show = d; }), kill() { p.killed = true; exit(); } }; p.exit = () => exit(); p.show = () => show(); return p; };
  const made = [];
  const node = (os, aboveCode = 0) => new NodeActions({ os, identityDir: "/nowhere", spawnNotice: (command) => { const p = fakeProcess(); p.command = command; made.push(p); return p; },
    runner: async () => ({ code: aboveCode, stdout: Buffer.alloc(0), stderr: "" }) });
  // Windows: up once the window says it is shown; Stop (the program ending by itself) says so.
  const win = node("win32").startNotice("Taofik");
  made.at(-1).show();
  assert.equal(await win.shown, true);
  made.at(-1).exit();
  assert.equal(await win.stopped, "Stop was pressed on this computer.");
  // Handing back closes it, and that is not a Stop.
  const back = node("win32").startNotice("Taofik");
  let said = null; void back.stopped.then((why) => { said = why; });
  back.close();
  await new Promise((d) => setTimeout(d, 20));
  assert.equal(made.at(-1).killed, true);
  assert.equal(said, null);
  // Linux: up once wmctrl keeps it above; if it never can, the notice is closed and nothing is used.
  const lin = node("linux").startNotice("Taofik");
  assert.equal(await lin.shown, true);
  const never = node("linux", 1).startNotice("Taofik");
  assert.equal(await never.shown, false);
  assert.match(await never.stopped, /could not show on top/);
  assert.equal(made.at(-1).killed, true);
});

test("the paired computer takes no input unless the owner holds it and its notice is up; chords, not words, go in its log", { timeout: 60000 }, async (t) => {
  const { NodeClient } = await import("../dist/devices/node/client.js");
  const sent = [], log = [], performed = [];
  let events, closeSocket;
  const notices = [];
  const actions = { available: async () => ["input"], prepare: async () => undefined,
    perform: async (capability, args) => { performed.push(args); return { value: { done: args.action } }; },
    startNotice: (owner) => { let press; const n = { owner, open: true, shown: Promise.resolve(notices.upNext !== false), stopped: new Promise((d) => { press = d; }), close() { n.open = false; }, press: () => press("Stop was pressed on this computer.") }; notices.push(n); return n; } };
  const identity = { hub: "http://127.0.0.1:1", deviceId: "0123456789abcdef", never: [], privateKey: "", publicKey: "" };
  const client = new NodeClient({ identity, platform: "linux", actions, log: (line) => log.push(line), backoffBase: 100000,
    dial: async (_hub, _id, e) => { events = e; return { text: (v) => sent.push(v), binary() {}, close() { closeSocket(); }, closed: new Promise((d) => { closeSocket = d; }) }; } });
  const stop = new AbortController();
  t.after(() => stop.abort());
  const running = client.run(stop.signal);
  while (!events) await new Promise((d) => setTimeout(d, 5));
  const hub = (frame) => events.onText(JSON.stringify(frame));
  const invoke = async (args) => {
    const id = Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
    hub({ type: "invoke", id, capability: "input", args, deadline: Date.now() + 10000 });
    for (let i = 0; i < 100 && !sent.some((v) => v.id === id); i++) await new Promise((d) => setTimeout(d, 5));
    return sent.find((v) => v.id === id);
  };
  hub({ type: "welcome", deviceId: identity.deviceId, enabled: ["input"], folder: null });
  assert.match((await invoke({ action: "key", chord: "enter" })).error, /Nobody is using this computer/, "no hold, no input: refused here even if Branch asks");
  hub({ type: "driving", on: true, owner: "Taofik" });
  assert.equal(notices.length, 1);
  assert.equal((await invoke({ action: "key", chord: "ctrl+s" })).ok, true);
  assert.equal((await invoke({ action: "type", text: "my secret words" })).ok, true);
  assert.ok(log.some((line) => /pressed ctrl\+s here/.test(line)), "the chord is in this computer's log");
  assert.ok(!log.some((line) => /secret words/.test(line)), "typed words are not");
  notices[0].press();
  for (let i = 0; i < 100 && !sent.some((v) => v.type === "hold-stopped"); i++) await new Promise((d) => setTimeout(d, 5));
  assert.equal(sent.find((v) => v.type === "hold-stopped").reason, "Stop was pressed on this computer.", "Branch is told");
  assert.match((await invoke({ action: "key", chord: "enter" })).error, /Stop was pressed here/);
  // A notice that never comes up: nothing is typed.
  notices.upNext = false;
  hub({ type: "driving", on: true, owner: "Taofik" });
  assert.match((await invoke({ action: "type", text: "x" })).error, /Nobody is using this computer/);
  // Switching it off takes the notice down.
  notices.upNext = true;
  hub({ type: "driving", on: false, owner: "Taofik" });
  hub({ type: "driving", on: true, owner: "Taofik" });
  assert.equal(client.held(), true);
  hub({ type: "enabled", enabled: [], folder: null });
  assert.equal(client.held(), false);
  assert.equal(notices.at(-1).open, false);
  assert.equal(performed.length, 2, "only the two inputs made while the notice was up were done");
  stop.abort();
  await running;
});

test("Windows: the notice script parses, checked by PowerShell's own parser without running it (no window here)", { skip: process.platform !== "win32" }, async () => {
  const { windowsNoticeScript } = await import("../dist/devices/node/commands.js");
  const check = "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:BRANCH_CHECK,[ref]$null,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}";
  const run = (script) => spawnRunner({ executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", check], env: { BRANCH_CHECK: script } }, { timeoutMs: 60_000, maxBytes: 4096 });
  const out = await run(windowsNoticeScript);
  assert.equal(out.code, 0, out.stdout.toString());
  assert.notEqual((await run(windowsNoticeScript.replace("$f.Controls.Add($b)", "$f.Controls.Add($b"))).code, 0, "a broken script is caught");
});
