import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { offerSelfDevelopment, prepareBranchSourceChange } from "../dist/self-development.js";
import { ToolRegistry } from "../dist/registry.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const sha = "a".repeat(40);
const terms = { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone", sideEffects: [], rollbackPlan: "Delete the worktree" };

const completed = (stdout = "") => ({ status: "completed", stdout, stderr: "", exitCode: 0, command: "git" });

test("a worktree whose contract predates pinned destinations is pinned when prepared again under the same name", async () => {
  const folder = "branch-agent-source/.branch-worktrees/self-remove-button";
  const contracts = new ContractBook(new DatabaseSync(":memory:"));
  const old = contracts.create("local", { taskRunId: "run-0", sourceSha: sha, worktreePath: folder, terms });
  assert.equal(old.sendRepositories, undefined, "written before Branch kept where changes may go");
  const records = [], calls = [];
  const deps = {
    workspace: "C:/owner/workspace", owner: "local", contracts,
    projects: { save: (_owner, project) => project, setActive: (_owner, input) => input },
    registry: {}, policy: { assertAllowed: async () => undefined },
    store: { audit: { record: (_owner, entry) => { records.push(entry); } } },
    exists: async () => true, // the source checkout and this change's worktree are both already there
    git: async ({ args }) => {
      calls.push(args.join(" "));
      if (args.join(" ").startsWith("remote get-url")) return completed("https://github.com/stabrea/Branch-Agent.git\n");
      return completed(args[0] === "rev-parse" ? `${sha}\n` : "");
    },
  };
  const input = { name: "remove-button", repository: "https://github.com/stabrea/Branch-Agent.git", base: "redesign/window", contract: terms };
  const again = await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));
  assert.equal(again.contract.revision, 2, "pinned as the next revision; the first stays as written");
  assert.deepEqual(again.contract.sendRepositories, ["keepoak/branch-agent"], "read from origin now, by the same rules as a new worktree (stabrea is read as KeepOak)");
  assert.ok(calls.includes("remote set-url origin https://github.com/KeepOak/Branch-Agent.git"), "a checkout cloned before the move is pointed at KeepOak");
  assert.deepEqual(again.contract.allowedPaths, terms.allowedPaths, "and nothing else changes");
  assert.equal(again.contract.sourceSha, sha);
  assert.deepEqual(contracts.history("local", folder).map((each) => each.revision), [1, 2]);
  assert.ok(calls.includes("remote get-url --push --all origin"));
  assert.ok(!calls.some((call) => call.startsWith("worktree add")), "the existing worktree is kept, under its own name");
  assert.ok(records.some((entry) => entry.outcome === "pinned" && /self-remove-button revision 2/.test(entry.subject)));
  const third = await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));
  assert.equal(third.contract.revision, 2, "a contract that already names them is never changed");
  assert.throws(() => contracts.pin("local", folder, { taskRunId: "r", sendRepositories: ["mallory/branch-agent"], approvedBy: "local" }),
    /already names where its changes may go/);
});

test("an owner's fork becomes an isolated Branch Agent project without touching the installed app", async () => {
  let source = false, copy = false, upstream = false, pendingAtClone = false;
  const records = [];
  const calls = [], saved = [], active = [], sites = [];
  const deps = {
    workspace: "C:/owner/workspace", owner: "local",
    projects: { save: (_owner, project) => { saved.push(project); return project; }, setActive: (_owner, input) => { active.push(input); return input; } },
    registry: {}, policy: { assertAllowed: async (url) => { sites.push(url.href); } },
    contracts: new ContractBook(new DatabaseSync(":memory:")), store: { audit: { record: (_owner, entry) => { records.push(entry); } } },
    exists: async (path) => path.endsWith("branch-agent-source") ? source : path.includes(".branch-worktrees") ? copy : false,
    git: async ({ cwd, args }) => {
      calls.push([cwd, ...args]);
      if (args[0] === "clone") { source = true; pendingAtClone = records.some((entry) => entry.outcome === "pending"); return completed(); }
      if (["remote get-url origin", "remote get-url --push --all origin"].includes(args.join(" "))) return completed("https://github.com/alice/Branch-Agent.git\n");
      if (args.join(" ") === "remote get-url upstream") return upstream ? completed("https://github.com/stabrea/Branch-Agent.git\n") : { ...completed(), status: "failed", stderr: "missing" };
      if (args.join(" ").startsWith("remote add upstream")) { upstream = true; return completed(); }
      if (args[0] === "worktree") { copy = true; return completed(); }
      if (args[0] === "rev-parse") return completed(`${sha}\n`);
      return completed();
    },
  };
  const input = { name: "remove-button", repository: "https://github.com/alice/Branch-Agent.git", base: "redesign/window", contract: terms };
  const result = await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));

  assert.equal(result.ready, true);
  assert.equal(result.pullRequestTarget, "KeepOak/Branch-Agent");
  assert.match(result.instructions, /Run node scripts\/review\.mjs with the focused test files/);
  assert.match(result.instructions, /never send to a shared line or change a repository.s settings or branch protection/);
  assert.match(result.instructions, /pending is never passed; when one fails, read why with github\.check_logs[^)]*\), then call branch\.finish_source_change/);
  assert.ok(calls.some((call) => call.includes("clone")), "the owner's fork is cloned into the workspace, not the installation");
  assert.ok(calls.some((call) => call.join(" ").includes("remote add upstream https://github.com/KeepOak/Branch-Agent.git")));
  assert.ok(calls.some((call) => call.join(" ").includes("fetch upstream redesign/window")));
  assert.ok(calls.some((call) => call.join(" ").includes(`worktree add -b branch/self-remove-button .branch-worktrees/self-remove-button ${sha}`)),
    "the worktree is made at the exact commit the contract names");
  assert.ok(calls.some((call) => call.join(" ").includes("rev-parse --verify upstream/redesign/window^{commit}")));
  assert.equal(result.contract.sourceSha, sha);
  assert.deepEqual(result.contract.sendRepositories, ["alice/branch-agent", "keepoak/branch-agent"], "a fork proposes to itself or to the upstream it was made from, nothing else");
  assert.equal(pendingAtClone, true, "the proposed contract was written down as pending before anything was cloned");
  assert.match(records.find((entry) => entry.outcome === "pending").reason, /From alice\/Branch-Agent at redesign\/window\. Paths src\/ui\/\*\*/);
  assert.equal(result.contract.worktreePath, "branch-agent-source/.branch-worktrees/self-remove-button");
  const contractAt = calls.findIndex((call) => call.includes("rev-parse")), worktreeAt = calls.findIndex((call) => call[1] === "worktree");
  assert.ok(contractAt >= 0 && contractAt < worktreeAt, "the contract is written before the worktree is made");
  assert.match(saved[0].folder, /^branch-agent-source\/\.branch-worktrees\//);
  assert.match(saved[0].instructions, /Why merge this/);
  assert.deepEqual(active, [{ active: "branch-agent-remove-button" }]);
  assert.ok(sites.every((site) => site.startsWith("https://github.com/")));

  const before = calls.length;
  await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));
  await assert.rejects(prepareBranchSourceChange(deps, { ...input, contract: { ...terms, allowedPaths: ["**"] } }, AbortSignal.timeout(1000)),
    /already has a contract \(revision 1\)\. Different terms need branch\.widen_source_contract/, "wider terms are never silently reused");
  assert.equal(calls.slice(before).some((call) => call.includes("clone") || call.includes("worktree")), false,
    "retrying reuses the protected source and isolated copy");
});

test("the special workflow refuses a repository that is not Branch-Agent", async () => {
  const deps = { workspace: "C:/owner/workspace", owner: "local", projects: {}, registry: {}, policy: {}, git: async () => completed() };
  await assert.rejects(
    prepareBranchSourceChange(deps, { name: "x", repository: "https://github.com/alice/unrelated.git", base: "main", contract: terms }, AbortSignal.timeout(1000)),
    /official Branch-Agent repository or your own GitHub fork/,
  );
});

test("the self-development tool appears only while remote Git is enabled", () => {
  const registry = new ToolRegistry();
  const stop = offerSelfDevelopment({ workspace: "C:/owner/workspace", owner: "local", projects: {}, registry,
    policy: {}, git: async () => completed() });
  assert.equal(registry.names().includes("branch.prepare_source_change"), false);
  registry.register({ name: "git.push", permission: "git.remote", description: "test", parameters: z.object({}), execute: async () => ({}) });
  assert.equal(registry.names().includes("branch.prepare_source_change"), true);
  assert.equal(registry.names().includes("branch.widen_source_contract"), true);
  assert.equal(registry.targetOf("branch.prepare_source_change", { name: "remove-button" }, {}),
    join("C:/owner/workspace", "branch-agent-source", ".branch-worktrees", "self-remove-button"));
  registry.unregister("git.push");
  assert.equal(registry.names().includes("branch.prepare_source_change"), false);
  assert.equal(registry.names().includes("branch.widen_source_contract"), false);
  stop();
});

test("Q187: a helper whose own context says owner, but whose task came from a chat, cannot prepare a source change", async () => {
  const registry = new ToolRegistry();
  const records = { chat: [{ kind: "run.started", data: { source: "channel" } }], mine: [{ kind: "run.started", data: { source: "owner" } }],
    // NAS c7bbf84: a household person's task, which records source "owner" too.
    sam: [{ kind: "run.started", data: { source: "owner", personProfileId: "sam" } }],
    // NAS c0c7ca1: records a key started, by its flag or only by its id.
    keyFlag: [{ kind: "run.started", data: { source: "owner", shortLivedKey: true } }],
    keyId: [{ kind: "run.started", data: { source: "owner", shortLivedKeyId: "k1" } }] };
  let owner = true;
  const store = { events: (runId) => records[runId] ?? [], run: () => undefined, get: () => undefined, profiles: { isOwner: () => owner } };
  const stop = offerSelfDevelopment({ workspace: "C:/owner/workspace", owner: "local", projects: {}, registry,
    policy: {}, git: async () => completed(), store, contracts: { current: () => null } });
  registry.register({ name: "git.push", permission: "git.remote", description: "test", parameters: z.object({}), execute: async () => ({}) });
  const input = { name: "x", repository: "https://github.com/alice/unrelated.git", base: "redesign/window", contract: terms };
  const call = (runId) => registry.execute("branch.prepare_source_change", input,
    { source: "owner", runId, owner: "local", permissions: new Set(["git.remote"]), signal: AbortSignal.timeout(1000), budget: { step: () => undefined, charge: () => undefined } });
  await assert.rejects(call("chat"), /Only the owner in the Branch app/, "the record leads back to a chat");
  await assert.rejects(call("sam"), /Only the owner in the Branch app/, "a household person's task");
  await assert.rejects(call("keyFlag"), /Only the owner in the Branch app/, "a key's task, by its flag");
  await assert.rejects(call("keyId"), /Only the owner in the Branch app/, "a key's task, by its id alone");
  // The widening tool asks the same way.
  await assert.rejects(registry.execute("branch.widen_source_contract", { name: "x", reason: "wider", changes: { allowedPaths: ["docs/**"] } },
    { source: "owner", runId: "chat", owner: "local", permissions: new Set(["git.remote"]), signal: AbortSignal.timeout(1000), budget: { step: () => undefined, charge: () => undefined } }),
    /Only the owner in the Branch app/, "widening a contract from a chat's task");
  // NAS 9993ab7: a Trunk's turn records the owner's source, so its context is what tells it apart.
  const trunkCall = (name, args, extra) => registry.execute(name, args, { source: "owner", runId: "mine", owner: "local", permissions: new Set(["git.remote"]),
    signal: AbortSignal.timeout(1000), budget: { step: () => undefined, charge: () => undefined }, ...extra });
  for (const extra of [{ trunk: "helper" }, { trunkKeys: { copyFromOwner: false, accounts: {} } }]) {
    await assert.rejects(trunkCall("branch.prepare_source_change", input, extra), /Only the owner in the Branch app/, `a Trunk's turn (${Object.keys(extra)[0]})`);
    await assert.rejects(trunkCall("branch.widen_source_contract", { name: "x", reason: "wider", changes: { allowedPaths: ["docs/**"] } }, extra),
      /Only the owner in the Branch app/, `widening from a Trunk's turn (${Object.keys(extra)[0]})`);
  }
  owner = false;
  await assert.rejects(call("mine"), /Only the owner in the Branch app/, "a window switched to a household profile");
  owner = true;
  await assert.rejects(call("mine"), (error) => !/Only the owner in the Branch app/.test(error.message), "control: the owner's own task gets past the check");
  stop();
});

test("selfdev: a checkout a cut clone left (no commit behind HEAD, no worktree) is cloned again; any other stays", async () => {
  const run = async (headAnswer) => {
    const calls = [];
    let cloned = false, removed = false; // removal is real (the folder is not there), so it is marked where it is decided
    const deps = {
      workspace: "C:/owner/workspace-that-is-not-there", owner: "local", contracts: new ContractBook(new DatabaseSync(":memory:")),
      projects: { save: (_owner, project) => project, setActive: (_owner, input) => input },
      registry: {}, policy: { assertAllowed: async () => undefined }, store: { audit: { record: () => undefined } },
      exists: async (path) => path.endsWith("branch-agent-source") ? !removed || cloned : path.endsWith(".branch-worktrees") ? false : cloned,
      git: async ({ args }) => {
        calls.push(args.join(" "));
        if (args[0] === "clone") { cloned = true; return completed(); }
        if (args.join(" ") === "rev-parse --verify --quiet HEAD^{commit}") return headAnswer;
        if (args.join(" ") === "rev-parse --is-inside-work-tree") { removed = true; return completed("true\n"); }
        if (args.join(" ").startsWith("remote get-url")) return completed("https://github.com/stabrea/Branch-Agent.git\n");
        return completed(args[0] === "rev-parse" ? `${sha}\n` : "");
      },
    };
    await prepareBranchSourceChange(deps, { name: "fix", repository: "https://github.com/stabrea/Branch-Agent.git", base: "redesign/window", contract: terms },
      AbortSignal.timeout(1000));
    return calls;
  };
  const unborn = await run({ status: "failed", stdout: "", stderr: "", exitCode: 1, command: "git" });
  assert.ok(unborn.some((call) => call.startsWith("clone ")), "cloned again");
  const whole = await run(completed(`${sha}\n`));
  assert.ok(!whole.some((call) => call.startsWith("clone ")), "a real checkout is kept");
  const unknown = await run({ status: "timed_out", stdout: "", stderr: "", exitCode: null, command: "git" });
  assert.ok(!unknown.some((call) => call.startsWith("clone ")), "an answer that is not 'no commit' keeps it too");
});

test("selfdev: only the task chain that wrote a worktree's contract counts as having prepared it", async () => {
  const { preparedByTask } = await import("../dist/self-development-contract.js");
  const book = new ContractBook(new DatabaseSync(":memory:"));
  const folder = "branch-agent-source/.branch-worktrees/self-fix";
  book.create("local", { taskRunId: "lead", sourceSha: sha, worktreePath: folder, terms, sendRepositories: ["stabrea/branch-agent"] });
  const parents = { helper: "lead", grandchild: "helper", other: null };
  const store = { events: (id) => [{ kind: "run.started", data: { parentRunId: parents[id] ?? null } }] };
  assert.equal(preparedByTask(store, book, "local", folder, "lead"), true);
  assert.equal(preparedByTask(store, book, "local", folder, "grandchild"), true, "a helper of that task works in it too");
  assert.equal(preparedByTask(store, book, "local", folder, "other"), false, "another task does not");
  assert.equal(preparedByTask(store, book, "someone-else", folder, "lead"), false, "another owner's book has no such contract");
  assert.equal(preparedByTask(store, book, "local", "branch-agent-source/.branch-worktrees/self-other", "lead"), false);
});

test("the move to KeepOak: a contract written as stabrea/branch-agent still proposes and pushes to KeepOak/Branch-Agent, and nowhere else", async () => {
  const { pullRequestPinned, pushRepositoryRefusal } = await import("../dist/self-development-contract.js");
  const pr = { repo: "KeepOak/Branch-Agent", base: "redesign/window", head: "branch/self-fix", draft: true };
  assert.equal(pullRequestPinned(pr, ["stabrea/branch-agent"]), null, "GitHub redirects the old name; it is the same repository");
  assert.equal(pullRequestPinned({ ...pr, repo: "stabrea/Branch-Agent" }, ["keepoak/branch-agent"]), null);
  assert.match(pullRequestPinned({ ...pr, repo: "mallory/Branch-Agent" }, ["stabrea/branch-agent"]) ?? "", /proposed only to stabrea\/branch-agent/);
  assert.equal(pushRepositoryRefusal(["stabrea/branch-agent"], "origin", ["keepoak/branch-agent"]), null);
  assert.match(pushRepositoryRefusal(["stabrea/branch-agent"], "origin", ["keepoak/branch-agent", "mallory/branch-agent"]) ?? "", /nothing is sent/);
});
