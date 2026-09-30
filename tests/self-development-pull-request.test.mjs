/**
 * Q12: the documented pull request step of a self-development task runs whole or not at all.
 * `github.pull_request_from_changes` pushes `branch/<name>` and then opens the draft with
 * `github.open_pull_request`. The contract must list both, and is asked about both before anything
 * is pushed. Real app, scripted model, a stand-in `git` first on PATH and a stand-in GitHub tool,
 * so nothing reaches a network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { savePullRequestHookSettings } from "../dist/pr-hook.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";
import { saveCodingMode } from "../dist/coding/settings.js";
import { GitHubAccess } from "../dist/integrations/github.js";
import { registerGitHubProject } from "../dist/integrations/git-tools.js";

const sha = "d".repeat(40);
// The worktree's commit, and the one new commit the pull request makes on it.
const walked = "e".repeat(40), made = "f".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const home = await mkdtemp(join(tmpdir(), "branch-self-pr-git-"));
const gitLog = join(home, "git.log"), diffOut = join(home, "diff.out");
// Written once the stand-in commits: from then on HEAD is the new commit, as it is for real Git.
const committed = join(home, "committed");
const bin = join(home, "bin");
await mkdir(bin, { recursive: true });
await writeFile(join(bin, "git"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -c) shift 2;; --no-pager) shift; break;; *) break;; esac; done
echo "$*" >> '${gitLog}'
case "$1" in
  remote) echo https://github.com/stabrea/Branch-Agent.git; exit 0;;
  symbolic-ref) echo refs/remotes/origin/main; exit 0;;
  --literal-pathspecs) case "$*" in *" commit "*) : > '${committed}';; esac; exit 0;;
  switch|push|merge-base) exit 0;;
  ls-remote) exit 0;;
  diff|diff-tree) cat '${diffOut}'; exit 0;;
  log) exit 0;;
  rev-parse) case "$*" in
    *--show-toplevel*) pwd -P; echo "$(pwd -P)/../../.git";;
    *refs/heads/branch/*) echo ${made};;
    *) if [ -f '${committed}' ]; then echo ${made}; else echo ${walked}; fi;;
  esac; exit 0;;
  rev-list) echo "${made} ${walked}"; exit 0;;
  ls-files) exit 0;;
  *) exit 1;;
esac
`);
await chmod(join(bin, "git"), 0o755);
// selfdev: the computer's own GitHub CLI, standing in: it writes down what it was asked and the body it was given.
const ghLog = join(home, "gh.log");
// A queued publication first looks for a pull request it may already have opened (gh api): there is none.
await writeFile(join(bin, "gh"), `#!/bin/sh
if [ "$1" = api ]; then echo '[]'; exit 0; fi
printf '%s\n' "$@" > '${ghLog}'
echo "--body--" >> '${ghLog}'
cat >> '${ghLog}'
echo https://github.com/stabrea/Branch-Agent/pull/9
`);
await chmod(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
test.after(() => discardTemp(home));
/** The stand-in git is a /bin/sh script, which Windows cannot run. */
const posixOnly = { skip: process.platform === "win32" && "the stand-in git is a /bin/sh script" };

async function branchWith(t, permissions, options = {}) {
  await writeFile(gitLog, "");
  await rm(committed, { force: true });
  await writeFile(diffOut, options.changed ?? "src/ui/button.ts\0");
  const root = await mkdtemp(join(tmpdir(), "branch-self-pr-"));
  let calls = 0;
  // By default the model asks for the pull request itself; `edit` makes it only change a file, for the hook to send.
  const call = options.edit ? { id: "edit", name: "files.write", arguments: JSON.stringify({ path: "src/ui/button.ts", content: "export const gone = true;\n" }) }
    : { id: "pr", name: "github.pull_request_from_changes", arguments: JSON.stringify({
      name: "self-remove-button", title: "Remove the button", summary: "Why merge this: the button is unused.", paths: ["src/ui/button.ts"],
      base: options.base ?? "redesign/window" }) };
  const provider = { name: "scripted", async complete() {
    return calls++ === 0 ? { content: "", toolCalls: [call] } : { content: "Done.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  // Q250: read-before-edit ships on. This test is about the pull request hook, not that guard, and its scripted model changes a file it never read.
  saveCodingMode(app.store, owner, "read-first", "off");
  savePolicy(app.store, owner, { preset: "off" });
  savePullRequestHookSettings(app.store, owner, { mode: options.mode ?? "when-needed" });
  const opened = [];
  await writeFile(ghLog, "");
  // selfdev: with no saved GitHub connection, sending Git work stays on (a stand-in; it is never called here).
  if (options.noGitHub) app.registry.register({ name: "git.push", permission: "git.remote", description: "stand-in", parameters: z.object({}).passthrough(), execute: async () => ({}) });
  if (!options.noGitHub) app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in for GitHub",
    parameters: z.object({}).passthrough(), execute: async (args) => { opened.push(args); return { number: 7, draft: args.draft }; } });
  // The saved connection behind it, which a queued publication asks first whether its pull request is already open: none is.
  if (!options.noGitHub) registerGitHubProject(app.registry, new GitHubAccess({}, { assertAllowed: async () => {} }, async () => "test-token",
    async () => new Response("[]", { status: 200 })));
  app.store.projects.save(owner, { id: "branch-agent-remove-button", name: "Branch Agent: remove-button", instructions: "",
    modelPreset: null, repository: "stabrea/Branch-Agent", folder: options.folder ?? worktree, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: "branch-agent-remove-button" });
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  await writeFile(join(workspace, worktree, "src", "ui", "button.ts"), "export {};\n");
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions, expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "The button is gone",
    sideEffects: ["a draft pull request"], rollbackPlan: "Close the pull request and delete branch/self-remove-button" },
    sendRepositories: ["stabrea/Branch-Agent"] });
  let run = await app.runtime.run({ prompt: "Open the pull request" });
  // selfdev: a pull request from Branch's own source is put to the owner every time, whatever the rules say.
  const question = run.status === "needs_input" ? app.runtime.approvals.questionFor(run.sessionId) : null;
  if (question) {
    assert.equal(question.tool, "github.pull_request_from_changes");
    assert.equal(question.remember, "never", "the yes to sending Branch's own source is never kept");
    assert.equal((await readFile(gitLog, "utf8")).split("\n").filter((line) => /^(switch|push)/.test(line)).length, 0, "nothing is sent before the yes");
    app.runtime.approve(run.sessionId, "allow", "never");
    calls = 0;
    run = await app.runtime.run({ prompt: "Open the pull request", sessionId: run.sessionId });
  }
  const failed = app.store.events(run.id).filter((event) => event.kind === "tool.failed").map((event) => event.data.error);
  return { app, owner, run, opened, failed, git: async () => (await readFile(gitLog, "utf8")).split("\n").filter(Boolean) };
}

test("with both steps in the contract, the branch is pushed and the draft pull request opens", posixOnly, async (t) => {
  const { run, opened, failed, git: log } = await branchWith(t, ["files.write", "github.pull_request_from_changes", "github.open_pull_request"]);
  const git = await log();
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual(failed, []);
  assert.ok(git.some((line) => line.startsWith("push")), git.join("\n"));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].head, "branch/self-remove-button");
  assert.equal(opened[0].draft, true);
});

test("with only the outer step in the contract, nothing is pushed and the refusal comes first", posixOnly, async (t) => {
  const { app, owner, opened, failed, git: log } = await branchWith(t, ["files.write", "github.pull_request_from_changes"]);
  const git = await log();
  assert.match(failed.join("\n"), /self-development contract: github\.open_pull_request is not one of the tools this contract allows/);
  assert.deepEqual(git.filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), [], "no branch was made, committed or pushed");
  assert.deepEqual(opened, []);
  const refused = app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused");
  assert.equal(refused.length, 1);
  assert.match(refused[0].subject, /^github\.open_pull_request in branch-agent-source\/\.branch-worktrees\/self-remove-button/);
});

/** Waits for the pull request hook, which runs after the task has finished, to say how it went. */
async function hookOutcome(app, runId) {
  for (let tries = 0; tries < 100; tries++) {
    const seen = app.store.events(runId).find((event) => event.kind === "pull_request.failed" || event.kind === "pull_request.opened");
    if (seen) return seen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the pull request hook never reported");
}

test("the finish-of-task hook's push is checked against the contract before anything is pushed", posixOnly, async (t) => {
  const { app, owner, run, opened, git: log } = await branchWith(t,
    ["files.write", "github.pull_request_from_changes", "github.open_pull_request"], { mode: "on", edit: true, changed: "src/ui/button.ts\0package.json\0" });
  assert.equal(run.status, "completed", run.output);
  const outcome = await hookOutcome(app, run.id);
  assert.equal(outcome.kind, "pull_request.failed");
  assert.match(outcome.data.reason, /changed files are outside the contract's allowed paths: package\.json/);
  assert.deepEqual((await log()).filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), [], "nothing was made, committed or pushed");
  assert.deepEqual(opened, []);
  const refused = app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused");
  assert.equal(refused.length, 1);
  assert.match(refused[0].subject, /^github\.pull_request_from_changes in branch-agent-source\/\.branch-worktrees\/self-remove-button/);
  assert.equal(refused[0].runId, run.id, "the record names the finished task the hook was sending");
});

test("the hook's push needs the pull request step in the contract, even when no tool call is made", posixOnly, async (t) => {
  const { app, run, opened, git: log } = await branchWith(t, ["files.write", "github.open_pull_request"], { mode: "on", edit: true });
  const outcome = await hookOutcome(app, run.id);
  assert.equal(outcome.kind, "pull_request.failed");
  assert.match(outcome.data.reason, /github\.pull_request_from_changes is not one of the tools this contract allows/);
  assert.deepEqual((await log()).filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), []);
  assert.deepEqual(opened, []);
});

test("selfdev: with the step listed and every change inside the contract, the hook still never sends Branch's own source by itself", posixOnly, async (t) => {
  const { app, run, opened, git: log } = await branchWith(t,
    ["files.write", "github.pull_request_from_changes", "github.open_pull_request"], { mode: "on", edit: true });
  const outcome = await hookOutcome(app, run.id);
  assert.equal(outcome.kind, "pull_request.failed", JSON.stringify(outcome.data));
  assert.match(outcome.data.reason, /sent only when you say yes to that step, never by itself/);
  assert.deepEqual((await log()).filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), [], "nothing was made, committed or pushed");
  assert.equal(opened.length, 0);
});

test("selfdev: a pull request from Branch's own source goes only to the line Beta builds", posixOnly, async (t) => {
  const { opened, failed, git: log } = await branchWith(t,
    ["files.write", "github.pull_request_from_changes", "github.open_pull_request"], { base: "mac/cross-platform" });
  assert.match(failed.join("\n"), /proposed only to redesign\/window/);
  assert.deepEqual((await log()).filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), []);
  assert.deepEqual(opened, []);
});

test("a pull request is never made from a folder below the worktree's root (a repository could be planted there)",
  posixOnly, async (t) => {
  const { app, owner, opened, failed, git: log } = await branchWith(t,
    ["files.write", "github.pull_request_from_changes", "github.open_pull_request"], { folder: `${worktree}/src/ui` });
  assert.match(failed.join("\n"), /Git runs in Branch's own source only at a self-development worktree's root/);
  assert.deepEqual((await log()).filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), []);
  assert.deepEqual(opened, []);
  assert.equal(app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused").length, 1);
});

test("selfdev: with no saved GitHub connection, the pull request opens with the computer's own gh sign-in, after the owner's yes", posixOnly, async (t) => {
  const { run, opened, failed, git: log } = await branchWith(t,
    ["files.write", "github.pull_request_from_changes", "github.open_pull_request"], { noGitHub: true });
  assert.equal(run.status, "completed", `${run.output} ${failed.join(" | ")}`);
  assert.deepEqual(failed, []);
  assert.ok((await log()).some((line) => line.startsWith("push")), "the line was pushed with the computer's own Git sign-in");
  assert.deepEqual(opened, [], "no saved connection was used");
  const [args, body] = (await readFile(ghLog, "utf8")).split("--body--\n");
  assert.deepEqual(args.trim().split("\n"), ["pr", "create", "--draft", "--repo=stabrea/Branch-Agent", "--base=redesign/window",
    "--head=branch/self-remove-button", "--title=Remove the button", "--body-file=-"]);
  assert.match(body, /Why merge this: the button is unused\./);
});

test("selfdev: the computer's gh sign-in is never used by the hook by itself", posixOnly, async (t) => {
  const { app, run, git: log } = await branchWith(t,
    ["files.write", "github.pull_request_from_changes", "github.open_pull_request"], { noGitHub: true, mode: "on", edit: true });
  const outcome = await hookOutcome(app, run.id).catch(() => null);
  if (outcome) assert.equal(outcome.kind, "pull_request.failed");
  assert.deepEqual((await log()).filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), []);
  assert.equal(await readFile(ghLog, "utf8"), "", "gh was never run");
});
