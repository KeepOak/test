/* Versioned app folders (src/desktop/app-folders.ts, shell-switch.ts, shell-window.ts): every version of Branch in a
   folder of its own, the new one made beside the one running and switched to by one rename, the one before kept whole
   for going back, and no program ever made. Stand-in files only: nothing here is a real program, and nothing touches
   an installed app, the registry, the scheduler or the network. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { appFolderName, linkRuntime, pointerFiles, pruneAppFolders, readPointer, runtimeFiles, sealAppFolder, partFolder, versionedLayout, writePointer } from "../dist/desktop/app-folders.js";
import { invisibleMoment, markShellUp, readSwitchFailure, shellUpMarker, takeHandOver, writeHandOver, failureName } from "../dist/desktop/shell-switch.js";
import { handOverHook, sameInstall, settleLayout } from "../dist/desktop/shell-window.js";
import { shortcutChanges } from "../dist/install/windows-identity.js";
import { Updater } from "../dist/desktop/updater.js";
import { betaLine } from "../dist/desktop/dev-build.js";

/* Versioned app folders are Windows-only (versionedLayout is null elsewhere): these write Windows paths and scripts. */
const windowsOnly = process.platform !== "win32" ? "versioned app folders are Windows-only" : false;

const exe = "Branch Agent.exe";
const exists = (path) => access(path).then(() => true, () => false);
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "branch-app-folders-"));
  t.after(() => discardTemp(dir));
  return dir;
}
async function write(path, text = "x") { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); }
/** A program folder as Electron and the app leave it, plus what belongs to the person and the installer. */
async function programFolder(dir, { version = "1.0.0", electron = "44.3.0" } = {}) {
  await write(join(dir, exe), "stand-in for Electron's stock program");
  await write(join(dir, "ffmpeg.dll")); await write(join(dir, "version"), electron); await write(join(dir, "locales", "en-US.pak"));
  await write(join(dir, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
  await write(join(dir, "resources", "app", "live", "c".repeat(40), "dist", "x.js"));
}

test("a copy knows its layout from its program's path; a portable copy and other systems keep the flat one", () => {
  assert.deepEqual(versionedLayout("C:\\P\\Branch Agent\\app-0.19.4-dev.1-gabc\\Branch Agent.exe", "win32", false), { root: "C:\\P\\Branch Agent", folder: "app-0.19.4-dev.1-gabc" });
  assert.deepEqual(versionedLayout("C:\\P\\Branch Agent\\Branch Agent.exe", "win32", false), { root: "C:\\P\\Branch Agent", folder: "" });
  assert.equal(versionedLayout("C:\\P\\Branch Agent\\Branch Agent.exe", "win32", true), null);
  assert.equal(versionedLayout("/Applications/Branch Agent.app/Contents/MacOS/Branch Agent", "darwin", false), null);
  assert.equal(appFolderName("0.19.4-dev.1790556492-gd79878db6032"), "app-0.19.4-dev.1790556492-gd79878db6032");
  assert.equal(appFolderName("1.0/../x"), "app-1.0_.._x");
});

test("a new version shares the running one's Electron runtime by hard links: the very same program file, nothing new", async (t) => {
  const root = await temp(t), running = join(root, "app-1.0.0");
  await programFolder(running);
  await write(join(running, "current.json"), "{}"); await write(join(running, "Uninstall Branch Agent.cmd")); await write(join(running, "Branch Data", "state", "db"));
  assert.deepEqual(await runtimeFiles(running), [exe, "ffmpeg.dll", "locales/en-US.pak", "version"]);
  const into = partFolder(root, "2.0.0");
  const linked = await linkRuntime(running, into, exe);
  assert.deepEqual(linked, { files: 4, copied: 0 });
  const [a, b] = await Promise.all([stat(join(running, exe)), stat(join(into, exe))]);
  assert.equal(a.ino, b.ino, "one file, two names: no program was written");
  assert.equal(await exists(join(into, "resources")), false, "the app is the new version's own, never linked");
  assert.equal(await exists(join(into, "Branch Data")), false);
});

test("the switch is prepared as whole pointer files, and going back names exactly what runs now", async (t) => {
  const root = await temp(t);
  const first = await pointerFiles(root, { folder: "", version: "1.0.0" }, { folder: "app-2.0.0", version: "2.0.0" });
  assert.deepEqual({ ...JSON.parse(await readFile(first.next, "utf8")), at: "t" }, { folder: "app-2.0.0", version: "2.0.0", previous: { folder: "", version: "1.0.0" }, at: "t" });
  assert.equal(await exists(first.rollback), false, "back to a flat copy: no pointer at all, as before the first switch");
  await writePointer(root, first.pointer);
  const second = await pointerFiles(root, { folder: "app-2.0.0", version: "2.0.0" }, { folder: "app-3.0.0", version: "3.0.0" });
  assert.equal(JSON.parse(await readFile(second.next, "utf8")).previous.folder, "app-2.0.0");
  const back = JSON.parse(await readFile(second.rollback, "utf8"));
  assert.deepEqual([back.folder, back.previous], ["app-2.0.0", { folder: "", version: "1.0.0" }]);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".part")), [], "nothing half-written is left");
});

test("a version is sealed only when whole, never over the one in use or the one before", async (t) => {
  const root = await temp(t);
  await writePointer(root, { folder: "app-2.0.0", version: "2.0.0", previous: { folder: "app-1.0.0", version: "1.0.0" }, at: new Date().toISOString() });
  await write(join(partFolder(root, "3.0.0"), exe));
  assert.equal(await sealAppFolder(root, "3.0.0", await readPointer(root)), join(root, "app-3.0.0"));
  await write(join(partFolder(root, "2.0.0"), exe));
  await assert.rejects(sealAppFolder(root, "2.0.0", await readPointer(root)), /already installed/);
});

test("older versions go, but never the one in use, the one before, a newer one waiting for its switch, a folder something runs from, or anything else", async (t) => {
  const root = await temp(t);
  for (const name of ["app-1.0.0", "app-2.0.0", "app-3.0.0", "app-4.0.0", "app-5.0.0.part", "app-9.0.0-dev.1-gabc", "Branch Data", "locales"]) await mkdir(join(root, name), { recursive: true });
  await write(join(root, exe));
  const pointer = { folder: "app-4.0.0", version: "4.0.0", previous: { folder: "app-3.0.0", version: "3.0.0" }, at: new Date().toISOString() };
  const busy = (await import("node:fs/promises")).rename;
  const removed = await pruneAppFolders(root, pointer, { rename: async (from, to) => { if (from.endsWith("app-2.0.0")) throw Object.assign(new Error("in use"), { code: "EBUSY" }); return busy(from, to); } });
  assert.deepEqual(removed.sort(), ["app-1.0.0", "app-5.0.0.part"]);
  assert.deepEqual((await readdir(root)).sort(), [exe, "Branch Data", "app-2.0.0", "app-3.0.0", "app-4.0.0", "app-9.0.0-dev.1-gabc", "locales"].sort());
});

test("what the window had open reaches the new version once, and only that version, while fresh", async (t) => {
  const dir = await temp(t);
  const kept = JSON.stringify({ drafts: { new: "half-written" }, caret: { start: 4, end: 4 } });
  await writeHandOver(dir, { version: "2.0.0", visible: true, at: new Date().toISOString(), kept });
  assert.equal(await takeHandOver(dir, "3.0.0"), null, "another version never takes it");
  await writeHandOver(dir, { version: "2.0.0", visible: true, at: new Date().toISOString(), kept });
  assert.equal((await takeHandOver(dir, "2.0.0"))?.kept, kept);
  assert.equal(await takeHandOver(dir, "2.0.0"), null, "taken once");
  await writeHandOver(dir, { version: "2.0.0", visible: true, at: new Date(Date.now() - 11 * 60_000).toISOString(), kept });
  assert.equal(await takeHandOver(dir, "2.0.0"), null, "a stale one is dropped");
});

test("the switch waits for the invisible moment: out of sight, or the owner away; never in front of them in use", async () => {
  assert.equal(invisibleMoment({ visible: true, minimized: false, focused: true, idle: "active" }), false);
  assert.equal(invisibleMoment({ visible: true, minimized: false, focused: true, idle: "idle" }), false, "in front of them, even untouched, it waits");
  for (const state of [{ visible: false, minimized: false, idle: "active" }, { visible: true, minimized: true, idle: "active" },
    { visible: true, minimized: false, focused: false, idle: "idle" }, { visible: true, minimized: false, idle: "locked" }]) assert.equal(invisibleMoment(state), true);
  const dir = await mkdtemp(join(tmpdir(), "branch-handover-"));
  try {
    let visible = true, polls = 0, kept = null;
    const window = { isVisible: () => visible, isMinimized: () => false, isDestroyed: () => false, isFocused: () => true,
      webContents: { executeJavaScript: async () => kept } };
    const hook = handOverHook({ window: () => window, userData: dir, power: { getSystemIdleState: () => "active" }, sleep: async () => { polls++; if (polls === 2) visible = false; if (polls === 3) kept = "{\"drafts\":{}}"; } });
    assert.deepEqual(await hook({ version: "2.0.0", stillWanted: () => true }), { minimized: true });
    assert.equal(polls, 3, "it waited while visible, then while the first message's conversation was confirmed");
    assert.equal(JSON.parse(await readFile(join(dir, "shell-handover.json"), "utf8")).kept, "{\"drafts\":{}}");
    const stopped = handOverHook({ window: () => ({ ...window, isVisible: () => true }), userData: dir, power: { getSystemIdleState: () => "active" }, sleep: async () => undefined });
    await assert.rejects(stopped({ version: "2.0.0", stillWanted: () => false }), /called off/);
    // Started in the tray with no window yet (or its window closed for good): nothing to wait for or keep.
    let waited = 0;
    const none = handOverHook({ window: () => null, userData: dir, power: { getSystemIdleState: () => "active" }, sleep: async () => { waited++; } });
    assert.deepEqual(await none({ version: "3.0.0", stillWanted: () => true }), { minimized: true });
    assert.equal(waited, 0, "no window: the moment is invisible at once");
    assert.equal(JSON.parse(await readFile(join(dir, "shell-handover.json"), "utf8")).kept, null);
  } finally { await discardTemp(dir); }
});

test("a version that did not come up is reported once, by the version it went back to", async (t) => {
  const dir = await temp(t);
  const failure = { kept: "1.0.0", tried: "2.0.0", commit: "a".repeat(40), at: new Date().toISOString(), message: "went back" };
  await writeFile(join(dir, failureName), JSON.stringify(failure));
  assert.equal(await readSwitchFailure(dir, "2.0.0"), null, "the new one never claims it");
  await writeFile(join(dir, failureName), JSON.stringify(failure));
  assert.deepEqual(await readSwitchFailure(dir, "1.0.0"), failure);
  assert.equal(await readSwitchFailure(dir, "1.0.0"), null, "once");
  await markShellUp(dir, "2.0.0", 42, true);
  assert.deepEqual({ ...JSON.parse(await readFile(shellUpMarker(dir, "2.0.0"), "utf8")), at: "t" }, { pid: 42, at: "t", restored: true });
});

test("shortcuts, start with Windows and the background engine's launcher follow the version in use, and nothing else's", { skip: windowsOnly }, async (t) => {
  const root = "C:\\Users\\o\\AppData\\Local\\Programs\\Branch Agent";
  assert.equal(sameInstall(root, `${root}\\Branch Agent.exe`), true);
  assert.equal(sameInstall(root, `${root}\\app-1.0.0\\Branch Agent.exe`), true);
  assert.equal(sameInstall(root, `${root} Copy\\Branch Agent.exe`), false);
  assert.equal(sameInstall(root, `${root}\\tools\\x\\Branch Agent.exe`), false);
  const now = `${root}\\app-2.0.0\\${exe}`;
  const moved = shortcutChanges({ target: `${root}\\${exe}`, appUserModelId: "KeepOak.BranchAgent" }, now, null, (path) => sameInstall(root, path));
  assert.equal(moved?.target, now);
  assert.equal(shortcutChanges({ target: "C:\\Other\\Branch Agent.exe" }, now, null, (path) => sameInstall(root, path)), null);
  const dataDir = await temp(t), written = {};
  const launcher = `CreateObject("WScript.Shell").Run "C:\\Windows\\System32\\cmd.exe /d /c set ""BRANCH_DATA_DIR=C:\\d"" & ""${root}\\app-1.0.0\\Branch Agent.exe"" ""${root}\\app-1.0.0\\resources\\app\\dist\\cli.js"" start", 0, False\r\n`;
  const done = await settleLayout({ root, folder: "app-2.0.0" }, exe, dataDir, {
    readRegistry: async () => `"${root}\\app-1.0.0\\${exe}" --start-minimized`, writeRegistry: async (_key, values) => { written.run = values[0].value; },
    readText: async () => launcher, writeText: async (_path, text) => { written.launcher = text; }, prune: async () => ["app-0.9.0"] });
  assert.equal(written.run, `"${now}" --start-minimized`);
  assert.match(written.launcher, /app-2\.0\.0\\Branch Agent\.exe"" ""[^"]*app-2\.0\.0\\resources\\app\\dist\\cli\.js/);
  assert.doesNotMatch(written.launcher, /app-1\.0\.0/);
  assert.deepEqual(done, { runKey: true, launcher: true, pruned: [], retired: false }, "nothing is removed or retired unless the pointer names this version");
  const other = {};
  await settleLayout({ root, folder: "app-2.0.0" }, exe, dataDir, { readRegistry: async () => `"C:\\Elsewhere\\Branch Agent.exe"`, writeRegistry: async () => { other.run = true; },
    readText: async () => null, writeText: async () => { other.launcher = true; } });
  assert.deepEqual(other, {}, "another program's entries are never touched");
});

// ---- the updater itself: a Beta change laid out beside the running version and switched to, nothing packaged ----

const NEW = "a".repeat(40), OLD = "b".repeat(40);
function tools(sourceDir) {
  const calls = [];
  const run = async (file, args, options) => {
    const plain = [];
    for (let at = 0; at < args.length; at++) { if (args[at] === "-c") { at++; continue; } plain.push(args[at]); }
    const line = [file, ...plain].join(" ");
    calls.push(line);
    if (args[0] === "--version") return file === "node" ? "v24.14.0\n" : "11.6.0\n";
    if (line.startsWith("git ls-remote")) return `${NEW}\trefs/heads/${betaLine}\n`;
    if (line.startsWith("git init")) { await mkdir(join(sourceDir, ".git"), { recursive: true }); return ""; }
    if (line.startsWith("git checkout")) {
      await write(join(sourceDir, "package.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2" }));
      await write(join(sourceDir, "package-lock.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2", packages: { "": { version: "0.19.2" } } }));
      await write(join(sourceDir, "node_modules", "electron", "package.json"), JSON.stringify({ version: "44.3.0" }));
      await write(join(sourceDir, "scripts", "assemble-app.mjs"), "// the change's own script");
      return "";
    }
    if (line.startsWith("git merge-base") && !line.includes("--is-ancestor")) return `${OLD}\n`;
    if (line.startsWith("git show")) return "1758600000\n";
    if (line.startsWith("git rev-parse")) return `${NEW}\n`;
    if (line.startsWith("npm run build")) await write(join(sourceDir, "dist", "cli.js"));
    if (line.startsWith("node scripts/assemble-app.mjs --app")) {
      const into = args[2], { version } = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8"));
      await write(join(into, "package.json"), JSON.stringify({ name: "branch-agent", version }));
      await write(join(into, "dist", "build-info.json"), await readFile(join(sourceDir, "dist", "build-info.json"), "utf8"));
    }
    return "";
  };
  return { run, calls };
}

test("a Beta change becomes a folder of its own beside the running version, is switched to, and nothing is packaged or stopped", { skip: windowsOnly }, async (t) => {
  const root = await temp(t), running = join(root, "app-0.19.3");
  await programFolder(running, { version: "0.19.3" });
  const buildDir = join(root, "data", "updates", "beta-build"), scratchDir = join(root, "scratch"), sourceDir = join(buildDir, "source");
  const fake = tools(sourceDir), order = [];
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.3", channel: "beta", installDir: running, executableName: exe,
    assetName: "Branch-Agent-windows-x64.zip", scratchDir, platform: "win32", fetch: async (url) => { throw new Error(`no network: ${url}`); },
    devRun: fake.run, currentCommit: OLD, devBuildDir: buildDir, appFolders: { root, folder: "app-0.19.3" },
    backup: async () => { order.push("backup"); }, canary: async (dir) => { order.push(`canary ${dir}`); }, tryOut: async (dir) => { order.push(`try ${dir}`); return null; },
    beforeStop: async () => { order.push("idle"); }, stopDaemon: async () => { order.push("stop engine"); return 1; },
    handOver: async ({ version }) => { order.push(`hand over ${version}`); return { minimized: true }; }, dataDir: join(root, "data") });
  assert.equal((await updater.check()).phase, "available");
  const { script, stagedDir } = await updater.install();
  const version = `0.19.3-dev.1758600000-g${NEW.slice(0, 12)}`;
  assert.equal(stagedDir, join(root, `app-${version}`));
  assert.deepEqual(order, [`canary ${stagedDir}`, `try ${stagedDir}`, "backup", "idle", `hand over ${version}`], "tried, copied, idle, then the moment; the engine is never stopped");
  assert.equal(fake.calls.some((call) => /package-desktop|package:desktop|packager/.test(call)), false, "nothing is packaged");
  assert.ok(fake.calls.includes(`node scripts/assemble-app.mjs --app ${join(`${partFolder(root, version)}`, "resources", "app")}`));
  assert.equal((await stat(join(stagedDir, exe))).ino, (await stat(join(running, exe))).ino, "the program is the running one's own file");
  // The switch is a plan the hand-over runner follows (version-switch.ts), not a script.
  assert.match(script, /switch-version\.json$/);
  const plan = JSON.parse(await readFile(script, "utf8"));
  assert.equal(plan.newExe, join(stagedDir, exe));
  assert.equal(plan.oldExe, join(running, exe));
  assert.deepEqual([plan.minimized, plan.pid, plan.version, plan.kept], [true, process.pid, version, "0.19.3"], "a window that was in the tray comes back in the tray");
  assert.equal(plan.dataDir, join(root, "data"), "the switch reads the saved work's format before it goes back");
  assert.ok(Number.isInteger(plan.understood) && plan.understood > 0, "with the newest format this version understands");
  assert.equal(JSON.parse(await readFile(join(root, "current.next.json"), "utf8")).folder, `app-${version}`);
  assert.equal(await exists(join(root, "current.json")), false, "nothing is switched until the script runs");
  const failure = JSON.parse(await readFile(join(scratchDir, `${failureName}.draft`), "utf8"));
  assert.deepEqual([failure.kept, failure.tried, failure.commit], ["0.19.3", version, NEW]);
  const back = updater.switchFailed(failure);
  assert.deepEqual([back.phase, back.outcome?.kept, back.release?.tag], ["error", "0.19.3", "dev-aaaaaaa"], "the version it went back to says so, and that change is not retried by itself");
});
