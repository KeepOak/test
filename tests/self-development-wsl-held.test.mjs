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

/** A stand-in for Branch's own scripts/review.mjs: runs node's test runner on each file and prints review's summary lines. */
const reviewStandIn = String.raw`import { spawnSync } from "node:child_process";
const files = process.argv.slice(2).filter((arg) => arg.endsWith(".test.mjs"));
let ok = true;
for (const file of files) {
  const out = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8" }).stdout ?? "";
  const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? 1);
  ok &&= fail === 0;
  console.log((fail ? "FAIL" : "PASS") + "  " + file + "  0.1s  " + pass + "/" + (pass + fail) + " passed");
}
if (ok) console.log("all steps passed in 0.2s"); else process.exitCode = 1;
`;

test("SELF-014 and SELF-016: branch.run_contract_tests runs the contract's review in WSL behind the wall and records pass, then fail", { skip: !ready && "needs Windows with WSL, Node.js and bubblewrap" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wsl-contract-tests-"));
  const worktree = "branch-agent-source/.branch-worktrees/self-y";
  let asked = 0;
  const provider = { name: "scripted", async complete(request) {
    const said = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const last = request.messages.at(-1);
    if (/contract tests/.test(said) && last?.role !== "tool") { asked++; return { content: "", toolCalls: [{ id: `t${asked}`, name: "branch.run_contract_tests", arguments: JSON.stringify({ worktree }) }] }; }
    return { content: "done", toolCalls: [] };
  } };
  const engine = await startEngine(root, { token: "x", npm: true, githubApiBase: "http://127.0.0.1:9/", privateAddresses: true, provider });
  t.after(async () => { await engine.close(); await discardTemp(root); });
  const source = join(engine.workspace, "branch-agent-source"), cwd = join(engine.workspace, worktree);
  const git = (at, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: at, encoding: "utf8" }).trim();
  await mkdir(join(source, "scripts"), { recursive: true });
  git(source, "init", "-q", "-b", "redesign/window");
  await writeFile(join(source, "scripts", "review.mjs"), reviewStandIn);
  await writeFile(join(source, "scripts", "build-ts.mjs"), "// stand-in\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ type: "module", scripts: { build: "node scripts/build-ts.mjs" } }));
  git(source, "add", "."); git(source, "commit", "-qm", "base");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "worktree", "add", "-q", "-b", "branch/self-y", ".branch-worktrees/self-y");
  const suite = (sum) => ['import test from "node:test";', 'import assert from "node:assert/strict";',
    'test("on Linux", () => assert.equal(process.platform, "linux"));', `test("adds", () => assert.equal(1 + 1, ${sum}));`, ""].join("\n");
  await mkdir(join(cwd, "tests"), { recursive: true });
  await writeFile(join(cwd, "tests", "a.test.mjs"), suite(2));
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "add a test");
  const owner = engine.app.runtime.owner;
  new ContractBook(engine.app.store.sqlite).create(owner, { taskRunId: "", sourceSha: base, worktreePath: worktree,
    terms: { allowedPaths: ["**"], permissions: ["shell.execute"], expectedTests: ["tests/a.test.mjs"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" },
    sendRepositories: ["keepoak/branch-agent"] });
  engine.app.store.projects.save(owner, { id: "self-y", name: "Branch Agent: y", folder: worktree, repository: "KeepOak/Branch-Agent" });
  engine.app.store.projects.setActive(owner, { active: "self-y" });
  const ask = async () => {
    const run = await engine.api("run", { prompt: "run the contract tests", mode: "full" });
    const done = engine.app.store.events(run.body.id).find((event) => event.kind === "tool.completed" && event.data.name === "branch.run_contract_tests");
    assert.ok(done, JSON.stringify(engine.app.store.events(run.body.id).filter((event) => /^tool\./.test(event.kind)).map((event) => event.data)).slice(0, 800));
    return done.data.result;
  };
  const green = await ask();
  assert.deepEqual([green.recorded, green.passed, green.testsPassed, green.commit], [true, true, 2, git(cwd, "rev-parse", "HEAD")]);
  assert.deepEqual(green.command, ["node", "scripts/review.mjs", "--jobs", "1", "tests/a.test.mjs"]);
  await writeFile(join(cwd, "tests", "a.test.mjs"), suite(3));
  git(cwd, "commit", "-qam", "break the test");
  const red = await ask();
  assert.deepEqual([red.recorded, red.passed], [true, false]);
  assert.deepEqual(red.failing, ["FAIL  tests/a.test.mjs  0.1s  1/2 passed"]);
});
