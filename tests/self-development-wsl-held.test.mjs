/**
 * selfdev (SELF-016): on Windows a command held to a self-development worktree really runs inside WSL behind
 * bubblewrap: Linux node, writes inside the folder it runs in, a write to Branch's protected checkout refused, and
 * Windows' npm alias running as npm. Runs only on a Windows computer whose WSL has Node.js and bubblewrap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractBook } from "../dist/self-development-contract.js";
import { wslProbe, wslReadiness } from "../dist/integrations/wsl-held.js";
import { startEngine } from "./fixtures/selfdev-harness.mjs";
import { discardTemp } from "./temp-dir.mjs";

const ready = process.platform === "win32" && (await wslReadiness(wslProbe)) === null;

test("a held command in the worktree this task prepared runs in WSL, held to its folder", { skip: !ready && "needs Windows with WSL, Node.js and bubblewrap" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wsl-held-"));
  const engine = await startEngine(root, { token: "x", npm: true, githubApiBase: "http://127.0.0.1:9/", privateAddresses: true,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await engine.close(); await discardTemp(root); });
  const source = join(engine.workspace, "branch-agent-source"), worktree = "branch-agent-source/.branch-worktrees/self-x";
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: source, encoding: "utf8" }).trim();
  await mkdir(source, { recursive: true });
  git("init", "-q", "-b", "redesign/window");
  await writeFile(join(source, "a.txt"), "original\n");
  git("add", "."); git("commit", "-qm", "base");
  git("worktree", "add", "-q", "-b", "branch/self-x", ".branch-worktrees/self-x");
  await mkdir(join(engine.workspace, worktree, "src"), { recursive: true });
  const run = await engine.api("run", { prompt: "work", mode: "full" });
  new ContractBook(engine.app.store.sqlite).create(engine.app.runtime.owner, { taskRunId: run.body.id, sourceSha: git("rev-parse", "HEAD"),
    worktreePath: worktree, terms: { allowedPaths: ["**"], permissions: ["shell.execute"], expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" }, sendRepositories: ["stabrea/branch-agent"] });
  const context = { ...engine.app.runtime.context({ runId: run.body.id }), permissions: new Set(["shell.execute"]) };
  const shell = (executable, args) => engine.app.registry.execute("shell.execute", { executable, args, cwd: `${worktree}/src` }, context);
  const inside = await shell("node", ["-e", "require('fs').writeFileSync('inside.txt','ok'); console.log(process.platform)"]);
  assert.equal(inside.stdout.trim(), "linux", "it ran inside WSL");
  assert.equal(await readFile(join(engine.workspace, worktree, "src", "inside.txt"), "utf8"), "ok");
  const outside = await shell("node", ["-e", "try { require('fs').writeFileSync('../../../../a.txt', 'PWNED'); console.log('wrote') } catch (e) { console.log(e.code) }"]);
  assert.match(outside.stdout, /EROFS|EACCES|ENOENT/, "a write to the protected checkout is refused");
  assert.equal(await readFile(join(source, "a.txt"), "utf8"), "original\n");
  assert.match((await shell("npm", ["--version"])).stdout.trim(), /^\d+\.\d+\.\d+$/, "Windows' npm alias runs as npm in WSL");
  // SELF-016: a real test run, not a probe: node's test runner in WSL behind the wall, at the worktree's root, pass and fail both read.
  await mkdir(join(engine.workspace, worktree, "tests"), { recursive: true });
  const suite = (expected) => [
    'import test from "node:test";', 'import assert from "node:assert/strict";', 'import { writeFileSync } from "node:fs";',
    'test("runs on Linux inside the worktree", () => { assert.equal(process.platform, "linux"); writeFileSync("tests/ran.txt", "yes"); });',
    `test("adds", () => { assert.equal(1 + 1, ${expected}); });`, ""].join("\n");
  const runTests = () => engine.app.registry.execute("shell.execute", { executable: "node", args: ["--test", "tests/a.test.mjs"], cwd: worktree }, context);
  await writeFile(join(engine.workspace, worktree, "tests", "a.test.mjs"), suite(2));
  const green = await runTests();
  assert.equal(green.exitCode, 0, green.stdout);
  assert.match(green.stdout, /# pass 2/);
  assert.match(green.stdout, /# fail 0/);
  assert.equal(await readFile(join(engine.workspace, worktree, "tests", "ran.txt"), "utf8"), "yes", "the tests wrote inside the worktree");
  await writeFile(join(engine.workspace, worktree, "tests", "a.test.mjs"), suite(3));
  const red = await runTests().catch((error) => ({ exitCode: 1, stdout: String(error.message) }));
  assert.notEqual(red.exitCode, 0, "a failing test is a failed run");
  assert.match(red.stdout, /# fail 1/, "the failure is read, not guessed");
});
