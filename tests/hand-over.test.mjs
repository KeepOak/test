import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Script } from "node:vm";
import { discardTemp } from "./temp-dir.mjs";
import { jobFor, launchHandOver, prepareRunner, runnerMain, runnerProgramName, windowsStartAfterScript } from "../dist/desktop/hand-over.js";

const prepared = "C:\\tmp\\hand-over-0000abcd\\Branch Agent Update.exe";

test("the hand-over's runner is started through the Task Scheduler so it outlives the app, with no script host, and started directly as the fallback", async () => {
  const calls = [], jobs = [];
  const exec = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null); };
  let spawned = null;
  const spawn = (command, args, options) => { spawned = { command, args, options }; return { unref() { spawned.unrefd = true; } }; };
  const prepare = async (job, scratch, runtime, executableName) => { jobs.push({ job, scratch, runtime, executableName }); return prepared; };
  const deps = { exec, spawn, prepare, systemRoot: "C:\\Windows", platform: "win32", runtime: "C:\\P\\app-2.0.0", executableName: "Branch Agent.exe" };
  assert.equal(await launchHandOver("C:\\tmp\\apply-update.cmd", 4242, deps), "task");
  assert.equal(spawned, null, "no direct child was started");
  assert.deepEqual(calls.map((c) => c.args[0]), ["/Create", "/Run", "/Delete"]);
  assert.ok(calls.every((c) => c.file.endsWith("System32\\schtasks.exe") && c.options.windowsHide === true));
  const create = calls[0].args;
  assert.equal(create[create.indexOf("/TN") + 1], "BranchAgentUpdate-4242");
  // The task runs the runner itself: Electron's own program, which has no console, so nothing flashes on screen.
  assert.equal(create[create.indexOf("/TR") + 1], `"${prepared}"`);
  assert.doesNotMatch(JSON.stringify(calls), /wscript|\.vbs|cscript/i, "no Windows Script Host anywhere");
  assert.deepEqual(jobs[0], { job: { kind: "script", script: "C:\\tmp\\apply-update.cmd", pid: 4242, log: "C:\\tmp\\hand-over-runner.log" },
    scratch: "C:\\tmp", runtime: "C:\\P\\app-2.0.0", executableName: "Branch Agent.exe" }, "the runner sits beside the scratch files, never in the program folder");
  const failing = (_file, _args, _options, callback) => callback(new Error("Access is denied."));
  const before = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try { assert.equal(await launchHandOver("C:\\tmp\\apply-update.cmd", 7, { ...deps, exec: failing }), "spawn"); }
  finally { if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = before; }
  assert.equal(spawned.command, prepared, "the fallback starts the same runner: a program with no console");
  assert.deepEqual(spawned.args, []);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.env.ELECTRON_RUN_AS_NODE, undefined, "the runner is Electron itself, never Node");
  assert.equal(spawned.unrefd, true);
});

test("a runner command the scheduler cannot hold (over 261 characters) is started directly", async () => {
  const calls = [];
  let spawned = null;
  const long = `C:\\${"x".repeat(270)}\\Branch Agent Update.exe`;
  const how = await launchHandOver("C:\\tmp\\a.cmd", 1, { platform: "win32", prepare: async () => long,
    exec: (file, args, options, callback) => { calls.push(args); callback(null); },
    spawn: (command) => { spawned = command; return { unref() {} }; } });
  assert.equal(how, "spawn");
  assert.deepEqual(calls, []);
  assert.equal(spawned, long);
});

test("a switch plan is run by the running version's own switch module; anything else is a batch script", () => {
  const job = jobFor("C:\\s\\switch-version.json", 5);
  assert.equal(job.kind, "module");
  assert.match(job.module, /[\\/]desktop[\\/]version-switch\.js$/);
  assert.equal(job.plan, "C:\\s\\switch-version.json");
  assert.equal(jobFor("C:\\s\\roll-back.cmd", 5).kind, "script");
});

test("the runner is Electron's runtime hard linked beside the scratch files under its own name, with its app and job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-over-"));
  t.after(() => discardTemp(root));
  const runtime = join(root, "app-2.0.0"), scratch = join(root, "scratch");
  await mkdir(join(runtime, "locales"), { recursive: true }); await mkdir(join(runtime, "resources", "app"), { recursive: true });
  for (const name of ["Branch Agent.exe", "resources.pak", "ffmpeg.dll", join("locales", "en-US.pak"), join("resources", "app", "package.json")])
    await writeFile(join(runtime, name), name);
  await writeFile(join(runtime, "Uninstall Branch Agent.cmd"), "not the runtime");
  await mkdir(join(scratch, "hand-over-0badc0de"), { recursive: true }); // an old runner nothing runs from
  const hourAgo = new Date(Date.now() - 3600_000);
  await utimes(join(scratch, "hand-over-0badc0de"), hourAgo, hourAgo);
  await mkdir(join(scratch, "hand-over-0000beef"), { recursive: true }); // one just made, perhaps not started yet
  const job = jobFor(join(scratch, "apply-update.cmd"), 9);
  const program = await prepareRunner(job, scratch, runtime, "Branch Agent.exe");
  const folder = join(program, "..");
  assert.equal(program.endsWith(runnerProgramName), true);
  assert.equal((await stat(program)).ino, (await stat(join(runtime, "Branch Agent.exe"))).ino, "the program is Electron's own file, linked, never a new one");
  assert.equal((await stat(join(folder, "locales", "en-US.pak"))).ino, (await stat(join(runtime, "locales", "en-US.pak"))).ino);
  const names = await readdir(folder);
  assert.ok(!names.includes("Branch Agent.exe"), "never under Branch's own name, so nothing looking for Branch by name finds it");
  assert.ok(!names.includes("Uninstall Branch Agent.cmd"));
  assert.equal(JSON.parse(await readFile(join(folder, "resources", "app", "package.json"), "utf8")).main, "runner.js");
  assert.deepEqual(JSON.parse(await readFile(join(folder, "resources", "app", "job.json"), "utf8")), job);
  assert.deepEqual((await readdir(scratch)).filter((name) => name.startsWith("hand-over-")).sort(), ["hand-over-0000beef", basename(folder)].sort(),
    "an old runner is tidied away; one just made is never taken from under its start");
  await assert.rejects(prepareRunner(job, scratch, scratch, "Branch Agent.exe"), /holds no Branch program/, "only an Electron program folder can run it");
});

test("the runner's app is plain script: a batch job runs hidden and is waited for, a switch plan goes to the switch module", () => {
  const text = runnerMain();
  assert.doesNotThrow(() => new Script(text));
  assert.match(text, /windowsHide: true, windowsVerbatimArguments: true/);
  assert.doesNotMatch(text, /detached/, "not detached: a detached script has no console, and each tool it starts would open one (CBQ-001)");
  assert.match(text, /runSwitchPlan\(job\.plan\)/);
  assert.match(text, /disableHardwareAcceleration/);
});

test("after going back, a small script waits for the gateway to close and starts the version back in use", () => {
  const text = windowsStartAfterScript({ exe: "C:\\P 100%\\app-1.0.0\\Branch Agent.exe", log: "C:\\d\\roll-back.log", words: "version 1.0.0 is back in use" });
  const lines = text.split("\r\n");
  assert.ok(lines.findIndex((line) => /tasklist\.exe \/FI "PID eq %PID%"/.test(line)) < lines.findIndex((line) => /start ""/.test(line)));
  assert.match(text, /if exist "C:\\P 100%%\\app-1\.0\.0\\Branch Agent\.exe" start "" "C:\\P 100%%\\app-1\.0\.0\\Branch Agent\.exe"/);
  assert.doesNotMatch(text, /robocopy|move |\/IM /i, "nothing is moved, copied or ended by name");
});
