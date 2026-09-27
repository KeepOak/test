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
import { confinedWall, installsPackages, npmRegistryHost } from "../dist/integrations/shell.js";
import { SandboxProxy } from "../dist/sandbox-proxy.js";
import { createServer } from "node:http";
import { connect } from "node:net";
import { updateCanary, readWatch } from "../dist/never-break/canary.js";
import { windowsSwap, startedMarker } from "../dist/desktop/updater.js";
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

/** One plain request through the door, as a program behind the wall sends it; the whole answer. */
function through(port, secret, host) {
  const auth = Buffer.from(`branch:${secret}`).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET http://${host}/left-pad HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`));
    let got = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { got += chunk; });
    socket.once("close", () => resolve(got));
    socket.once("error", reject);
  });
}

test("selfdev: npm ci in the self-development copy reaches the npm registry and nothing else; no key is swapped in", async (t) => {
  const open = { network: "open", keySites: { NPM_TOKEN: npmRegistryHost }, unreadable: [], readOnly: [], answer: () => "allow", granted: () => ["x"], spend: () => undefined };
  const npm = { path: "C:\\Program Files\\nodejs\\npm.cmd", args: [] };
  assert.equal(installsPackages(npm, ["ci"]), true);
  assert.equal(installsPackages({ path: "/usr/bin/npm", args: [] }, ["ci", "--registry=https://evil.example"]), true, "the door, not the words, decides where it goes");
  for (const [executable, args] of [[npm, ["publish"]], [npm, ["install", "x"]], [{ path: "/usr/bin/node", args: [] }, ["ci"]], [npm, ["run", "ci"]]])
    assert.equal(installsPackages(executable, args), false, `${executable.path} ${args.join(" ")}`);
  const wall = confinedWall(open, { registry: true });
  assert.equal(wall.network, "per-site");
  assert.deepEqual(wall.keySites, {}, "a saved key is never swapped in, so the registry cannot be signed in to");
  assert.deepEqual(wall.granted("network.site"), []);
  assert.equal(wall.answer("network.site", npmRegistryHost), "allow");
  for (const host of ["registry.yarnpkg.com", "evil.example", "registry.npmjs.org.evil.example", "api.github.com", "npmjs.org"])
    assert.equal(wall.answer("network.site", host), "deny", host);
  assert.equal(confinedWall(open, { registry: false }).network, "none");
  // The wall's own door with this wall's answers: the registry goes through, any other site is refused.
  const site = createServer((request, response) => response.end(`package ${request.url}`));
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => site.close(done)));
  const door = new SandboxProxy({ network: wall.network, decide: (host) => wall.answer("network.site", host) ?? "ask",
    resolve: async () => ["93.184.216.34"], upstream: () => ({ host: "127.0.0.1", port: site.address().port, secure: false }) });
  const address = await door.start();
  t.after(() => door.close());
  assert.match(await through(address.httpPort, door.secret, npmRegistryHost), /200 OK[\s\S]*package \/left-pad/);
  const refused = await through(address.httpPort, door.secret, "evil.example");
  assert.match(refused, /403[\s\S]*have not allowed programs to reach evil\.example/);
  assert.deepEqual(door.asked, [], "another site is refused outright, never put to the owner as a question");
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

test("selfdev, Beta: after the swap the new version must say its engine is up, or the previous one is put back by itself", () => {
  const plan = { install: "C:\B", staged: "C:\s", previous: "C:\B.previous", exe: "C:\B\b.exe", log: "C:\l", sys: "", archive: "a", unpacked: "u",
    mirror: () => "mirror", sleep: (n) => `sleep ${n}`, running: "running", recover: "r", runOnceKey: "k", image: "b.exe" };
  const marker = startedMarker(join("scratch"), "2.0.0-beta+abc");
  assert.equal(marker, join("scratch", "started-2.0.0-beta_abc"));
  const beta = windowsSwap({ ...plan, started: marker }).join("\n");
  const start = beta.indexOf("starting new version"), wait = beta.indexOf(`if exist "${marker}" goto upcheck`);
  assert.ok(beta.includes(`del /q "${marker}"`) && beta.indexOf(`del /q "${marker}"`) < start && start < wait, "a file left by the check is removed before the start; the wait comes after it");
  assert.match(beta, /:upcheck\nrunning\nif not errorlevel 1 goto done\ngoto restore/);
  assert.match(beta, /did not say it was up; ending it[^\n]*\ntaskkill\.exe \/IM "b\.exe"[^\n]*\nsleep 2\ngoto restore/);
  const stable = windowsSwap(plan).join("\n");
  assert.doesNotMatch(stable, /upcheck|started-/, "Stable keeps the check it had");
});
