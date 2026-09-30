/**
 * Q12: the first self-development contract needs the owner's own yes, asked every time and never
 * kept, and the question names the paths and tools asked for. Runs the real app and the real
 * `branch.prepare_source_change`, with a stand-in `git` first on PATH so nothing reaches a network.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const sha = "c".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const greedy = { allowedPaths: ["**"], permissions: ["files.write", "shell.execute", "git.push"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone", sideEffects: [], rollbackPlan: "Remove the worktree" };

/**
 * A `git` that answers the few commands preparing a change uses, writes each one down, and never
 * reaches a network. One for the whole file (the app finds `git` once), with the address `origin`
 * names and any upstream kept in files beside it, set per test.
 */
const shared = await mkdtemp(join(tmpdir(), "branch-self-git-"));
after(() => discardTemp(shared));
async function fakeGit(root, origin = "https://github.com/stabrea/Branch-Agent.git") {
  const bin = join(shared, "bin"), log = join(shared, "git.log");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "");
  await writeFile(join(shared, "origin"), `${origin}
`);
  await rm(join(shared, "upstream"), { force: true });
  await writeFile(join(bin, "git"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -c) shift 2;; --no-pager) shift; break;; *) break;; esac; done
echo "$*" >> '${log}'
case "$1" in
  remote) for last; do :; done
    [ "$2" = get-url ] && [ "$last" = origin ] && { cat '${shared}/origin'; exit 0; }
    [ "$2" = get-url ] && [ "$last" = upstream ] && { [ -f '${shared}/upstream' ] && cat '${shared}/upstream' && exit 0; exit 2; }
    [ "$2" = add ] && [ "$3" = upstream ] && { echo "$4" > '${shared}/upstream'; exit 0; }
    [ "$2" = set-url ] && [ "$3" = origin ] && { echo "$4" > '${shared}/origin'; exit 0; }; exit 1;;
  fetch) exit 0;;
  rev-parse) echo ${sha}; exit 0;;
  worktree) [ "$2" = add ] && mkdir -p "$5" && exit 0; exit 1;;
  *) exit 1;;
esac
`);
  await chmod(join(bin, "git"), 0o755);
  if (!process.env.PATH.startsWith(`${bin}${delimiter}`)) process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  return () => readFile(log, "utf8");
}

test("the first contract is made only after the owner's own yes, and that yes is never kept", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-first-"));
  const gitLog = await fakeGit(root);
  let calls = 0;
  const provider = { name: "scripted", async complete() {
    return calls++ === 0 ? { content: "", toolCalls: [{ id: "prepare", name: "branch.prepare_source_change",
      arguments: JSON.stringify({ name: "remove-button", contract: greedy }) }] } : { content: "Ready.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  // The history of what is remembered ships when needed and keeps its own Git repository after each task (the ship-on
  // rule); this is about the Git a source change runs, so the owner switches that history off.
  app.memoryHistory.configure(app.runtime.owner, { mode: "off" });
  app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(),
    execute: async () => ({}) });
  await mkdir(join(workspace, "branch-agent-source"), { recursive: true });
  const book = new ContractBook(app.store.sqlite);
  const ask = (sessionId) => { calls = 0; return app.runtime.run({ prompt: "Remove the button", ...(sessionId ? { sessionId } : {}) }); };

  const paused = await ask();
  assert.equal(paused.status, "needs_input", paused.output);
  const waiting = app.runtime.approvals.questionFor(paused.sessionId);
  assert.equal(waiting.tool, "branch.prepare_source_change");
  assert.equal(waiting.remember, "never", "a yes to a contract is never kept");
  assert.match(waiting.label, /allowed to change \*\*, using files\.write, shell\.execute, git\.push/, "the question names the paths and tools");
  assert.deepEqual(book.history(app.runtime.owner, worktree), [], "no yes, no contract");
  assert.equal(existsSync(join(workspace, worktree)), false, "no yes, no worktree");
  assert.equal(await gitLog(), "", "no yes, no Git at all");

  assert.throws(() => app.runtime.approve(paused.sessionId, "allow", "session"), /once|kept|remember|time/i);
  assert.throws(() => app.runtime.approve(paused.sessionId, "allow", "always"), /once|kept|remember|time/i);
  assert.deepEqual(book.history(app.runtime.owner, worktree), [], "a remembered yes is refused and makes nothing");

  app.runtime.approve(paused.sessionId, "allow", "never");
  const done = await ask(paused.sessionId);
  assert.equal(done.status, "completed", done.output);
  const [first] = book.history(app.runtime.owner, worktree);
  assert.equal(first?.revision, 1);
  assert.equal(first.sourceSha, sha);
  assert.deepEqual(first.allowedPaths, ["**"]);
  assert.deepEqual(first.sendRepositories, ["keepoak/branch-agent"], "where a pull request may go is read from origin once (stabrea is read as KeepOak), and written with the contract");
  assert.match(await gitLog(), /remote set-url origin https:\/\/github\.com\/KeepOak\/Branch-Agent\.git/, "a checkout cloned before the move is pointed at KeepOak");
  assert.match(await gitLog(), /remote get-url --push --all origin/, "the repository origin pushes to, every address of it");
  assert.ok(existsSync(join(workspace, worktree)), "the worktree is made after the contract");
  assert.match(await gitLog(), new RegExp(`worktree add -b branch/self-remove-button .branch-worktrees/self-remove-button ${sha}`));
  const audit = app.store.audit.list(app.runtime.owner, { limit: 50 });
  assert.ok(audit.some((entry) => entry.action === "approval.decided" && /branch\.prepare_source_change/.test(entry.subject) && entry.outcome === "allowed"));
  assert.ok(audit.some((entry) => entry.action === "self_development.contract" && entry.outcome === "written" && /self-remove-button revision 1/.test(entry.subject)));
});

test("a fork's contract names its own origin and the upstream it was made from, and nothing else", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-fork-"));
  await fakeGit(root, "https://github.com/alice/Branch-Agent.git");
  let calls = 0;
  const provider = { name: "scripted", async complete() {
    return calls++ === 0 ? { content: "", toolCalls: [{ id: "prepare", name: "branch.prepare_source_change",
      arguments: JSON.stringify({ name: "remove-button", repository: "https://github.com/alice/Branch-Agent.git", contract: greedy }) }] } : { content: "Ready.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  app.memoryHistory.configure(app.runtime.owner, { mode: "off" });
  app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(),
    execute: async () => ({}) });
  await mkdir(join(workspace, "branch-agent-source"), { recursive: true });
  const ask = (sessionId) => { calls = 0; return app.runtime.run({ prompt: "Remove the button", ...(sessionId ? { sessionId } : {}) }); };
  const paused = await ask();
  app.runtime.approve(paused.sessionId, "allow", "never");
  const done = await ask(paused.sessionId);
  assert.equal(done.status, "completed", done.output);
  const [first] = new ContractBook(app.store.sqlite).history(app.runtime.owner, worktree);
  assert.deepEqual(first.sendRepositories, ["alice/branch-agent", "keepoak/branch-agent"]);
});
