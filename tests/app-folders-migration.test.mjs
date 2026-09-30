/* Versioned app folders over time (src/desktop/app-folders.ts, shell-window.ts): going back by the pointer, keeping two
   versions, the one-time move off the flat layout a copy was installed with, and files held open during each step.
   Stand-in files in a temp folder: nothing here is a real program or touches an installed app. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { discardTemp } from "./temp-dir.mjs";
import {
  launcherMain, launcherName, partFolder, pointerFiles, pruneAppFolders, readPointer, retireFlatCopy, rollBackPointer, sealAppFolder,
  tidyRetirement, writePointer,
} from "../dist/desktop/app-folders.js";
import { forwardedVariable, forwardTarget, guardedForward } from "../dist/desktop/shell-window.js";
import { holdOpen, locksWork } from "./version-lock.mjs";

const exe = "Branch Agent.exe";
const exists = (path) => access(path).then(() => true, () => false);
const at = () => new Date().toISOString();
const notInUse = async () => false;
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "branch-app-migration-"));
  t.after(() => discardTemp(dir));
  return dir;
}
async function write(path, text = "x") { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); }
/** A program folder as Electron and the app leave it. */
async function program(dir, version) {
  await write(join(dir, exe), "stand-in for Electron's stock program");
  await write(join(dir, "resources.pak")); await write(join(dir, "locales", "en-US.pak"));
  await write(join(dir, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
  await write(join(dir, "resources", "app", "public", "assets", "branch.ico"), "icon");
}
/** A copy installed before versioned folders: the program at the top, with the person's and the installer's files. */
async function flatInstall(root) {
  await program(root, "1.0.0");
  await write(join(root, "Uninstall Branch Agent.cmd"), "@echo off");
  await write(join(root, "Branch Data", "keep.txt"), "the person's");
}
/** What the switch does to the pointer when the new version came up (version-switch.ts, step 2). */
async function switchTo(root, running, next) {
  const files = await pointerFiles(root, running, next);
  await rename(files.next, join(root, "current.json"));
}

test("rollback: the pointer names the version before again, forgetting it as the one before; with none, nothing changes", async (t) => {
  const root = await temp(t);
  await program(join(root, "app-1.0.0"), "1.0.0"); await program(join(root, "app-2.0.0"), "2.0.0");
  assert.equal(await rollBackPointer(root, exe), null, "no pointer: nothing to go back to");
  await writePointer(root, { folder: "app-2.0.0", version: "2.0.0", previous: { folder: "app-1.0.0", version: "1.0.0" }, at: at() });
  assert.deepEqual(await rollBackPointer(root, exe), { folder: "app-1.0.0", version: "1.0.0" });
  assert.deepEqual(await readPointer(root), { ...(await readPointer(root)), folder: "app-1.0.0", previous: null });
  assert.equal(await rollBackPointer(root, exe), null, "going back twice has nowhere to go");
  assert.equal(await exists(join(root, "app-2.0.0", exe)), true, "the version gone back from stays whole");
  await writePointer(root, { folder: "app-2.0.0", version: "2.0.0", previous: { folder: "app-9.0.0", version: "9.0.0" }, at: at() });
  assert.equal(await rollBackPointer(root, exe), null, "a version before that is not there is never named");
  assert.equal((await readPointer(root)).folder, "app-2.0.0");
});

test("prune keeps two: the version in use and the one before; a folder held open is left for a later tidy", { skip: !locksWork && "Windows file locks" }, async (t) => {
  const root = await temp(t);
  for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) await program(join(root, `app-${version}`), version);
  const lock = await holdOpen(join(root, "app-2.0.0", "resources.pak"));
  t.after(() => lock.release());
  const pointer = { folder: "app-4.0.0", version: "4.0.0", previous: { folder: "app-3.0.0", version: "3.0.0" }, at: at() };
  assert.deepEqual(await pruneAppFolders(root, pointer), ["app-1.0.0"]);
  assert.equal(await exists(join(root, "app-2.0.0", exe)), true, "the folder something holds open is untouched");
  await lock.release();
  assert.deepEqual(await pruneAppFolders(root, pointer), ["app-2.0.0"], "and goes on the next tidy");
  assert.deepEqual((await readdir(root)).sort(), ["app-3.0.0", "app-4.0.0"]);
});

test("a version is not sealed over a folder something runs from; the half-made one is kept for the next try", { skip: !locksWork && "Windows file locks" }, async (t) => {
  const root = await temp(t);
  await program(join(root, "app-2.0.0"), "2.0.0");
  await program(partFolder(root, "2.0.0"), "2.0.0");
  const lock = await holdOpen(join(root, "app-2.0.0", "resources.pak"));
  t.after(() => lock.release());
  await assert.rejects(sealAppFolder(root, "2.0.0", null));
  assert.equal(await exists(join(partFolder(root, "2.0.0"), exe)), true);
  await lock.release();
  assert.equal(await sealAppFolder(root, "2.0.0", null), join(root, "app-2.0.0"));
});

test("migration: a flat copy is the version before on the first switch, is gone back to, and only retires once not needed", async (t) => {
  const root = await temp(t);
  await flatInstall(root);
  // First update on this build: the flat copy runs, the new version gets a folder of its own.
  await program(join(root, "app-2.0.0"), "2.0.0");
  await switchTo(root, { folder: "", version: "1.0.0" }, { folder: "app-2.0.0", version: "2.0.0" });
  let pointer = await readPointer(root);
  assert.deepEqual(pointer.previous, { folder: "", version: "1.0.0" });
  assert.equal(await retireFlatCopy(root, pointer, { executableName: exe, icon: null, inUse: notInUse }), false, "still the way back");
  // Going back to it removes the pointer: the flat copy is what runs, exactly as before.
  assert.deepEqual(await rollBackPointer(root, exe), { folder: "", version: "1.0.0" });
  assert.equal(await readPointer(root), null);
  assert.equal(JSON.parse(await readFile(join(root, "resources", "app", "package.json"), "utf8")).name, "branch-agent");
  // Forward again, then a second update: now the flat copy is neither in use nor the one before.
  await switchTo(root, { folder: "", version: "1.0.0" }, { folder: "app-2.0.0", version: "2.0.0" });
  await program(join(root, "app-3.0.0"), "3.0.0");
  await switchTo(root, { folder: "app-2.0.0", version: "2.0.0" }, { folder: "app-3.0.0", version: "3.0.0" });
  pointer = await readPointer(root);
  const asked = [];
  const retired = await retireFlatCopy(root, pointer, { executableName: exe, icon: join(root, "app-3.0.0", "resources", "app", "public", "assets", "branch.ico"),
    inUse: async (path) => { asked.push(path); return false; } });
  assert.equal(retired, true);
  assert.deepEqual(asked, [join(root, exe)], "asked by the flat program's exact path");
  const app = join(root, "resources", "app");
  assert.equal(JSON.parse(await readFile(join(app, "package.json"), "utf8")).name, launcherName, "the top is now the stable launcher");
  assert.equal(await readFile(join(app, "public", "assets", "branch.ico"), "utf8"), "icon", "shortcut icons still find the icon");
  for (const kept of [exe, "resources.pak", "Uninstall Branch Agent.cmd", join("Branch Data", "keep.txt"), "current.json", join("app-2.0.0", exe), join("app-3.0.0", exe)])
    assert.equal(await exists(join(root, kept)), true, `${kept} is kept`);
  assert.deepEqual((await readdir(root)).filter((name) => /^resources.(next|trash)-/.test(name)), [], "nothing half-done is left");
  assert.equal(await retireFlatCopy(root, pointer, { executableName: exe, icon: null, inUse: notInUse }), false, "once only");
});

test("the flat copy is not retired while a program runs from it, and a cut-off retirement is put right", async (t) => {
  const root = await temp(t);
  await flatInstall(root);
  const pointer = { folder: "app-3.0.0", version: "3.0.0", previous: { folder: "app-2.0.0", version: "2.0.0" }, at: at() };
  assert.equal(await retireFlatCopy(root, pointer, { executableName: exe, icon: null, inUse: async () => true }), false);
  assert.equal(await retireFlatCopy(root, pointer, { executableName: exe, icon: null, inUse: async () => { throw new Error("no answer"); } }), false, "no answer counts as in use");
  // The second rename fails: the flat app is put back whole.
  let calls = 0;
  const flaky = async (from, to) => { if (++calls === 2) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return rename(from, to); };
  assert.equal(await retireFlatCopy(root, pointer, { executableName: exe, icon: null, inUse: notInUse }, { rename: flaky }), false);
  assert.equal(JSON.parse(await readFile(join(root, "resources", "app", "package.json"), "utf8")).name, "branch-agent");
  assert.deepEqual((await readdir(root)).filter((name) => /^resources.(next|trash)-/.test(name)), []);
  // Power cut between the two renames: only the set-aside app is there; the next start puts it back.
  await rename(join(root, "resources"), join(root, "resources.trash-0123abcd"));
  await write(join(root, "resources.next-0123abcd", "app", "package.json"), "{}");
  await tidyRetirement(root);
  assert.equal(JSON.parse(await readFile(join(root, "resources", "app", "package.json"), "utf8")).name, "branch-agent");
  assert.deepEqual((await readdir(root)).filter((name) => /^resources.(next|trash)-/.test(name)), []);
});

test("the flat copy's app held open stops its retirement with nothing changed", { skip: !locksWork && "Windows file locks" }, async (t) => {
  const root = await temp(t);
  await flatInstall(root);
  const lock = await holdOpen(join(root, "resources", "app", "package.json"));
  t.after(() => lock.release());
  const pointer = { folder: "app-3.0.0", version: "3.0.0", previous: null, at: at() };
  assert.equal(await retireFlatCopy(root, pointer, { executableName: exe, icon: null, inUse: notInUse }), false);
  await lock.release();
  assert.equal(JSON.parse(await readFile(join(root, "resources", "app", "package.json"), "utf8")).name, "branch-agent");
  assert.deepEqual((await readdir(root)).filter((name) => /^resources.(next|trash)-/.test(name)), []);
});

test("the stable launcher is plain script that starts the version in use and never loops", () => {
  const text = launcherMain();
  assert.doesNotThrow(() => new Script(text), "it compiles");
  assert.match(text, /current\.json/);
  assert.match(text, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(text, /\^app-\[0-9A-Za-z\._\+-\]\{1,100\}\$/, "only a version folder of this install is ever started");
});

test("a start of a version that is not the one in use goes to the one in use, once, and only within this install", () => {
  const root = "C:\\P", pointer = JSON.stringify({ folder: "app-3.0.0", version: "3.0.0", previous: null, at: at() });
  const deps = (text, there = true) => ({ readText: () => text, exists: () => there });
  assert.deepEqual(forwardTarget({ root, folder: "app-2.0.0" }, exe, {}, deps(pointer)), { program: join(root, "app-3.0.0", exe), version: "3.0.0" });
  assert.equal(forwardTarget({ root, folder: "" }, exe, {}, deps(pointer))?.program, join(root, "app-3.0.0", exe), "the flat copy forwards too");
  assert.equal(forwardTarget({ root, folder: "app-3.0.0" }, exe, {}, deps(pointer)), null, "the version in use starts itself");
  assert.equal(forwardTarget({ root, folder: "app-2.0.0" }, exe, { [forwardedVariable]: "x" }, deps(pointer)), null, "never twice");
  assert.equal(forwardTarget({ root, folder: "app-2.0.0" }, exe, {}, deps(pointer, false)), null, "a missing version is never started");
  assert.equal(forwardTarget({ root, folder: "app-2.0.0" }, exe, {}, deps(null)), null, "no pointer");
  assert.equal(forwardTarget({ root, folder: "app-2.0.0" }, exe, {}, deps(JSON.stringify({ folder: "..\\evil", version: "1", previous: null, at: at() }))), null);
  assert.equal(forwardTarget(null, exe, {}, deps(pointer)), null, "portable, other systems, from source");
});

/** Stand-ins for the forwarding start: `upAfter` starts (null: never) before the version says its window is up. */
function forwarding({ seenBefore = false, upAfter = null, safe = true, back = true } = {}) {
  const log = { started: 0, ended: [], told: [], rolledBack: 0 };
  let waits = 0;
  const deps = {
    start: () => { log.started++; return 5000 + log.started; },
    up: () => seenBefore || (upAfter !== null && waits >= upAfter),
    end: async (pid) => { log.ended.push(pid); }, safe: async () => safe,
    rollBack: async () => { log.rolledBack++; return back; }, tell: async (tried) => { log.told.push(tried); },
    sleep: async () => { waits++; }, upSeconds: 5,
  };
  return { deps, log };
}
const target = { program: "C:\\P\\app-3.0.0\\Branch Agent.exe", version: "3.0.0" };

test("a start forwarded to a version seen up before just starts it", async () => {
  const { deps, log } = forwarding({ seenBefore: true });
  assert.equal(await guardedForward(target, deps), "forwarded");
  assert.deepEqual([log.started, log.ended.length, log.rolledBack], [1, 0, 0]);
});

test("a start forwarded to a version never seen up waits for its window; one that comes up is kept", async () => {
  const { deps, log } = forwarding({ upAfter: 2 });
  assert.equal(await guardedForward(target, deps), "forwarded");
  assert.deepEqual([log.started, log.ended.length, log.rolledBack], [1, 0, 0]);
});

test("a version put in use with no window open that never comes up is ended and gone back from, and this start opens instead", async () => {
  const { deps, log } = forwarding();
  assert.equal(await guardedForward(target, deps), "went-back");
  assert.deepEqual(log.ended, [5001], "the one process it started, by its id");
  assert.deepEqual([log.rolledBack, log.told], [1, ["3.0.0"]]);
});

test("going back is refused when the saved work is too new for this version, or there is nothing before: the version in use starts again", async () => {
  for (const setup of [{ safe: false }, { back: false }]) {
    const { deps, log } = forwarding(setup);
    assert.equal(await guardedForward(target, deps), "forwarded");
    assert.equal(log.started, 2);
    assert.deepEqual(log.told, []);
  }
});
