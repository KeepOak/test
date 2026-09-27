import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { discardTemp } from "./temp-dir.mjs";

import { requestUpdateBackup, stopBackgroundEngine } from "../dist/install/background-engine.js";
import { writeRunning, readRunning } from "../dist/install/running.js";
import { Updater } from "../dist/desktop/updater.js";

async function scratch(t) {
  const base = join(tmpdir(), "Codex-session-files");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "branch-daemon-update-"));
  t.after(() => discardTemp(root));
  return root;
}

/** A release the updater can download, verify and unpack without touching the network. */
function fakeRelease() {
  const bytes = Buffer.from("pretend zip");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return async (url) => {
    if (String(url).includes("releases/latest"))
      return new Response(JSON.stringify({
        tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null,
        html_url: "https://github.com/x/y/releases/tag/v2.0.0",
        assets: [
          { name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: bytes.length },
          { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).endsWith("app.zip")) return new Response(bytes, { status: 200 });
    return new Response(`${digest}  app.zip\n`, { status: 200 });
  };
}

async function updaterFor(root, name, extra = {}) {
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  return new Updater({ lastReleaseWithoutProvenance: "2.0.0",
    repo: "x/y", currentVersion: "1.0.0", installDir, executableName: "Branch Agent.exe",
    assetName: "app.zip", scratchDir: join(root, name), fetch: fakeRelease(),
    extract: async (_archive, into) => {
      await mkdir(join(into, "app", "resources", "app"), { recursive: true });
      await writeFile(join(into, "app", "Branch Agent.exe"), "new");
      await writeFile(join(into, "app", "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    },
    backup: async () => {},
    platform: "win32",
    ...extra,
  });
}

// ------------------------------------------------- asking a background engine for the safety copy

test("the window asks the engine it joined for the safety copy, with the session token", async () => {
  const seen = [];
  const answer = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.authorization });
    return new Response(JSON.stringify({ path: "C:\\data\\update-backups\\before.json", pruned: [], dataCopy: "data-2026-09-26T10-00-00-000Z-v0.19.3" }), { status: 200 });
  };
  await requestUpdateBackup("http://127.0.0.1:4321", "a".repeat(64), { fetch: answer });
  assert.deepEqual(seen, [{
    url: "http://127.0.0.1:4321/api/deployment/backup",
    method: "POST",
    auth: `Bearer ${"a".repeat(64)}`,
  }]);
});

test("whatever the engine says went wrong is what the owner is shown, word for word", async () => {
  const tooBig = async () => new Response(
    JSON.stringify({ error: "This copy holds more saved work than a safety copy can hold (64 MiB)." }),
    { status: 400 });
  await assert.rejects(requestUpdateBackup("http://127.0.0.1:1", "t", { fetch: tooBig }), /can hold \(64 MiB\)\.$/);
  const silent = async () => new Response("<html>", { status: 503 });
  await assert.rejects(requestUpdateBackup("http://127.0.0.1:1", "t", { fetch: silent }), /HTTP 503/);
  const odd = async () => new Response(JSON.stringify({ pruned: [] }), { status: 200 });
  await assert.rejects(requestUpdateBackup("http://127.0.0.1:1", "t", { fetch: odd }), /did not say where it put the copy/);
  // An engine that made the rows' copy but not the data folder's stops the update too (src/install/data-copy.ts).
  const rowsOnly = async () => new Response(JSON.stringify({ path: "C:\\data\\update-backups\\before.json", pruned: [] }), { status: 200 });
  await assert.rejects(requestUpdateBackup("http://127.0.0.1:1", "t", { fetch: rowsOnly }), /did not make a copy of the data folder/);
});

test("an update through a joined engine stops with advice when the copy cannot be made", async (t) => {
  const root = await scratch(t);
  const refuse = async () => new Response(
    JSON.stringify({ error: "This copy holds more saved work than a safety copy can hold (64 MiB)." }),
    { status: 400 });
  const updater = await updaterFor(root, "scratch-too-big", {
    backup: () => requestUpdateBackup("http://127.0.0.1:1", "t", { fetch: refuse }),
  });
  await assert.rejects(updater.install(),
    /safety copy could not be made.*\(64 MiB\)\. Free some space on this drive, or move Branch's data folder somewhere it can write, then try the update again\./s);
  assert.equal(updater.status.phase, "error");
});

// ------------------------------------------------------------------- closing the background engine

const noteFor = (dataDir, pid, mode = "daemon") =>
  writeRunning(dataDir, { port: 3210, pid, url: "http://127.0.0.1:3210", mode, version: "1.0.0" });
// Windows: what tasklist says about a process id, so only Branch's own program is ever ended.
const tasklist = (file, args, image = "Branch Agent.exe") =>
  file.endsWith("tasklist.exe") ? `"${image}","${args[1].replace("PID eq ", "")}","Console","1","90,000 K"\r\n` : null;
const nothingListening = async () => { throw new Error("nothing is listening"); };

test("the background engine is asked to close, forced if it will not, and the note is cleared", async (t) => {
  const root = await scratch(t);
  await noteFor(root, 40404);
  const calls = [];
  let living = true;
  const report = await stopBackgroundEngine(root, {
    run: async (file, args) => tasklist(file, args) ?? (calls.push([file, args]), living = false, ""),
    alive: () => living,
    sleep: async () => {},
    platform: "win32", fetch: nothingListening,
  });
  assert.deepEqual(report, {
    pid: 40404, stopped: true, forced: false,
    message: "Branch stopped working in the background so the new version can replace the files.",
  });
  assert.equal(calls.length, 1, "asking politely was enough");
  assert.ok(calls[0][0].endsWith("System32\\taskkill.exe"));
  assert.deepEqual(calls[0][1], ["/PID", "40404", "/T"]);
  assert.equal(await readRunning(root), null, "the note that an engine is running is cleared");
});

test("an engine that ignores the polite ask is ended, and one that never goes does not stop the update", async (t) => {
  const root = await scratch(t);
  await noteFor(root, 50505);
  const args = [];
  let living = true;
  const forced = await stopBackgroundEngine(root, {
    run: async (file, called) => {
      if (tasklist(file, called)) return tasklist(file, called);
      args.push(called);
      if (!called.includes("/F")) throw new Error("This process can only be terminated forcefully");
      living = false;
      return "";
    },
    alive: () => living, sleep: async () => {}, platform: "win32", fetch: nothingListening,
  });
  assert.deepEqual(args, [["/PID", "50505", "/T"], ["/PID", "50505", "/T", "/F"]]);
  assert.deepEqual([forced.pid, forced.stopped, forced.forced], [50505, true, true]);

  await noteFor(root, 60606);
  const stubborn = await stopBackgroundEngine(root, {
    run: async (file, args) => tasklist(file, args) ?? "", alive: () => true, sleep: async () => {}, waitMs: 0, platform: "win32",
    fetch: nothingListening,
  });
  assert.deepEqual([stubborn.pid, stubborn.stopped], [60606, false]);
  assert.match(stubborn.message, /did not close in time; the update will close it/);
  assert.notEqual(await readRunning(root), null, "a note for an engine still running is left alone");
});

test("automatic update leaves an unresponsive background engine running", async (t) => {
  const root = await scratch(t);
  await noteFor(root, 61616);
  const calls = [];
  const report = await stopBackgroundEngine(root, {
    run: async (file, args) => tasklist(file, args) ?? (calls.push(args), ""),
    alive: () => true, sleep: async () => {}, waitMs: 0,
    platform: "win32", fetch: nothingListening, gracefulOnly: true,
  });
  assert.deepEqual(calls, [["/PID", "61616", "/T"]], "no forced termination follows a slow polite ask");
  assert.deepEqual([report.pid, report.stopped, report.forced], [61616, false, false]);
  assert.notEqual(await readRunning(root), null, "the running engine remains registered");
});

test("Windows: a note left by a crash that names another program's process id never ends that program", async (t) => {
  const root = await scratch(t);
  await noteFor(root, 80808);
  const killed = [];
  const report = await stopBackgroundEngine(root, {
    run: async (file, args) => tasklist(file, args, "WINWORD.EXE") ?? (killed.push(args), ""),
    alive: () => true, sleep: async () => {}, platform: "win32", fetch: nothingListening,
  });
  assert.deepEqual(killed, [], "taskkill is never run");
  assert.deepEqual([report.pid, report.stopped], [null, false]);
  assert.equal(await readRunning(root), null, "the stale note is cleared");
});

test("a window that runs its own engine has nothing to close", async (t) => {
  const root = await scratch(t);
  assert.equal((await stopBackgroundEngine(root, { run: async () => "" })).pid, null, "no note at all");
  await noteFor(root, 70707, "app");
  assert.equal((await stopBackgroundEngine(root, { run: async () => "" })).pid, null, "the note is a window, not an engine");
  await noteFor(root, process.pid);
  assert.equal((await stopBackgroundEngine(root, { run: async () => "" })).pid, null, "the note is this very process");
});

test("waiting for the engine watches a real process until it is really gone", async (t) => {
  const root = await scratch(t);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  await noteFor(root, child.pid);
  const ended = once(child, "exit");
  const report = await stopBackgroundEngine(root, {
    // Windows: taskkill ends the child. macOS and Linux: the system names the engine script for that
    // process id, nothing answers on the noted address, so the stop signal ends the child.
    run: async (file, args) => {
      if (file === "/bin/ps") return "/opt/app/resources/app/dist/cli.js start";
      if (tasklist(file, args)) return tasklist(file, args);
      child.kill(); return "";
    },
    fetch: async () => { throw new Error("nothing is listening"); },
  });
  await ended;
  assert.deepEqual([report.pid, report.stopped], [child.pid, true]);
  assert.equal(await readRunning(root), null);
});

// -------------------------------------------------------------- the hand-over waits for both of them

test("the hand-over waits for the engine as well, and is unchanged when there is no engine", async (t) => {
  const root = await scratch(t);
  const alone = await readFile((await (await updaterFor(root, "scratch-alone")).install()).script, "utf8");
  assert.ok(!alone.includes("background engine"), "nothing about an engine when there was none");
  assert.ok(!alone.includes(":engine"), "no second wait loop");

  const stopped = [];
  const joined = await updaterFor(root, "scratch-joined", {
    stopDaemon: async () => { stopped.push("asked"); return 4321; },
  });
  const text = await readFile((await joined.install()).script, "utf8");
  assert.deepEqual(stopped, ["asked"], "the engine is closed before the hand-over script is written");
  assert.match(text, /:wait[\s\S]*app closed[\s\S]*:engine[\s\S]*background engine closed[\s\S]*:drain/,
    "the app is waited for, then the engine, then the leftovers");
  assert.match(text, /tasklist\.exe \/FI "PID eq 4321" \/NH \/FO CSV/);
  assert.match(text, /background engine still open after %EWAITED% waits[\s\S]*taskkill\.exe \/PID 4321 \/T \/F/,
    "an engine that will not go is ended, so the copy never hits a locked file");
  assert.ok(text.indexOf(":engine") < text.indexOf("keeping previous version"),
    "both are gone before the previous version is mirrored");
});

test("cmd runs the two-wait script through to the copy", { skip: process.platform !== "win32" && "Windows batch" }, async (t) => {
  const root = await scratch(t);
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent.exe"), "old");
  // Neither process id exists, so both waits fall straight through; "stay" stops before anything starts.
  // Its own RunOnce key, so a run never registers anything for the next real sign-in.
  const updater = await updaterFor(root, "scratch-run", { stopDaemon: async () => 999998, runOnceKey: "HKCU\\Software\\BranchAgentTest\\RunOnce" });
  t.after(() => new Promise((resolve) => spawn("reg.exe", ["delete", "HKCU\\Software\\BranchAgentTest", "/f"], { stdio: "ignore", windowsHide: true }).on("close", resolve).on("error", resolve)));
  const { script } = await updater.install();
  await new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/d", "/c", script, "999999", "stay"], { stdio: "ignore", windowsHide: true });
    child.on("close", resolve);
    child.on("error", resolve);
  });
  assert.equal(await readFile(join(installDir, "Branch Agent.exe"), "utf8"), "new", "the new files landed");
  assert.match(await readFile(join(root, "scratch-run", "apply-update.log"), "utf8"),
    /app closed[\s\S]*background engine closed[\s\S]*copying new version beside the old one, attempt 1/,
    "both waits were passed, in order, before the copy");
});

test("an engine that refuses to close stops the update before hand-over", async (t) => {
  const root = await scratch(t);
  const updater = await updaterFor(root, "scratch-refused", {
    stopDaemon: async () => { throw new Error("taskkill is missing"); },
  });
  await assert.rejects(updater.install(), /taskkill is missing/);
  assert.equal(updater.status.phase, "error");
  await assert.rejects(readFile(join(root, "scratch-refused", "apply-update.cmd")), /ENOENT/);
});
