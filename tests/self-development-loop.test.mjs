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
import { access, copyFile, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, setLockdown } from "../dist/index.js";
import { ContractBook, contractGuard, pushRefusal, selfDevelopmentLine, sourceSendHold } from "../dist/self-development-contract.js";
import { PrepareSourceChangeSchema } from "../dist/self-development.js";
import { betaLine } from "../dist/desktop/dev-build.js";
import { confinedWall, heldCommand, installsPackages, npmRegistryHost } from "../dist/integrations/shell.js";
import { gitCommonDir, heldCover, heldView, wslHeldPlan, wslHeldStart, wslProgram, wslReadiness, wslNoBubblewrap, wslNoNode, wslNotSetUp } from "../dist/integrations/wsl-held.js";
import { bwrapArgs } from "../dist/sandbox-bwrap.js";
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
    // origin sends to the fork the worktree was made from (the first repository its contract names).
    if (line.startsWith("remote get-url")) return answer("git@github.com:alice/Branch-Agent.git\n");
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
  // A fork: origin is alice's copy, and the upstream it was made from is the official repository.
  new ContractBook(branch.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms,
    sendRepositories: ["alice/Branch-Agent", "stabrea/Branch-Agent"] });
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
  for (const [executable, args] of [[npm, ["ci", "--"]], [npm, ["ci", "--no-ignore-scripts"]], [npm, ["ci", "--ignore-scripts=false"]], [npm, ["publish"]], [npm, ["install", "x"]], [{ path: "/usr/bin/node", args: [] }, ["ci"]], [npm, ["run", "ci"]]])
    assert.equal(installsPackages(executable, args), false, `${executable.path} ${args.join(" ")}`);
  assert.deepEqual(heldCommand(npm, ["ci"]), { args: ["ci", "--ignore-scripts"], registry: true }, "only npm itself has the registry: no package's scripts run");
  assert.deepEqual(heldCommand(npm, ["run", "build"]), { args: ["run", "build"], registry: false });
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
  // Only into a repository written with the contract when the worktree was made: its origin, or the upstream of a fork.
  await guard("github.open_pull_request", { ...pr, repo: "alice/branch-agent" }, context());
  await assert.rejects(guard("github.open_pull_request", { ...pr, repo: "mallory/Branch-Agent" }, context()),
    /proposed only to alice\/branch-agent or stabrea\/branch-agent, where this worktree was made from, so no pull request is opened in mallory\/Branch-Agent/);
  await assert.rejects(guard("github.publish_repo", { folder: ".", name: "copy" }, context()), /never published as a repository/);
});

test("every push or pull request from Branch's own source asks the owner, whatever the rules say", async (t) => {
  const { branch, owner, workspace } = await app(t);
  assert.deepEqual(sourceSendHold({ workspace, scope: worktree, tool: "git.push", args: { folder: "." } })?.onceOnly, true);
  assert.deepEqual(sourceSendHold({ workspace, scope: worktree, tool: "github.pull_request_from_changes", args: {} })?.onceOnly, true);
  // A direct github.open_pull_request from the source is asked about too, not only the composite helper.
  assert.deepEqual(sourceSendHold({ workspace, scope: worktree, tool: "github.open_pull_request", args: {} })?.onceOnly, true);
  assert.deepEqual(sourceSendHold({ workspace, scope: "", tool: "git.push", args: { folder: worktree } })?.onceOnly, true);
  assert.equal(sourceSendHold({ workspace, scope: "elsewhere", tool: "git.push", args: { folder: "." } }), null, "other work is not held");
  assert.equal(sourceSendHold({ workspace, scope: worktree, tool: "files.write", args: {} }), null);
  savePolicy(branch.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  const decision = (tool, args) => branch.runtime.checkPolicy(tool, args, branch.runtime.context({ source: "owner" }), `f-${tool}`).decision;
  assert.equal(decision("git.push", { folder: ".", remote: "origin" }), "ask", "a standing allow never sends Branch's own source");
  assert.equal(decision("github.open_pull_request", { repo: "stabrea/Branch-Agent", base: "redesign/window", head: "branch/self-fix", draft: true }), "ask",
    "a standing allow never opens a pull request from Branch's own source without asking");
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

test("on Windows a held command runs inside WSL: wsl.exe --exec node, a Linux program by name, /mnt paths, no WSL names crossing", () => {
  const plan = wslHeldPlan({ executable: { path: "C:/Program Files/nodejs/npm.cmd", args: [] }, args: ["ci"],
    cwd: "C:/src/.branch-worktrees/self-fix/app", workspace: "C:/src/.branch-worktrees/self-fix",
    env: { PATH: "C:/Windows", Path: "C:/x", HOME: "C:/Users/o", TEMP: "C:/t", WSL_INTEROP: "/run/WSL/1_interop", WSLENV: "PATH/l", LANG: "C.UTF-8", MY_KEY: "real-value" },
    secrets: ["MY_KEY"], registry: true, timeoutMs: 5000 });
  assert.equal(plan.program, "npm");
  assert.deepEqual(plan.args, ["ci"]);
  assert.equal(plan.workspace, "/mnt/c/src/.branch-worktrees/self-fix");
  assert.equal(plan.cwd, "/mnt/c/src/.branch-worktrees/self-fix/app");
  assert.deepEqual(plan.env, { LANG: "C.UTF-8" }, "only the allowlisted names cross; never PATH, HOME, temp, a WSL name or a saved key's value");
  assert.deepEqual(plan.secrets, ["MY_KEY"]);
  assert.equal(plan.registry, true);
  for (const [path, program] of [["C:/n/node.exe", "node"], ["C:/n/NPX.CMD", "npx"], ["C:/Program Files/Git/cmd/git.exe", "git"]])
    assert.equal(wslProgram(path), program);
  for (const path of ["C:/Windows/System32/cmd.exe", "C:/x/powershell.exe", "C:/x/bash.exe", "C:/x/node-evil.exe"])
    assert.throws(() => wslProgram(path), /only node, npm, npx, git, python3, pip, pip3, pipx, uv, curl, wget \(python for python3\) are available/); // SELF-015
  assert.throws(() => wslHeldPlan({ executable: { path: "C:/n/node.exe", args: [] }, args: [], cwd: "//server/share", workspace: "//server/share",
    env: {}, secrets: [], registry: false, timeoutMs: 1 }), /WSL, which cannot reach this folder/);
  const start = wslHeldStart({ runner: "C:/app/dist/integrations/wsl-held-runner.js", planFile: "C:/Temp/branch-held-1/held-plan.json",
    cwd: "C:/w", env: { SystemRoot: "C:/Windows", WSL_INTEROP: "x", PATH: "C:/y" } });
  assert.equal(start.executable, join("C:/Windows", "System32", "wsl.exe"));
  assert.deepEqual(start.args, ["--exec", "node", "/mnt/c/app/dist/integrations/wsl-held-runner.js", "/mnt/c/Temp/branch-held-1/held-plan.json"]);
  assert.deepEqual(start.env, { SystemRoot: "C:/Windows", WSLENV: "" }, "nothing of Windows' environment crosses into WSL");
});

test("WSL that is not ready refuses in a plain sentence naming what is missing, and never runs Windows' node.exe", async () => {
  const answers = (node, bwrap) => async (executable, args) => (args.includes("process.platform") ? node : bwrap);
  const ok = { code: 0, stdout: "linux\n", stderr: "", missing: false };
  assert.equal(await wslReadiness(answers(ok, { code: 0, stdout: "", stderr: "", missing: false }), "wsl.exe"), null);
  assert.equal(await wslReadiness(answers(ok, { code: 1, stdout: "", stderr: "", missing: false }), "wsl.exe"), wslNoBubblewrap);
  assert.match(wslNoBubblewrap, /no bubblewrap.*Ask the owner; with their yes, it is set up with `sudo apt-get install bubblewrap` in Ubuntu/);
  assert.equal(await wslReadiness(answers({ code: 1, stdout: "", stderr: "", missing: false }, ok), "wsl.exe"), wslNoNode);
  assert.equal(await wslReadiness(answers({ code: 0, stdout: "win32\n", stderr: "", missing: false }, ok), "wsl.exe"), wslNoNode,
    "Windows' node.exe reached through WSL's search path is not Linux's Node");
  assert.match(wslNoNode, /WSL here has no Node\.js.*with their yes/);
  assert.equal(await wslReadiness(answers({ code: null, stdout: "", stderr: "", missing: true }, ok), "wsl.exe"), wslNotSetUp);
});

test("the held view under WSL hides /mnt, /run and the home, and binds each held program's install folder under the home back", () => {
  const home = "/home/o";
  // node, npm and npx from a version manager under the home; git from the system outside it.
  const view = heldView(home, ["/home/o/.nvm/versions/node/v22/bin/node", "/home/o/.nvm/versions/node/v22/bin/npm", "/usr/bin/git"]);
  assert.deepEqual(view.covered, ["/mnt", "/run", home], "the Windows drives, all of /run (not only /run/WSL) and the home are hidden");
  assert.ok(view.covered.includes("/run") && !view.covered.includes("/run/WSL"), "all of /run, so dbus, snapd, the container daemon and the per-user sockets go too");
  assert.ok(view.covered.includes(home), "the home is hidden, so another agent's control socket and the saved sign-ins under it are unreachable");
  assert.deepEqual(view.restored, ["/home/o/.nvm/versions/node/v22/bin", "/home/o/.nvm/versions/node/v22/lib"],
    "only the interpreter's own folder and the lib beside it are bound back, once; the system git needs nothing");
  // Never the rest of the prefix: a node in ~/.local/bin brings ~/.local/lib, never ~/.local/share (where keyrings live).
  assert.deepEqual(heldView(home, ["/home/o/.local/bin/node"]).restored, ["/home/o/.local/bin", "/home/o/.local/lib"]);
  // A program directly under the home never restores the home itself, which would undo the cover.
  assert.deepEqual(heldView(home, ["/home/o/node"]).restored, [], "a program sitting straight in the home is not restored, so the home stays hidden");
  assert.deepEqual(heldView(home, ["/home/o/bin/node"]).restored, ["/home/o/bin", "/home/o/lib"], "a program one folder in restores that folder and its lib, never the home");
});

test("on Linux the held view is read from the disk: the programs found, and the worktree's Git folder when a cover would hide it",
  { skip: process.platform === "win32" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-held-view-")));
  t.after(() => discardTemp(root));
  const home = join(root, "home"), prefix = join(home, ".nvm", "versions", "node", "v22");
  for (const dir of [join(prefix, "bin"), join(prefix, "lib"), join(prefix, "share"), join(home, ".codex"), join(home, "src", ".git", "worktrees", "w"),
    join(home, "src", ".branch-worktrees", "w", "src", "ui")]) await mkdir(dir, { recursive: true });
  await writeFile(join(prefix, "bin", "node"), "");
  await writeFile(join(home, "src", ".git", "worktrees", "w", "commondir"), "../..\n");
  await writeFile(join(home, "src", ".branch-worktrees", "w", ".git"), `gitdir: ${join(home, "src", ".git", "worktrees", "w")}\n`);
  const workspace = join(home, "src", ".branch-worktrees", "w", "src", "ui");
  assert.equal(await gitCommonDir(workspace), join(home, "src", ".git"), "a worktree's .git file is followed to the repository's common folder");
  const view = await heldCover({ home, programs: [], searchPath: `/nowhere:${join(prefix, "bin")}`, workspace });
  assert.ok(view.covered.includes(home), "the home is covered");
  assert.deepEqual(view.restored.sort(), [join(home, "src", ".git"), join(prefix, "bin"), join(prefix, "lib")].sort(),
    "node's own folder, its lib and the worktree's Git folder come back; never the rest of the prefix or another program's folder");
  const outside = await heldCover({ home, programs: [], searchPath: "", workspace: join(root, "elsewhere") });
  assert.deepEqual(outside.restored, [], "nothing is bound back that the cover does not hide");
  assert.equal(view.refusal, null, "node from a version manager, run in the worktree, is fine");

  // What cannot work behind the view is refused before anything runs, saying why and what works instead.
  await mkdir(join(home, "tools"), { recursive: true });
  for (const file of [join(home, "node"), join(home, "tools", "build.mjs"), join(workspace, "build.mjs"), join(root, "loose.mjs"),
    join(prefix, "lib", "cli.js")]) await writeFile(file, "");
  const refusal = async (programs, args) => (await heldCover({ home, programs, args, searchPath: "", workspace })).refusal;
  assert.match(await refusal([join(home, "node")], []), new RegExp(`^${join(home, "node")} sits straight in your home folder, which a command held to its folder cannot see .*so it did not run\\. Install it under a folder of its own, such as ~/\\.local/bin \\(its bin and lib folders are then shown to the command\\), or use one installed outside your home\\.$`));
  assert.match(await refusal(["/bin/sh"], ["-c", "x", join(home, "tools", "build.mjs")]), new RegExp(`^${join(home, "tools", "build.mjs")} is in ${home}, which a command held to its folder cannot see .*so it did not run\\. Move the file into the worktree and run it from there\\.$`));
  assert.match(await refusal(["/bin/sh"], [join(root, "loose.mjs")]) ?? "", /is in \/tmp, which a command held to its folder cannot see/, "a fresh /tmp hides the rest of it too");
  assert.equal(await refusal(["/bin/sh"], [join(workspace, "build.mjs"), "relative.mjs", "--flag"]), null, "a file in the worktree, or named from it, is fine");
  assert.equal(await refusal([join(prefix, "bin", "node")], [join(prefix, "lib", "cli.js")]), null, "a file in a folder shown to the command is fine");
});

test("under WSL the wall covers /mnt and /run/WSL before the worktree is bound, and makes them read-only after", () => {
  const args = bwrapArgs({ workspace: "/mnt/c/src/w", network: "none", home: "/home/o", temp: "/tmp/held", kindOf: () => null,
    covered: ["/mnt", "/run/WSL"] }, { executable: "/usr/local/bin/node", args: [] });
  const at = (...pair) => args.findIndex((arg, index) => pair.every((each, offset) => args[index + offset] === each));
  const bind = at("--bind", "/mnt/c/src/w", "/mnt/c/src/w");
  for (const folder of ["/mnt", "/run/WSL"]) {
    assert.ok(at("--tmpfs", folder) > at("--ro-bind", "/", "/") && at("--tmpfs", folder) < bind, `${folder} is covered before the worktree is bound`);
    assert.ok(at("--tmpfs", folder) < at("--tmpfs", "/tmp/held"), `${folder} is covered before the private temporary folder is made, so one inside it still shows`);
    assert.ok(at("--remount-ro", folder) > bind, `${folder} turns read-only after the worktree is bound inside it`);
  }
  assert.ok(at("--ro-bind-try", "/mnt/c/src/w/.git", "/mnt/c/src/w/.git") > bind);
  const plain = bwrapArgs({ workspace: "/w", network: "none", kindOf: () => null }, { executable: "/bin/true", args: [] });
  assert.ok(!plain.includes("/mnt") && !plain.includes("--remount-ro"), "outside WSL nothing is covered");
  // A socket reached through links is covered where it really is, once, so the wall still starts and still hides it.
  const real = { "/var/run/docker.sock": "/home/o/.docker/desktop/docker.sock", "/run/docker.sock": "/home/o/.docker/desktop/docker.sock" };
  const linked = bwrapArgs({ workspace: "/w", network: "none", home: "/home/o", kindOf: (path) => (path.endsWith(".sock") ? "file" : null),
    canonical: (path) => real[path] ?? path }, { executable: "/bin/true", args: [] });
  const covers = linked.filter((arg, index) => linked[index - 2] === "--ro-bind" && linked[index - 1] === "/dev/null");
  assert.deepEqual(covers, ["/home/o/.docker/desktop/docker.sock"]);
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
  assert.match(beta, /did not say it was up; ending it[^\n]*\ncall :taskoff\ntaskkill\.exe \/IM "b\.exe"[^\n]*\nsleep 2\ngoto restore/);
  const stable = windowsSwap(plan).join("\n");
  assert.doesNotMatch(stable, /upcheck|started-/, "Stable keeps the check it had");
});
