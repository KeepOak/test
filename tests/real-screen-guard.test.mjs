import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { realScreenAllowed, realScreenMarker } from "./real-screen.mjs";

/* Tests that drive this computer's real screen (open Notepad, type into it, photograph it) must never run on the owner's
   PC by accident: they carry the marker line, check realScreenAllowed() before anything runs, and scripts/review.mjs
   refuses them. This file fails when a test that reaches the real screen is missing either. It only reads those files:
   it never runs one, so a broken guard can never make it drive the screen. */

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** What a test that touches the real screen contains: starting Notepad, a Windows Forms window, keys sent to it, a picture of it. */
const screenWords = new RegExp(["notepad", "\\.exe", "|System\\.Windows\\.", "Forms|CopyFrom", "Screen|user", "32\\.dll"].join(""), "i");
// Windows' own SendKeys is matched with its capital S only: a paired computer's plain `sendKeys` value is not it.
const sendKeys = new RegExp(["\\bSend", "Keys\\b"].join(""));
const realScreen = { test: (text) => screenWords.test(text) || sendKeys.test(text) };

function testFiles(folder) {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : testFiles(path);
    return /\.m?js$/.test(name) ? [path] : [];
  });
}

test("a real-screen test runs only with the owner's opt-in or on a Windows CI runner", () => {
  assert.equal(realScreenAllowed({}, "win32"), false, "nothing set on this PC: refused");
  assert.equal(realScreenAllowed({ BRANCH_SCREEN_TESTS: "1" }, "win32"), true);
  assert.equal(realScreenAllowed({ BRANCH_SCREEN_TESTS: "true" }, "win32"), false, "only the exact opt-in counts");
  assert.equal(realScreenAllowed({ CI: "true" }, "win32"), true);
  assert.equal(realScreenAllowed({ CI: "false" }, "win32"), false);
  assert.equal(realScreenAllowed({ CI: "0" }, "win32"), false);
  assert.equal(realScreenAllowed({ CI: "true" }, "linux"), false, "a Linux runner has no Windows screen to drive");
});

test("every test that reaches the real screen carries the marker and checks the opt-in first", () => {
  const own = new Set(["real-screen-guard.test.mjs", "real-screen.mjs"]);
  const reaching = testFiles(here).filter((path) => !own.has(path.split(/[\\/]/).pop()) && realScreen.test(readFileSync(path, "utf8")));
  assert.ok(reaching.some((path) => path.endsWith("screen-control.test.mjs")), "control: screen-control reaches the real screen");
  for (const path of reaching) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.split(/\r?\n/)[0].trim(), realScreenMarker, `${path} starts with the marker line`);
    const guard = source.indexOf("if (!realScreenAllowed())");
    assert.ok(guard > 0, `${path} checks realScreenAllowed()`);
    assert.match(source.slice(guard, guard + 300), /process\.exit\(0\)/, `${path} stops before any test when it is not allowed`);
  }
});

test("scripts/review.mjs refuses a real-screen test before it builds or runs anything", () => {
  const root = join(here, "..");
  // A bad option after the file: were the refusal ever missing, review stops on the option instead of building and
  // running anything, and this test still fails on the words. This file never runs a real-screen test itself.
  const said = spawnSync(process.execPath, ["scripts/review.mjs", "tests/screen-control.test.mjs", "--never-run"], { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(said.status, 2);
  assert.match(said.stderr, /drives this computer's real screen; it is never run from here/);
});

/* The engine side: every place Branch starts the program that reaches the real screen asks the guard first, so no test,
   however it is written, reaches the screen through the real runner without the opt-in. Checked by reading the source
   (nothing here starts that program) and by the guard's own answers. */
test("under the test runner the engine refuses the real screen unless a person opted in", async () => {
  const { realScreenRefusal, realScreenTestRefusal } = await import("../dist/integrations/real-screen-guard.js");
  assert.ok(process.env.NODE_TEST_CONTEXT, "control: this file runs under the test runner");
  assert.equal(realScreenRefusal({ NODE_TEST_CONTEXT: "child-v8" }, "win32"), realScreenTestRefusal);
  assert.equal(realScreenRefusal({ NODE_TEST_CONTEXT: "child-v8" }, "linux"), realScreenTestRefusal);
  assert.equal(realScreenRefusal({ NODE_TEST_CONTEXT: "child-v8", BRANCH_SCREEN_TESTS: "1" }, "win32"), null);
  assert.equal(realScreenRefusal({ NODE_TEST_CONTEXT: "child-v8", CI: "true" }, "win32"), null);
  assert.equal(realScreenRefusal({ NODE_TEST_CONTEXT: "child-v8", CI: "true" }, "linux"), realScreenTestRefusal);
  assert.equal(realScreenRefusal({}, "win32"), null, "Branch itself, outside the test runner, is untouched");
});

test("only a program that truly lies inside the temporary folder counts as a test's stand-in", async (t) => {
  const { assertRealScreenAllowed, realScreenRefusal, realScreenTestRefusal, standInProgram } = await import("../dist/integrations/real-screen-guard.js");
  // Only asked, never started: under the test runner a real program is refused and a stand-in in the temp folder is not.
  const own = mkdtempSync(join(tmpdir(), "branch-standin-own-"));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  writeFileSync(join(own, "xdotool"), "#!/bin/sh\n");
  assert.doesNotThrow(() => assertRealScreenAllowed(join(own, "xdotool")));
  // Where the screen is allowed anyway (a Windows CI runner, or the opt-in) nothing is refused.
  if (realScreenRefusal()) {
    assert.throws(() => assertRealScreenAllowed(process.execPath), { message: realScreenTestRefusal });
    assert.throws(() => assertRealScreenAllowed(), { message: realScreenTestRefusal });
  }
  const root = mkdtempSync(join(tmpdir(), "branch-standin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temp = join(root, "t");
  const beside = join(root, "t-x");
  const outside = join(root, "o");
  for (const folder of [temp, beside, outside]) mkdirSync(folder);
  const write = (path) => { writeFileSync(path, "#!/bin/sh\n"); return path; };
  assert.equal(standInProgram(write(join(temp, "xdotool")), temp), true, "a program written into the temporary folder");
  assert.equal(standInProgram(write(join(outside, "xdotool")), temp), false, "a program anywhere else");
  assert.equal(standInProgram(write(join(beside, "xdotool")), temp), false, "a folder whose name only begins the same way");
  assert.equal(standInProgram(join(temp, "missing"), temp), false, "a program that is not there");
  assert.equal(standInProgram(temp, temp), false, "the temporary folder itself");
  assert.equal(standInProgram(join(temp, "..", "o", "xdotool"), temp), false, "a way out written into the path");
  // A link inside the temporary folder to a folder outside it leads outside: a junction needs no rights on Windows.
  symlinkSync(outside, join(temp, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(standInProgram(join(temp, "link", "xdotool"), temp), false, "a link that leads outside");
});

test("every real-screen program start in the engine asks the guard first", () => {
  const src = (path) => readFileSync(join(here, "..", "src", path), "utf8");
  const script = src("integrations/desktop-script.ts");
  const before = (text, start, marker) => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `found ${start}`);
    const at = text.indexOf(marker, from);
    const guard = text.indexOf("assertRealScreenAllowed(", from);
    assert.ok(guard > from && guard < at, `${start}: the guard comes before ${marker}`);
  };
  before(script, "async run(action: DesktopAction", "new ShellProcess(");
  before(script, "const boundedRunner = (standIns: boolean): PosixExec", "new ShellProcess(");
  before(script, "liveProcess(target?: NativeCaptureTarget", "executable: this.executable");
  before(script, "private helper(limit: number): DesktopHelper", "executable: this.executable");
  before(src("integrations/desktop-banner.ts"), "async show(onStop: () => void)", "spawn(");
  // Only the Mac/Linux runner passes its program, so only there may a test's stand-in run; the Windows places never.
  assert.deepEqual(script.match(/assertRealScreenAllowed\([^)]*\)/g), ["assertRealScreenAllowed()", "assertRealScreenAllowed()", "assertRealScreenAllowed()", "assertRealScreenAllowed(standIns ? executable : undefined)"]);
  // ...and only when the code that built the runner handed in its own program finder, which Branch itself never does:
  // its one screen runner is built with no Mac/Linux options at all.
  assert.match(script, /this\.posix\.exec \?\? boundedRunner\(this\.posix\.locate !== undefined\)/);
  assert.equal((script.match(/boundedRunner\(/g) ?? []).length, 1, "no other place builds the bounded runner");
  const index = src("index.ts");
  assert.match(index, /\.\.\.screenControlParts\(options\.bannerWindow \? \{ window: options\.bannerWindow \} : \{\}\)/);
  assert.equal((index.match(/screenControlParts\(/g) ?? []).length, 1);
  assert.doesNotMatch(src("integrations/desktop.ts"), /new DesktopScriptRunner\([^)]/, "the default runner is built with nothing handed in");
  assert.deepEqual(src("integrations/desktop-banner.ts").match(/assertRealScreenAllowed\([^)]*\)/g), ["assertRealScreenAllowed()"]);
  const spawns = (script.match(/\bspawn\(|new ShellProcess\(/g) ?? []).length;
  assert.equal(spawns, 4, "no other place in the runner starts a program; a new one needs the guard too");
  // The live reader and the resident helper each start only the command they were handed, which a guarded factory builds.
  const starts = script.split("private async start(signal: AbortSignal): Promise<ChildProcess>").slice(1);
  assert.equal(starts.length, 2);
  for (const start of starts) assert.ok(start.indexOf("await this.command()") < start.indexOf("spawn("), "only the command it was handed");
});
