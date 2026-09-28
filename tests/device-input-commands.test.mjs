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
