import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";
import { underTask } from "../dist/task-scope.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { clarifyRequest } from "../dist/settings-kit/clarify.js";
import { recordSourceArrival, sourceArrived } from "../dist/self-development-arrival.js";
import { evaluateBud, regressionCases } from "../dist/seasons/bud-evaluation.js";
import * as packaging from "../scripts/package-desktop.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-capability-loop-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "work"),
    provider: { name: "fixed", async complete() { return { content: "Done", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "Add a quantum report style setting" });
  return { app, context: app.runtime.context({ runId: run.id }) };
}

test("a local owner task files a review request but cannot approve it; keys and foreign origins cannot file", async t => {
  const { app, context } = await fixture(t);
  const filed = underTask(context.runId, () => app.sourceRequests.fileOwnerTask("Add the setting", context));
  assert.equal(filed.status, "waiting");
  assert.equal(filed.worktree, null);
  await assert.rejects(underTask(context.runId, () => app.sourceRequests.approve(filed.id, {})), /task cannot/);
  assert.throws(() => underShortLivedKey(() => app.sourceRequests.fileOwnerTask("Add setting", context)), /Only the owner/);
  assert.throws(() => app.sourceRequests.fileOwnerTask("Add setting", { ...context, source: "channel" }), /Only the owner/);
  assert.throws(() => underTask("another-task", () => app.sourceRequests.fileOwnerTask("Add setting", context)), /owner's own task/);
});

test("missing-setting discovery offers an explicit handoff without planning a change or interpreting negation as consent", async t => {
  const { app } = await fixture(t);
  const missing = clarifyRequest(app.store, app.runtime.owner, { request: "quantum report style", value: "on" }, app.registry);
  assert.equal(missing.planned, false);
  assert.equal(missing.missingCapability.tool, "seasons.request_setting");
  assert.equal(missing.missingCapability.value, "on");
  const off = clarifyRequest(app.store, app.runtime.owner, { request: "quantum report style", value: false }, app.registry);
  assert.equal(off.missingCapability.value, false, "a supplied false value travels with the handoff");
  const noTool = { inventory: () => app.registry.inventory().filter((tool) => tool.name !== "seasons.request_setting") };
  assert.equal(clarifyRequest(app.store, app.runtime.owner, { request: "quantum report style", value: "on" }, noTool).missingCapability, undefined,
    "no handoff is offered when its tool is not available");
  const negated = clarifyRequest(app.store, app.runtime.owner, { request: "do not add quantum report style" }, app.registry);
  assert.equal(negated.missingCapability, undefined);
});

test("installed proof binds owner, worktree, exact merge commit and approval time; receipts are immutable", async t => {
  const { app } = await fixture(t);
  const sha = "a".repeat(40), worktree = "branch-agent-source/.branch-worktrees/self-setting";
  const before = new Date(Date.now() - 1000).toISOString();
  assert.equal(sourceArrived(app.store, app.runtime.owner, worktree, before, sha), false);
  recordSourceArrival(app.store, app.runtime.owner, worktree, sha);
  assert.equal(sourceArrived(app.store, app.runtime.owner, worktree, before, sha), true);
  assert.equal(sourceArrived(app.store, app.runtime.owner, worktree, before, "b".repeat(40), ["b".repeat(40), sha]), true,
    "the running build's stamped ancestry can contain a reviewed merge");
  for (const args of [["other", worktree, before, sha], [app.runtime.owner, "other", before, sha],
    [app.runtime.owner, worktree, before, "b".repeat(40)], [app.runtime.owner, worktree, "2999-01-01", sha]])
    assert.equal(sourceArrived(app.store, ...args), false);
  assert.throws(() => app.store.sqlite.prepare("UPDATE self_development_arrivals SET sha=?").run("b".repeat(40)), /cannot be changed/);
});

test("a generated revision cannot erase or rewrite old expected answers", () => {
  const original = [{ input: { n: 1 }, expected: 2 }];
  assert.throws(() => regressionCases(original, [{ input: { n: 1 }, expected: 999 }]), /cannot change/);
  assert.deepEqual(regressionCases(original, [{ input: { n: 2 }, expected: 4 }]), [...original, { input: { n: 2 }, expected: 4 }]);
});

test("evaluations discard the outer wall's write grants as well as live tool permissions", async t => {
  const { context } = await fixture(t);
  let exposed;
  await evaluateBud({ async run(_input, held) { exposed = held.osSandbox; return { ok: true, result: [{ value: 2, complete: true }], calls: [], output: "" }; } },
    { source: "async function build(){return 2}", tools: ["files.write"] }, undefined, [{ input: {}, expected: 2 }],
    { ...context, osSandbox: { granted: () => ["/owner/report"] } });
  assert.equal(exposed, undefined);
});

test("packaging deepens a shallow checkout before stamping ancestry, without fetching a complete checkout", () => {
  const seen = [];
  assert.equal(packaging.prepareBuildHistory((_file, args) => {
    seen.push(args);
    return { status: 0, stdout: args.includes("--is-shallow-repository") ? "true\n" : args.includes("rev-parse") ? "a".repeat(40) : "" };
  }), true);
  assert.ok(seen.some(args => args.includes("fetch") && args.includes("--deepen=2000") && args.at(-1) === "a".repeat(40)));
  const full = [];
  assert.equal(packaging.prepareBuildHistory((_file, args) => { full.push(args); return { status: 0, stdout: "false\n" }; }), true);
  assert.equal(full.length, 1, "full histories need no network operation");
  const info = packaging.buildInfo({ GITHUB_SHA: "b".repeat(40) }, () => "", () => `${"b".repeat(40)}\n${"a".repeat(40)}\n`);
  assert.deepEqual(info.ancestors, ["b".repeat(40), "a".repeat(40)]);
});

test("a real shallow package checkout includes its earlier merge history after preparation", async t => {
  const root = await mkdtemp(join(tmpdir(), "branch-build-history-"));
  t.after(() => discardTemp(root));
  const source = join(root, "source"), shallow = join(root, "shallow");
  await mkdir(source);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-q");
  await writeFile(join(source, "setting"), "v1"); git(source, "add", "."); git(source, "commit", "-qm", "setting");
  const first = git(source, "rev-parse", "HEAD");
  await writeFile(join(source, "setting"), "v2"); git(source, "commit", "-qam", "later change");
  git(root, "clone", "-q", "--depth=1", pathToFileURL(source).href, shallow);
  assert.equal(git(shallow, "rev-list", "--count", "HEAD"), "1");
  assert.equal(packaging.prepareBuildHistory((file, args, options) => spawnSync(file, args, { ...options, cwd: shallow })), true);
  const info = packaging.buildInfo({}, () => git(shallow, "rev-parse", "HEAD"), sha => git(shallow, "rev-list", "--max-count=2000", sha));
  assert.ok(info.ancestors.includes(first));
});
