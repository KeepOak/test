import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { realScreenAllowed, realScreenMarker } from "./real-screen.mjs";

/* Tests that drive this computer's real screen (open Notepad, type into it, photograph it) must never run on the owner's
   PC by accident: they carry the marker line, check realScreenAllowed() before anything runs, and scripts/review.mjs
   refuses them. This file fails when a test that reaches the real screen is missing either. It only reads those files:
   it never runs one, so a broken guard can never make it drive the screen. */

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** What a test that touches the real screen contains: starting Notepad, a Windows Forms window, keys sent to it, a picture of it. */
const realScreen = new RegExp(["notepad", "\\.exe", "|System\\.Windows\\.", "Forms|CopyFrom", "Screen|Send", "Keys|user", "32\\.dll"].join(""), "i");

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

test("every real-screen program start in the engine asks the guard first", () => {
  const src = (path) => readFileSync(join(here, "..", "src", path), "utf8");
  const script = src("integrations/desktop-script.ts");
  const before = (text, start, marker) => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `found ${start}`);
    const at = text.indexOf(marker, from);
    const guard = text.indexOf("assertRealScreenAllowed()", from);
    assert.ok(guard > from && guard < at, `${start}: the guard comes before ${marker}`);
  };
  before(script, "async run(action: DesktopAction", "new ShellProcess(");
  before(script, "const runBounded: PosixExec", "new ShellProcess(");
  before(script, "liveProcess(): LiveScreenProcess | null", "executable: this.executable");
  before(src("integrations/desktop-banner.ts"), "async show(onStop: () => void)", "spawn(");
  const spawns = (script.match(/\bspawn\(|new ShellProcess\(/g) ?? []).length;
  assert.equal(spawns, 3, "no other place in the runner starts a program; a new one needs the guard too");
  const liveStart = script.slice(script.indexOf("private async start(): Promise<ChildProcess>"));
  assert.ok(liveStart.indexOf("await this.command()") < liveStart.indexOf("spawn("), "the live reader starts only the command it was handed, which the guarded factory builds");
});
