import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { isSoon, openSettingsPage, settingsWindow } from "./settings-window.mjs";
import { createBranch, saveDesktopSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { DesktopBanner, noBannerRefusal, screenControlParts } from "../dist/integrations/desktop-banner.js";
import { DesktopScriptRunner } from "../dist/integrations/desktop-script.js";
import { bannerPage, bannerWindowOptions, electronBannerWindow, stopAddress } from "../dist/desktop/banner-window.js";
import { VoiceService, systemVoiceWords, ttsRouteFor } from "../dist/voice-service.js";
import { microphoneHelp, systemVoices, voicePlan, whereAudioGoes } from "../dist/voice-api.js";
import { VoiceSettingsSchema, saveVoiceSettings, voiceSettings } from "../dist/voice.js";
import { modeOf, sentFields, settleSwitch, switchedToolTiers } from "../dist/feature-switches.js";
import { readDesktopSettings } from "../dist/integrations/desktop-config.js";
import { readKeychainSettings, saveKeychainSettings } from "../dist/vault-sources.js";
import { keychainApi, permissionsContext } from "../dist/keychain-api.js";
import { linuxConsent, probeReader } from "../dist/os-permissions.js";
import { Store } from "../dist/store.js";
import { migrateFeatureSwitches, migrationKey } from "../dist/feature-switch-migration.js";
import { optionalFields } from "../dist/feature-switches.js";
import { BriefSettingsSchema } from "../dist/brief.js";
import { meteringSettings, saveMeteringSettings } from "../dist/metering.js";
import { readAttachSettings, saveAttachSettings } from "../dist/integrations/browser-attach.js";
import { readPolicy, savePolicy } from "../dist/policy.js";

/**
 * Wave mac2: the Stop notice, the voice list and the permission screens on a Mac and on Linux.
 * Every window here is a stand-in object and every program a function that records what it was
 * asked: nothing is shown, spoken, or asked of the real Keychain.
 */
const sayVoices = "Albert              en_US    # Hello! My name is Albert.\nAmélie              fr_CA    # Bonjour, je m’appelle Amélie.\n";

/**
 * A fresh app in a temporary folder. Whatever else a test opens (a server, a browser, a screen
 * control) is handed to `closeFirst`, so one hook closes it, then the app, then deletes the folder.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mac2-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await app.close();
    await discardTemp(root);
  });
  return { app, root, closeFirst: (close) => closers.push(close) };
}

/** An app with its server and a headless browser page, all closed before the folder goes. */
async function pageFixture(t) {
  const f = await fixture(t);
  const server = await startServer(f.app, { dataDir: join(f.root, "data"), port: 0 });
  f.closeFirst(() => server.close());
  const browser = await chromium.launch({ headless: true });
  f.closeFirst(() => browser.close());
  return { ...f, server, page: await browser.newPage() };
}

/** A pretend macOS runner: every call is written down and answered with one window. */
function fakeMac() {
  const calls = [];
  const exec = async (executable, args) => {
    calls.push({ executable, args });
    return { status: "completed", exitCode: 0, stderr: "",
      stdout: JSON.stringify({ ok: true, result: { windows: [{ handle: "501:1", title: "Notes", program: "Notes", processId: 501, minimised: false, width: 800, height: 600 }] } }) };
  };
  return { calls, exec };
}

/** A pretend notice window, as the desktop app's main process would make one. */
function fakeWindowFactory({ showing = true, fail = false } = {}) {
  const made = [];
  const factory = async (closed) => {
    if (fail) throw new Error("no display");
    const window = { showing, closedBy: null, pressStop() { this.showing = false; closed(); }, close() { this.showing = false; this.closedBy = "hide"; closed(); } };
    made.push(window);
    return window;
  };
  return { made, factory };
}

async function screenFixture(t, window) {
  const { app, closeFirst } = await fixture(t);
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const fake = fakeMac();
  const parts = screenControlParts({ platform: "darwin", posix: { exec: fake.exec }, ...(window ? { window } : {}) });
  const control = new DesktopControl(app.store, parts);
  closeFirst(() => control.close());
  const run = await app.runtime.run({ prompt: "look at my screen" });
  return { app, control, parts, fake, run, context: app.runtime.context({ runId: run.id }) };
}

/* ---------- the Stop notice ---------- */

test("without the desktop app a Mac or Linux refuses screen control in one sentence and starts nothing", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    const { app, closeFirst } = await fixture(t);
    saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
    const fake = fakeMac();
    const control = new DesktopControl(app.store, screenControlParts({ platform, posix: { exec: fake.exec, env: { DISPLAY: ":1" }, locate: () => "/usr/bin/xdotool" } }));
    closeFirst(() => control.close());
    const run = await app.runtime.run({ prompt: "list windows" });
    await assert.rejects(control.windows({ action: "list" }, app.runtime.context({ runId: run.id })), (error) => error.message === noBannerRefusal);
    assert.equal(fake.calls.length, 0, `${platform}: nothing was started`);
  }
  assert.match(noBannerRefusal, /from the Branch Agent app/);
});

test("the screen is used only while the notice is really up, and closing it is Stop", async (t) => {
  const windows = fakeWindowFactory();
  const f = await screenFixture(t, windows.factory);
  // Straight to the runner, with no notice, nothing happens.
  await assert.rejects(f.parts.runner.run("windows", {}, AbortSignal.timeout(5000)), /only uses your screen while its notice/);
  assert.equal(f.fake.calls.length, 0);

  const listed = await f.control.windows({ action: "list" }, f.context);
  assert.equal(listed.windows[0].title, "Notes");
  assert.equal(windows.made.length, 1, "one notice was put up");
  assert.equal(f.parts.banner.visible, true);
  assert.equal(f.fake.calls[0].executable, "/usr/bin/osascript");
  await f.control.windows({ action: "list" }, f.context);
  assert.equal(windows.made.length, 1, "the same notice stays up for the next action");

  windows.made[0].pressStop();
  assert.equal(f.parts.banner.visible, false);
  assert.ok(f.app.store.events(f.run.id).some((event) => event.kind === "desktop.stopped"), "Stop is written down");
  const before = f.fake.calls.length;
  await assert.rejects(f.control.windows({ action: "list" }, f.context), /You pressed Stop/);
  assert.equal(f.fake.calls.length, before, "nothing ran after Stop");
});

test("the notice coming down at the end of a task is not a Stop, and the runner goes quiet again", async (t) => {
  const windows = fakeWindowFactory();
  const f = await screenFixture(t, windows.factory);
  await f.control.windows({ action: "list" }, f.context);
  await f.control.closeRun(f.context);
  assert.equal(windows.made[0].closedBy, "hide");
  assert.equal(f.parts.banner.visible, false);
  assert.ok(!f.app.store.events(f.run.id).some((event) => event.kind === "desktop.stopped"), "taking it down is not Stop");
  await assert.rejects(f.parts.runner.run("windows", {}, AbortSignal.timeout(5000)), /only uses your screen while its notice/);
});

test("a notice that fails, or never shows, keeps the screen untouched", async (t) => {
  for (const options of [{ fail: true }, { showing: false }]) {
    const windows = fakeWindowFactory(options);
    const f = await screenFixture(t, windows.factory);
    await assert.rejects(f.control.windows({ action: "list" }, f.context), /could not be shown, so Branch has not touched your screen/);
    assert.equal(f.fake.calls.length, 0);
    assert.equal(f.parts.banner.visible, false);
    if (options.showing === false) assert.equal(windows.made[0].closedBy, "hide", "the half-made notice is closed");
  }
});

test("a runner paired with another notice refuses, and a missing notice never reads as Linux saying no", async (t) => {
  const windows = fakeWindowFactory();
  const { app, closeFirst } = await fixture(t);
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const fake = fakeMac();
  const parts = screenControlParts({ platform: "darwin", posix: { exec: fake.exec }, window: windows.factory });
  // A different notice goes up, but the runner only answers to its own, which is not showing.
  const other = new DesktopBanner(parts.runner, undefined, { platform: "darwin", window: fakeWindowFactory().factory });
  const mismatched = new DesktopControl(app.store, { runner: parts.runner, banner: other });
  closeFirst(() => mismatched.close());
  const run = await app.runtime.run({ prompt: "list windows" });
  await assert.rejects(mismatched.windows({ action: "list" }, app.runtime.context({ runId: run.id })), /only uses your screen while its notice/);
  assert.equal(fake.calls.length, 0, "a runner whose notice is not the one shown does nothing");
  assert.equal(windows.made.length, 0);

  // Linux on X11 asks the screen by listing windows, which bypasses the notice: that refusal is
  // "nothing to say", never "this computer said no".
  const linux = screenControlParts({ platform: "linux", posix: { exec: fake.exec, env: { DISPLAY: ":0" }, locate: () => "/usr/bin/xdotool" } });
  const control = new DesktopControl(app.store, linux);
  closeFirst(() => control.close());
  const read = probeReader(() => control.probe(), linuxConsent({ DISPLAY: ":0" }), "linux");
  assert.equal(await read("screen"), "unknown");
  assert.equal(fake.calls.length, 0);
});

test("Windows keeps the notice it always had", () => {
  const parts = screenControlParts({ platform: "win32", window: async () => { throw new Error("never asked"); } });
  assert.ok(parts.runner instanceof DesktopScriptRunner);
  assert.ok(parts.banner instanceof DesktopBanner);
  assert.equal(parts.banner.visible, false);
});

/* ---------- the Electron window behind the notice ---------- */

function fakeHost({ appears = true } = {}) {
  const listeners = {};
  const host = {
    options: null, destroyed: false, visible: false, calls: [], navigate: null,
    isDestroyed() { return this.destroyed; },
    emit(name) { for (const listener of listeners[name] ?? []) listener(); },
    on(name, listener) { (listeners[name] ??= []).push(listener); },
    once(name, listener) { const wrapped = () => { listeners[name] = listeners[name].filter((one) => one !== wrapped); listener(); }; this.on(name, wrapped); },
    showInactive() { this.calls.push("showInactive"); if (appears) { this.visible = true; this.emit("show"); } },
    close() { this.calls.push("close"); this.destroyed = true; this.emit("closed"); },
    destroy() { this.calls.push("destroy"); this.destroyed = true; },
    setAlwaysOnTop(flag, level) { this.calls.push(`top:${flag}:${level}`); },
    setVisibleOnAllWorkspaces(flag) { this.calls.push(`everywhere:${flag}`); },
    async loadURL(url) { this.url = url; },
    webContents: {
      on: (name, listener) => { if (name === "will-navigate") host.navigate = listener; },
      setWindowOpenHandler: (handler) => { host.openHandler = handler; },
    },
  };
  return host;
}

test("the Electron notice is a locked-down frameless window whose Stop link closes it", async () => {
  const host = fakeHost();
  let closedCount = 0;
  const factory = electronBannerWindow({ create: (options) => { host.options = options; return host; },
    workArea: () => ({ x: 0, y: 25, width: 1440, height: 875 }), platform: "darwin" });
  const window = await factory(() => { closedCount += 1; });
  assert.equal(window.showing, true);
  assert.deepEqual({ frame: host.options.frame, top: host.options.alwaysOnTop, x: host.options.x, y: host.options.y },
    { frame: false, top: true, x: 490, y: 37 });
  assert.deepEqual(host.options.webPreferences,
    { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false, partition: "branch-banner" });
  assert.ok(host.calls.includes("top:true:screen-saver") && host.calls.includes("everywhere:true"));
  assert.ok(host.calls.includes("showInactive"), "it does not take the keyboard away from the window being worked");
  assert.deepEqual(host.openHandler(), { action: "deny" });
  const page = decodeURIComponent(host.url.replace(/^data:text\/html;charset=utf-8,/, ""));
  assert.match(page, /default-src 'none'/);
  assert.ok(page.includes(`href="${stopAddress}"`) && !/<script/i.test(page));

  let prevented = 0;
  host.navigate({ preventDefault: () => { prevented += 1; } }, "https://example.com/");
  assert.equal(closedCount, 0, "going anywhere else is refused and is not Stop");
  host.navigate({ preventDefault: () => { prevented += 1; } }, stopAddress);
  assert.equal(prevented, 2, "the Stop address is never visited either");
  assert.equal(closedCount, 1);
  assert.equal(window.showing, false);
});

test("an Electron notice that never appears is destroyed and counts as not shown", async () => {
  const host = fakeHost({ appears: false });
  const factory = electronBannerWindow({ create: () => host, workArea: () => ({ x: 0, y: 0, width: 800, height: 600 }), platform: "linux", showTimeoutMs: 30 });
  await assert.rejects(factory(() => undefined), /did not appear/);
  assert.ok(host.calls.includes("destroy"));
  assert.ok(!host.calls.includes("everywhere:true"), "the all-desktops setting is a Mac one");
  // Through the banner, the same failure is the plain refusal.
  const banner = new DesktopBanner(new DesktopScriptRunner(), undefined, { platform: "linux", window: factory });
  await assert.rejects(banner.show(() => undefined), /could not be shown/);
});

test("the Electron notice and the banner together: Stop in the window reaches the task", async () => {
  const host = fakeHost();
  const banner = new DesktopBanner(new DesktopScriptRunner(), undefined, {
    platform: "darwin", window: electronBannerWindow({ create: () => host, workArea: () => ({ x: 0, y: 0, width: 800, height: 600 }), platform: "darwin" }),
  });
  let stopped = 0;
  await banner.show(() => { stopped += 1; });
  assert.equal(banner.visible, true);
  host.navigate({ preventDefault() {} }, stopAddress);
  assert.equal(stopped, 1);
  assert.equal(banner.visible, false);
  assert.equal(bannerWindowOptions({ x: 0, y: 0, width: 460, height: 100 }).x, 0);
  assert.match(bannerPage(), /^data:text\/html/);
});

/* ---------- voice ---------- */

test("the voice service is told which computer it is on, and never starts the real say", async (t) => {
  const { app } = await fixture(t);
  const started = [];
  const runProgram = async (file, args) => {
    started.push({ file, args });
    if (args.includes("?")) return sayVoices;
    const out = args[args.indexOf("-o") + 1];
    await writeFile(out, Buffer.from("RIFF0000WAVE"));
    return "";
  };
  const voice = new VoiceService(app.store, app.runtime.models, new NetworkPolicy({}), fetch,
    { platform: "darwin", runProgram, locate: (name) => (name === "say" ? "/pretend/say" : null) });
  assert.equal(voice.platform, "darwin");
  // Switched off out of the box: nothing is listed, nothing is asked, and reading aloud says why.
  const quiet = await systemVoices(voice, "local");
  assert.deepEqual([quiet.system, quiet.mode], [[], "off"]);
  await assert.rejects(voice.speak("local", { text: "hello", voice: "", speed: 1 }), /own voice is switched off.*or choose your provider's voice/);
  saveVoiceSettings(app.store, "local", { keepAudioOnThisComputer: true });
  await assert.rejects(voice.speak("local", { text: "hello", voice: "", speed: 1 }),
    (error) => /switched off/.test(error.message) && !/provider/.test(error.message), "no advice that would be refused too");
  saveVoiceSettings(app.store, "local", { keepAudioOnThisComputer: false });
  assert.equal(started.length, 0, "nothing was started while it was off");
  const deps0 = { store: app.store, models: app.runtime.models, owner: "local", voice, policy: new NetworkPolicy({}), fetch };
  assert.equal(voicePlan(deps0).readAloud.ready, false);
  saveVoiceSettings(app.store, "local", { systemVoice: "when-needed" });
  assert.equal(voiceSettings(app.store, "local").autoReadAloud, false, "saving one field kept the others");
  const listed = await systemVoices(voice, "local");
  assert.deepEqual(listed.windows, ["Albert", "Amélie"]);
  assert.deepEqual(listed.system, listed.windows, "the neutral name carries the same list");
  assert.match(listed.label, /^Your computer's own voice/);
  assert.match(listed.microphoneHelp, /System Settings, Privacy & Security, Microphone/);
  const spoken = await voice.speak("local", { text: "hello", voice: "Albert", speed: 1 });
  assert.equal(spoken.route, "windows");
  assert.equal(started.at(-1).file, "/pretend/say");
  assert.ok(started.every((call) => call.file === "/pretend/say"), "only the stand-in was started");
  const deps = { store: app.store, models: app.runtime.models, owner: "local", voice, policy: new NetworkPolicy({}), fetch };
  assert.match(voicePlan(deps).readAloud.reason, /your computer's own voice/);

  // An older caller that hands in only a runner still gets it used.
  const older = new VoiceService(app.store, app.runtime.models, new NetworkPolicy({}), fetch, async () => { throw new Error("stand-in"); });
  assert.equal(older.platform, process.platform);
});

test("owner-facing voice words: Windows keeps its own, every other computer says its own voice", () => {
  const settings = VoiceSettingsSchema.parse({});
  assert.equal(ttsRouteFor(settings, undefined, "win32").reason, "Higher-quality voice is switched off, so the free Windows voice is used");
  assert.equal(ttsRouteFor({ ...settings, ttsRoute: "windows" }, undefined, "win32").reason, "You chose the voice that comes with Windows");
  assert.equal(ttsRouteFor({ ...settings, useProviderVoice: true }, undefined, "win32").reason, "No connected model offers this, so the free Windows voice is used");
  for (const platform of ["darwin", "linux"]) {
    assert.equal(ttsRouteFor({ ...settings, ttsRoute: "windows" }, undefined, platform).reason, "You chose your computer's own voice");
    assert.doesNotMatch(ttsRouteFor(settings, undefined, platform).reason, /Windows/);
    assert.doesNotMatch(whereAudioGoes("local", "windows", platform), /Windows/);
    assert.doesNotMatch(whereAudioGoes("openai", "windows", platform), /Windows/);
    assert.doesNotMatch(microphoneHelp(platform), /Windows/);
  }
  assert.equal(whereAudioGoes("local", "windows", "win32"),
    "Nothing leaves this computer: recordings are written out here, and replies are read aloud by a voice that comes with Windows.");
  assert.match(whereAudioGoes("openai", "windows", "win32"), /a voice that comes with Windows, which costs nothing/);
  assert.match(microphoneHelp("win32"), /in Windows settings/);
  assert.equal(systemVoiceWords("win32").chosen, "the voice that comes with Windows");
});

/* ---------- the owner's three-way switch ---------- */

test("every switch is off / when needed / on, ships off, and older yes-no saves keep working", async (t) => {
  assert.equal(modeOf({}), "off");
  assert.equal(modeOf({ enabled: true }), "when-needed", "an old yes meant ordinary tiering");
  assert.deepEqual(settleSwitch({ mode: "on" }, { enabled: false }), { mode: "off", enabled: false });
  assert.deepEqual(settleSwitch({ mode: "off" }, { enabled: true }), { mode: "when-needed", enabled: true });
  assert.deepEqual(settleSwitch({ mode: "on" }, { enabled: true }), { mode: "on", enabled: true });
  assert.deepEqual(settleSwitch({ mode: "when-needed" }, { enabled: false, mode: "on" }), { mode: "on", enabled: true });
  assert.deepEqual(sentFields({ a: false, b: 2 }, { b: 2 }), { b: 2 });

  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  assert.deepEqual([readDesktopSettings(app.store, owner).mode, readKeychainSettings(app.store, owner).mode, voiceSettings(app.store, owner).systemVoice],
    ["off", "off", "off"], "all three ship off");
  app.store.save("settings", owner, "desktop-control", { enabled: true, maxActionsPerRun: 40 });
  assert.equal(readDesktopSettings(app.store, owner).mode, "when-needed");
  assert.equal(saveDesktopSettings(app.store, owner, { mode: "on" }).enabled, true);
  const limited = saveDesktopSettings(app.store, owner, { maxActionsPerRun: 5 });
  assert.deepEqual([limited.mode, limited.enabled, limited.maxActionsPerRun], ["on", true, 5], "saving the limit keeps the switch");
  assert.equal(saveDesktopSettings(app.store, owner, { enabled: false }).mode, "off");
  await assert.rejects(async () => saveDesktopSettings(app.store, owner, { mode: "sometimes" }));

  saveKeychainSettings(app.store, owner, { mode: "when-needed", entries: [{ name: "gh", service: "github.com" }] });
  const kept = saveKeychainSettings(app.store, owner, { timeoutMs: 2000 });
  assert.deepEqual([kept.mode, kept.enabled, kept.entries.length], ["when-needed", true, 1], "saving one field keeps the switch and the list");
});

test("on loads a feature's tools from the start, off keeps the screen tools out of the list", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  const all = ["desktop.windows", "desktop.click", "voice.say", "files.read"];
  assert.deepEqual(switchedToolTiers(app.store, owner, all), { preload: [], hidden: ["desktop.windows", "desktop.click"] },
    "off hides the screen tools, but not voice.say, which also reads with a provider's voice");
  saveDesktopSettings(app.store, owner, { mode: "when-needed" });
  assert.deepEqual(switchedToolTiers(app.store, owner, all), { preload: [], hidden: [] }, "when needed is the ordinary tiering");
  saveDesktopSettings(app.store, owner, { mode: "on" });
  saveVoiceSettings(app.store, owner, { systemVoice: "on" });
  assert.deepEqual(switchedToolTiers(app.store, owner, all).preload.map((tool) => tool.name), ["desktop.windows", "desktop.click", "voice.say"]);

  // Through a real task: the first request to the model carries the screen tools only when "on".
  const seen = [];
  const root = await mkdtemp(join(tmpdir(), "branch-mac2-tiers-"));
  const tiered = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) { seen.push(request.tools.map((tool) => tool.name)); return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await tiered.close(); await discardTemp(root); });
  await tiered.runtime.run({ prompt: "hello there" });
  assert.ok(!seen.at(-1).some((name) => name.startsWith("desktop.")), "off: no screen tool travels");
  saveDesktopSettings(tiered.store, tiered.runtime.owner, { mode: "on" });
  await tiered.runtime.run({ prompt: "hello there" });
  assert.ok(seen.at(-1).includes("desktop.windows"), `on: the screen tools travel from the first round (${seen.at(-1).join(", ")})`);
});

/* ---------- the permissions card and the Keychain list ---------- */

test("the Keychain list keeps names only, is off by default, and exists only on a Mac", async (t) => {
  const { app } = await fixture(t);
  const none = async () => ({});
  const first = await keychainApi(app.store, "local", "GET", none, "darwin");
  assert.equal(first.enabled, false);
  assert.deepEqual(first.entries, []);
  assert.equal(first.available, true);
  assert.equal((await keychainApi(app.store, "local", "GET", none, "linux")).available, false);
  const saved = await keychainApi(app.store, "local", "POST",
    async () => ({ enabled: true, entries: [{ name: "github", service: "api.github.com", account: "me" }] }), "darwin");
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.references, { github: "secret://keychain/github" });
  await assert.rejects(keychainApi(app.store, "local", "POST",
    async () => ({ entries: [{ name: "x", service: "y", password: "hunter2" }] }), "darwin"), /password|Unrecognized/i);
  await assert.rejects(keychainApi(app.store, "local", "POST",
    async () => ({ entries: [{ name: "x", service: "-w" }] }), "darwin"), /cannot start with a dash/);
  await assert.rejects(keychainApi(app.store, "local", "POST",
    async () => ({ entries: [{ name: "x", service: "a" }, { name: "x", service: "b" }] }), "darwin"), /same name/);
  await assert.rejects(keychainApi(app.store, "local", "DELETE", none, "darwin"), /not something Branch can do/);
  assert.equal((await keychainApi(app.store, "local", "GET", none, "darwin")).entries.length, 1, "a refused save changes nothing");
  assert.ok(!JSON.stringify(app.store.get("settings", "local", "keychain-entries")).includes("hunter2"));
});

test("the permissions context names the computer and, on Linux, the session", () => {
  assert.deepEqual(permissionsContext("darwin", {}), { platform: "darwin" });
  assert.deepEqual(permissionsContext("win32", {}), { platform: "win32" });
  assert.deepEqual(permissionsContext("linux", { WAYLAND_DISPLAY: "wayland-0" }), { platform: "linux", session: "wayland" });
  assert.deepEqual(permissionsContext("linux", { DISPLAY: ":0" }), { platform: "linux", session: "x11" });
  assert.deepEqual(permissionsContext("linux", {}), { platform: "linux", session: "none" });
});

test("the routes answer through the server with the session token only", async (t) => {
  const { app, root, closeFirst } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closeFirst(() => server.close());
  const call = (path, init = {}) => fetch(server.url + path, { ...init, headers: { authorization: `Bearer ${server.token}`, ...(init.headers ?? {}) } });
  assert.equal((await fetch(server.url + "/api/keychain/settings")).status, 401);
  const permissions = await (await call("/api/os-permissions")).json();
  assert.equal(permissions.platform, process.platform);
  assert.ok(Array.isArray(permissions.permissions));
  const saved = await call("/api/keychain/settings", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, entries: [{ name: "npm", service: "registry.npmjs.org" }] }) });
  assert.equal(saved.status, 200);
  assert.equal((await (await call("/api/keychain/settings")).json()).entries[0].name, "npm");
  const plan = await (await call("/api/voice/plan")).json();
  assert.equal(plan.systemVoice.label.includes("Windows"), process.platform === "win32");
  assert.equal(plan.systemVoice.platform, process.platform);
  // Redesign: the old window's card script (public/os-permissions.js) left with that window. The new window's This Mac /
  // This PC rows read the same route, and opening the computer's own settings is not wired live there.
  const rows = await readFile(new URL("../public/app/settings/pages/permissions.js", import.meta.url), "utf8");
  assert.match(rows, /api\("os-permissions"\)/);
  assert.doesNotMatch(rows.slice(rows.indexOf("markLive(")).split(")")[0], /sys16/, "Open System Settings is not marked live");
});

/* Redesign: the old window's four cards (#os-permissions-card, #screen-switch-card, #system-voice-card, #keychain-card and
   their scripts public/os-permissions.js and public/voice.js) left with that window. The new window draws the prototype's
   pages instead: This Mac / This PC in Settings › Permissions (public/app/settings/pages/permissions.js, one row for each
   permission GET /api/os-permissions checked, its pill from the engine, "Open System Settings" greyed), the screen switch in
   Settings › Computer & browser (public/app/settings/pages/computer.js, POST /api/desktop/settings) and the computer's own
   voices in Settings › Voice (public/app/settings/pages/voice.js, GET /api/voice/voices). The prototype has no Keychain
   list (only an achievement names it), so the new window draws none; the Keychain route's own tests above still hold. */
const WORDS = {
  en: JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8")),
  fr: JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8")),
};
/** GET /api/os-permissions answered as a Mac (or `platform`) would, whatever this computer is. */
const osAnswer = (platform, permissions) => async (page) => {
  await page.route("**/api/os-permissions", (route) => route.fulfill({ json: { platform, permissions } }));
};
const MAC_PERMISSIONS = [
  { capability: "screen", state: "unknown", allowed: true, message: "", explanation: "Lets Branch take a picture.",
    settingsLink: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" },
  { capability: "microphone", state: "allowed", allowed: true, message: "", explanation: "Lets Branch hear you." },
  { capability: "camera", state: "refused", allowed: false, message: "", explanation: "Lets Branch use the camera.", settingsLink: "javascript:alert(1)" },
];
/** The This Mac / This PC section of Settings › Permissions: its heading, and each row's name and pill. */
const osSection = (page) => page.evaluate(() => {
  const section = [...document.querySelectorAll(".set-col .sec")].find((node) => node.querySelector(".perm16"));
  if (!section) return null;
  return { heading: section.querySelector(":scope > h2")?.textContent.trim(), headingTag: section.firstElementChild?.tagName,
    rows: [...section.querySelectorAll(".perm16")].map((row) => [row.querySelector("b").textContent.trim(), row.querySelector(".pill").textContent.trim()]) };
});
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test("Settings › Voice asks for the computer's own voices only when it is opened, with the window's own key", async (t) => {
  const { page, errors, server } = await settingsWindow(t, { name: "mac2-voices" });
  const asked = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/voice/voices") asked.push(request.headers().authorization ?? ""); });
  await openSettingsPage(page, "general");
  await page.locator(".set-col h1").first().waitFor();
  assert.deepEqual(asked, [], "the voices are not asked for when the window or another Settings page opens");
  const voices = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/voice/voices");
  await openSettingsPage(page, "voice");
  await voices;
  assert.deepEqual(asked, [`Bearer ${server.token}`], "asked once, with the key the window holds");
  const source = await readFile(new URL("../public/app/settings/pages/voice.js", import.meta.url), "utf8");
  assert.match(source, /voices\.system/, "the computer's own voices are read from the engine's answer");
  assert.deepEqual(errors, []);
});

for (const width of [1440, 860, 400]) {
  test(`DG-008 computer Settings sections have native section headings at ${width}px`, async (t) => {
    const { page, errors } = await settingsWindow(t, { name: "mac2-dg008", width, height: 900, route: osAnswer("darwin", MAC_PERMISSIONS) });
    for (const language of ["en", "fr"]) {
      await page.evaluate(async (lang) => (await import("/i18n.js")).setLanguage(lang), language);
      const words = WORDS[language];
      await openSettingsPage(page, "permissions");
      await page.locator(".set-col .perm16").first().waitFor();
      const os = await osSection(page);
      assert.equal(os.headingTag, "H2", "This Mac is a section with its own heading");
      assert.equal(os.heading, words["window.settings.permissions.this-mac"]);
      assert.equal(await page.locator(".set-col").getByRole("heading", { level: 2, name: os.heading, exact: true }).count(), 1, "headed once");
      assert.equal(await page.locator(".set-col h1").count(), 1, "one page title above the sections");
      await openSettingsPage(page, "computer");
      const screen = page.locator(".set-col #c-screen");
      await screen.waitFor({ state: "attached" });
      assert.equal(await screen.evaluate((node) => node.closest(".sec")?.querySelector(":scope > h2")?.textContent.trim()),
        words["window.settings.computer.on-a-computer"], "the screen switch sits under its section's heading");
      assert.equal(await sideways(page), 0, `${width} px: nothing goes sideways`);
    }
    assert.deepEqual(errors, []);
  });
}

test("the permission rows show the engine's state, nothing opens by itself, and the screen switch saves", async (t) => {
  const { app, page, errors } = await settingsWindow(t, { name: "mac2-homes", route: osAnswer("darwin", MAC_PERMISSIONS) });
  // Only now is the page given a stand-in for the app's opener, so sign-in is not the desktop app's.
  await page.evaluate(() => {
    globalThis.opened = [];
    globalThis.branchDesktop = { openExternal: async (url) => { globalThis.opened.push(url); } };
  });
  await openSettingsPage(page, "permissions");
  await page.locator(".set-col .perm16").first().waitFor();
  const en = WORDS.en;
  assert.deepEqual((await osSection(page)).rows, [
    ["Screen Recording", en["window.settings.permissions.not-yet"]],
    ["Microphone", en["window.settings.permissions.granted"]],
    ["Camera", en["window.settings.permissions.turned-off"]],
  ], "one row for each permission the engine checked, with the engine's state");
  const open = page.locator('.set-col [data-act="sys16"]');
  assert.equal(await open.count(), 2, "a permission not yet granted offers the computer's own settings");
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await isSoon(open.nth(index)), true, "opening the computer's settings stays greyed");
    await open.nth(index).evaluate((button) => button.click());
  }
  assert.deepEqual(await page.evaluate(() => globalThis.opened), [], "nothing is opened, by itself or by a press");

  await openSettingsPage(page, "computer");
  const screen = page.locator(".set-col #c-screen");
  await screen.waitFor();
  assert.equal(await screen.isChecked(), false, "the screen switch ships off");
  await screen.check();
  await page.waitForFunction(() => document.querySelector(".set-col #c-screen")?.checked === true);
  for (let tries = 0; tries < 50 && readDesktopSettings(app.store, app.runtime.owner).mode === "off"; tries += 1) await page.waitForTimeout(100);
  assert.notEqual(readDesktopSettings(app.store, app.runtime.owner).mode, "off", "the engine keeps the switch as it was pressed");

  await page.setViewportSize({ width: 400, height: 800 });
  await openSettingsPage(page, "permissions");
  await page.locator(".set-col .perm16").first().waitFor();
  assert.equal(await sideways(page), 0, "at 400 px nothing goes sideways");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await openSettingsPage(page, "permissions");
  await page.locator(".set-col").getByRole("heading", { level: 2, name: WORDS.fr["window.settings.permissions.this-mac"], exact: true }).waitFor();
  assert.deepEqual((await osSection(page)).rows.map(([, pill]) => pill),
    ["window.settings.permissions.not-yet", "window.settings.permissions.granted", "window.settings.permissions.turned-off"].map((key) => WORDS.fr[key]),
    "the pills are in French too");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  assert.deepEqual(errors, []);
});

test("on Windows the Mac-only permissions are not drawn, and the screen switch is still there", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "mac2-windows", route: osAnswer("win32", [
    { capability: "screen", state: "unknown", allowed: true, message: "", explanation: "" },
    { capability: "microphone", state: "unknown", allowed: true, message: "", explanation: "" },
    { capability: "camera", state: "allowed", allowed: true, message: "", explanation: "" },
  ]) });
  await openSettingsPage(page, "permissions");
  await page.locator(".set-col .perm16").first().waitFor();
  const os = await osSection(page);
  assert.equal(os.heading, WORDS.en["window.settings.permissions.this-pc"]);
  assert.deepEqual(os.rows.map(([name]) => name), ["Microphone", "Camera"], "no Screen Recording row on Windows");
  await openSettingsPage(page, "computer");
  await page.locator(".set-col #c-screen").waitFor({ state: "attached" });
  assert.deepEqual(errors, []);
});

/* ---------- integration: the switches ship off for new installs only ---------- */

/** A data folder as an older Branch left it: a database with saved settings and no switches. */
async function olderInstall(t, save) {
  const root = await mkdtemp(join(tmpdir(), "branch-mac2-old-"));
  await mkdir(join(root, "data"), { recursive: true });
  const store = new Store(join(root, "data", "branch.sqlite"));
  save(store);
  store.close();
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("a new install starts with every switch off, and the one-time step is written down", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  assert.equal(voiceSettings(app.store, owner).systemVoice, "off");
  assert.equal(readDesktopSettings(app.store, owner).mode, "off");
  assert.equal(readKeychainSettings(app.store, owner).mode, "off");
  assert.equal(app.store.get("settings", owner, migrationKey).data.existingInstall, false);
  assert.equal((await new VoiceService(app.store, app.runtime.models, new NetworkPolicy({}), fetch,
    { platform: "win32", runProgram: async () => { throw new Error("nothing may start"); } }).systemVoiceNames(owner)).length, 0);
});

test("an install from before the switches keeps its voice, screen and Keychain behaviour", async (t) => {
  const app = await olderInstall(t, (store) => {
    store.save("settings", "local", "voice", { ttsRoute: "windows", language: "en" });
    store.save("settings", "local", "desktop-control", { enabled: true, maxActionsPerRun: 12 });
    store.save("settings", "local", "keychain-entries", { enabled: true, entries: [{ name: "gh", service: "github.com" }] });
  });
  const owner = app.runtime.owner;
  assert.equal(voiceSettings(app.store, owner).systemVoice, "when-needed", "the Windows voice keeps reading aloud");
  assert.equal(voiceSettings(app.store, owner).ttsRoute, "windows", "the rest of the voice settings are kept");
  const desktop = readDesktopSettings(app.store, owner);
  assert.deepEqual([desktop.mode, desktop.enabled, desktop.maxActionsPerRun], ["when-needed", true, 12]);
  const keychain = readKeychainSettings(app.store, owner);
  assert.deepEqual([keychain.mode, keychain.entries.length], ["when-needed", 1]);
  let started = 0;
  const voice = new VoiceService(app.store, app.runtime.models, new NetworkPolicy({}), fetch,
    { platform: "win32", runProgram: async () => { started += 1; return "Microsoft David\n"; } });
  assert.deepEqual(await voice.systemVoiceNames(owner), ["Microsoft David"], "the voice list is still offered");
  assert.equal(started, 1, "only the stand-in runner was asked");
  assert.equal(app.store.get("settings", owner, migrationKey).data.existingInstall, true);
});

test("an older install that never touched voice settings keeps its voice; a switch left off stays off; it runs once", async (t) => {
  const app = await olderInstall(t, (store) => {
    store.save("settings", "local", "desktop-control", { enabled: false, maxActionsPerRun: 40 });
  });
  const owner = app.runtime.owner;
  assert.equal(voiceSettings(app.store, owner).systemVoice, "when-needed");
  assert.equal(readDesktopSettings(app.store, owner).mode, "off", "an unticked switch stays off");
  assert.equal(readKeychainSettings(app.store, owner).mode, "off", "nothing saved means off");
  // The owner turns the voice off afterwards; the step never runs again to undo that.
  saveVoiceSettings(app.store, owner, { systemVoice: "off" });
  assert.deepEqual(migrateFeatureSwitches(app.store, owner, true), { migrated: [] });
  assert.equal(voiceSettings(app.store, owner).systemVoice, "off");
});

/* ---------- integration: saving one field keeps the others ---------- */

test("settings that save one field at a time no longer reset the rest to their defaults", async (t) => {
  const { app, root, closeFirst } = await fixture(t);
  const owner = app.runtime.owner;
  // The morning brief tool: only what the model sent is merged.
  assert.deepEqual(optionalFields(BriefSettingsSchema).parse({ dailyAt: "08:00" }), { dailyAt: "08:00" });
  // Metering: changing the folder keeps it switched on.
  saveMeteringSettings(app.store, owner, { enabled: true, every: "weekly" });
  const metering = saveMeteringSettings(app.store, owner, { folder: "costs" });
  assert.deepEqual([metering.enabled, metering.every, metering.folder], [true, "weekly", "costs"]);
  assert.equal(meteringSettings(app.store, owner).enabled, true);
  // The owner's own browser: switching it on keeps the owner's extra refused sites.
  saveAttachSettings(app.store, owner, { extraRefusedHosts: ["bank.example"] });
  const attach = saveAttachSettings(app.store, owner, { enabled: true, runId: "r1" });
  assert.deepEqual(attach.extraRefusedHosts, ["bank.example"], "a refused site is never dropped by another save");
  assert.equal(readAttachSettings(app.store, owner).enabled, true);
  // Approval limits: setting one limit keeps the other.
  savePolicy(app.store, owner, { limits: { toolCallsPerMinute: 10, modelRoundsPerMinute: 5 } });
  assert.deepEqual(savePolicy(app.store, owner, { limits: { toolCallsPerMinute: 20 } }).limits, { toolCallsPerMinute: 20, modelRoundsPerMinute: 5 });
  assert.deepEqual(readPolicy(app.store, owner).limits, { toolCallsPerMinute: 20, modelRoundsPerMinute: 5 });
  // Plan or act: choosing how far to go keeps "show me the plan first".
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closeFirst(() => server.close());
  const post = async (body) => (await fetch(server.url + "/api/plan-act", { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  await post({ scope: "project", planMode: "show-plan" });
  const after = await post({ scope: "project", autonomy: "every-step" });
  assert.deepEqual([after.project.planMode, after.project.autonomy], ["show-plan", "every-step"]);
});
