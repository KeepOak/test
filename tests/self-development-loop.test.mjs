/**
 * Branch improves Branch through owner-reviewed pull requests, never breaking. The loop's guards, each checked on
 * its own: work only in the self-development worktree (never the protected checkout, the data folder or anything
 * outside the workspace), send only a fresh `branch/…` line as a draft pull request into the line Beta builds (never
 * a shared line, never a merge, never a repository of its own), no network for a held command, the owner asked
 * before every push or pull request, everything refused under Lockdown, and a Beta build whose app will not start
 * never replacing the running one. Real app in temporary folders; Git is a stand-in function, so nothing reaches a
 * network, and the "broken build" is a copy of this Node that exits at once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, setLockdown } from "../dist/index.js";
import { ContractBook, contractGuard, pushRefusal, selfDevelopmentLine, sourceSendHold } from "../dist/self-development-contract.js";
import { PrepareSourceChangeSchema } from "../dist/self-development.js";
import { betaLine } from "../dist/desktop/dev-build.js";
import { confinedWall } from "../dist/integrations/shell.js";
import { updateCanary, readWatch } from "../dist/never-break/canary.js";
import { saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";

const sha = "a".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-fix";
const terms = { allowedPaths: ["src/ui/**"], expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "The button is fixed",
  sideEffects: ["a draft pull request"], rollbackPlan: "Close the pull request",
  permissions: ["files.write", "shell.execute", "git.push", "github.open_pull_request", "github.publish_repo", "github.pull_request_from_changes"] };
const exists = (path) => access(path).then(() => true, () => false);

/** A stand-in Git: the worktree is its own, on `branch/self-fix`, at the contract's commit, with nothing outside it changed. */
function fakeGit(workspace) {
  const answer = (stdout) => ({ command: "git", status: "completed", stdout, stderr: "", exitCode: 0, signal: null, durationMs: 0, truncated: false,
    observedOutputBytes: 0, cleanup: { status: "parent_exited", strategy: "", limitation: "" } });
  return async ({ cwd, args }) => {
    const line = args.join(" ");
    if (line.includes("--show-toplevel")) return answer(`${cwd}\n${join(workspace, "branch-agent-source", ".git")}\n`);
    if (line.startsWith("symbolic-ref")) return answer("refs/heads/branch/self-fix\n");
    if (line.startsWith("rev-parse")) return answer(`${sha}\n`);
    return answer("");
  };
}

async function app(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-loop-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const branch = await createBranch({ workspace, dataDir, provider });
  t.after(async () => { await branch.close(); await discardTemp(root); });
  const owner = branch.runtime.owner;
  for (const [name, permission] of [["git.push", "git.remote"], ["shell.execute", "shell.execute"], ["github.open_pull_request", "github.manage"],
    ["github.publish_repo", "github.manage"]]) {
    branch.registry.unregister(name);
    branch.registry.register({ name, permission, description: "stand-in", parameters: z.object({}).passthrough(), execute: async () => ({ ran: name }) });
  }
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  new ContractBook(branch.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  branch.store.projects.save(owner, { id: "branch-agent-fix", name: "Branch Agent: fix", instructions: "", modelPreset: null,
    repository: "stabrea/Branch-Agent", folder: worktree, profile: null, knowledgeBases: [], branch: "" });
  branch.store.projects.setActive(owner, { active: "branch-agent-fix" });
  const deps = { store: branch.store, owner, workspace, registry: branch.registry, book: new ContractBook(branch.store.sqlite),
    git: fakeGit(workspace), confinement: async () => true };
  const context = () => ({ ...branch.runtime.context({ source: "owner" }), workspace, signal: AbortSignal.timeout(20_000) });
  return { branch, owner, root, workspace, dataDir, deps, guard: contractGuard(deps), context };
}

test("a change to Branch itself starts from, and is proposed back to, only the line Beta builds", () => {
  assert.equal(selfDevelopmentLine, betaLine);
  assert.equal(selfDevelopmentLine, "redesign/window");
  const contract = { ...terms, permissions: ["files.write"] };
  assert.equal(PrepareSourceChangeSchema.parse({ name: "fix", contract }).base, "redesign/window");
  for (const base of ["mac/cross-platform", "main", "redesign/window/../main"])
    assert.throws(() => PrepareSourceChangeSchema.parse({ name: "fix", base, contract }), /starts from redesign\/window/, base);
});

test("work stays in the worktree: never the protected checkout, the data folder, or a command outside it", async (t) => {
  const { guard, context, branch, dataDir, workspace } = await app(t);
  await guard("files.write", { path: "src/ui/button.ts", content: "x" }, context());
  await assert.rejects(guard("files.write", { path: "../../src/ui/button.ts", content: "x" }, context()),
    /outside the contract.s worktree/);
  await assert.rejects(guard("files.write", { path: "package.json", content: "x" }, context()), /outside the contract's allowed paths/);
  await assert.rejects(branch.runtime.executeTool("files.write", { path: join(dataDir, "planted.txt"), content: "x" }, { mode: "owner" }));
  assert.equal(await exists(join(dataDir, "planted.txt")), false, "nothing was written into the data folder");
  await assert.rejects(guard("shell.execute", { executable: "node", args: ["-v"], cwd: "branch-agent-source" }, context()),
    /a command runs only inside the active self-development worktree/);
  const held = await guard("shell.execute", { executable: "node", args: ["-v"], cwd: `${worktree}/src/ui` }, context());
  assert.equal(resolve(held.writesConfinedTo), resolve(workspace, worktree, "src", "ui"), "a command's writes are held to the folder it runs in");
});

test("a held command never gets the network, so nothing it runs can push or merge with this computer's sign-in", () => {
  const open = { network: "open", keySites: {}, unreadable: [], readOnly: [], answer: () => "allow", granted: () => ["x"], spend: () => undefined };
  assert.equal(confinedWall(open).network, "none");
  assert.equal(confinedWall(undefined).network, "none");
  assert.equal(confinedWall(open).answer("sandbox.write", "/anywhere"), "deny");
});

test("no self-merge and no shared line: only a draft pull request from a branch/… line into the line Beta builds", async (t) => {
  const { guard, context } = await app(t);
  for (const branch of ["redesign/window", "mac/cross-platform", "main"])
    await assert.rejects(guard("git.push", { folder: ".", remote: "origin", branch, confirmed: true }, context()),
      /is not a branch\/… line of work, so nothing is sent/, branch);
  const sent = await guard("git.push", { folder: ".", remote: "origin", branch: "branch/self-fix" }, context());
  assert.equal(sent.sendsRef, "refs/heads/branch/self-fix");
  const pr = { repo: "stabrea/Branch-Agent", title: "Fix the button", head: "branch/self-fix", base: "redesign/window", draft: true };
  await guard("github.open_pull_request", pr, context());
  await guard("github.open_pull_request", { ...pr, head: "alice:branch/self-fix" }, context());
  await assert.rejects(guard("github.open_pull_request", { ...pr, base: "mac/cross-platform" }, context()), /proposed only to redesign\/window/);
  await assert.rejects(guard("github.open_pull_request", { ...pr, draft: false }, context()), /only as a draft pull request/);
  await assert.rejects(guard("github.open_pull_request", { ...pr, head: "redesign/window" }, context()), /not a branch\/… line of work/);
  await assert.rejects(guard("github.publish_repo", { folder: ".", name: "copy" }, context()), /never published as a repository/);
});

test("every push or pull request from Branch's own source asks the owner, whatever the rules say", async (t) => {
  const { branch, owner, workspace } = await app(t);
  assert.deepEqual(sourceSendHold({ workspace, scope: worktree, tool: "git.push", args: { folder: "." } })?.onceOnly, true);
  assert.deepEqual(sourceSendHold({ workspace, scope: worktree, tool: "github.pull_request_from_changes", args: {} })?.onceOnly, true);
  assert.deepEqual(sourceSendHold({ workspace, scope: "", tool: "git.push", args: { folder: worktree } })?.onceOnly, true);
  assert.equal(sourceSendHold({ workspace, scope: "elsewhere", tool: "git.push", args: { folder: "." } }), null, "other work is not held");
  assert.equal(sourceSendHold({ workspace, scope: worktree, tool: "files.write", args: {} }), null);
  savePolicy(branch.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  const decision = (tool, args) => branch.runtime.checkPolicy(tool, args, branch.runtime.context({ source: "owner" }), `f-${tool}`).decision;
  assert.equal(decision("git.push", { folder: ".", remote: "origin" }), "ask", "a standing allow never sends Branch's own source");
  branch.store.projects.save(owner, { id: "other-work", name: "Other work", instructions: "", modelPreset: null,
    repository: "", folder: "other", profile: null, knowledgeBases: [], branch: "" });
  branch.store.projects.setActive(owner, { active: "other-work" });
  assert.equal(decision("git.push", { folder: ".", remote: "origin" }), "allow", "the owner's rule still decides other work");
});

test("under Lockdown, Branch does not prepare, change or send its own source", async (t) => {
  const { branch, owner, guard, context, deps, workspace } = await app(t);
  setLockdown(branch.store, owner, { on: true });
  await assert.rejects(guard("files.write", { path: "src/ui/button.ts", content: "x" }, context()), /Lockdown is on, so Branch does not work on its own source/);
  const pushed = await pushRefusal({ ...deps, folder: join(workspace, worktree), runId: "", signal: AbortSignal.timeout(10_000) });
  assert.match(pushed.refusal ?? "", /Lockdown is on/);
  await assert.rejects(branch.runtime.executeTool("branch.prepare_source_change", { name: "other", contract: terms }, { mode: "owner" }), /Lockdown is on/);
  await assert.rejects(branch.sourceRequests.approve("00000000-0000-4000-8000-000000000000", { name: "other", contract: terms }), /Lockdown is on/);
  setLockdown(branch.store, owner, { on: false });
  await guard("files.write", { path: "src/ui/button.ts", content: "x" }, context());
});

test("a Beta build whose app will not start is refused before it replaces anything, even with the never-break switch off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-beta-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data"), staged = join(root, "staged");
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "off" }));
  const platform = process.platform === "win32" ? "win32" : "linux", executableName = platform === "win32" ? "Branch Agent.exe" : "branch-agent";
  await mkdir(join(staged, "resources", "app", "dist"), { recursive: true });
  await copyFile(process.execPath, join(staged, executableName));
  await writeFile(join(staged, "resources", "app", "dist", "cli.js"), "process.exit(1);\n");
  let copies = 0;
  const snapshot = async () => {
    const folder = join(dataDir, "updates", `canary-${copies++}`, "data");
    await mkdir(folder, { recursive: true });
    return folder;
  };
  const canary = updateCanary({ dataDir, platform, executableName, fromVersion: "1.0.0", target: join(root, "installed"), snapshot, timeoutMs: 60_000 });
  await canary(staged, "2.0.0");
  assert.equal(copies, 0, "Stable with the switch off behaves as before");
  await assert.rejects(canary(staged, "2.0.0", { required: true }), /did not|failed|stopped|exit/i);
  assert.equal(copies, 1, "the Beta build was tried on a copy of the work");
  assert.deepEqual(await readdir(join(dataDir, "updates")), [], "the copy was removed");
  assert.equal(await readWatch(dataDir), null, "nothing was swapped, so nothing is watched");
});
