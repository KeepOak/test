// real-screen-test
/**
 * computer-control: real proof on a throwaway Windows runner, never on the owner's PC (see
 * tests/windows-computer-proof.test.mjs and tests/windows-proof-kit.mjs). The live reader frames a display only while
 * every window of the process it must hide is excluded from capture (SetWindowDisplayAffinity 0x11, as Electron's
 * setContentProtection sets it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { realScreenAllowed } from "./real-screen.mjs";

// Only on a throwaway Windows CI runner (or BRANCH_SCREEN_TESTS=1): it makes windows, even if off every screen.
if (!realScreenAllowed()) {
  test("computer-control display proof is opt-in (a Windows CI runner, or BRANCH_SCREEN_TESTS=1)", { skip: true }, () => {});
  process.exit(0);
}
const { testWindow, runner, signal, list } = await import("./windows-proof-kit.mjs");

test("a display is framed only while every window the view must leave out is excluded from capture", { timeout: 300000 }, async (t) => {
  const [hidden, shown, targets] = await Promise.all([testWindow(t, true), testWindow(t, false), runner.run("capture-targets", {}, signal())]);
  assert.equal(hidden.affinity, 0x11, "WDA_EXCLUDEFROMCAPTURE took on this Windows");
  assert.equal(shown.affinity, 0);
  const monitors = list(targets.monitors);
  const display = monitors.find((m) => m.primary) ?? monitors[0];
  assert.ok(display, "the runner has a display");
  const target = { kind: "monitor", deviceName: display.deviceName, bounds: display.bounds };
  const good = runner.liveProcess(target, { processId: hidden.processId, handles: [hidden.handle] });
  t.after(() => good.close());
  const bad = runner.liveProcess(target, { processId: shown.processId, handles: [shown.handle] });
  t.after(() => bad.close());
  // Both readers start together: each is a program of its own.
  const [frame] = await Promise.all([good.frame(640, signal()),
    assert.rejects(bad.frame(640, signal()), /could not exclude/, "a window that would show in its own view stops the frame")]);
  assert.equal(frame.method, "monitor");
  assert.deepEqual(frame.screen, display.bounds);
});

// Diagnostic only (no assertion): how long PowerShell takes to start and load an assembly with the environment the
// screen scripts once had, the one they have now, and the whole environment, side by side on this runner.
test("diagnostic: PowerShell start with each environment", { timeout: 200000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { scriptEnvironment, powerShellPath } = await import("../dist/integrations/desktop-script.js");
  const now = scriptEnvironment();
  const keep = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "USERPROFILE", "SYSTEMDRIVE"];
  const before = Object.fromEntries(keep.filter((k) => now[k]).map((k) => [k, now[k]]));
  const time = (name, env) => new Promise((done) => {
    const started = Date.now();
    execFile(powerShellPath, ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Drawing; [Console]::Out.Write('ok')"],
      { env, timeout: 180000, windowsHide: true }, (error, stdout) => done(`${name}: ${Date.now() - started} ms ${error ? error.message : stdout}`));
  });
  for (const line of await Promise.all([time("before", before), time("now", now), time("whole", process.env)])) console.log(`# ${line}`);
});
