// real-screen-test
/**
 * computer-control: real proof on a throwaway Windows runner, never on the owner's PC. The file carries the marker line,
 * so scripts/review.mjs refuses it and tests/real-screen.mjs runs it only in CI on Windows (or with BRANCH_SCREEN_TESTS=1).
 *
 * A test window is made far off every screen (-30000, -30000), so nothing shows and no one's pointer is used. Against it
 * the real Windows script (src/integrations/desktop-script.ts) compiles and runs:
 *   - desktop.read lists its parts with refs and boxes; a named button is pressed through UI Automation;
 *   - a pointer click on a spot nothing real is on top of is refused, with nothing done (fail closed);
 *   - a close-up of the window comes from the window itself (its own colour, not the screen's);
 *   - the live reader frames that window alone, and frames a display only while every window of the process it must
 *     hide is excluded from capture (SetWindowDisplayAffinity 0x11, as Electron's setContentProtection sets it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realScreenAllowed } from "./real-screen.mjs";
import { DesktopScriptRunner, powerShellPath } from "../dist/integrations/desktop-script.js";

// Only on a throwaway Windows CI runner (or BRANCH_SCREEN_TESTS=1): it makes a window, even if off every screen.
if (!realScreenAllowed()) {
  test("computer-control proof is opt-in (a Windows CI runner, or BRANCH_SCREEN_TESTS=1)", { skip: true }, () => {});
  process.exit(0);
}

const folder = mkdtempSync(join(tmpdir(), "branch-proof-"));
const formScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ProofAffinity {
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
}
'@
$form = New-Object System.Windows.Forms.Form
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-30000, -30000)
$form.Size = New-Object System.Drawing.Size(400, 300)
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(12, 200, 90)
$form.Text = 'Branch proof 0 0'
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Proof button'; $button.Location = New-Object System.Drawing.Point(10, 10); $button.Size = New-Object System.Drawing.Size(140, 30)
$list = New-Object System.Windows.Forms.ListBox
$list.AccessibleName = 'Proof list'; $list.Location = New-Object System.Drawing.Point(10, 50); $list.Size = New-Object System.Drawing.Size(200, 120)
foreach ($i in 1..500) { [void]$list.Items.Add('Row ' + $i) }
$form.Controls.Add($button); $form.Controls.Add($list)
$script:clicks = 0
$button.Add_Click({ $script:clicks++ })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({ $form.Text = 'Branch proof ' + $script:clicks + ' ' + $list.TopIndex })
$form.Add_Shown({
  $timer.Start()
  if ($env:PROOF_EXCLUDE -eq '1') { [void][ProofAffinity]::SetWindowDisplayAffinity($form.Handle, 0x11) }
  $a = 0; [void][ProofAffinity]::GetWindowDisplayAffinity($form.Handle, [ref]$a)
  [Console]::Out.WriteLine('ready ' + $form.Handle.ToInt64() + ' ' + $PID + ' ' + $a); [Console]::Out.Flush()
})
[System.Windows.Forms.Application]::Run($form)
`;
const formFile = join(folder, "proof-form.ps1");
writeFileSync(formFile, formScript, "utf8");

/** Starts one off-screen test window in a program of its own: its handle, process and display affinity. */
async function testWindow(t, exclude) {
  const child = spawn(powerShellPath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", formFile],
    { env: { ...process.env, PROOF_EXCLUDE: exclude ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  let text = "", errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const line = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the test window did not start: ${errors}`)), 60000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const found = /ready (\d+) (\d+) (\d+)/.exec(text);
      if (found) { clearTimeout(timer); done(found); }
    });
    child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`the test window ended (${code}): ${errors}`)); });
  });
  return { handle: line[1], processId: Number(line[2]), affinity: Number(line[3]) };
}
const runner = new DesktopScriptRunner();
const signal = () => AbortSignal.timeout(90000);
async function listed(handle) {
  const { windows } = await runner.run("windows", {}, signal());
  return (Array.isArray(windows) ? windows : [windows]).find((w) => String(w.handle) === handle);
}
async function titled(handle, pattern) {
  for (let i = 0; i < 60; i++) {
    const found = await listed(handle);
    if (found && pattern.test(found.title)) return found.title;
    await new Promise((done) => setTimeout(done, 250));
  }
  return (await listed(handle))?.title;
}
function pixel(path, x, y) {
  const read = spawnSync(powerShellPath, ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap($env:PROOF_PNG); $c = $b.GetPixel(${x}, ${y}); [Console]::Out.Write('' + $c.R + ',' + $c.G + ',' + $c.B + ' ' + $b.Width + 'x' + $b.Height); $b.Dispose()`],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, PROOF_PNG: path } });
  return read.stdout.trim();
}

test("the real script reads parts with refs, presses a named button without the pointer, and refuses a covered spot", { timeout: 240000 }, async (t) => {
  const proof = await testWindow(t, false);
  let started = Date.now();
  assert.ok(await listed(proof.handle), "the test window is listed");
  t.diagnostic(`windows: ${Date.now() - started} ms`);
  started = Date.now();
  const reading = await runner.run("read", { handle: proof.handle, limit: 30 }, signal());
  t.diagnostic(`read: ${Date.now() - started} ms, of which the tree walk ${reading.readMs} ms`);
  assert.ok(reading.readMs < 8500, "the walk keeps to its time budget");
  const nodes = Array.isArray(reading.nodes) ? reading.nodes : [reading.nodes];
  const button = nodes.find((n) => n.name === "Proof button");
  assert.ok(button, `the button is listed: ${JSON.stringify(nodes.map((n) => n.name))}`);
  assert.match(button.ref, /^-?[0-9]+(\.-?[0-9]+)+$/, "with UI Automation's runtime id as its ref");
  assert.equal(button.box.length, 4, "and its box in window pixels");
  assert.ok(button.box[0] >= 0 && button.box[1] >= 0 && button.box[2] > 100, `inside the window: ${button.box}`);
  assert.deepEqual([reading.bounds.x, reading.bounds.y], [-30000, -30000], "the window's own place, far off every screen");

  const pressed = await runner.run("click", { handle: proof.handle, name: "Proof button" }, signal());
  assert.equal(pressed.how, "invoke", "pressed through UI Automation: the pointer never moved");
  assert.match(await titled(proof.handle, /^Branch proof 1 /), /^Branch proof 1 /, "the button's own handler ran once");

  // A spot on this window is off every screen, so nothing of it is on top there: the pointer click is refused unsent.
  await assert.rejects(runner.run("pointer", { handle: proof.handle, kind: "click", at: { ref: button.ref }, button: "left", count: 1, modifiers: [] }, signal()),
    /nothing was done/i);
  await new Promise((done) => setTimeout(done, 400));
  assert.match(await titled(proof.handle, /^Branch proof 1 /), /^Branch proof 1 /, "no second click reached it");
  // A picture's promise: a window that is not where the picture said is refused before anything else.
  await assert.rejects(runner.run("pointer", { handle: proof.handle, kind: "move", at: { point: { x: 5, y: 5 } }, hoverMs: 0, expect: { x: 0, y: 0, w: 400, h: 300 } }, signal()),
    /moved or changed size/);
});

test("the real close-up and the live reader take the window from the window itself", { timeout: 240000 }, async (t) => {
  const proof = await testWindow(t, false);
  const out = join(folder, "zoom.png");
  const zoom = await runner.run("zoom", { handle: proof.handle, region: { x: 300, y: 200, width: 40, height: 40 }, scale: 2, outPath: out }, signal());
  assert.equal(zoom.method, "window", "PrintWindow, not a copy of the screen");
  assert.ok(existsSync(out));
  assert.equal(pixel(out, 20, 20), "12,200,90 80x80", "the test window's own colour, enlarged twice");

  const found = await listed(proof.handle);
  const target = { kind: "window", handle: proof.handle, processId: proof.processId, bounds: { x: found.x, y: found.y, w: found.width, h: found.height } };
  const reader = runner.liveProcess(target, { processId: process.pid, handles: [] });
  t.after(() => reader.close());
  const frame = await reader.frame(320, signal());
  assert.equal(frame.method, "window");
  assert.deepEqual(frame.target, target);
  assert.ok(Buffer.from(frame.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG of that window");
});

test("a display is framed only while every window the view must leave out is excluded from capture", { timeout: 240000 }, async (t) => {
  const hidden = await testWindow(t, true), shown = await testWindow(t, false);
  assert.equal(hidden.affinity, 0x11, "WDA_EXCLUDEFROMCAPTURE took on this Windows");
  assert.equal(shown.affinity, 0);
  const targets = await runner.run("capture-targets", {}, signal());
  const monitors = Array.isArray(targets.monitors) ? targets.monitors : [targets.monitors];
  const display = monitors.find((m) => m.primary) ?? monitors[0];
  assert.ok(display, "the runner has a display");
  const target = { kind: "monitor", deviceName: display.deviceName, bounds: display.bounds };
  const good = runner.liveProcess(target, { processId: hidden.processId, handles: [hidden.handle] });
  t.after(() => good.close());
  const frame = await good.frame(640, signal());
  assert.equal(frame.method, "monitor");
  assert.deepEqual(frame.screen, display.bounds);
  const bad = runner.liveProcess(target, { processId: shown.processId, handles: [shown.handle] });
  t.after(() => bad.close());
  await assert.rejects(bad.frame(640, signal()), /could not exclude/, "a window that would show in its own view stops the frame");
});
