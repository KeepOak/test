import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { pullRequestFromChanges, savePullRequestHookSettings } from "../dist/pr-hook.js";
import { sourcePublicationQueue } from "../dist/self-development-publication-hook.js";
import { discardTemp } from "./temp-dir.mjs";

const plain = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "publication-hook-")), workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: { name: "test", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "branch-agent-source/.branch-worktrees/self-publication", source = join(workspace, "branch-agent-source"), cwd = join(workspace, folder);
  await mkdir(source, { recursive: true });
  plain(source, "init", "-q", "-b", "main"); plain(source, "commit", "--allow-empty", "-qm", "source");
  plain(source, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const sourceSha = plain(source, "rev-parse", "HEAD").trim();
  plain(source, "worktree", "add", "-q", "-b", "publication", cwd);
  await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src/a.ts"), "export const value = 1;\n");
  const owner = app.runtime.owner;
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha, worktreePath: folder,
    sendRepositories: ["acme/widgets"], terms: { allowedPaths: ["src/**"], permissions: ["github.pull_request_from_changes", "github.open_pull_request"],
      expectedTests: ["tests/a.test.mjs"], definitionOfDone: "A is ready", sideEffects: ["Draft PR"], rollbackPlan: "Close PR" } });
  app.store.projects.save(owner, { id: "publication", name: "Publication", instructions: "", modelPreset: null, repository: "acme/widgets", folder, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: "publication" });
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "fake", parameters: z.object({}).passthrough(), execute: async () => ({}) });
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  let offline = true, remote = null, pushes = 0, opens = 0;
  const deps = { store: app.store, owner, files: app.files, registry: app.registry, policy: { assertAllowed: async () => {} },
    preflight: () => null, findPublication: async () => null,
    runTool: async () => { opens++; return { number: 4 }; },
    git: async ({ cwd: at, args }) => {
      if (args[0] === "ls-remote") {
        if (offline) throw new Error("ECONNREFUSED");
        return { status: "completed", stdout: remote ? `${remote}\trefs/heads/branch/change\n` : "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "push") {
        pushes++; assert.equal(args[1], "--force-with-lease=refs/heads/branch/change:");
        assert.equal(args[2], "https://github.com/acme/widgets.git");
        assert.match(args[3], /^[a-f0-9]{40}:refs\/heads\/branch\/change$/); remote = args[3].split(":")[0];
        return { status: "completed", stdout: "", stderr: "", exitCode: 0 };
      }
      try { return { status: "completed", stdout: plain(at, ...args), stderr: "", exitCode: 0 }; }
      catch (error) { return { status: "failed", stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), exitCode: error.status }; }
    } };
  const ask = { name: "change", title: "Add A", summary: "A is needed", paths: ["src/a.ts"], base: "redesign/window", signal: new AbortController().signal };
  return { app, deps, cwd, root, ask, online: () => { offline = false; }, counts: () => ({ pushes, opens }) };
}
function due(app, entry) {
  app.store.sqlite.prepare("UPDATE self_development_publications SET due=0,data=? WHERE id=?").run(JSON.stringify({ ...entry, nextAttemptAt: 0 }), entry.id);
}
test("RES711 real selfdev publication commits locally during outage then publishes exact saved commit", async (t) => {
  const f = await fixture(t), result = await pullRequestFromChanges(f.deps, f.ask);
  assert.equal(result.publication.state, "waiting"); assert.equal(result.pullRequest, null);
  assert.equal(plain(f.cwd, "status", "--porcelain").trim(), "");
  assert.equal(plain(f.cwd, "rev-parse", "HEAD").trim(), result.publication.sha);
  assert.deepEqual(f.counts(), { pushes: 0, opens: 0 });
  assert.equal((await pullRequestFromChanges(f.deps, f.ask)).publication.id, result.publication.id);
  f.online(); due(f.app, result.publication);
  assert.equal((await sourcePublicationQueue(f.deps).attempt(result.publication.id, f.ask.signal)).state, "published");
  assert.deepEqual(f.counts(), { pushes: 1, opens: 1 });
});
test("RES711 queued real selfdev publication refuses changed branch and current settings", async (t) => {
  const f = await fixture(t), result = await pullRequestFromChanges(f.deps, f.ask);
  f.online(); due(f.app, result.publication);
  plain(f.cwd, "commit", "--allow-empty", "-qm", "another change");
  assert.equal((await sourcePublicationQueue(f.deps).attempt(result.publication.id, f.ask.signal)).state, "blocked");
  assert.deepEqual(f.counts(), { pushes: 0, opens: 0 });
});
test("RES711 DNS outage still saves the local source commit without bypassing network policy", async (t) => {
  const f = await fixture(t);
  f.deps.policy.assertAllowed = async () => { throw new Error("github.com could not be resolved"); };
  const result = await pullRequestFromChanges(f.deps, f.ask);
  assert.equal(result.publication.state, "waiting");
  assert.equal(plain(f.cwd, "status", "--porcelain").trim(), "");
  assert.deepEqual(f.counts(), { pushes: 0, opens: 0 });
  f.deps.policy.assertAllowed = async () => { throw new Error("github.com is on the policy blocked list"); };
  due(f.app, result.publication);
  assert.equal((await sourcePublicationQueue(f.deps).attempt(result.publication.id, f.ask.signal)).state, "blocked");
  assert.deepEqual(f.counts(), { pushes: 0, opens: 0 });
});
test("RES711 empty-output Git timeout remains a retryable outage", async (t) => {
  const f = await fixture(t), git = f.deps.git;
  f.deps.git = async (options, signal) => options.args[0] === "ls-remote"
    ? { status: "timed_out", stdout: "", stderr: "", exitCode: null }
    : git(options, signal);
  assert.equal((await pullRequestFromChanges(f.deps, f.ask)).publication.state, "waiting");
  assert.deepEqual(f.counts(), { pushes: 0, opens: 0 });
});
test("RES711 create-only lease rejects an ancestor branch created after remote inspection", async (t) => {
  const f = await fixture(t), git = f.deps.git, bare = join(f.root, "remote.git");
  plain(f.root, "init", "--bare", "-q", bare); f.online();
  let ancestor;
  f.deps.git = async (options, signal) => {
    if (options.args[0] !== "push") return git(options, signal);
    ancestor = plain(f.cwd, "rev-parse", "HEAD^").trim();
    plain(f.cwd, "push", bare, `${ancestor}:refs/heads/branch/change`);
    assert.equal(options.args[1], "--force-with-lease=refs/heads/branch/change:");
    try { plain(f.cwd, "push", options.args[1], bare, options.args.at(-1)); assert.fail("existing branch overwritten"); }
    catch (error) { return { status: "failed", stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message), exitCode: 1 }; }
  };
  const result = await pullRequestFromChanges(f.deps, f.ask);
  assert.equal(result.publication.state, "blocked");
  assert.equal(plain(bare, "rev-parse", "refs/heads/branch/change").trim(), ancestor);
  assert.equal(f.counts().opens, 0);
});
