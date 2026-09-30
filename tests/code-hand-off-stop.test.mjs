/**
 * P0 (self-build): a stopped or timed-out hand-off leaves nothing running. npm's Codex launcher starts the real program
 * with its own standard streams and only passes signals on, and on Windows ending Node passes nothing on. Node's own job
 * does take the real program down with the launcher, but not what the real program had started (a command it was
 * running, its tool servers), which kept going after Branch said "timed out". The stand-ins here are a launcher, a
 * program started the same way, and a command that program starts outside any job, as Codex's own commands are; the
 * real claude or codex is never started (the stand-in's own platform package has no program in it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { programStart, runProgram } from "../dist/coding/hand-off.js";
import { codexBinary } from "../dist/asks/codex-app-server.js";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function gone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await delay(25); }
  return false;
}
/** A scratch folder, and the exact commands to end before it goes, whatever the test found. */
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-stop-")), pids = [];
  t.after(async () => {
    for (const pid of pids) try { if (alive(pid)) process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    await discardTemp(root);
  });
  return { root, pids };
}
async function readPid(path, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { try { return Number(await readFile(path, "utf8")); } catch { await delay(20); } }
  assert.fail("the stand-in's command never started");
}

/** npm's layout: a launcher on PATH, the package's `bin/codex.js`, and a platform package with no program in it. */
async function standIn(root) {
  const bin = join(root, "bin"), pkg = join(bin, "node_modules", "@openai", "codex");
  const platformPkg = join(pkg, "node_modules", "@openai", `codex-${process.platform}-${process.arch}`);
  await mkdir(join(pkg, "bin"), { recursive: true });
  await mkdir(platformPkg, { recursive: true });
  await writeFile(join(platformPkg, "package.json"), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
  const script = join(pkg, "bin", "codex.js");
  // Like the real launcher (codex-cli/bin/codex.js): the program gets the launcher's own streams, and the launcher only
  // passes signals on and waits for it.
  const program = join(root, "program.cjs");
  // The stand-in program starts one command and waits. On Windows the command is outside Node's own job, as a command
  // Codex starts is; elsewhere it stays in the program's process group, as Codex's do.
  await writeFile(program, `const { spawn } = require("node:child_process");
const command = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.STUB_PID_FILE, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);"],
  { stdio: "ignore", detached: process.platform === "win32", windowsHide: true, env: process.env });
setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);
`);
  await writeFile(script, `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(program)}], { stdio: "inherit", env: process.env });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on("exit", (code) => process.exit(code ?? 1));
`);
  if (process.platform === "win32")
    await writeFile(join(bin, "codex.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  else await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return bin;
}

test("a stopped hand-off ends the program and everything it started before Branch checks the folder", async (t) => {
  const { root, pids } = await scratch(t);
  const bin = await standIn(root);
  const pidFile = join(root, "command.pid");
  const env = { ...process.env, PATH: [bin, dirname(process.execPath)].join(delimiter), STUB_PID_FILE: pidFile };
  delete env.Path;
  assert.equal(codexBinary("codex", env), null, "the stand-in has no real program, so nothing real can start");
  const controller = new AbortController();
  const running = runProgram({ command: "codex", args: ["exec", "-"], cwd: root }, "a job", env, controller.signal, 60_000, () => {});
  const pid = await readPid(pidFile);
  pids.push(pid);
  controller.abort();
  const ran = await running;
  assert.equal(ran.code, null);
  assert.equal(await gone(pid, 3000), true, `the command ${pid} the program started was still running after the stop`);
});

test("a timed-out hand-off leaves nothing running either", async (t) => {
  const { root, pids } = await scratch(t);
  const bin = await standIn(root);
  const pidFile = join(root, "command.pid");
  const env = { ...process.env, PATH: [bin, dirname(process.execPath)].join(delimiter), STUB_PID_FILE: pidFile };
  delete env.Path;
  const running = runProgram({ command: "codex", args: ["exec", "-"], cwd: root }, "a job", env, new AbortController().signal, 1500, () => {});
  const pid = await readPid(pidFile);
  pids.push(pid);
  const ran = await running;
  assert.equal(ran.timedOut, true);
  // Settled only once the tree had ended: nothing is left to edit the folder while Branch checks it.
  assert.equal(await gone(pid, 3000), true, `the command ${pid} the program started was still running after the timeout`);
});

test("an npm-installed Codex is handed its job as its own program, not through the launcher", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-native-"));
  t.after(() => discardTemp(root));
  const pkg = join(root, "node_modules", "@openai", "codex");
  const platformPkg = join(pkg, "node_modules", "@openai", `codex-win32-${process.arch}`);
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  await mkdir(join(pkg, "bin"), { recursive: true });
  await mkdir(join(platformPkg, "vendor", triple, "bin"), { recursive: true });
  await writeFile(join(pkg, "bin", "codex.js"), "");
  await writeFile(join(platformPkg, "package.json"), JSON.stringify({ name: `@openai/codex-win32-${process.arch}` }));
  await writeFile(join(platformPkg, "vendor", triple, "bin", "codex.exe"), "");
  await writeFile(join(root, "codex.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const start = programStart({ command: "codex", args: ["exec", "--json", "-"], cwd: root }, { PATH: root });
  assert.ok(start.command.endsWith(join("vendor", triple, "bin", "codex.exe")), start.command);
  assert.deepEqual(start.args, ["exec", "--json", "-"]);
  assert.equal(start.env.CODEX_MANAGED_BY_NPM, "1");
  assert.ok(start.env.CODEX_MANAGED_PACKAGE_ROOT.endsWith(join("@openai", "codex")));
  // Claude Code is started as it always was.
  assert.equal(programStart({ command: "claude", args: ["-p"], cwd: root }, { PATH: join(root, "nowhere") }).command, "claude");
});
