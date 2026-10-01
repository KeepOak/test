/* SELF-026: the Inbox publishes exactly the committed draft the owner reviewed, as a draft pull request, and only with
   their consent from the owner's own window. A stale review, uncommitted files, a caller other than the owner here, or a
   contract that changed before a retry publishes nothing. Real Git in temporary folders; the network side is a stand-in. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { ContractBook, contractHash, selfDevelopmentLine } from "../dist/self-development-contract.js";
import { savePullRequestHookSettings } from "../dist/pr-hook.js";
import { sourcePublicationQueue } from "../dist/self-development-publication-hook.js";
import { asCaller, resolveCaller } from "../dist/caller.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";

const plain = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const window = { key: "window", pairedDoor: false, fromThisComputer: true, windowHousehold: false, lockdown: false, appLocked: false };
const here = (work) => asCaller(resolveCaller(window), work);
const remote = (work) => asCaller(resolveCaller({ ...window, fromThisComputer: false }), work);
const requestId = "0b6f8a8e-5d7e-4e8a-9f35-3a1c2b4d5e6f";

async function fixture(t) {
  const { SourceRequestDrafts } = await import("../dist/self-development-drafts.js");
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "source-drafts-")), workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: { name: "test", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "branch-agent-source/.branch-worktrees/self-drafts", source = join(workspace, "branch-agent-source"), cwd = join(workspace, folder);
  await mkdir(source, { recursive: true });
  plain(source, "init", "-q", "-b", "main"); plain(source, "commit", "--allow-empty", "-qm", "source");
  plain(source, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const sourceSha = plain(source, "rev-parse", "HEAD").trim();
  plain(source, "worktree", "add", "-q", "-b", "branch/self-drafts", cwd);
  await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src/a.ts"), "export const value = 1;\n");
  plain(cwd, "add", "src/a.ts"); plain(cwd, "commit", "-qm", "Add A");
  const owner = app.runtime.owner, book = new ContractBook(app.store.sqlite);
  let contract = book.create(owner, { taskRunId: "run-1", sourceSha, worktreePath: folder, sendRepositories: ["acme/widgets"],
    terms: { allowedPaths: ["src/**"], permissions: ["github.pull_request_from_changes", "github.open_pull_request"], expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "A is ready", sideEffects: ["Draft PR"], rollbackPlan: "Close PR" } });
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "fake", parameters: z.object({}).passthrough(), execute: async () => ({}) });
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  const sent = { pushes: [], opens: [] };
  const publication = { store: app.store, owner, files: app.files, registry: app.registry, policy: { assertAllowed: async () => {} },
    preflight: () => null, findPublication: async () => null,
    runTool: async (_name, opening) => { sent.opens.push(opening); return { number: 4 }; },
    git: async ({ cwd: at, args }) => {
      if (args[0] === "ls-remote") return { status: "completed", stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "push") { sent.pushes.push(args.at(-1)); return { status: "completed", stdout: "", stderr: "", exitCode: 0 }; }
      try { return { status: "completed", stdout: plain(at, ...args), stderr: "", exitCode: 0 }; }
      catch (error) { return { status: "failed", stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), exitCode: error.status }; }
    } };
  const requests = { prepared: () => ({ request: { id: requestId }, contract }) };
  const drafts = new SourceRequestDrafts({ source: { store: app.store, owner, workspace }, requests, publication, locked: () => false,
    audit: (_label, work) => work("run-1", new AbortController().signal) });
  publication.authorizePublication = (entry) => drafts.authorize(entry);
  const review = () => ({ revision: contract.revision, contractHash: contractHash(contract), sourceSha,
    head: plain(cwd, "rev-parse", "HEAD").trim(), tree: plain(cwd, "rev-parse", "HEAD^{tree}").trim(),
    branch: "branch/self-drafts", repository: "acme/widgets", base: selfDevelopmentLine, remote: "origin" });
  const ask = (extra = {}) => ({ review: review(), title: "Add A", summary: "A is needed", consent: true, ...extra });
  return { app, drafts, publication, cwd, sent, ask, review, revise: (next) => { contract = next(contract); } };
}

test("SELF-026 the owner here publishes exactly the reviewed commit as a draft pull request", async (t) => {
  const f = await fixture(t);
  const { publication } = await here(() => f.drafts.publish(requestId, f.ask()));
  assert.equal(publication.state, "published");
  assert.deepEqual(f.sent.pushes, [`${f.review().head}:refs/heads/branch/self-drafts`], "the reviewed commit, and nothing else");
  assert.equal(f.sent.opens.length, 1);
  assert.equal(f.sent.opens[0].draft, true, "a draft, never a merge");
  assert.deepEqual([f.sent.opens[0].repo, f.sent.opens[0].title, f.sent.opens[0].base], ["acme/widgets", "Add A", selfDevelopmentLine]);
  assert.deepEqual(publication.files, ["src/a.ts"]);
  assert.deepEqual(publication.review, { requestId, revision: f.review().revision, sourceSha: f.review().sourceSha, tree: f.review().tree });
});

test("SELF-026 no consent, a stale review, uncommitted files, or anyone but the owner here publishes nothing", async (t) => {
  const f = await fixture(t);
  await assert.rejects(here(() => f.drafts.publish(requestId, f.ask({ consent: false }))));
  await assert.rejects(remote(() => f.drafts.publish(requestId, f.ask())), /owner's local window/);
  await assert.rejects(f.drafts.publish(requestId, f.ask()), /owner's local window/, "the engine's own work is not the owner's click");
  await assert.rejects(here(() => underShortLivedKey(() => f.drafts.publish(requestId, f.ask()))), /Only the owner/);
  const stale = f.ask();
  plain(f.cwd, "commit", "--allow-empty", "-qm", "a later change nobody reviewed");
  await assert.rejects(here(() => f.drafts.publish(requestId, stale)), /stale/);
  await writeFile(join(f.cwd, "src/b.ts"), "export const other = 2;\n");
  await assert.rejects(here(() => f.drafts.publish(requestId, f.ask())), /Commit the edits/);
  assert.deepEqual(f.sent, { pushes: [], opens: [] });
});

test("SELF-026 a saved publication is checked again before a retry: a changed contract blocks it", async (t) => {
  const f = await fixture(t);
  f.publication.git = ((git) => async (options, signal) => options.args[0] === "ls-remote"
    ? { status: "failed", stdout: "", stderr: "ECONNREFUSED", exitCode: 1 } : git(options, signal))(f.publication.git);
  const { publication } = await here(() => f.drafts.publish(requestId, f.ask()));
  assert.equal(publication.state, "waiting", "saved while GitHub is out of reach");
  f.revise((contract) => ({ ...contract, revision: contract.revision + 1 }));
  f.app.store.sqlite.prepare("UPDATE self_development_publications SET due=0,data=? WHERE id=?")
    .run(JSON.stringify({ ...publication, nextAttemptAt: 0 }), publication.id);
  const retried = await here(() => sourcePublicationQueue(f.publication).attempt(publication.id, new AbortController().signal));
  assert.equal(retried.state, "blocked");
  assert.deepEqual(f.sent, { pushes: [], opens: [] });
});
