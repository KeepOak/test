// real-screen-test
/**
 * computer-control: what the Windows proof files share (tests/windows-computer-*proof.test.mjs). They run only on a
 * throwaway Windows CI runner, never on the owner's PC; each checks realScreenAllowed() before it imports this, and
 * this checks again, so importing it anywhere else does nothing.
 *
 * A test window is made far off every screen (-30000, -30000), so nothing shows and no one's pointer is used. The real
 * Windows script (src/integrations/desktop-script.ts) runs against it through one runner per file, whose resident
 * helper starts once; each action says how long it took.
 */
import { after } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realScreenAllowed } from "./real-screen.mjs";
import { DesktopScriptRunner, powerShellPath } from "../dist/integrations/desktop-script.js";

if (!realScreenAllowed()) process.exit(0);

const run = promisify(execFile);

export const folder = mkdtempSync(join(tmpdir(), "branch-proof-"));
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
export async function testWindow(t, exclude) {
  const started = Date.now();
  const child = spawn(powerShellPath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", formFile],
    { env: { ...process.env, PROOF_EXCLUDE: exclude ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  let text = "", errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const line = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the test window did not start: ${errors}`)), 90000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const found = /ready (\d+) (\d+) (\d+)/.exec(text);
      if (found) { clearTimeout(timer); done(found); }
    });
    child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`the test window ended (${code}): ${errors}`)); });
  });
  console.log(`# test window: ${Date.now() - started} ms`);
  return { handle: line[1], processId: Number(line[2]), affinity: Number(line[3]) };
}

// The file's one runner: its first action also starts the resident helper (PowerShell, UI Automation and the C#
// compile, slow on a hosted runner that shares its CPU with the rest of the lane), so actions get two minutes.
const real = new DesktopScriptRunner(undefined, { timeoutMs: 120000 });
after(() => real.close());
export const runner = {
  async run(action, payload, signal) {
    const started = Date.now();
    try { return await real.run(action, payload, signal); } finally { console.log(`# ${action}: ${Date.now() - started} ms`); }
  },
  liveProcess: (target, exclusion) => real.liveProcess(target, exclusion),
};
export const signal = () => AbortSignal.timeout(150000);
export const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
export async function listed(handle) {
  const { windows } = await runner.run("windows", {}, signal());
  return list(windows).find((w) => String(w.handle) === handle);
}
export async function titled(handle, pattern) {
  let title;
  for (let i = 0; i < 6; i++) {
    title = (await listed(handle))?.title;
    if (title && pattern.test(title)) return title;
    await new Promise((done) => setTimeout(done, 1000));
  }
  return title;
}
/** One pixel of a PNG and its size, read by Windows itself ("r,g,b WxH"). */
export async function pixel(path, x, y) {
  const { stdout } = await run(powerShellPath, ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap($env:PROOF_PNG); $c = $b.GetPixel(${x}, ${y}); [Console]::Out.Write('' + $c.R + ',' + $c.G + ',' + $c.B + ' ' + $b.Width + 'x' + $b.Height); $b.Dispose()`],
    { encoding: "utf8", timeout: 90000, windowsHide: true, env: { ...process.env, PROOF_PNG: path } });
  return stdout.trim();
}
/** Ways a part is pressed without the pointer: UI Automation's own, its MSAA default action, or the button's message. */
export const pressedWithoutPointer = ["invoke", "toggle", "select", "expand", "legacy", "message"];
