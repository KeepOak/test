import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchHandOver } from "../dist/desktop/hand-over.js";
import { calibrate } from "./console-calibration.mjs";

/**
 * CBQ-001: a packaged Windows update must not put a console window on the owner's screen, and closing
 * one helper must not start another.
 *
 * The tests that came before this one assert that the code passes `windowsHide: true`. That is a test
 * of the source, not of the screen, and it passes while a console is really appearing: on Windows
 * `detached: true` and `windowsHide: true` cannot both apply, so the flag is present and ignored. So
 * these tests start the real launchers and then ask Windows which top-level windows exist.
 *
 * A test that only ever reports "no window appeared" is indistinguishable from a blind one, so the
 * first test here makes a console that is meant to be seen and fails if it cannot see it.
 */
const onWindows = process.platform === "win32";
const system32 = join(process.env.SystemRoot ?? "C:/Windows", "System32");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every process that owns a top-level window right now, by process id. */
/**
 * Only programs that host a console window count. This machine is shared — the owner, other agents'
 * test browsers, notifications — and counting every new window on the desktop failed this test once
 * when nothing of ours had appeared. A task started through the Task Scheduler is not a child of this
 * process, so windows cannot be matched to it by process tree; but the only window a leaked console can
 * appear in is one of these hosts, and the first test below proves such a window is still seen.
 */
const consoleHosts = new Set(["conhost", "openconsole", "windowsterminal", "cmd", "wscript", "cscript", "powershell", "pwsh"]);
function windowsOnScreen() {
  const ask = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |"
    + " Select-Object -Property Id,ProcessName | ConvertTo-Json -Compress";
  const printed = execFileSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", ask],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 22 }).trim();
  const rows = printed ? JSON.parse(printed) : [];
  return new Map((Array.isArray(rows) ? rows : [rows])
    .filter((row) => consoleHosts.has(String(row.ProcessName).toLowerCase()))
    .map((row) => [row.Id, row.ProcessName]));
}

/*
 * Whether this machine can show the test a console window at all. A build machine may not: a GitHub
 * runner lists no console window even for a console that is meant to be seen. There, and only on a build
 * machine (CI=true), the no-window checks are skipped and say so, while the work itself is still checked.
 * Anywhere else a blind control fails, because then the listing itself is broken.
 */
let blind = false;
const BLIND = "the no-window check is skipped: this build machine shows the test no console windows (see the first test); the work itself was checked";

/**
 * Runs `start`, then watches the screen for as long as the work can take. On a build machine that shows the test no
 * console windows (`blind`, see the first test) the screen is not asked, as the no-window checks are skipped there: it
 * waits only until the work has written its `count`th line to `done`, the proof the attempt really ran.
 */
async function windowsOpenedBy(start, { done, count }, watchMs = 4000) {
  if (blind) {
    const result = await start();
    for (let waited = 0; waited < 30000 && readCount(done) < count; waited += 100) await sleep(100);
    return { opened: new Map(), result };
  }
  const before = windowsOnScreen();
  const result = await start();
  const opened = new Map();
  for (let waited = 0; waited < watchMs; waited += 400) {
    await sleep(400);
    for (const [id, name] of windowsOnScreen()) if (!before.has(id)) opened.set(id, name);
  }
  return { opened, result };
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "cbq-001-"));
  // A runner may still be ending when the test does: its folder is left for the temp cleanup then.
  t.after(async () => { await sleep(1500); try { rmSync(root, { recursive: true, force: true }); } catch { /* still in use */ } });
  const script = join(root, "hand-over.cmd");
  const done = join(root, "handed-over.txt");
  writeFileSync(script, `@echo off\r\n${join(system32, "ping.exe")} -n 2 127.0.0.1 >NUL\r\n`
    + `echo %1>> "${done}"\r\n`, "utf8");
  return { root, script, done };
}

/** The scheduler is asked for first; this makes it refuse, which is the fallback the fix is about. */
/*
 * The runner (src/desktop/hand-over.ts) is Electron's stock program linked beside the script; this test runs under Node,
 * so it links the Electron program the repository installs.
 */
const runner = { runtime: join(process.cwd(), "node_modules", "electron", "dist"), executableName: "electron.exe" };
const noScheduler = { ...runner, exec: (_file, _args, _options, callback) => callback(new Error("schtasks missing")) };

/*
 * The control: a console this test starts and means to be seen. Only that console counts, and only it is
 * closed (tests/console-calibration.mjs); another program's window appearing meanwhile is not proof.
 */
test("this test can see a console window that is meant to be seen", { skip: !onWindows }, async (t) => {
  const { seen, others } = await calibrate();
  if (!seen && process.env.CI === "true") {
    blind = true;
    t.skip(`this build machine listed no window of the test's own console in 30 s (other new windows: ${others.join(", ") || "none"}), so the no-window checks below are skipped`);
    return;
  }
  assert.ok(seen, "a plain console opened no window this test could see, so every zero below would be meaningless");
  await sleep(2000);
});

test("the update hand-over opens no window through the scheduler, ten times over",
  { skip: !onWindows }, async (t) => {
    const { script, done } = workspace(t);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const { opened, result } = await windowsOpenedBy(() => launchHandOver(script, 900000 + attempt, runner), { done, count: attempt });
      assert.equal(result, "task", `attempt ${attempt} did not take the scheduler route`);
      if (!blind) assert.deepEqual([...opened], [], `attempt ${attempt} put a window on the screen`);
    }
    assert.equal(readCount(done), 10, "every attempt really ran, so the zeros above are about work that happened");
    if (blind) t.skip(BLIND);
  });

test("and none through the fallback either, which is where the flag was being ignored",
  { skip: !onWindows }, async (t) => {
    const { script, done } = workspace(t);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const { opened, result } = await windowsOpenedBy(() => launchHandOver(script, 910000 + attempt, noScheduler), { done, count: attempt });
      assert.equal(result, "spawn", `attempt ${attempt} did not take the fallback route`);
      if (!blind) assert.deepEqual([...opened], [], `attempt ${attempt} put a window on the screen`);
    }
    assert.equal(readCount(done), 10, "every attempt really ran");
    if (blind) t.skip(BLIND);
  });

test("one hand-over is one hand-over: no second launcher and no task left behind",
  { skip: !onWindows }, async (t) => {
    const { root, script, done } = workspace(t);
    await launchHandOver(script, 920001, runner);
    await sleep(3000);
    assert.equal(readCount(done), 1, "the work ran exactly once, not twice");
    assert.equal(taskExists("BranchAgentUpdate-920001"), false, "the scheduled task deleted itself");
    const made = readdirSync(root);
    assert.equal(made.filter((name) => /^hand-over-[0-9a-f]{8}$/.test(name)).length, 1, "its runner is in the test's own folder");
    assert.deepEqual(made.filter((name) => /\.vbs$/i.test(name)), [], "and no Windows Script Host file is written (VBScript is going away)");
  });

function readCount(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function taskExists(name) {
  try {
    execFileSync(join(system32, "schtasks.exe"), ["/Query", "/TN", name],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch { return false; }
}
