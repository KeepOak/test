/**
 * Setup › Keep it running: "Start with Windows" / "Start when you log in" through POST /api/deployment/autostart.
 * The registry tool is always a stand-in here (the RunTool the autostart module takes), so this computer's real
 * sign-in list is never read or written; the Mac login item is a stand-in for what the desktop app hands in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appRuntime, deploymentApi, noSignInStartHereWords } from "../dist/deployment-api.js";
import { macLoginItemsLink } from "../dist/install/autostart.js";
import { runKey, runValueName } from "../dist/install/installer.js";
import { macLoginItem } from "../dist/desktop/login-item.js";

const exe = "C:\\Users\\pat\\AppData\\Local\\Programs\\Branch Agent\\Branch Agent.exe";
function registry() {
  const values = new Map(), calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    const [verb, key] = args;
    assert.equal(key, runKey, "only the per-person sign-in list");
    const name = args[args.indexOf("/v") + 1];
    if (verb === "query") { if (!values.has(name)) throw new Error("not found"); return `\r\n${key}\r\n    ${name}    REG_SZ    ${values.get(name)}\r\n`; }
    if (verb === "add") { values.set(name, args[args.indexOf("/d") + 1]); return ""; }
    if (verb === "delete") { values.delete(name); return ""; }
    throw new Error(verb);
  };
  return { values, calls, deps: { run, systemRoot: "C:\\Windows" } };
}
const context = (overrides) => ({ dataDir: "/nowhere", workspace: "/nowhere", port: 0, executable: exe, installRoot: "C:\\x", remote: { status: () => ({}) }, ...overrides });
const post = (ctx, platform, body) => deploymentApi({ version: "1" }, { method: "POST", url: "/", headers: {} }, "/api/deployment/autostart", ctx, async () => body, () => {}, { platform });

test("Windows: switching it on and off writes and removes Branch's line in the per-person sign-in list, and answers what is there", async () => {
  const reg = registry();
  const on = await post(context({ autostartDeps: reg.deps }), "win32", { enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.available, true);
  assert.equal(on.needsApproval, false);
  assert.equal(reg.values.get(runValueName), `"${exe}" --start-minimized`, "the installed program, opening to the tray");
  assert.ok(reg.calls.every(([file]) => file === "C:\\Windows\\System32\\reg.exe"));
  const off = await post(context({ autostartDeps: reg.deps }), "win32", { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(reg.values.has(runValueName), false);
});

test("a source checkout has no program to register, so it is refused in the engine's words and nothing is run", async () => {
  const reg = registry();
  await assert.rejects(post(context({ executable: null, autostartDeps: reg.deps }), "win32", { enabled: true }), /has to be installed on this computer before it can start with Windows\.$/);
  assert.deepEqual(reg.calls, []);
});

test("the background engine, run by the installed app's own program in node mode, can still switch it on", async () => {
  const reg = registry();
  const ctx = context({ executable: null, installRoot: null, autostartDeps: reg.deps });
  const post2 = (appRuntime, body) => deploymentApi({ version: "1" }, { method: "POST", url: "/", headers: {} }, "/api/deployment/autostart", ctx, async () => body, () => {}, { platform: "win32", appRuntime });
  const on = await post2(exe, { enabled: true });
  assert.equal(on.available, true);
  assert.equal(reg.values.get(runValueName), `"${exe}" --start-minimized`, "the app's program, never node");
  const calls = reg.calls.length;
  await assert.rejects(post2(null, { enabled: true }), /has to be installed/);
  assert.equal(reg.calls.length, calls, "a plain runtime runs nothing");
});

test("only the installed app's program counts as its runtime: not plain Node, not Electron from a checkout", () => {
  const app = "C:\\Users\\pat\\AppData\\Local\\Programs\\Branch Agent\\Branch Agent.exe";
  assert.equal(appRuntime({ ELECTRON_RUN_AS_NODE: "1" }, { electron: "44.3.0" }, app), app);
  assert.equal(appRuntime({}, { electron: "44.3.0" }, app), null, "the app's window runs its engine in-process and says where it is");
  assert.equal(appRuntime({ ELECTRON_RUN_AS_NODE: "1" }, {}, "C:\\Program Files\\nodejs\\node.exe"), null);
  assert.equal(appRuntime({ ELECTRON_RUN_AS_NODE: "1" }, { electron: "44.3.0" }, "C:\\src\\Branch\\node_modules\\electron\\dist\\electron.exe"), null);
});

test("a Mac uses the app's login item, and says when macOS wants it approved in Login Items", async () => {
  const reg = registry();
  let on = false;
  const loginItem = { read: () => ({ enabled: on, needsApproval: on }), set: (enabled) => { on = enabled; return loginItem.read(); } };
  const view = await post(context({ autostartDeps: reg.deps, loginItem }), "darwin", { enabled: true });
  assert.deepEqual([view.enabled, view.needsApproval, view.settingsLink, view.available], [true, true, macLoginItemsLink, true]);
  assert.deepEqual(reg.calls, [], "a Mac never runs reg.exe");
});

test("a Mac or Linux engine without a login item says it cannot, and never runs reg.exe", async () => {
  for (const platform of ["darwin", "linux"]) {
    const reg = registry();
    await assert.rejects(post(context({ autostartDeps: reg.deps }), platform, { enabled: true }), new RegExp(noSignInStartHereWords.replace(/\./g, "\\.")));
    assert.deepEqual(reg.calls, [], platform);
  }
});

test("the desktop app's login item reads macOS's own status and asks for nothing when read", () => {
  const set = [];
  let settings = { openAtLogin: false, status: "not-registered" };
  const item = macLoginItem({ getLoginItemSettings: () => settings, setLoginItemSettings: (s) => { set.push(s); settings = { openAtLogin: false, status: "requires-approval" }; } });
  assert.deepEqual(item.read(), { enabled: false, needsApproval: false });
  assert.deepEqual(set, [], "reading changes nothing");
  assert.deepEqual(item.set(true), { enabled: true, needsApproval: true }, "waiting for approval still counts as on");
  assert.deepEqual(set, [{ openAtLogin: true }]);
  settings = { openAtLogin: true, status: "enabled" };
  assert.deepEqual(item.read(), { enabled: true, needsApproval: false });
});
