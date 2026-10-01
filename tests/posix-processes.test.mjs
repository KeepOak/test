import { processRunning } from "./process-running.mjs";
/**
 * mac1/processes: holding programs to limits and ending them cleanly on macOS and Linux, with the
 * Windows side unchanged. Pure logic takes `platform` as a parameter so all three are checked on
 * every machine. The only real programs started are `/bin/sh` and short-lived `node -e` children:
 * no window, no sound, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import {
  limitScript, limitWrapper, posixLimitSupport, endProcessGroup, PosixProcessGroups,
} from "../dist/integrations/posix-limits.js";
import { defaultJobObjects, noJobObjects, WindowsJobObjects, startedThrough } from "../dist/integrations/job-object.js";
import { psSeconds, psGroupSample, readDarwinGroup, readLinuxGroup, usageReaderFor } from "../dist/integrations/process-usage.js";
import { ShellProcess } from "../dist/integrations/shell-process.js";
import { defaultShellFor, quoteForShell, posixEnvironment, fromTheTop, shellEnvironment, ShellConfigSchema } from "../dist/integrations/shell-config.js";
import { gitFinder, findGitOn, gitEnvironment } from "../dist/integrations/git-run.js";
import { sshProgram, sshEnvironment } from "../dist/remote/ssh-workspace.js";
import { sandboxShape, sandboxChoices } from "../dist/sandbox.js";

const posix = process.platform !== "win32";
const limits = { maxMemoryMb: 1024, maxCpuSeconds: 60 };
const alive = (pid) => processRunning(pid, () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } });
async function gone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await delay(25); }
  return false;
}
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "branch-posix-"));
  t.after(() => discardTemp(dir));
  return dir;
}
/** Runs a command to the end and hands back what it printed. */
function output(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
  });
}

/* ---- the limit wrapper ---- */

test("the limit wrapper is an argument array whose script holds only fixed text and numbers", () => {
  const nasty = ["'; touch /tmp/pwned; '", "$(reboot)", "`id`", "a b", "--", "-c"];
  for (const platform of ["darwin", "linux"]) {
    const wrapped = limitWrapper({ executable: "/opt/tool", args: nasty }, { maxMemoryMb: 512, maxCpuSeconds: 42.4 }, platform);
    assert.equal(wrapped.executable, "/bin/sh");
    assert.equal(wrapped.args[0], "-c");
    assert.deepEqual(wrapped.args.slice(2), ["/opt/tool", ...nasty], "the program and its arguments follow the script untouched");
    const script = wrapped.args[1];
    assert.match(script, /exec "\$0" "\$@"$/);
    assert.match(script, /ulimit -S -t 42;/);
    assert.match(script, /ulimit -H -t 42; fi/);
    assert.doesNotMatch(script, /opt|tool|pwned|reboot|-v|-d|-u/, "no user text and no memory or process-count flag");
    assert.equal(script.replace(/\d+/g, "N"), limitScript({ maxMemoryMb: 1, maxCpuSeconds: 9 }, platform).replace(/\d+/g, "N"),
      "the script is the same fixed text whatever the limits are");
  }
  assert.throws(() => limitScript({ maxMemoryMb: 1, maxCpuSeconds: Number.POSITIVE_INFINITY }, "linux"), /whole numbers/);
});

test("what the system holds is reported plainly for macOS and Linux", () => {
  for (const platform of ["darwin", "linux"]) {
    const support = posixLimitSupport(platform);
    assert.equal(support.processorTime, true);
    assert.equal(support.memory, false, "the system memory caps stop Node from starting, so they are not claimed");
    assert.equal(support.processCount, false);
    assert.equal(support.wholeGroupEnds, true);
    assert.match(support.sentence, platform === "darwin" ? /^On macOS/ : /^On Linux/);
    assert.match(support.sentence, /memory.*checked about once a second/);
    assert.match(support.sentence, /not OS isolation/);
    assert.match(support.sentence, /may survive/);
    assert.doesNotMatch(support.sentence, /launchd|rlimit|setrlimit|ulimit/i, "plain words");
  }
});

test("the wrapper really starts the program with its arguments intact", { skip: !posix }, async () => {
  const args = ["'; echo broken; '", "$(echo no)", "two words", "-c"];
  const wrapped = limitWrapper({ executable: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args] }, limits, process.platform);
  const { code, out, err } = await output(wrapped);
  assert.equal(code, 0, err);
  assert.equal(err, "", "no complaint from the shell about any limit");
  assert.deepEqual(JSON.parse(out), args);
});

test("hostile arguments never run as shell commands through the wrapper", { skip: !posix }, async (t) => {
  const dir = await scratch(t);
  const marks = ["a", "b", "c", "d"].map((name) => join(dir, name));
  const args = [`$(touch ${marks[0]})`, `\`touch ${marks[1]}\``, `x\ntouch ${marks[2]}`, `'; touch ${marks[3]}; '`, "--", "\"$@\"", "$0"];
  const wrapped = limitWrapper({ executable: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args] }, limits, process.platform);
  const { code, out, err } = await output(wrapped);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out), args, "every argument arrives byte for byte");
  for (const mark of marks) assert.equal(await readFile(mark).then(() => true, () => false), false, `${mark} was created`);
  // A hostile program name is also only ever "$0", never part of the script.
  const odd = limitWrapper({ executable: `/nonexistent/$(touch ${marks[0]})`, args: [] }, limits, process.platform);
  const failed = await output(odd);
  assert.notEqual(failed.code, 0);
  assert.equal(await readFile(marks[0]).then(() => true, () => false), false);
});

test("a limit can only be lowered: a lower one already in place is kept, a higher one is brought down", { skip: !posix }, async () => {
  const report = ["-c", "echo $(ulimit -S -t) $(ulimit -H -t)"];
  const wrapped = limitWrapper({ executable: "/bin/sh", args: report }, limits, process.platform);
  const plain = await output(wrapped);
  assert.equal(plain.out.trim().split(" ").map(Number).every((value) => value <= 60), true, plain.out);
  // Start the wrapper from a shell that already holds the soft limit at 7 seconds.
  const tighter = await output({ executable: "/bin/sh", args: ["-c", 'ulimit -S -t 7; exec "$0" "$@"', ...[wrapped.executable, ...wrapped.args]] });
  const [soft, hard] = tighter.out.trim().split(" ");
  assert.equal(soft, "7", "the tighter limit already in place was not loosened to 60");
  assert.equal(Number(hard) <= 60, true, `hard limit ${hard} was brought down`);
});

/* ---- choosing the job, and starting through it ---- */

test("each platform gets its own kind of job, and Windows keeps its own", async () => {
  assert.ok(defaultJobObjects("win32") instanceof WindowsJobObjects);
  assert.ok(defaultJobObjects("darwin") instanceof PosixProcessGroups);
  assert.ok(defaultJobObjects("linux") instanceof PosixProcessGroups);
  assert.equal(defaultJobObjects("aix"), noJobObjects);
  const job = await new PosixProcessGroups("linux", () => undefined).create(limits);
  assert.equal(job.kind, "process-group");
  assert.deepEqual(startedThrough(null, { executable: "/x", args: ["a"] }), { executable: "/x", args: ["a"] });
  assert.equal(startedThrough(job, { executable: "/x", args: ["a"] }).executable, "/bin/sh");
  assert.equal(await job.assign(1234), true);
  const bare = await new PosixProcessGroups("linux", () => undefined).create(limits);
  assert.deepEqual(bare.wrap({ executable: "tool", args: [] }), { executable: "tool", args: [] }, "a bare name is not wrapped");
  assert.equal(await bare.assign(1234), false, "and so the job does not claim to hold it");
});

test("letting a group go asks first, then forces only what is still there", async () => {
  const calls = [];
  let living = true;
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (!living) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (signal === "SIGTERM") living = false;
  };
  await endProcessGroup(4321, { kill, graceMs: 200 });
  assert.deepEqual(calls, [[-4321, "SIGTERM"], [-4321, 0]], "a group that left on SIGTERM is not sent SIGKILL");

  const stubborn = [];
  await endProcessGroup(4321, { kill: (pid, signal) => { stubborn.push(signal); }, graceMs: 60 });
  assert.equal(stubborn[0], "SIGTERM");
  assert.equal(stubborn.at(-1), "SIGKILL", "one that ignores SIGTERM is forced after the grace");

  const never = [];
  await endProcessGroup(1, { kill: (pid, signal) => never.push(signal) });
  await endProcessGroup(0, { kill: (pid, signal) => never.push(signal) });
  assert.deepEqual(never, [], "never the whole system, never our own group");
  await assert.rejects(endProcessGroup(99, { kill: () => { throw Object.assign(new Error("no"), { code: "EPERM" }); } }), /no/);
  // macOS answers EPERM once only finished, uncollected members are left: that is the group gone.
  const zombies = [];
  await endProcessGroup(77, { graceMs: 200, kill: (pid, signal) => {
    zombies.push(signal);
    if (signal !== "SIGTERM") throw Object.assign(new Error("only zombies"), { code: "EPERM" });
  } });
  assert.deepEqual(zombies, ["SIGTERM", 0], "no SIGKILL, and no error, once only zombies remain");
});

test("closing the group ends a grandchild the command left behind", { skip: !posix }, async (t) => {
  const dir = await scratch(t);
  const pidFile = join(dir, "grandchild.pid");
  const grandchild = "setInterval(() => {}, 1000)";
  const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const job = await defaultJobObjects().create(limits);
  const argv = startedThrough(job, { executable: process.execPath, args: ["-e", parent] });
  const child = spawn(argv.executable, argv.args, { detached: true, stdio: "ignore" });
  assert.equal(await job.assign(child.pid), true);
  let grandPid = 0;
  for (let i = 0; i < 200 && !grandPid; i++) { grandPid = Number(await readFile(pidFile, "utf8").catch(() => 0)); if (!grandPid) await delay(25); }
  t.after(() => { for (const pid of [child.pid, grandPid]) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  assert.ok(grandPid > 0, "the grandchild started");
  assert.equal(alive(grandPid), true);
  await job.close();
  assert.equal(await gone(grandPid), true, "the grandchild was ended with the group");
  assert.equal(await gone(child.pid), true, "and so was the command itself");
});

test("a finished command's leftovers are ended, and the result says what the system held", { skip: !posix }, async (t) => {
  const dir = await scratch(t);
  const pidFile = join(dir, "left.pid");
  const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
c.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`;
  const job = await defaultJobObjects().create(limits);
  const result = await new ShellProcess({ executable: process.execPath, args: ["-e", script], cwd: dir, env: { PATH: "" },
    signal: new AbortController().signal, timeoutMs: 10000, maxOutputBytes: 1024, maxMemoryMb: 1024, maxCpuSeconds: 60, job }).run();
  const left = Number(await readFile(pidFile, "utf8"));
  t.after(() => { try { process.kill(left, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.isolation, "sampling", "the Windows-only name is not borrowed");
  assert.deepEqual(result.heldBySystem, { processorTime: true, memory: false, wholeGroupEnds: true });
  assert.match(result.cleanup.strategy, /process group/);
  assert.match(result.cleanup.limitation, process.platform === "darwin" ? /^On macOS/ : /^On Linux/);
  assert.equal(await gone(left), true, "what the command left running was ended with it");
});

test("a command with no job reports exactly what it did before", { skip: !posix }, async () => {
  const result = await new ShellProcess({ executable: process.execPath, args: ["-e", "1"], cwd: tmpdir(), env: { PATH: "" },
    signal: new AbortController().signal, timeoutMs: 10000, maxOutputBytes: 1024 }).run();
  assert.equal(result.status, "completed");
  assert.equal(result.isolation, "sampling");
  assert.equal(result.heldBySystem, undefined);
  assert.equal(result.cleanup.strategy, "POSIX process group");
});

/* ---- reading usage ---- */

test("ps times from macOS and Linux are read the same way", () => {
  assert.equal(psSeconds("0:00.01"), 0.01);
  assert.equal(psSeconds("314:50.28"), 314 * 60 + 50.28);
  assert.equal(psSeconds("00:01:05"), 65);
  assert.equal(psSeconds("2-03:04:05"), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(psSeconds("soon"), null);
  const sample = psGroupSample("  2400   0:01.50\n  1184   1:00.00\n garbage\n");
  assert.deepEqual(sample, { memoryMb: 2400 / 1024, cpuSeconds: 61.5 }, "largest program's memory, total processor time");
  assert.equal(psGroupSample(""), null);
  assert.equal(psGroupSample(null), null);
});

test("macOS reads the whole group with ps -g, and falls back to the program alone", async () => {
  const calls = [];
  const run = async (executable, args) => { calls.push([executable, ...args]); return args[2] === "-g" ? "100 0:02.00\n300 0:03.00\n" : null; };
  assert.deepEqual(await readDarwinGroup(77, run), { memoryMb: 300 / 1024, cpuSeconds: 5 });
  assert.deepEqual(calls, [["ps", "-o", "rss=,time=", "-g", "77"]]);
  const fallback = [];
  const lone = async (executable, args) => { fallback.push(args.join(" ")); return args[2] === "-p" ? "50 0:01.00\n" : null; };
  assert.deepEqual(await usageReaderFor("darwin", { run: lone })(9), { memoryMb: 50 / 1024, cpuSeconds: 1 });
  assert.deepEqual(fallback, ["-o rss=,time= -g 9", "-o rss=,time= -p 9"]);
});

test("Linux reads the whole group from /proc without starting a program", async (t) => {
  const proc = await scratch(t);
  const entry = async (pid, name, pgrp, utime, stime, rssKb) => {
    await mkdir(join(proc, String(pid)));
    const fields = ["S", "1", String(pgrp), ...Array(8).fill("0"), String(utime), String(stime), ...Array(9).fill("0")];
    await writeFile(join(proc, String(pid), "stat"), `${pid} (${name}) ${fields.join(" ")}\n`);
    await writeFile(join(proc, String(pid), "status"), `Name:\t${name}\nVmRSS:\t   ${rssKb} kB\n`);
  };
  await entry(500, "node", 500, 150, 50, 2048);
  await entry(501, "a (tricky) name", 500, 100, 0, 4096);
  await entry(502, "other", 999, 9999, 9999, 999999);
  await mkdir(join(proc, "self"));
  assert.deepEqual(await readLinuxGroup(500, proc), { memoryMb: 4, cpuSeconds: 3 });
  assert.equal(await readLinuxGroup(12345, proc), null);
  assert.deepEqual(await usageReaderFor("linux", { procRoot: proc })(500), { memoryMb: 4, cpuSeconds: 3 });
  assert.equal(await readLinuxGroup(500, join(proc, "missing")), null);
});

test("the real reader sees this computer's own group", { skip: !posix }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { detached: true, stdio: "ignore" });
  try {
    await delay(200);
    const sample = await usageReaderFor(process.platform)(child.pid);
    assert.ok(sample && sample.memoryMb > 1, JSON.stringify(sample));
  } finally { process.kill(-child.pid, "SIGKILL"); }
});

test("macOS ps -g really reads every program in the group, not just the leader", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn("/bin/sh", ["-c", `"${process.execPath}" -e "setTimeout(() => {}, 3000)" & wait`], { detached: true, stdio: "ignore" });
  try {
    await delay(300);
    const rows = [];
    const sample = await readDarwinGroup(child.pid, async (executable, args) => {
      const text = execFileSync(executable, args, { encoding: "utf8" });
      rows.push(...text.trim().split("\n"));
      return text;
    });
    assert.ok(sample && sample.memoryMb > 1, JSON.stringify(sample));
    assert.ok(rows.length >= 2, `the group read saw ${rows.length} program(s)`);
  } finally { process.kill(-child.pid, "SIGKILL"); }
});

/* ---- a rule can only tighten ---- */

test("a sandbox rule only ever tightens, every field, on macOS, Linux and Windows alike", () => {
  const ruleShape = { "no-internet": { job: true, netless: true }, "limits-only": { job: true, netless: false }, none: { job: false, netless: false } };
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const choice of [null, undefined, ...sandboxChoices]) {
      for (const job of [true, false]) for (const netless of [true, false]) {
        const fallback = { job, netless };
        const shape = sandboxShape(choice, fallback);
        const expected = choice ? { job: ruleShape[choice].job || job, netless: ruleShape[choice].netless || netless } : fallback;
        assert.deepEqual(shape, expected, `${platform}: ${choice} over ${JSON.stringify(fallback)}`);
        assert.ok(!job || shape.job, `${platform}: ${choice} let go of limits the settings hold`);
        assert.ok(!netless || shape.netless, `${platform}: ${choice} reopened the internet the settings closed`);
        // On macOS and Linux a held shape is started through the fixed limit script, and that
        // script only ever lowers a limit, so composing it with the host's limits cannot loosen them.
        if (shape.job && platform !== "win32") {
          const script = limitWrapper({ executable: "/x", args: [] }, limits, platform).args[1];
          assert.doesNotMatch(script.replace(/ulimit -[SH] -t \d+; fi/g, ""), /ulimit -[SH] -t \d+/,
            "every limit it sets is guarded by the lower-only test");
        }
      }
    }
  }
  // "none" still drops the box when the settings never asked for one.
  assert.deepEqual(sandboxShape("none", { job: false, netless: false }), { job: false, netless: false });
});

/* ---- shells ---- */

test("the default command line suits each computer", () => {
  assert.deepEqual(defaultShellFor("darwin", { SHELL: "/opt/homebrew/bin/fish" }), { path: "/bin/zsh", args: ["-f"] });
  assert.deepEqual(defaultShellFor("linux", { SHELL: "/usr/bin/zsh" }), { path: "/usr/bin/zsh", args: [] });
  assert.deepEqual(defaultShellFor("linux", { SHELL: "zsh" }), { path: "/bin/bash", args: [] }, "not a full address");
  assert.deepEqual(defaultShellFor("linux", { SHELL: "/usr/bin/python3" }), { path: "/bin/bash", args: [] }, "not a shell");
  assert.deepEqual(defaultShellFor("linux", {}), { path: "/bin/bash", args: [] });
  const windows = defaultShellFor("win32", { SystemRoot: "D:\\Win" });
  assert.equal(windows.path, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(defaultShellFor("win32", {}).path, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(fromTheTop("win32"), "starting from the drive");
  assert.equal(fromTheTop("darwin"), "starting with /");
});

test("quoting follows the shell it is for", () => {
  assert.equal(quoteForShell("/bin/zsh", "it's $HOME"), `'it'\\''s $HOME'`);
  assert.equal(quoteForShell("/bin/bash", ""), "''");
  assert.equal(quoteForShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "it's $env:X"), "'it''s $env:X'");
  assert.equal(quoteForShell("pwsh", "a\u2019b"), "'a\u2019\u2019b'");
  assert.throws(() => quoteForShell("cmd.exe", "x"), /PowerShell/);
  assert.throws(() => quoteForShell("/bin/sh", "a\u0000b"), /NUL/);
});

test("a quoted argument comes back unchanged through a real POSIX shell", { skip: !posix }, () => {
  const values = ["it's", "$(id)", "`id`", "a\nb", "*", "\\", "\"quoted\"", "-n"];
  const line = `printf '%s\\0' ${values.map((value) => quoteForShell("/bin/sh", value)).join(" ")}`;
  const out = execFileSync("/bin/sh", ["-c", line], { env: { PATH: "/usr/bin:/bin" } }).toString();
  assert.deepEqual(out.split("\u0000").slice(0, -1), values);
});

test("POSIX environment names are picked only off Windows", () => {
  const source = { TMPDIR: "/t", USER: "o", SSH_AUTH_SOCK: "/s", EMPTY: "" };
  assert.deepEqual(posixEnvironment(["TMPDIR", "USER", "EMPTY", "NONE"], source, "darwin"), { TMPDIR: "/t", USER: "o" });
  assert.deepEqual(posixEnvironment(["TMPDIR", "USER"], source, "win32"), {});
  assert.equal(gitEnvironment({ ...source, PATH: "/bin" }, "linux").SSH_AUTH_SOCK, "/s");
  assert.equal(gitEnvironment({ ...source, PATH: "/bin" }, "win32").SSH_AUTH_SOCK, undefined, "Windows is unchanged");
  assert.equal(sshEnvironment({ ...source, PATH: "/bin" }, "darwin").SSH_AUTH_SOCK, "/s");
  assert.equal(sshEnvironment({ ...source, PATH: "/bin" }, "win32").SSH_AUTH_SOCK, undefined);
  const config = ShellConfigSchema.parse({ executables: { sh: { path: "/bin/sh" } }, inheritEnv: ["PATH", "HOME", "TMPDIR"] });
  assert.deepEqual(Object.keys(shellEnvironment(config, { PATH: "/bin", HOME: "/h", TMPDIR: "/t", SECRET: "x" })).sort(), ["HOME", "PATH", "TMPDIR"]);
  assert.deepEqual(ShellConfigSchema.parse({ executables: { sh: { path: "/bin/sh" } } }).inheritEnv,
    ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"], "the default list is unchanged");
});

test("programs are found without .exe or where off Windows", async () => {
  assert.deepEqual(gitFinder("darwin", {}), { executable: "/bin/sh", args: ["-c", "command -v git"] });
  assert.deepEqual(gitFinder("linux", {}), { executable: "/bin/sh", args: ["-c", "command -v git"] });
  assert.deepEqual(gitFinder("win32", { SystemRoot: "C:\\Windows" }).args, ["git"]);
  assert.match(gitFinder("win32", { SystemRoot: "C:\\Windows" }).executable, /System32.where\.exe$/);
  assert.equal(sshProgram("ssh", "win32"), "ssh.exe");
  assert.equal(sshProgram("ssh", "darwin"), "ssh");
  assert.equal(sshProgram("scp", "linux"), "scp");
  const seen = [];
  const lines = async (executable, args) => { seen.push([executable, ...args]); return ["git", "", process.execPath]; };
  // Off Windows only a full POSIX path is taken, so this computer's own runtime qualifies only where it has one.
  assert.equal(await findGitOn({}, "linux", lines), process.platform === "win32" ? null : process.execPath,
    "a bare name is skipped, a real file is taken");
  assert.deepEqual(seen, [["/bin/sh", "-c", "command -v git"]]);
  assert.equal(await findGitOn({}, "win32", async () => [process.execPath]), process.platform === "win32" ? process.execPath : null,
    "on Windows only an .exe is taken");
});

test("a kept-open command line works with a POSIX shell, under its limits", { skip: !posix }, async (t) => {
  const { ShellSessions } = await import("../dist/shell-session.js");
  const workspace = await scratch(t);
  await mkdir(join(workspace, "inner"));
  const store = { get: () => undefined, run: () => undefined, event: () => undefined };
  const shell = defaultShellFor(process.platform === "darwin" ? "darwin" : "linux", {});
  const shells = new ShellSessions({ executables: { sh: { path: "/bin/sh", args: [] } }, inheritEnv: ["PATH", "HOME"] },
    store, "local", { PATH: "/usr/bin:/bin", HOME: workspace });
  t.after(() => shells.closeAll());
  const context = { workspace, runId: "" };
  const opened = await shells.start({ program: "sh", args: [], cwd: ".", name: "posix" }, context);
  assert.equal(opened.status, "open");
  assert.equal(opened.isolation, "sampling", "the Windows-only name is not borrowed");
  assert.deepEqual(opened.heldBySystem, { processorTime: true, memory: false, wholeGroupEnds: true });
  await shells.send({ id: opened.id, input: "cd inner", waitMs: 300 }, context);
  const where = await shells.send({ id: opened.id, input: "pwd; echo cpu=$(ulimit -S -t)", waitMs: 5000 }, context);
  assert.match(where.output, /inner\n/, "the folder carried over from the first command");
  assert.match(where.output, /cpu=\d+/, "the processor-time ceiling is in place");
  const quoted = await shells.send({ id: opened.id, input: `printf '%s\\n' ${quoteForShell("/bin/sh", "it's $HOME")}`, waitMs: 5000 }, context);
  assert.equal(quoted.output, "it's $HOME\n");
  const pid = opened.pid;
  const closed = await shells.close(opened.id);
  assert.equal(closed.status, "closed");
  assert.equal(await gone(pid), true);
  assert.ok(shell.path.startsWith("/bin/"));
});

test("a program left running is held, listed with what the system holds, and ended with its group", { skip: !posix }, async (t) => {
  const { BackgroundProcesses } = await import("../dist/processes.js");
  const workspace = await scratch(t);
  const pidFile = join(workspace, "child.pid");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid)); setInterval(() => {}, 1000);`;
  const settings = { programs: { node: { path: process.execPath, args: ["-e", script] } } };
  const store = { get: (kind, owner, key) => key === "background-processes" ? { data: settings } : undefined, run: () => undefined, event: () => undefined };
  const processes = new BackgroundProcesses(store, "local", workspace, undefined, async () => ({ code: null, stdout: "", stderr: "", missing: true }));
  t.after(() => processes.stopAll());
  const started = await processes.start({ program: "node", args: [], cwd: ".", name: "held" }, { workspace, runId: "" });
  assert.equal(started.isolation, "sampling");
  assert.deepEqual(started.heldBySystem, { processorTime: true, memory: false, wholeGroupEnds: true });
  let grandPid = 0;
  for (let i = 0; i < 200 && !grandPid; i++) { grandPid = Number(await readFile(pidFile, "utf8").catch(() => 0)); if (!grandPid) await delay(25); }
  t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch { /* already gone */ } });
  assert.ok(grandPid > 0);
  const stopped = await processes.stop(started.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(await gone(grandPid), true, "what it started went with it");
  assert.equal(await gone(started.pid), true);
});
