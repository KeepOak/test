/**
 * computer-control: the one Windows script every screen action and the live view run (src/integrations/desktop-script.ts)
 * is parsed by PowerShell's own parser, so a syntax slip in any verb (the pointer, the close-up, the live reader) fails
 * here instead of breaking every desktop.* call at once. Parsing runs nothing: no window is looked at, nothing is clicked.
 * Windows only (the lane that runs it is chosen by this file's name).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopScript, powerShellPath } from "../dist/integrations/desktop-script.js";

const windows = process.platform === "win32";

test("PowerShell parses the whole desktop script without an error", { skip: !windows }, () => {
  const file = join(mkdtempSync(join(tmpdir(), "branch-parse-")), "branch-desktop.ps1");
  writeFileSync(file, desktopScript, "utf8");
  const check = "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:BRANCH_PARSE_FILE, [ref]$t, [ref]$e); " +
    "foreach ($x in $e) { [Console]::Out.WriteLine('line ' + $x.Extent.StartLineNumber + ': ' + $x.Message) }; [Console]::Out.WriteLine('errors=' + $e.Count)";
  const run = spawnSync(powerShellPath, ["-NoProfile", "-NonInteractive", "-Command", check],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, BRANCH_PARSE_FILE: file } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /errors=0\s*$/, run.stdout);
});
