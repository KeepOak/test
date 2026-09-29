/**
 * SELF-010: the sandbox proof's own pieces (scripts/selfdev-proof-sandbox.mjs), without GitHub: the change it makes
 * really passes the sandbox's test, and its scripted stand-in only merges after checks passed and only calls the
 * pull request done once GitHub says merged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxChange, scriptedSandboxCoder, sandboxRepo } from "../scripts/selfdev-proof-sandbox.mjs";
import { discardTemp } from "./temp-dir.mjs";

const settings = [
  "/** The app's settings knobs: each has a default and says which values it accepts. */",
  "export const knobs = {",
  "  theme: { default: \"light\", valid: (value) => [\"light\", \"dark\"].includes(value) },",
  "};",
  "",
  "export function readSetting(saved, name) {",
  "  const knob = knobs[name];",
  "  if (!knob) throw new Error(`No setting called ${name}`);",
  "  return Object.hasOwn(saved, name) && knob.valid(saved[name]) ? saved[name] : knob.default;",
  "}",
  "",
].join("\r\n");
const tests = [
  "import test from \"node:test\";", "import assert from \"node:assert/strict\";", "import { readSetting } from \"../src/settings.mjs\";", "",
  "test(\"theme defaults to light\", () => { assert.equal(readSetting({}, \"theme\"), \"light\"); });", "",
].join("\n");

test("the sandbox change adds one knob whose test passes on the files as main holds them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sandbox-change-"));
  t.after(() => discardTemp(root));
  const change = sandboxChange(settings, tests, "knobabc");
  await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "src", "settings.mjs"), change.settings);
  await writeFile(join(root, "tests", "settings.test.mjs"), change.tests);
  // The child runs its own tests: this runner's NODE_TEST_CONTEXT would send its report here instead of printing it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
  const out = execFileSync(process.execPath, ["--test", "tests/settings.test.mjs"], { cwd: root, encoding: "utf8", env });
  assert.match(out, /pass 2/);
  assert.match(change.settings, /knobabc: \{ default: "medium"/);
  assert.throws(() => sandboxChange("export const other = 1;\n", tests, "x"), /no longer has its knobs list/);
});

test("the scripted stand-in merges only after checks passed, then waits for the queue until GitHub says merged", async () => {
  const { provider, state } = scriptedSandboxCoder({ branch: "selfdev/k", knob: "k", change: { settings: "s", tests: "t" }, message: "feat: k" });
  const tool = (content) => ({ messages: [{ role: "user", content: "go" }, { role: "tool", content }] });
  const names = [];
  for (let step = 0; step < 10; step++) names.push((await provider.complete(tool(""))).toolCalls[0].name);
  assert.deepEqual(names, ["git.clone", "shell.execute", "files.read", "files.write", "files.read", "files.write", "shell.execute",
    "git.commit", "git.push", "github.open_pull_request"]);
  const next = async (content) => (await provider.complete(tool(content))).toolCalls?.[0] ?? null;
  assert.equal((await next('{"number":4,"state":"open"}')).name, "github.wait_for_checks");
  assert.equal(state.number, 4);
  assert.equal((await next('{"state":"pending"}')).name, "github.wait_for_checks", "pending is waited on, never merged");
  const merge = await next('{"state":"passed","headSha":"a"}');
  assert.equal(merge.name, "github.merge_pull_request");
  assert.deepEqual(JSON.parse(merge.arguments), { repo: sandboxRepo, number: 4 });
  assert.equal((await next('{"merged":false,"queued":true,"state":"QUEUED"}')).name, "github.wait_for_checks");
  assert.equal((await next('{"state":"pending","queued":true}')).name, "github.wait_for_checks", "the queue is waited on too");
  const finished = await provider.complete(tool('{"state":"merged","mergeSha":"b"}'));
  assert.equal(finished.toolCalls.length, 0);
  assert.match(finished.content, /#4 is merged/);
  const red = scriptedSandboxCoder({ branch: "b", knob: "k", change: { settings: "s", tests: "t" }, message: "m" });
  for (let step = 0; step < 10; step++) await red.provider.complete(tool(""));
  await red.provider.complete(tool('{"number":5}'));
  const stop = await red.provider.complete(tool('{"state":"failed","summary":"test failed"}'));
  assert.equal(stop.toolCalls.length, 0);
  assert.match(stop.content, /nothing was merged/);
});

test("Branch's own path in the proof: contract tests before the draft, finish only after checks passed, done only when merged", async () => {
  const { scriptedSelfCoder, selfBase } = await import("../scripts/selfdev-proof-sandbox-self.mjs");
  const worktree = "branch-agent-source/.branch-worktrees/self-k";
  const { provider, state } = scriptedSelfCoder({ worktree, branch: "branch/self-k", change: { settings: "s", tests: "t" }, message: "feat: k" });
  const tool = (content) => ({ messages: [{ role: "user", content: "go" }, { role: "tool", content }] });
  const names = [];
  for (let step = 0; step < 8; step++) names.push((await provider.complete(tool('{"ok":true}'))).toolCalls[0]);
  assert.deepEqual(names.map((one) => one.name), ["files.read", "files.write", "files.read", "files.write", "git.commit",
    "branch.run_contract_tests", "git.push", "github.open_pull_request"]);
  assert.deepEqual(JSON.parse(names[7].arguments).draft, true, "Branch's own change is proposed only as a draft");
  assert.equal(JSON.parse(names[7].arguments).base, selfBase);
  const next = async (content) => (await provider.complete(tool(content))).toolCalls?.[0] ?? null;
  assert.equal((await next('{"number":10}')).name, "github.wait_for_checks");
  assert.equal((await next('{"state":"pending"}')).name, "github.wait_for_checks");
  assert.equal((await next('{"state":"passed"}')).name, "branch.finish_source_change");
  const review = await provider.complete({ messages: [{ role: "user", content: "Review this proposed Branch source change independently. {}" }] });
  assert.deepEqual(JSON.parse(review.content), { passed: true, findings: [] });
  assert.equal(state.reviews, 1);
  assert.equal((await next('{"merged":false,"queued":true}')).name, "github.wait_for_checks");
  const finished = await provider.complete(tool('{"state":"merged"}'));
  assert.match(finished.content, /#10 is merged/);
  const refused = scriptedSelfCoder({ worktree, branch: "branch/self-k", change: { settings: "s", tests: "t" }, message: "m" });
  await refused.provider.complete(tool(""));
  const stop = await refused.provider.complete(tool('{"ok":false,"error":"refused by the contract"}'));
  assert.match(stop.content, /A step was refused/, "a refused step stops the run rather than carrying on");
});
