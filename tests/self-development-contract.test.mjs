/**
 * Q12: Branch changing its own source is held to a contract written before the first change.
 *
 *   1. a write inside the contract's allowed paths goes ahead                       (real runtime)
 *   2. a write outside them is refused and written in the audit record              (real runtime)
 *   3. a remote Git step the contract does not list is refused and audited          (real runtime, git double)
 *   4. with no contract, every change in the worktree is refused                    (real runtime)
 *   5. a contract cannot be changed: no update call, the table refuses edits, and a
 *      row changed behind its back fails its hash check (and the guard refuses)
 *   6. widening without the owner's yes changes nothing; with it, a new revision is
 *      written, the old one stays readable, and the widening is audited            (real runtime)
 *   7. a remote step is checked against the source commit and every changed file    (guard with a git double)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { AuditLog } from "../dist/audit.js";
import { exportBackup, importBackup } from "../dist/backup.js";
import { ToolRegistry } from "../dist/registry.js";
import { ContractBook, contractGuard, contractHold, globFits, pullRequestPinned, windowsPlain, workspacePath } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const sha = "b".repeat(40);
const terms = {
  allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone and its test passes", sideEffects: ["none outside the worktree"],
  rollbackPlan: "Remove the worktree and its branch",
};

/** A real Branch whose model makes the given tool calls, one per round, then stops. */
async function realBranch(t, calls) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-contract-"));
  let at = 0;
  const provider = {
    name: "scripted",
    async complete() {
      const call = calls[at++];
      return call ? { content: "", toolCalls: [{ id: `call-${at}`, name: call.name, arguments: JSON.stringify(call.args) }] }
        : { content: "Done.", toolCalls: [] };
    },
  };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const pushed = [];
  // The test double for sending work to GitHub: it only notes that it was reached.
  app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(),
    execute: async (args) => { pushed.push(args); return { pushed: true }; } });
  const owner = app.runtime.owner;
  app.store.projects.save(owner, { id: "branch-agent-remove-button", name: "Branch Agent: remove-button", instructions: "",
    modelPreset: null, repository: "stabrea/Branch-Agent", folder: worktree, profile: null, knowledgeBases: [], branch: "" });
  // The project assigns an existing working copy; production must refuse a missing one.
  await mkdir(join(root, "workspace", worktree), { recursive: true });
  app.store.projects.setActive(owner, { active: "branch-agent-remove-button" });
  const book = new ContractBook(app.store.sqlite);
  return {
    app, owner, book, pushed, workspace: join(root, "workspace"),
    ask: async (sessionId) => {
      at = 0;
      const first = await app.runtime.run({ prompt: "Remove the button", ...(sessionId ? { sessionId } : {}) });
      // selfdev: a push from Branch's own source is put to the owner every time; say yes once, and the model asks again.
      const question = first.status === "needs_input" ? app.runtime.approvals.questionFor(first.sessionId) : null;
      if (!question || question.tool !== "git.push") return first;
      assert.equal(pushed.length, 0, "nothing is pushed before the owner's yes");
      app.runtime.approve(first.sessionId, "allow", "never");
      at -= 1;
      const second = await app.runtime.run({ prompt: "Go on", sessionId: first.sessionId });
      return { ...second, runs: [first.id, second.id] };
    },
    refusals: () => app.store.audit.list(owner, { action: "self_development.contract" }),
  };
}

const failures = (app, run) => (run.runs ?? [run.id]).flatMap((id) => app.store.events(id)).filter((event) => event.kind === "tool.failed").map((event) => event.data.error);

test("a write inside the contract's allowed paths goes ahead", async (t) => {
  const branch = await realBranch(t, [{ name: "files.write", args: { path: "src/ui/button.ts", content: "export {};\n" } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const run = await branch.ask();
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual(failures(branch.app, run), []);
  assert.ok(existsSync(join(branch.workspace, worktree, "src/ui/button.ts")), "the file was written in the worktree");
  assert.deepEqual(branch.refusals(), []);
});

test("a write outside the allowed paths is refused and audited", async (t) => {
  const branch = await realBranch(t, [{ name: "files.write", args: { path: "package.json", content: "{}" } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const run = await branch.ask();
  assert.match(failures(branch.app, run).join("\n"), /self-development contract: package\.json is outside the contract's allowed paths/);
  assert.equal(existsSync(join(branch.workspace, worktree, "package.json")), false, "nothing was written");
  const [entry] = branch.refusals();
  assert.equal(entry?.outcome, "refused");
  assert.match(entry.subject, /files\.write in branch-agent-source\/\.branch-worktrees\/self-remove-button/);
  assert.equal(entry.runId, run.id);
  assert.equal(entry.source, "system", "the refusal is Branch's, not the owner's");
  assert.equal(entry.actor, `task:${run.id}`, "the task that tried it is named");
  assert.equal(entry.origin, "owner", "what started the task is kept apart");
});

test("a refusal in a task something else started names that task and where it came from", async () => {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db), log = new AuditLog(db), registry = new ToolRegistry();
  registry.pathScope = () => worktree;
  registry.register({ name: "files.write", permission: "files.write", description: "double",
    parameters: z.object({ path: z.string(), content: z.string() }), execute: async () => ({}) });
  const guard = contractGuard({ store: { audit: log, get: () => undefined }, owner: "local", workspace: "/w", registry, book, git: async () => answer("") });
  await assert.rejects(guard("files.write", { path: "src/a.ts", content: "x" }, { runId: "run-scheduled", source: "schedule" }), /no contract/);
  const [entry] = log.list("local", { action: "self_development.contract" });
  assert.deepEqual([entry.source, entry.origin, entry.actor, entry.runId], ["system", "schedule", "task:run-scheduled", "run-scheduled"]);
});

test("a remote Git step the contract does not list is refused and audited before Git is reached", async (t) => {
  const branch = await realBranch(t, [{ name: "git.push", args: { remote: "origin" } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const run = await branch.ask();
  assert.match(failures(branch.app, run).join("\n"), /git\.push is not one of the tools this contract allows/);
  assert.deepEqual(branch.pushed, [], "the Git double was never reached");
  assert.match(branch.refusals()[0]?.subject ?? "", /^git\.push in /);
});

test("with no contract, every change in the worktree and the protected checkout is refused", async (t) => {
  const branch = await realBranch(t, [
    { name: "files.write", args: { path: "src/ui/button.ts", content: "x" } },
    { name: "git.push", args: { remote: "origin" } },
  ]);
  const run = await branch.ask();
  const errors = failures(branch.app, run);
  assert.equal(errors.length, 2, errors.join("\n"));
  assert.ok(errors.every((error) => /no contract/.test(error)), errors.join("\n"));
  assert.deepEqual(branch.pushed, []);
  assert.equal(existsSync(join(branch.workspace, worktree, "src/ui/button.ts")), false);
  assert.equal(branch.refusals().length, 2);
  // From the workspace itself, the protected checkout is never written, contract or not.
  const direct = contractGuard({ store: branch.app.store, owner: branch.owner, workspace: branch.workspace,
    registry: branch.app.registry, book: branch.book, git: async () => { throw new Error("not reached"); } });
  branch.app.registry.pathScope = () => "";
  await assert.rejects(direct("files.write", { path: "branch-agent-source/src/main.ts", content: "x" }, { runId: "r" }),
    /protected Branch Agent source checkout is never changed directly/);
});

test("a contract cannot be changed, and a row changed behind its back fails its hash check", async (t) => {
  const branch = await realBranch(t, [{ name: "files.write", args: { path: "src/ui/button.ts", content: "x" } }]);
  const first = branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  assert.equal(typeof branch.book.update, "undefined", "there is no update call");
  assert.throws(() => branch.book.create(branch.owner, { taskRunId: "run-2", sourceSha: sha, worktreePath: worktree,
    terms: { ...terms, allowedPaths: ["**"] } }), /already has a contract/);
  const db = branch.app.store.sqlite;
  assert.throws(() => db.prepare("UPDATE self_development_contracts SET body=?").run("{}"), /cannot be changed/);
  assert.throws(() => db.prepare("DELETE FROM self_development_contracts").run(), /cannot be removed/);
  assert.deepEqual(branch.book.current(branch.owner, worktree), first);
  // Someone with the database file in hand drops the rule and widens the paths by editing the row.
  db.exec("DROP TRIGGER self_development_contracts_no_update");
  const forged = JSON.stringify({ ...first, allowedPaths: ["**"] });
  db.prepare("UPDATE self_development_contracts SET body=? WHERE worktree=?").run(forged, worktree);
  assert.throws(() => branch.book.current(branch.owner, worktree), /does not match its hash/);
  const run = await branch.ask();
  assert.match(failures(branch.app, run).join("\n"), /does not match its hash/);
  assert.equal(branch.refusals()[0]?.outcome, "refused");
});

test("where a pull request may be opened is written with the contract, kept by a widening, and nothing else is accepted", () => {
  const book = new ContractBook(new DatabaseSync(":memory:"));
  assert.throws(() => book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms,
    sendRepositories: ["a/branch-agent", "b/branch-agent", "c/branch-agent"] }), /at most two repositories/);
  assert.throws(() => book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms,
    sendRepositories: ["https://github.com/a/branch-agent"] }), /each as owner\/name/);
  const first = book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms, sendRepositories: ["Alice/Branch-Agent"] });
  assert.deepEqual(first.sendRepositories, ["alice/branch-agent"]);
  const wider = book.widen("local", worktree, { taskRunId: "run-2", terms: { allowedPaths: ["src/**"] }, approvedBy: "local", reason: "more" });
  assert.deepEqual(wider.sendRepositories, ["alice/branch-agent"], "a widening never changes where the change may be proposed");
  const pr = { repo: "alice/Branch-Agent", title: "t", head: "branch/self-fix", base: "redesign/window", draft: true };
  assert.equal(pullRequestPinned(pr, wider.sendRepositories), null);
  assert.match(pullRequestPinned({ ...pr, repo: "stabrea/Branch-Agent" }, wider.sendRepositories) ?? "", /proposed only to alice\/branch-agent/);
  assert.match(pullRequestPinned(pr, undefined) ?? "", /prepared before Branch kept where its changes may go.*Prepare the change again under the same name/,
    "a contract written before the repositories were kept opens no pull request at all");
});

test("a forged extra revision with a wrong hash is caught", () => {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db);
  const first = book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  db.prepare("INSERT INTO self_development_contracts(owner, worktree, revision, body, hash, created_at) VALUES(?,?,?,?,?,?)")
    .run("local", worktree, 2, JSON.stringify({ ...first, revision: 2, allowedPaths: ["**"] }), "0".repeat(64), first.createdAt);
  assert.throws(() => book.history("local", worktree), /revision 2\) does not match its hash/);
});

test("widening needs the owner's yes every time, and then writes a new revision and audits it", async (t) => {
  const branch = await realBranch(t, [{ name: "branch.widen_source_contract",
    args: { name: "remove-button", reason: "The button's test lives under tests/", changes: { allowedPaths: ["src/ui/**", "tests/ui.test.mjs"] } } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const paused = await branch.ask();
  assert.equal(paused.status, "needs_input", paused.output);
  assert.equal(branch.book.history(branch.owner, worktree).length, 1, "nothing is widened before the owner answers");
  // Called straight, past the question (as code inside the app could), the tool finds no yes and refuses.
  const direct = branch.app.runtime.context({ runId: paused.id, source: "owner" });
  await assert.rejects(branch.app.registry.execute("branch.widen_source_contract",
    { name: "remove-button", reason: "no question asked", changes: { allowedPaths: ["**"] } }, direct), /Nobody has said yes to widening this contract/);
  assert.equal(branch.book.history(branch.owner, worktree).length, 1);
  const waiting = branch.app.runtime.approvals.questionFor(paused.sessionId);
  assert.equal(waiting.tool, "branch.widen_source_contract");
  assert.equal(waiting.remember, "never", "a yes to widening is never kept");
  assert.throws(() => branch.app.runtime.approve(paused.sessionId, "allow", "session"), /once|kept|remember|time/i);
  // Answered from a chat app, so the record names where the yes came from, not just the owner.
  branch.app.runtime.approve(paused.sessionId, "allow", "never", undefined, "telegram");
  const done = await branch.ask(paused.sessionId);
  assert.equal(done.status, "completed", done.output);
  const history = branch.book.history(branch.owner, worktree);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0].allowedPaths, ["src/ui/**"], "the old revision stays readable, unchanged");
  assert.deepEqual(history[1].allowedPaths, ["src/ui/**", "tests/ui.test.mjs"]);
  assert.equal(history[1].sourceSha, sha, "widening never moves the source commit");
  assert.equal(history[1].approvedBy, `${branch.owner} (answered on telegram)`, "the one who answered, and where, is recorded");
  const widened = branch.refusals().find((entry) => entry.outcome === "widened");
  assert.match(widened?.subject ?? "", /self-remove-button revision 2/);
  // Asking again is a new question: the yes was used up.
  const again = await branch.ask(paused.sessionId);
  assert.equal(again.status, "needs_input", again.output);
  assert.equal(branch.book.history(branch.owner, worktree).length, 2);
});

/** The guard alone, with a registry of test tools and a Git double that answers as told. */
function guardWith(git, contract = {}, workspace = "/w") {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db);
  const log = new AuditLog(db);
  const registry = new ToolRegistry();
  registry.pathScope = () => worktree;
  registry.register({ name: "github.pull_request_from_changes", permission: "github.manage", description: "double",
    parameters: z.object({ name: z.string() }), execute: async () => ({}) });
  // Stand-ins shaped like the real git tools: each names its folder, and the whole of it when no file is named.
  const inFolder = (args) => [{ kind: "write", path: args.folder, folder: true }];
  for (const name of ["git.push", "git.pull"])
    registry.register({ name, permission: "git.remote", description: "double", targets: inFolder,
      parameters: z.object({ folder: z.string().default("."), remote: z.string().default("origin"), branch: z.string().optional() }), execute: async () => ({}) });
  registry.register({ name: "github.publish_repo", permission: "github.manage", description: "double", targets: inFolder,
    parameters: z.object({ folder: z.string().default("."), name: z.string().default("r"), remote: z.string().default("origin"), branch: z.string().optional() }), execute: async () => ({}) });
  // Like the real git.commit: the repository folder beside the named files, whole only when none are named.
  registry.register({ name: "git.commit", permission: "git.write", description: "double",
    targets: (args) => [{ kind: "write", path: args.folder, ...(args.paths?.length ? {} : { folder: true }) },
      ...(args.paths ?? []).map((path) => ({ kind: "write", path: `${args.folder}/${path}` }))],
    parameters: z.object({ folder: z.string().default("."), message: z.string().default("m"), paths: z.array(z.string()).optional() }), execute: async () => ({}) });
  book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree,
    terms: { ...terms, permissions: ["files.write", "github.pull_request_from_changes", "git.push", "git.pull", "git.commit", "github.publish_repo"], ...contract },
    sendRepositories: ["stabrea/Branch-Agent"] });
  const calls = [];
  const guard = contractGuard({ store: { audit: log, get: () => undefined }, owner: "local", workspace, registry, book,
    git: async (options) => {
      calls.push(options.args.join(" "));
      // Q109: a ref's commit is named here by the ref itself, so the walk below reads the same either way.
      if (options.args[0] === "rev-parse" && options.args[1] === "--verify" && !git.ownRevParse) return answer(options.args.at(-1).replace(/\^\{commit\}$/, ""));
      // Like a real worktree: its own folder at the top, sharing the source checkout's repository.
      if (options.args[0] === "rev-parse" && !git.ownRevParse) return answer(`${options.cwd}\n${join(options.cwd, "..", "..", ".git")}\n`);
      // selfdev: the worktree is on its own branch/… line, the only kind a push from Branch's own source may send.
      if (options.args[0] === "symbolic-ref") return answer("refs/heads/branch/self-remove-button\n");
      // Where origin sends: the repository the worktree was made from, unless a test says otherwise.
      if (options.args[0] === "remote" && options.args[1] === "get-url" && !git.ownRemote) return answer("https://github.com/stabrea/Branch-Agent.git\n");
      return git(options.args);
    } });
  return { guard, calls, log };
}
const answer = (stdout = "", status = "completed") => ({ status, stdout, stderr: "", exitCode: status === "completed" ? 0 : 1, command: "git" });
const pr = { name: "remove-button" };

test("a remote step is checked against the source commit and every changed file", async () => {
  const clean = guardWith((args) => args[0] === "diff" ? answer("src/ui/button.ts\0") : answer(""));
  await clean.guard("github.pull_request_from_changes", pr, { runId: "r", signal: AbortSignal.timeout(1000) });
  assert.ok(clean.calls.includes(`merge-base --is-ancestor ${sha} HEAD`), clean.calls.join("\n"));

  const moved = guardWith((args) => args[0] === "merge-base" ? answer("", "failed") : answer(""));
  await assert.rejects(moved.guard("github.pull_request_from_changes", pr, { runId: "r", signal: AbortSignal.timeout(1000) }),
    /no longer starts from the contract's source commit/);

  const stray = guardWith((args) => args[0] === "ls-files" ? answer("src/ui/ok.ts\0scripts/postinstall.mjs\0") : answer(""));
  await assert.rejects(stray.guard("github.pull_request_from_changes", pr, { runId: "r", signal: AbortSignal.timeout(1000) }),
    /changed files are outside the contract's allowed paths: scripts\/postinstall\.mjs/);
  assert.equal(stray.log.list("local", { action: "self_development.contract" })[0]?.outcome, "refused");
});

test("allowed paths are globs inside the worktree", () => {
  assert.equal(globFits("src/ui/**", "src/ui/a/b.ts"), true);
  assert.equal(globFits("src/ui/*.ts", "src/ui/a/b.ts"), false);
  assert.equal(globFits("src/**/button.ts", "src/button.ts"), true);
  assert.equal(globFits("tests/", "tests/x.test.mjs"), true);
  assert.equal(globFits("src/ui/**", "src/uix/a.ts"), false);
  assert.equal(globFits("src/ui.ts", "src/uiXts"), false);
});

test("a command started from the workspace with its folder inside a worktree is held to that worktree's contract", async () => {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db), log = new AuditLog(db), registry = new ToolRegistry();
  registry.pathScope = () => "";
  registry.register({ name: "shell.execute", permission: "shell.execute", description: "double",
    parameters: z.object({ command: z.string(), cwd: z.string().optional() }), execute: async () => ({}) });
  const guard = contractGuard({ store: { audit: log, get: () => undefined }, owner: "local", workspace: "/w", registry, book, git: async () => answer("") });
  await guard("shell.execute", { command: "ls" }, { runId: "r" });
  await assert.rejects(guard("shell.execute", { command: "npm version patch", cwd: worktree }, { runId: "r" }), /no contract/);
  book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  await assert.rejects(guard("shell.execute", { command: "npm version patch", cwd: worktree }, { runId: "r" }),
    /shell\.execute is not one of the tools this contract allows/);
  assert.equal(log.list("local", { action: "self_development.contract" }).length, 2);
});

test("a backup keeps every contract revision, and a restore brings them back with hashes that still verify", async (t) => {
  const from = await realBranch(t, []);
  from.book.create(from.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  from.book.widen(from.owner, worktree, { taskRunId: "run-2", terms: { allowedPaths: ["src/ui/**", "tests/ui.test.mjs"] }, approvedBy: from.owner, reason: "tests" });
  const archive = JSON.parse(JSON.stringify(exportBackup(from.app.store.sqlite, "test")));
  assert.equal(archive.tables.self_development_contracts.length, 2);

  const into = await realBranch(t, []);
  importBackup(into.app.store.sqlite, archive, { replaceExisting: true });
  const restored = into.book.history(into.owner, worktree);
  assert.deepEqual(restored, from.book.history(from.owner, worktree), "every revision, each checked against its hash");
  // Restoring over an install that already has them neither removes nor duplicates a revision.
  importBackup(into.app.store.sqlite, archive, { replaceExisting: true });
  assert.equal(into.book.history(into.owner, worktree).length, 2);
  // A backup made before contracts existed still restores.
  const { self_development_contracts: _gone, ...older } = archive.tables;
  importBackup(into.app.store.sqlite, { ...archive, tables: older }, { replaceExisting: true });
  assert.equal(into.book.history(into.owner, worktree).length, 2);
});

test("every spelling of the source folder is held to the contract or refused, and the real path still works", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-spelling-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  await mkdir(join(workspace, "proj"), { recursive: true });
  await symlink(join(workspace, "branch-agent-source"), join(workspace, "link"));
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db), log = new AuditLog(db), registry = new ToolRegistry();
  let scope = "";
  registry.pathScope = () => scope;
  registry.register({ name: "files.write", permission: "files.write", description: "double",
    parameters: z.object({ path: z.string(), content: z.string() }), execute: async () => ({}) });
  registry.register({ name: "shell.execute", permission: "shell.execute", description: "double",
    parameters: z.object({ command: z.string(), cwd: z.string().optional() }), execute: async () => ({}) });
  book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const guard = contractGuard({ store: { audit: log, get: () => undefined }, owner: "local", workspace, registry, book, git: async () => answer("") });
  const write = (path) => guard("files.write", { path, content: "x" }, { runId: "r" });
  await write(`${worktree}/src/ui/button.ts`);
  // Where the disk ignores case this is the same folder, read back in its true spelling and held to the
  // same contract; where it does not, it is some other folder inside the protected checkout: refused.
  const foldsCase = existsSync(join(workspace, "BRANCH-AGENT-SOURCE"));
  const shouted = write("BRANCH-AGENT-SOURCE/.Branch-Worktrees/SELF-REMOVE-BUTTON/src/ui/button.ts");
  if (foldsCase) await shouted; else await assert.rejects(shouted, /protected Branch Agent source checkout/);
  // A whole absolute path in capitals is this workspace only where the disk ignores case.
  if (foldsCase) await assert.rejects(write(join(workspace.toUpperCase(), "BRANCH-AGENT-SOURCE", "src", "main.ts")), /protected Branch Agent source checkout/);
  for (const [path, why] of [
    ["Branch-Agent-Source/src/main.ts", /protected Branch Agent source checkout/],
    ["BRANCH-AGENT-SOURCE/.branch-worktrees/self-remove-button/package.json", /package\.json is outside the contract's allowed paths/],
    // Where the disk ignores case this is src/NEW, elsewhere SRC/NEW: outside src/ui/** either way.
    [`${worktree}/SRC/NEW/button.ts`, /NEW\/button\.ts is outside the contract's allowed paths/],
    ["branch-agent-source./src/main.ts", /protected Branch Agent source checkout/],
    ["branch-agent-source /src/main.ts", /protected Branch Agent source checkout/],
    ["link/.branch-worktrees/self-remove-button/package.json", /package\.json is outside the contract's allowed paths/],
    ["link/src/main.ts", /protected Branch Agent source checkout/],
    ["proj/../branch-agent-source/src/main.ts", /protected Branch Agent source checkout/],
    ["branch-agent-source/.branch-worktrees/self-other/src/ui/a.ts", /no contract/],
  ]) await assert.rejects(write(path), why, path);
  scope = "proj";
  // A command's folder is read from the workspace, not the active project, exactly as the shell tool reads it.
  await assert.rejects(guard("shell.execute", { command: "npm version patch", cwd: "Branch-Agent-Source" }, { runId: "r" }),
    /Refused by the self-development contract/, "a folder named from the workspace while another project is active");
  assert.equal(log.list("local", { action: "self_development.contract" }).length, 11);
  // Before the folder exists on disk the spelling alone must be enough (the first write can make it).
  const bare = contractGuard({ store: { audit: log, get: () => undefined }, owner: "local", workspace: join(root, "empty"), registry, book, git: async () => answer("") });
  scope = "";
  for (const path of ["Branch-Agent-Source/src/main.ts", "BRANCH-AGENT-SOURCE/.branch-worktrees/self-remove-button/package.json"])
    await assert.rejects(bare("files.write", { path, content: "x" }, { runId: "r" }), /self-development contract/, path);
  // Only the source folder's own name is folded. A worktree folder or name in another case is not a
  // worktree until the disk says it is the same folder, so it is refused as the protected checkout.
  for (const path of ["branch-agent-source/.Branch-Worktrees/self-remove-button/src/ui/a.ts",
    "branch-agent-source/.branch-worktrees/SELF-REMOVE-BUTTON/src/ui/a.ts", "Branch-Agent-Source/.branch-worktrees./self-remove-button/src/ui/a.ts"])
    await assert.rejects(bare("files.write", { path, content: "x" }, { runId: "r" }), /protected Branch Agent source checkout/, path);
});

const signal = () => AbortSignal.timeout(1000);

test("a tool that works on a whole folder needs the allowed paths to cover all of it", async () => {
  // Legion's repro: git.pull on the worktree could bring in scripts/evil.mjs under a src/ui/** contract.
  const narrow = guardWith(() => answer(""));
  await assert.rejects(narrow.guard("git.pull", { folder: "." }, { runId: "r", signal: signal() }),
    /git\.pull works on the whole of the worktree, and the contract's allowed paths do not cover all of it/);
  // Below the worktree's root Git is refused outright (a nested repository's settings could start a program).
  for (const folder of ["src", "src/ui"])
    await assert.rejects(narrow.guard("git.pull", { folder }, { runId: "r", signal: signal() }), /Git runs in Branch's own source only at a self-development worktree's root/);
  assert.equal(narrow.calls.length, 0, "refused before Git is asked anything");
  const wide = guardWith(() => answer(""), { allowedPaths: ["**"] });
  await wide.guard("git.pull", { folder: "." }, { runId: "r", signal: signal() });
});

test("a push goes only to the repository origin pushed to when the worktree was made, whatever the remote says now", async () => {
  const sendsTo = (stdout, status = "completed") => Object.assign((args) => (args[0] === "remote" ? answer(stdout, status) : answer("")), { ownRemote: true });
  const push = (git, remote = "origin") => guardWith(git).guard("git.push", { folder: ".", remote }, { runId: "r", signal: signal() });
  await push(sendsTo("git@github.com:STABREA/Branch-Agent.git\n"));
  await assert.rejects(push(sendsTo("https://github.com/mallory/Branch-Agent.git\n")),
    /sent only to stabrea\/branch-agent, where this worktree was made from, and origin sends to mallory\/branch-agent, so nothing is sent/);
  await assert.rejects(push(sendsTo("https://github.com/stabrea/Branch-Agent.git\nhttps://github.com/mallory/Branch-Agent.git\n")),
    /and origin sends to stabrea\/branch-agent, mallory\/branch-agent, so nothing is sent/, "every push address counts");
  await assert.rejects(push(sendsTo("https://gitlab.com/stabrea/Branch-Agent.git\n")), /origin: The remote is not on GitHub\. So nothing is sent/);
  await assert.rejects(push(sendsTo("", "failed"), "fork"), /fork is not a remote of this worktree, so nothing is sent/);
});

test("a push is walked commit by commit, both sides of each change, for the branch actually sent", async () => {
  const walk = (lines) => guardWith((args) => (args[0] === "log" ? answer(lines) : answer("")));
  const addedAndRemoved = walk("A\t.github/workflows/x.yml\n\nD\t.github/workflows/x.yml\n");
  await assert.rejects(addedAndRemoved.guard("git.push", { folder: "." }, { runId: "r", signal: signal() }),
    /outside the contract's allowed paths: \.github\/workflows\/x\.yml/);
  assert.ok(addedAndRemoved.calls.includes(`log --no-renames -m --name-status --format= ${sha}..refs/heads/branch/self-remove-button`), addedAndRemoved.calls.join("\n"));
  const moved = walk("D\tscripts/a.mjs\nA\tsrc/ui/p.mjs\n");
  await assert.rejects(moved.guard("git.push", { folder: "." }, { runId: "r", signal: signal() }), /allowed paths: scripts\/a\.mjs/);
  // The branch pushed is the one walked, not whatever is checked out.
  const side = guardWith((args) => (args[0] === "log" && args.at(-1) === `${sha}..refs/heads/branch/side` ? answer("A\tscripts/evil.mjs\n") : answer("")));
  await side.guard("git.push", { folder: "." }, { runId: "r", signal: signal() });
  await assert.rejects(side.guard("git.push", { folder: ".", branch: "branch/side" }, { runId: "r", signal: signal() }), /scripts\/evil\.mjs/);
  assert.ok(side.calls.includes(`merge-base --is-ancestor ${sha} refs/heads/branch/side`));
  // Q98: publishing sends the branch it names too, so that is the one walked. It works on the whole worktree,
  // so its contract allows everything; an owner's branch that does not start from the source commit is refused.
  // selfdev: publishing Branch's own source as a repository of its own is refused outright, before Git is asked.
  const orphan = guardWith((args) => (args[0] === "merge-base" && args.at(-1) === "refs/heads/branch/owner-orphan" ? answer("", "failed") : answer("")), { allowedPaths: ["**"] });
  await assert.rejects(orphan.guard("github.publish_repo", { folder: "." }, { runId: "r", signal: signal() }), /never published as a repository/);
  assert.equal(orphan.calls.length, 0);
  await assert.rejects(orphan.guard("git.push", { folder: ".", branch: "branch/owner-orphan" }, { runId: "r", signal: signal() }),
    /refs\/heads\/branch\/owner-orphan no longer starts from the contract's source commit/);
  // Q98: the branch is walked as refs/heads/<name>, never as a bare name Git could read as one of its own files
  // (ORIG_HEAD, worktrees/<id>/HEAD, main-worktree/HEAD), so the walk and the push pick the same commit.
  // selfdev: and only a branch/… line is ever sent, so none of these is walked at all.
  const full = guardWith(() => answer(""), { allowedPaths: ["**"] });
  for (const branch of ["ORIG_HEAD", "worktrees/self-x/HEAD", "main-worktree/HEAD", "worktrees/self-x/ORIG_HEAD", "refs/heads/side", "main", "redesign/window"])
    await assert.rejects(full.guard("git.push", { folder: ".", branch, confirmed: true }, { runId: "r", signal: signal() }), /is not a branch\/… line of work/, branch);
  assert.ok(!full.calls.some((call) => call.startsWith("merge-base")), full.calls.join("\n"));
  for (const branch of ["branch/side", "refs/heads/branch/side"]) {
    await full.guard("git.push", { folder: ".", branch }, { runId: "r", signal: signal() });
    assert.ok(full.calls.includes(`merge-base --is-ancestor ${sha} refs/heads/branch/side`), `${branch}: ${full.calls.at(-3)}`);
  }
  await full.guard("git.push", { folder: ".", branch: "HEAD" }, { runId: "r", signal: signal() });
  assert.ok(full.calls.includes(`merge-base --is-ancestor ${sha} refs/heads/branch/self-remove-button`), "HEAD itself is the checked-out branch");
  const clean = walk("M\tsrc/ui/button.ts\n");
  await clean.guard("git.push", { folder: ".", branch: "branch/side" }, { runId: "r", signal: signal() });
});

test("the owner's question shows every broad glob first and says how many narrow ones it left out", () => {
  const narrow = Array.from({ length: 49 }, (_, index) => `src/area${index}/**`);
  const tools = Array.from({ length: 40 }, (_, index) => `tool.number${index}`);
  for (const [tool, args] of [["branch.prepare_source_change", { contract: { allowedPaths: [...narrow, "**"], permissions: tools } }],
    ["branch.widen_source_contract", { changes: { allowedPaths: [...narrow, "*.ts", "**"], permissions: tools } }]]) {
    const { reason } = contractHold(tool, args);
    if (tool === "branch.prepare_source_change") assert.match(reason, /allowed to change \*\*, src\/area0\//, `${tool}: the bare ** comes first`);
    else assert.match(reason, /allowed to change \*\.ts, \*\*, src\/area0\//, `${tool}: every broad glob comes first`);
    assert.match(reason, /and \d+ more, using /, `${tool}: the cut path list says how many are left out`);
    assert.match(reason, /tool\.number0, .* and \d+ more\.$/, `${tool}: so does the tool list`);
  }
  assert.match(contractHold("branch.prepare_source_change", { contract: { allowedPaths: ["src/ui/**"], permissions: ["files.write"] } }).reason,
    /allowed to change src\/ui\/\*\*, using files\.write\.$/, "a short list is shown whole");
});

test("Windows spellings of the source folder go through the path normaliser, on any computer", () => {
  assert.equal(windowsPlain("\\\\?\\C:\\ws\\x"), "C:\\ws\\x");
  assert.equal(windowsPlain("\\\\.\\C:\\ws\\x"), "C:\\ws\\x");
  assert.equal(windowsPlain("\\\\localhost\\C$\\ws\\x"), "C:\\ws\\x");
  assert.equal(windowsPlain("\\\\?\\UNC\\127.0.0.1\\c$\\ws\\x"), "c:\\ws\\x");
  const ws = "C:\\Users\\o\\work";
  for (const path of [
    "\\\\?\\C:\\Users\\o\\work\\branch-agent-source\\src\\main.ts",
    "\\\\localhost\\C$\\Users\\o\\work\\branch-agent-source\\src\\main.ts",
    "\\\\?\\UNC\\localhost\\C$\\Users\\o\\work\\Branch-Agent-Source\\src\\main.ts",
    "C:\\USERS\\O\\WORK\\BRANCH-AGENT-SOURCE\\src\\main.ts",
    "\\\\.\\C:\\Users\\o\\work\\branch-agent-source.\\src\\main.ts",
    "C:\\Users\\o\\work\\branch-agent-source \\src\\main.ts",
    "Branch-Agent-Source\\src\\main.ts",
  ]) assert.equal(workspacePath(ws, "", path, "win32"), "branch-agent-source/src/main.ts", path);
  assert.equal(workspacePath(ws, "", "\\\\server\\share\\branch-agent-source\\x", "win32"), null, "another computer's share is not this workspace");
});

test("worktree A's contract never judges a write into worktree B", async () => {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db), log = new AuditLog(db), registry = new ToolRegistry();
  registry.pathScope = () => worktree;
  registry.register({ name: "files.write", permission: "files.write", description: "double",
    parameters: z.object({ path: z.string(), content: z.string() }), execute: async () => ({}) });
  book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const guard = contractGuard({ store: { audit: log, get: () => undefined }, owner: "local", workspace: "/w", registry, book, git: async () => answer("") });
  const other = "/w/branch-agent-source/.branch-worktrees/self-other/src/ui/a.ts";
  await assert.rejects(guard("files.write", { path: other, content: "x" }, { runId: "r" }),
    /branch-agent-source\/\.branch-worktrees\/self-other\/src\/ui\/a\.ts is outside the contract's worktree/);
  await guard("files.write", { path: "src/ui/a.ts", content: "x" }, { runId: "r" });
});

test("a valid row copied under another worktree, or out of its revision order, is rejected", () => {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db);
  const first = book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const [row] = db.prepare("SELECT body, hash, created_at FROM self_development_contracts").all();
  const other = "branch-agent-source/.branch-worktrees/self-other";
  db.prepare("INSERT INTO self_development_contracts(owner, worktree, revision, body, hash, created_at) VALUES(?,?,?,?,?,?)")
    .run("local", other, 1, row.body, row.hash, row.created_at);
  assert.throws(() => book.history("local", other), /does not match its hash/, "a row that names another worktree");
  db.prepare("INSERT INTO self_development_contracts(owner, worktree, revision, body, hash, created_at) VALUES(?,?,?,?,?,?)")
    .run("local", worktree, 2, row.body, row.hash, row.created_at);
  assert.throws(() => book.history("local", worktree), /revision 2\) does not match its hash/, "revision 1's body stored as revision 2");
  assert.equal(first.revision, 1);
});

test("git.commit of named files is judged by those files; with none named it commits the whole worktree", async (t) => {
  // A real workspace, so the worktree folder is on disk: naming it beside the files must not make the commit whole-folder.
  const root = await mkdtemp(join(tmpdir(), "branch-self-commit-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, worktree, "src", "ui"), { recursive: true });
  const guard = guardWith(() => answer(""), {}, root);
  await guard.guard("git.commit", { folder: ".", paths: ["src/ui/button.ts"] }, { runId: "r", signal: signal() });
  await assert.rejects(guard.guard("git.commit", { folder: ".", paths: ["package.json"] }, { runId: "r", signal: signal() }),
    /package\.json is outside the contract's allowed paths/);
  await assert.rejects(guard.guard("git.commit", { folder: "." }, { runId: "r", signal: signal() }), /git\.commit works on the whole of the worktree/);
});

test("a push is refused below the worktree's root, and from any repository that is not the worktree's own", async () => {
  const nested = guardWith(() => answer(""));
  await assert.rejects(nested.guard("git.push", { folder: "src/ui/nested" }, { runId: "r", signal: signal() }),
    /Git runs in Branch's own source only at a self-development worktree's root/);
  assert.equal(nested.calls.length, 0, "refused before Git is asked anything");
  const planted = (args) => (args[0] === "rev-parse" ? answer("/w/elsewhere\n/w/elsewhere/.git\n") : answer(""));
  planted.ownRevParse = true;
  const other = guardWith(planted);
  await assert.rejects(other.guard("git.push", { folder: "." }, { runId: "r", signal: signal() }), /is not the worktree's own/);
  assert.ok(!other.calls.some((call) => call.startsWith("log")), "nothing is walked in the wrong repository");
});
