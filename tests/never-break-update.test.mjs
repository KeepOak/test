/**
 * Never breaks, threats 5, 6 and 7: an update is tried on a copy of the data first, the last two
 * versions are kept, a new version that does not stay up is rolled back, and an update cut off
 * half-way is repaired. Fake releases, fake installs and processes this file starts, in temporary
 * folders only; no real app is ever launched and nothing on this computer is installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Updater } from "../dist/desktop/updater.js";
import { posixHandOverScript, posixRollbackScript, windowsRollbackScript } from "../dist/desktop/hand-over.js";
import {
  stagedEngine, runCanary, snapshotData, updateCanary, watchVerdict, repairSwap, readWatch, writeWatch,
} from "../dist/never-break/canary.js";
import { Gateway } from "../dist/never-break/gateway.js";
import { saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";
import { rollBackUpdate, RollbackRefusedError } from "../dist/never-break/worker-link.js";
import { readPointer, writePointer } from "../dist/desktop/app-folders.js";
import { DatabaseSync } from "node:sqlite";

const posix = process.platform !== "win32";
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BRANCH_") && name !== "NODE_OPTIONS"));
/**
 * Windows will not delete an open database, so what a test opened (`closeFirst`) is closed, newest
 * first, in the same hook and before its folder is removed.
 */
const closers = new WeakMap();
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-update-"));
  const list = [];
  closers.set(t, list);
  t.after(async () => { for (const close of list.reverse()) await close(); await discardTemp(root); });
  return root;
}
const closeFirst = (t, close) => closers.get(t).push(close);
const exists = (path) => access(path).then(() => true, () => false);
const run = (file, args) => new Promise((done) => {
  const child = spawn(file, args, { stdio: "ignore" });
  child.once("exit", (code, signal) => done({ code, signal, pid: child.pid }));
});

/* ---------- pure pieces ---------- */

test("the engine is found where each system's package puts it", () => {
  assert.deepEqual(stagedEngine("/tmp/u/Branch Agent.app", "darwin", "Branch Agent.app"), {
    executable: "/tmp/u/Branch Agent.app/Contents/MacOS/Branch Agent",
    script: "/tmp/u/Branch Agent.app/Contents/Resources/app/dist/cli.js" });
  assert.deepEqual(stagedEngine("/tmp/u/Branch-Agent-linux-x64", "linux", "branch-agent"), {
    executable: "/tmp/u/Branch-Agent-linux-x64/branch-agent", script: "/tmp/u/Branch-Agent-linux-x64/resources/app/dist/cli.js" });
  assert.match(stagedEngine("/tmp/u/app", "win32", "Branch Agent.exe").executable, /Branch Agent\.exe$/);
});

test("the watch after an update: roll back only while it is still inside the window", () => {
  const watch = { from: "1.0.0", to: "2.0.0", target: "/x", platform: "linux", executableName: "b", startedAt: new Date(1_000_000).toISOString() };
  const at = (seconds, extra) => watchVerdict(watch, { now: 1_000_000 + seconds * 1000, watchSeconds: 300, runningVersion: "2.0.0", failing: false, ...extra });
  assert.equal(watchVerdict(null, { now: 0, watchSeconds: 300, runningVersion: null, failing: true }), "none");
  assert.equal(at(10), "watching");
  assert.equal(at(10, { failing: true }), "roll-back");
  assert.equal(at(301), "done");
  assert.equal(at(301, { failing: true }), "done", "a crash after the window is an ordinary crash");
  assert.equal(at(10, { runningVersion: "1.0.0" }), "watching");
  assert.equal(at(301, { runningVersion: "1.0.0" }), "none");
});

/* ---------- an update cut off half-way ---------- */

async function fakeInstall(root) {
  const target = join(root, "Apps", "Branch-Agent-linux-x64");
  const staged = join(root, "scratch", "unpacked", "Branch-Agent-linux-x64");
  for (const [dir, marker] of [[target, "old"], [staged, "new"]]) {
    await mkdir(join(dir, "resources"), { recursive: true });
    await writeFile(join(dir, "branch-agent"), `#!/bin/sh\necho started-${marker} >> "${join(root, "launched.log")}"\n`);
    await chmod(join(dir, "branch-agent"), 0o755);
    await writeFile(join(dir, "resources", "version.txt"), marker);
  }
  return { target, staged };
}
const versionIn = (folder) => readFile(join(folder, "resources", "version.txt"), "utf8").catch(() => null);

test("an update cut off after any line leaves one whole version, and a second update keeps two", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await temp(t);
  const plan = (install) => ({ platform: "linux", ...install, log: join(root, "update.log"), executableName: "branch-agent", daemonPid: null, settleSeconds: 0 });
  const lines = posixHandOverScript(plan({ target: "/t", staged: "/s" })).split("\n");
  const moves = lines.map((line, index) => [line, index]).filter(([line]) => /^(rm|mv|cp|if|\/usr)/.test(line)).map(([, index]) => index);
  assert.ok(moves.length >= 6, "the script has steps to cut off");
  const dead = (await run(process.execPath, ["-e", ""])).pid;
  for (const cut of moves) {
    const folder = join(root, `cut-${cut}`);
    const install = await fakeInstall(folder);
    const text = posixHandOverScript(plan(install)).split("\n");
    text.splice(cut + 1, 0, 'kill -9 $$');
    await writeFile(join(folder, "apply.sh"), text.join("\n"));
    await run("/bin/sh", [join(folder, "apply.sh"), String(dead), "stay"]);
    const repaired = await repairSwap(install.target);
    const now = await versionIn(install.target);
    assert.ok(now === "old" || now === "new", `after line ${cut} (${text[cut]}) the program folder holds a whole version, got ${now}; ${repaired.join(" ")}`);
    assert.equal(await exists(`${install.target}.incoming`), false);
  }
  // Two updates in a row keep the two versions before the current one.
  const install = await fakeInstall(join(root, "twice"));
  await writeFile(join(root, "twice", "apply.sh"), posixHandOverScript(plan(install)));
  await run("/bin/sh", [join(root, "twice", "apply.sh"), String(dead), "stay"]);
  await writeFile(join(install.staged, "resources", "version.txt"), "newer");
  await run("/bin/sh", [join(root, "twice", "apply.sh"), String(dead), "stay"]);
  assert.deepEqual([await versionIn(install.target), await versionIn(`${install.target}.previous`), await versionIn(`${install.target}.previous-2`)],
    ["newer", "new", "old"]);
});

test("rolling back puts the previous version in place, keeps the failed one aside and starts the old one", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await temp(t);
  const { target } = await fakeInstall(root);
  for (const [suffix, marker] of [[".previous", "before"], [".previous-2", "long-before"]]) {
    await mkdir(join(`${target}${suffix}`, "resources"), { recursive: true });
    await writeFile(join(`${target}${suffix}`, "resources", "version.txt"), marker);
    await writeFile(join(`${target}${suffix}`, "branch-agent"), `#!/bin/sh\necho started-${marker} >> "${join(root, "launched.log")}"\n`);
    await chmod(join(`${target}${suffix}`, "branch-agent"), 0o755);
  }
  const script = join(root, "roll-back.sh");
  await writeFile(script, posixRollbackScript({ platform: "linux", target, log: join(root, "roll-back.log"), executableName: "branch-agent" }));
  const dead = (await run(process.execPath, ["-e", ""])).pid;
  await run("/bin/sh", [script, String(dead)]);
  assert.equal(await versionIn(target), "before");
  assert.equal(await versionIn(`${target}.failed`), "old", "the version that failed is kept aside, not deleted");
  assert.equal(await versionIn(`${target}.previous`), "long-before", "there is still one to go back to");
  for (let i = 0; i < 50 && !(await exists(join(root, "launched.log"))); i++) await delay(20);
  assert.match(await readFile(join(root, "launched.log"), "utf8"), /started-before/);
  assert.match(await readFile(join(root, "roll-back.log"), "utf8"), /going back[\s\S]*previous version is back/);
  // With nothing to go back to, nothing is touched.
  const lonely = await fakeInstall(join(root, "lonely"));
  const again = join(root, "lonely", "roll-back.sh");
  await writeFile(again, posixRollbackScript({ platform: "linux", target: lonely.target, log: join(root, "lonely.log"), executableName: "branch-agent" }));
  assert.equal((await run("/bin/sh", [again, String(dead), "stay"])).code, 1);
  assert.equal(await versionIn(lonely.target), "old");
});

test("Windows rolls back through the hidden launcher, with no console window", async (t) => {
  const root = await temp(t);
  const text = windowsRollbackScript({ install: "C:\\Apps\\Branch Agent", exe: "C:\\Apps\\Branch Agent\\Branch Agent.exe", log: "C:\\Data\\roll-back.log" });
  assert.match(text, /^@echo off\r\n/);
  assert.match(text, /robocopy\.exe "C:\\Apps\\Branch Agent" "C:\\Apps\\Branch Agent\.failed" \/MIR/);
  assert.match(text, /robocopy\.exe "C:\\Apps\\Branch Agent\.previous" "C:\\Apps\\Branch Agent" \/MIR[\s\S]*if errorlevel 8 exit \/b 1/);
  assert.match(text, /if not exist "C:\\Apps\\Branch Agent\.previous\\"/);
  assert.ok(!/powershell|cmd\.exe \/k/i.test(text));
  const launched = [];
  const script = await rollBackUpdate({ from: "1.0.0", to: "2.0.0", target: "C:\\Apps\\Branch Agent", platform: "win32",
    executableName: "Branch Agent.exe", startedAt: new Date().toISOString() }, root, async (...args) => { launched.push(args); return "task"; });
  assert.match(script, /roll-back\.cmd$/);
  assert.equal(launched[0][2].platform, "win32", "the Windows hand-over (scheduled task + runner, no script host) starts it");
  assert.equal(launched[0][2].runtime, "C:\\Apps\\Branch Agent", "its runner is linked from the installed program");
  assert.match(await readFile(script, "utf8"), /previous version is back/);
});

/** A versioned install (src/desktop/app-folders.ts): app-1.0.0 before, app-2.0.0 in use and being watched. */
async function versionedInstall(root) {
  for (const folder of ["app-1.0.0", "app-2.0.0"]) { await mkdir(join(root, "install", folder), { recursive: true }); await writeFile(join(root, "install", folder, "Branch Agent.exe"), "stand-in"); }
  await writePointer(join(root, "install"), { folder: "app-2.0.0", version: "2.0.0", previous: { folder: "app-1.0.0", version: "1.0.0" }, at: new Date().toISOString() });
  await mkdir(join(root, "data"), { recursive: true });
  return { from: "1.0.0", to: "2.0.0", target: join(root, "install", "app-2.0.0"), platform: "win32", executableName: "Branch Agent.exe",
    startedAt: new Date().toISOString(), understood: 3 };
}

test("Windows with versioned folders goes back by the pointer, then starts the version before once the gateway has closed", async (t) => {
  const root = await temp(t);
  const watch = await versionedInstall(root);
  const launched = [];
  const script = await rollBackUpdate(watch, join(root, "data"), async (...args) => { launched.push(args); return "task"; });
  assert.equal((await readPointer(join(root, "install"))).folder, "app-1.0.0", "going back is one rename, made at once");
  const text = await readFile(script, "utf8");
  assert.match(text, /start "" ".*app-1\.0\.0[\\/]Branch Agent\.exe"/);
  assert.doesNotMatch(text, /robocopy/i, "nothing is copied");
  assert.equal(launched[0][1], process.pid, "the script waits for this gateway");
  assert.equal(launched[0][2].runtime, join(root, "install", "app-1.0.0"));
});

test("Windows with versioned folders refuses to go back when the version before cannot read the saved work", async (t) => {
  const root = await temp(t);
  const watch = await versionedInstall(root);
  const store = new DatabaseSync(join(root, "data", "branch.sqlite"));
  closeFirst(t, () => undefined);
  store.exec("PRAGMA user_version = 5; CREATE TABLE branch_format(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL); INSERT INTO branch_format VALUES (1, 5, 5, 'now')");
  store.close();
  const launched = [];
  await assert.rejects(rollBackUpdate(watch, join(root, "data"), async (...args) => { launched.push(args); return "task"; }),
    (error) => error instanceof RollbackRefusedError && /cannot read/.test(error.message));
  assert.equal((await readPointer(join(root, "install"))).folder, "app-2.0.0", "nothing changed");
  assert.deepEqual(launched, []);
  await assert.rejects(rollBackUpdate({ ...watch, understood: 5 }, join(root, "data"), async () => "task").then(async () => {
    // Readable now: it goes back; a second time there is nothing before it.
    await rollBackUpdate({ ...watch, understood: 5 }, join(root, "data"), async () => "task");
  }), (error) => error instanceof RollbackRefusedError && /nothing to go back to/.test(error.message));
});

test("the Windows update keeps the version before the previous one too", async (t) => {
  const root = await temp(t);
  const bytes = Buffer.from("zip");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fetch = async (url) => String(url).includes("releases/latest")
    ? Response.json({ tag_name: "v2.0.0", name: null, body: "", published_at: null, html_url: "https://github.com/x/y/releases/tag/v2.0.0",
      assets: [{ name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: 3 },
        { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] })
    : String(url).endsWith("app.zip") ? new Response(bytes) : new Response(`${digest}  app.zip\n`);
  const make = (name, extra = {}) => new Updater({ lastReleaseWithoutProvenance: "2.0.0", repo: "x/y", currentVersion: "1.0.0", installDir: join(root, "installed"),
    executableName: "Branch Agent.exe", assetName: "app.zip", scratchDir: join(root, name), fetch, platform: "win32",
    extract: async (_archive, into) => {
      await mkdir(join(into, "app", "resources", "app"), { recursive: true });
      await writeFile(join(into, "app", "Branch Agent.exe"), "new");
      await writeFile(join(into, "app", "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    },
    ...extra });
  await mkdir(join(root, "installed"), { recursive: true });
  const text = await readFile((await make("plain").install()).script, "utf8");
  assert.ok(text.indexOf("previous-2") < text.indexOf("keeping previous version"), "the older copy is kept first");
  // mac7/real-update: the older copy is now renamed aside rather than mirrored.
  assert.match(text, /if exist "[^"]*installed\.previous\\" if not exist "[^"]*installed\.previous-2\\" move "[^"]*installed\.previous" "[^"]*installed\.previous-2"/);

  // A canary that refuses stops the update before any safety copy or script.
  const order = [];
  const refused = make("refused", { backup: async () => { order.push("backup"); },
    canary: async (staged, version) => { order.push(`canary ${version}`); throw new Error("Version 2.0.0 failed its check on a copy of your work: opens the saved work (boom)"); } });
  await assert.rejects(refused.install(), /did not pass its check, so nothing was changed\. Version 2\.0\.0 failed its check/);
  assert.deepEqual(order, ["canary 2.0.0"]);
  assert.equal(refused.status.phase, "error");
  assert.equal(await exists(join(root, "refused", "apply-update.cmd")), false, "no hand-over was written");
  const passed = make("passed", { backup: async () => { order.push("backup"); }, canary: async () => { order.push("canary ok"); } });
  await passed.install();
  assert.deepEqual(order.slice(1), ["canary ok", "backup"], "the check comes before the safety copy");
});

/* ---------- the canary ---------- */

async function fakeRelease(root, body) {
  const staged = join(root, "staged");
  await mkdir(join(staged, "resources", "app", "dist"), { recursive: true });
  await writeFile(join(staged, "resources", "app", "dist", "cli.js"), body);
  await symlink(process.execPath, join(staged, "node-runtime"));
  return stagedEngine(staged, "linux", "node-runtime");
}
async function copyFolder(root) {
  const folder = join(root, "data", "updates", "canary-x", "data");
  await mkdir(folder, { recursive: true });
  return folder;
}

test("the canary reads the new version's own verdict and always cleans up the copy", { skip: !posix && "a link to the runtime" }, async (t) => {
  const root = await temp(t);
  const verdict = (ok) => `import { writeFileSync } from "node:fs";
    if (!process.env.BRANCH_DATA_DIR.includes("canary-")) process.exit(9);
    writeFileSync(process.env.BRANCH_SELF_TEST, JSON.stringify({ ok: ${ok}, version: "2.0.0", contract: 1, format: 1,
      checks: [{ name: "opens the saved work", ok: ${ok}, detail: ${ok ? '"format 1"' : '"it broke"'} }] }));`;
  const passing = await fakeRelease(join(root, "a"), verdict(true));
  const copy = await copyFolder(join(root, "a"));
  const good = await runCanary({ engine: passing, dataCopy: copy });
  assert.equal(good.ok, true, good.detail);
  assert.match(good.detail, /2\.0\.0 passed its check on a copy/);
  assert.equal(await exists(join(copy, "..")), false, "the copy is gone");

  const failing = await fakeRelease(join(root, "b"), verdict(false));
  const bad = await runCanary({ engine: failing, dataCopy: await copyFolder(join(root, "b")) });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /failed its check on a copy of your work: opens the saved work \(it broke\)/);

  const mismatched = await fakeRelease(join(root, "version"), verdict(true));
  const wrongVersion = await runCanary({ engine: mismatched, dataCopy: await copyFolder(join(root, "version")), expectedVersion: "2.1.0" });
  assert.equal(wrongVersion.ok, false);
  assert.match(wrongVersion.detail, /reported version 2\.0\.0.*expected 2\.1\.0/i);

  const hanging = await fakeRelease(join(root, "c"), "setInterval(() => {}, 1000);");
  const slow = await runCanary({ engine: hanging, dataCopy: await copyFolder(join(root, "c")), timeoutMs: 500 });
  assert.equal(slow.ok, false);
  assert.match(slow.detail, /did not finish its check \(it took too long and was stopped\)/);

  const missing = await runCanary({ engine: { executable: process.execPath, script: join(root, "nowhere", "cli.js") }, dataCopy: await copyFolder(join(root, "d")) });
  assert.match(missing.detail, /engine was not found in the download/);
});

test("the real engine passes its own check on a copy of real saved work", { skip: !posix && "a link to the runtime" }, async (t) => {
  const root = await temp(t);
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "w"), dataDir });
  closeFirst(t, () => app.close());
  await app.runtime.run({ prompt: "remember this conversation", onTextDelta: () => undefined });
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on" }));
  const staged = join(root, "staged");
  await mkdir(join(staged, "resources"), { recursive: true });
  await symlink(resolve("."), join(staged, "resources", "app"));
  await symlink(process.execPath, join(staged, "node-runtime"));
  const snapshot = () => snapshotData({ dataDir, database: app.store.sqlite, journal: app.neverBreak.journal.database });
  const canary = updateCanary({ dataDir, platform: "linux", executableName: "node-runtime", fromVersion: "0.16.0",
    target: join(root, "installed"), snapshot, timeoutMs: 240_000 });
  const realVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  await canary(staged, realVersion);
  const watch = await readWatch(dataDir);
  assert.deepEqual([watch.from, watch.to, watch.target], ["0.16.0", realVersion, join(root, "installed")]);
  assert.deepEqual(await readdir(join(dataDir, "updates")), [], "the copy was removed");
  assert.equal(app.store.runs("local").length, 1, "the owner's own data was not touched by the check");

  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "off" }));
  let asked = false;
  await updateCanary({ dataDir, platform: "linux", executableName: "x", fromVersion: "1", target: null, snapshot: async () => { asked = true; return ""; } })(staged, "2");
  assert.equal(asked, false, "with the switch off the update behaves as before");
});

/* ---------- the gateway watching the first minutes ---------- */

async function watchedGateway(t, { env, watch, rollBack }) {
  const root = await temp(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on", watchSeconds: 10 }));
  await writeWatch(dataDir, { from: "1.0.0", to: "2.0.0", target: join(root, "installed"), platform: "linux",
    executableName: "branch-agent", ...watch });
  const events = [];
  const gw = new Gateway({ dataDir, script: resolve("tests/fixtures/never-break-worker.mjs"), args: [], port: 0, version: "2.0.0",
    env: { ...cleanEnv(), ...env }, settleMs: 100000, onWorker: (event) => events.push(event), ...(rollBack ? { rollBack } : {}) });
  closeFirst(t, async () => { await gw.stop(); });
  await gw.start();
  return { gw, dataDir, events };
}
const notes = (gw) => gw.health().notes.map((n) => n.text).join("\n");

test("a new version that stays up through its first minutes ends the watch", async (t) => {
  const { gw, dataDir } = await watchedGateway(t, { env: { FAKE_VERSION: "2.0.0" },
    watch: { startedAt: new Date(Date.now() - 9_500).toISOString() } });
  for (let i = 0; i < 200 && !/is done/.test(notes(gw)); i++) await delay(25);
  assert.match(notes(gw), /update to version 2\.0\.0 is done/);
  assert.equal(await readWatch(dataDir), null);
});

test("a new version that will not start is rolled back to the previous one", async (t) => {
  const rolled = [];
  const { gw, dataDir, events } = await watchedGateway(t, { env: { FAKE_MODE: "crash-start" },
    watch: { startedAt: new Date().toISOString() }, rollBack: async (watch) => { rolled.push(watch); } });
  for (let i = 0; i < 200 && !rolled.length; i++) await delay(25);
  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].from, "1.0.0");
  assert.equal(events.filter((e) => e.kind === "crash").length, 2, "one retry first, then the way back");
  assert.match(notes(gw), /Version 2\.0\.0 did not stay up after the update, so version 1\.0\.0 is being put back/);
  assert.equal(await readWatch(dataDir), null);
  await delay(1500);
  assert.equal(events.filter((e) => e.kind === "crash").length, 2, "after the way back is started, the new version is not started again");
});

/* ---------- integration review (17 September) ---------- */

import { isCanaryCopy } from "../dist/never-break/canary.js";
import { quietCopy } from "../dist/never-break/self-test.js";
import { recoverAfterRestart } from "../dist/never-break/resume.js";

test("the update only ever uses and removes a copy in its own place", async (t) => {
  const root = await temp(t);
  const dataDir = join(root, "data");
  assert.equal(isCanaryCopy(dataDir, join(dataDir, "updates", "canary-2026-09-17T10-00-00-000Z", "data")), true);
  for (const wrong of [join(root, "data"), root, join(dataDir, "updates", "..", "..", "x", "data"), join(dataDir, "updates", "canary-x", "data", ".."), "/"])
    assert.equal(isCanaryCopy(dataDir, wrong), false, wrong);
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on" }));
  await writeFile(join(root, "keep.txt"), "the owner's");
  const canary = updateCanary({ dataDir, platform: "linux", executableName: "x", fromVersion: "1", target: null, snapshot: async () => join(root, "elsewhere") });
  await assert.rejects(canary(join(root, "staged"), "2"), /not where Branch keeps update copies/);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "the owner's", "nothing outside the copy was removed");
});

test("the check on a copy leaves the owner's timed jobs, webhooks and interrupted tasks alone", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d") });
  closeFirst(t, () => app.close());
  app.store.save("schedules", "local", "s1", { kind: "reminder", prompt: "pay the bill", status: "pending", dueAt: new Date(0).toISOString() });
  const owners = app.store.createRun("local", "the owner's own cut-off task");
  app.store.finish(owners.id, "interrupted", "cut off");
  const announced = [];
  app.runtime.notifyEvent = (kind) => announced.push(kind);
  quietCopy(app);
  await app.scheduler.tick();
  assert.equal(app.store.get("schedules", "local", "s1").data.status, "paused", "the copy's timed jobs do not fire");
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  assert.deepEqual(announced, [], "nothing is announced from the copy");
  const mine = app.store.createRun("local", "self-test task");
  app.store.finish(mine.id, "interrupted", "self-test");
  const report = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on", only: new Set([mine.id]) });
  assert.deepEqual(report.map((r) => r.runId), [mine.id], "only the check's own task is settled");
  await Promise.all(report.map((r) => r.resumed));
  assert.equal(app.store.run(owners.id).status, "interrupted");
});
