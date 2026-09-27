/**
 * Q12: a held command can write inside its folder, so it could plant `x/.git/config` naming a program
 * (core.fsmonitor, diff.external). Branch's own Git must never run that program outside the sandbox:
 *   1. Git tools refuse any folder in Branch's source that is not a worktree's root (real app);
 *   2. every Git Branch runs pins the settings that start programs, so even run there, nothing starts.
 * Only a local `git init` is run here; nothing reaches a network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBranch } from "../dist/index.js";
import { GitRunner, gitEnvironment, hardening } from "../dist/integrations/git-run.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { GitTools } from "../dist/integrations/git.js";
import { WorkspaceFiles } from "../dist/files.js";
import { discardTemp } from "./temp-dir.mjs";

const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";
const sha = "a".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";

/** A nested repository at <worktree>/src/ui/x whose own config names a program that leaves a marker. */
async function plantedRepository(workspace, only) {
  const nested = join(workspace, worktree, "src", "ui", "x"), marker = join(workspace, "..", "PWNED");
  await mkdir(nested, { recursive: true });
  const script = join(workspace, "..", "evil.sh");
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
  await chmod(script, 0o755);
  const git = (...args) => execFileSync("git", args, { cwd: nested, stdio: "ignore" });
  git("init", "-q");
  await writeFile(join(nested, "a.txt"), "one\n");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
  await writeFile(join(nested, "a.txt"), "two\n");
  for (const key of only ? [only] : ["core.fsmonitor", "diff.external"]) git("config", key, script);
  return { nested, marker };
}

test("Git tools refuse a folder in Branch's source that is not a worktree's root", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-nested-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { marker } = await plantedRepository(workspace);
  new ContractBook(app.store.sqlite).create(app.runtime.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["git.status", "git.diff", "git.log"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } });
  const run = app.store.createRun(app.runtime.owner, "look");
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  for (const name of ["git.status", "git.diff", "git.log"])
    await assert.rejects(app.registry.execute(name, { folder: `${worktree}/src/ui/x` }, context),
      /Git runs in Branch's own source only at a self-development worktree's root/, name);
  await assert.rejects(app.registry.execute("git.status", { folder: "branch-agent-source" }, context), /only at a self-development worktree's root/,
    "the protected checkout itself");
  assert.equal(existsSync(marker), false, "the planted program never ran");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused").length, 4);
});

test("every Git Branch runs pins the settings that start programs, so a planted config runs nothing", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-pins-"));
  t.after(() => discardTemp(root));
  const { nested, marker } = await plantedRepository(join(root, "workspace"));
  const runner = new GitRunner();
  for (const args of [["status", "--porcelain"], ["diff", "--no-ext-diff", "--no-textconv"], ["log", "-p", "-1"]]) {
    const outcome = await runner.run({ cwd: nested, args }, AbortSignal.timeout(20_000));
    assert.equal(outcome.status, "completed", `${args.join(" ")}: ${outcome.stderr}`);
  }
  // A patch asked for without --no-ext-diff stops loudly on the pinned `false` instead of running the planted program.
  const plain = await runner.run({ cwd: nested, args: ["diff"] }, AbortSignal.timeout(20_000));
  assert.match(plain.stderr, /external diff died/);
  assert.equal(existsSync(marker), false, "neither core.fsmonitor nor diff.external ran");
});

test("each setting a repository's own config could use to start a program runs nothing", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-pins-each-"));
  t.after(() => discardTemp(root));
  const runner = new GitRunner();
  const cases = [
    ["core.fsmonitor", ["status", "--porcelain"]],
    ["diff.external", ["diff"]],
    ["core.editor", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty"]],
    ["gpg.program", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=true", "commit", "-q", "--allow-empty", "-m", "signed?"]],
    ["core.pager", ["-p", "log", "-1"]],
  ];
  for (const [key, args] of cases) {
    const repo = join(root, key.replace(".", "-"));
    const { marker } = await plantedRepository(repo, key);
    await runner.run({ cwd: join(repo, worktree, "src", "ui", "x"), args }, AbortSignal.timeout(20_000));
    assert.equal(existsSync(marker), false, `${key} started nothing`);
  }
  // A commit hook in the planted repository never runs either (core.hooksPath is pinned to an empty folder).
  const hooked = join(root, "hooks");
  const { nested, marker } = await plantedRepository(hooked, "core.fsmonitor");
  await writeFile(join(nested, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
  await runner.run({ cwd: nested, args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "hooked?"] }, AbortSignal.timeout(20_000));
  assert.equal(existsSync(marker), false, "the pre-commit hook started nothing");
  // The ones that only act over a network, or that change what the owner sees, are pinned only inside
  // Branch's source (checked in the arguments, not run here).
  const inSource = hardening("/w/branch-agent-source/.branch-worktrees/self-x").join(" "), elsewhere = hardening("/w/proj").join(" ");
  for (const key of ["core.gitProxy=", "protocol.ext.allow=never", "safe.bareRepository=explicit", "commit.gpgSign=false", "diff.ignoreSubmodules=all"])
    assert.ok(inSource.includes(`-c ${key}`), key);
  for (const key of ["commit.gpgSign=false", "diff.ignoreSubmodules=all", "safe.bareRepository=explicit"])
    assert.ok(!elsewhere.includes(`-c ${key}`), `${key} is not forced on the owner's own repositories`);
  assert.ok(elsewhere.includes("-c core.fsmonitor=false") && elsewhere.includes("-c diff.external=false"));
});

test("the owner's own Git sign-in is left alone: a credential helper they set is still the one Git uses", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-signin-"));
  t.after(() => discardTemp(root));
  const home = join(root, "home"), repo = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[credential]\n\thelper = !echo keep-me\n");
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  const runner = new GitRunner({ env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
  const helper = await runner.run({ cwd: repo, args: ["config", "--get", "credential.helper"] }, AbortSignal.timeout(20_000));
  assert.equal(helper.stdout.trim(), "!echo keep-me", "the helper is not cleared by Branch's settings");
  for (const key of ["credential.helper=", "core.askPass=", "core.sshCommand=ssh"]) assert.ok(!hardening(repo).join(" ").includes(`-c ${key}`), key);
  assert.equal(gitEnvironment(process.env).GIT_CONFIG_NOSYSTEM, undefined, "the computer-wide config (where macOS keeps its keychain helper) is read");
});

/**
 * Q12: a held command can turn an allowed folder (here `src/`) into a bare repository with no `.git`
 * name anywhere. Git then reads a remote name nobody configured, "src", as that folder, and the
 * planted repository's hooks run outside the wall. Each guard is tested on its own.
 */
async function plantedBare(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-bare-repo-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "branch-agent-source/.branch-worktrees/self-bare";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "feature");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
  execFileSync("git", ["init", "--bare", "-q", join(cwd, "src")]);
  const marker = join(root, "hook-ran");
  const hook = join(cwd, "src", "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
  await chmod(hook, 0o755);
  return { app, folder, cwd, marker };
}

test("Q12 control: without Branch's pins, a push to the unconfigured name \"src\" runs the planted hook", { skip: posixOnly }, async (t) => {
  const { cwd, marker } = await plantedBare(t);
  execFileSync("git", ["push", "-q", "src", "HEAD:refs/heads/x"], { cwd, stdio: "pipe" });
  assert.equal(existsSync(marker), true, "the setup is the real attack: plain Git runs the hook");
});

test("Q12: the source pins alone stop Git's local transport, so the planted hook never runs", { skip: posixOnly }, async (t) => {
  const { cwd, marker } = await plantedBare(t);
  assert.ok(hardening(cwd).includes("protocol.file.allow=never"));
  assert.throws(() => execFileSync("git", [...hardening(cwd), "push", "-q", "src", "HEAD:refs/heads/x"], { cwd, stdio: "pipe" }),
    (error) => /transport 'file' not allowed/.test(String(error.stderr)));
  assert.equal(existsSync(marker), false);
});

test("Q12: git.push and git.pull in source refuse a remote nobody configured, before Git runs", { skip: posixOnly }, async (t) => {
  const { app, folder, marker } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  await assert.rejects(app.git.push({ folder, remote: "src", branch: "feature" }, signal), /Remote "src" is not configured/);
  await assert.rejects(app.git.pull({ folder, remote: "src", branch: "feature" }, signal), /Remote "src" is not configured/);
  assert.equal(existsSync(marker), false);
});

test("Q12: git.push and git.pull in source refuse a configured remote that is a folder or a file:// address", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd, marker } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "near", join(cwd, "src")], { cwd });
  execFileSync("git", ["remote", "add", "far", `file://${join(cwd, "src")}`], { cwd });
  for (const remote of ["near", "far"]) {
    await assert.rejects(app.git.push({ folder, remote, branch: "feature" }, signal), /Remote URL must use https/, remote);
    await assert.rejects(app.git.pull({ folder, remote, branch: "feature" }, signal), /Remote URL must use https/, remote);
  }
  assert.equal(existsSync(marker), false);
});

test("Q12: a link to Branch's source still gets the source pins", { skip: posixOnly }, async (t) => {
  const { cwd } = await plantedBare(t);
  const link = join(await mkdtemp(join(tmpdir(), "branch-self-link-")), "elsewhere");
  t.after(() => discardTemp(dirname(link)));
  await symlink(cwd, link);
  assert.ok(hardening(link).includes("protocol.file.allow=never"), "decided on the real path, not the link's name");
});

test("Q79: git.push and git.pull in source refuse LOCAL scoped credential.helper", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "credential.helper", "fake"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
});

test("Q79: git.push and git.pull in source refuse LOCAL scoped core.askPass", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "core.askPass", "/bin/false"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /password prompt.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /password prompt.*local scope/);
});

test("Q79: git.push and git.pull in source refuse LOCAL scoped core.sshCommand", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "core.sshCommand", "/bin/false"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /SSH command.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /SSH command.*local scope/);
});

test("Q79: git.push and git.pull in source refuse WORKTREE scoped credential.helper", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-wtree-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "branch-agent-source/.branch-worktrees/self-worktree";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "feature");
  git("config", "extensions.worktreeConfig", "true");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
  git("remote", "add", "origin", "https://example.com/repo.git");
  git("config", "--worktree", "credential.helper", "fake");
  const signal = AbortSignal.timeout(10_000);
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*worktree scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*worktree scope/);
});

test("Q79: git.push and git.pull in source leave the owner's own GLOBAL credential.helper alone", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-global-"));
  t.after(() => discardTemp(root));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[credential]\n\thelper = fake\n");
  // The Git these tools run must read the same home, or a global helper would never be seen at all.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const tools = new GitTools(new WorkspaceFiles(workspace), new GitRunner({ env }));
  const folder = "branch-agent-source/.branch-worktrees/self-global";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
  git("init", "-q", "-b", "feature");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
  assert.match(git("config", "--show-scope", "--get-regexp", "^credential\\..*helper$").toString(), /^global\scredential\.helper fake$/m, "the helper is seen, at global scope");
  const signal = AbortSignal.timeout(10_000);
  // Past the sign-in check, the unconfigured remote is what refuses: the owner's helper was allowed.
  await assert.rejects(tools.push({ folder, remote: "origin", branch: "feature" }, signal), /Remote "origin" is not configured/);
  await assert.rejects(tools.pull({ folder, remote: "origin", branch: "feature" }, signal), /Remote "origin" is not configured/);
});

test("Q79: outside Branch's source, a LOCAL scoped credential.helper is not refused", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-outside-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "normal-repo";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "custom"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
  execFileSync("git", ["config", "--local", "credential.helper", "fake"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd });
  const signal = AbortSignal.timeout(10_000);
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "custom" }, signal), /reach the server/, "rejected for the invalid host or network, not refused by Q79 scope check");
});

test("Q82: git.push and git.pull in source refuse an scp-like remote with host starting with dash", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "attack", "git@-h:repo.git"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
  await assert.rejects(app.git.pull({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
});

test("Q82: git.push and git.pull in source refuse an ssh:// remote with host starting with dash", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "attack", "ssh://-oProxyCommand=id@example.com/repo.git"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
  await assert.rejects(app.git.pull({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
});

test("Q82: a dash-led user or host is refused in every spelling of an ssh remote", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  for (const [name, url] of [["a", "ssh://git@-oProxyCommand=id/repo.git"], ["b", "ssh://git@-h:22/repo.git"], ["c", "-oProxyCommand=id@example.com:repo.git"]]) {
    execFileSync("git", ["config", `remote.${name}.url`, url], { cwd });
    await assert.rejects(app.git.push({ folder, remote: name, branch: "feature" }, signal), /user or host with "-"|must use https/, url);
  }
});

test("Q82: git.push and git.pull in source refuse a remote URL changed by url.<x>.insteadOf", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://example.com/"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
});

test("Q82: outside Branch's source, an scp-like remote with dash host is not refused by Q82 check", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-outside-dash-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "normal-repo";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "custom"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
  execFileSync("git", ["remote", "add", "attack", "git@-h:repo.git"], { cwd });
  const signal = AbortSignal.timeout(10_000);
  // Verify the rejection is not from the Q82 dash check (which should only run in Branch's source)
  await assert.rejects(app.git.push({ folder, remote: "attack", branch: "custom" }, signal), (e) => {
    assert.doesNotMatch(String(e), /user or host with "-"/, "Q82 dash check should not run outside Branch's source");
    return true;
  });
});

test("A1: git.push and git.pull in source refuse LOCAL scoped include.path", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "include.path", "/tmp/evil"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /included config file.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /included config file.*local scope/);
});

test("A1: git.push and git.pull in source refuse URL-scoped credential.helper (LOCAL scope)", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "credential.https://example.com.helper", "fake"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
});

test("A1: git.push and git.pull in source allow credential.username (not matched by helper pattern)", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "credential.username", "fake"], { cwd });
  // Should not refuse for credential.username; will fail for unconfigured remote or network reasons
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /not configured/, "credential.username does not trigger the helper refusal");
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /not configured/, "credential.username does not trigger the helper refusal");
});

test("B: git.push in source refuses when push URLs count differs from configured URL count", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["remote", "set-url", "--add", "--push", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["remote", "set-url", "--add", "--push", "origin", "https://evil.com/repo.git"], { cwd });
  // Now there are 2 push URLs but only 1 base URL; this should be refused
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
});

test("C: git.pull in source judges the fetch URL, not the push URL, when only fetching is rewritten", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  // pushInsteadOf maps the URL to itself, so pushing still goes to example.com; fetching goes to evil.com.
  execFileSync("git", ["config", "--local", "url.https://example.com/.pushInsteadOf", "https://example.com/"], { cwd });
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://example.com/"], { cwd });
  assert.equal(execFileSync("git", ["remote", "get-url", "--push", "origin"], { cwd, encoding: "utf8" }).trim(), "https://example.com/repo.git");
  assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim(), "https://evil.com/repo.git");
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
});

test("C: git.pull in source refuses when fetch URL rewritten to dash-leading host", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["config", "--local", "url.git@-h:.insteadOf", "https://example.com/"], { cwd });
  // Pull should refuse because fetch URL is rewritten to git@-h:, which has a dash-leading host
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /user or host with "-"/);
});

test("Q96: a remote Git reads from an old .git/remotes or .git/branches file is refused in source, even rewritten", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8" }).trim();
  await mkdir(join(gitDir, "remotes"), { recursive: true });
  await mkdir(join(gitDir, "branches"), { recursive: true });
  await writeFile(join(gitDir, "remotes", "legacy"), "URL: https://example.com/repo.git\n");
  await writeFile(join(gitDir, "branches", "older"), "https://example.com/other.git\n");
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://example.com/"], { cwd });
  assert.equal(execFileSync("git", ["remote", "get-url", "legacy"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    "https://evil.com/repo.git", "Git itself sends to the rewritten address");
  for (const remote of ["legacy", "older"]) {
    await assert.rejects(app.git.push({ folder, remote, branch: "feature" }, signal), /not set in Git's settings/, remote);
    await assert.rejects(app.git.pull({ folder, remote, branch: "feature" }, signal), /not set in Git's settings/, remote);
  }
});

test("Q98: publishing from Branch's source gets the push checks: a rewritten address or a local helper is refused, and no remote is left", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://github.com/"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "", "the refused address is not left behind");
  execFileSync("git", ["config", "--local", "--unset", "url.https://evil.com/.insteadOf"], { cwd });
  execFileSync("git", ["config", "--local", "credential.https://github.com.helper", "!echo planted"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /credential helper/);
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "");
});

test("Q98: publishing is held to the worktree-root rule like the Git tools", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-publish-root-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { marker } = await plantedRepository(workspace);
  new ContractBook(app.store.sqlite).create(app.runtime.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["github.publish_repo"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } });
  // Publishing is registered only once GitHub access is set up; the refusal comes before GitHub is ever asked.
  const { GitHubAccess } = await import("../dist/integrations/github.js");
  const { registerGitHubProject } = await import("../dist/integrations/git-tools.js");
  const { NetworkPolicy } = await import("../dist/network-policy.js");
  registerGitHubProject(app.registry, new GitHubAccess({ apiBase: "http://127.0.0.1:9" }, new NetworkPolicy({ allowPrivateAddresses: true }), async () => "ghp_fake"), app.git);
  const run = app.store.createRun(app.runtime.owner, "publish");
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  await assert.rejects(app.registry.execute("github.publish_repo", { folder: `${worktree}/src/ui/x`, name: "demo" }, context),
    /Git runs in Branch's own source only at a self-development worktree's root/);
  assert.equal(existsSync(marker), false, "the planted program never ran");
});

test("Q98: publishing checks the address Git will push to, so a push-only rewrite is refused too", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "url.https://evil.com/.pushInsteadOf", "https://github.com/"], { cwd });
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd }); // should the check ever miss, nothing leaves this computer
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "", "no remote is left");
});

test("Q101: a refused publish leaves the folder's own remote as it was", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/mine.git"], { cwd });
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://github.com/"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
  assert.equal(execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim(), "https://example.com/mine.git",
    "the folder's own origin is untouched");
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "origin", "the check's own remote is gone");
});

test("Q101: settings for the pushed name kept in the computer's own Git settings are checked too", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  const home = await mkdtemp(join(tmpdir(), "branch-q101-home-"));
  await writeFile(join(home, ".gitconfig"), "[remote \"origin\"]\n\tpushurl = https://evil.example/global.git\n");
  const before = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, ".config");
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  execFileSync("git", ["remote", "add", "origin", "https://example.com/mine.git"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /publishing cannot replace/);
  assert.equal(execFileSync("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim(), "https://example.com/mine.git",
    "refused before the folder's own origin is touched");
});

test("Q101: two publishes at once each check their own address", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd }); // B's push goes nowhere
  execFileSync("git", ["config", "--local", "url.https://evil.example/a.insteadOf", "https://github.com/o/a"], { cwd });
  const runner = app.git.runner, real = runner.run.bind(runner);
  // Hold A right after its own check remote is added, and let B go all the way through meanwhile.
  let letAGo, aAdded;
  const aHeld = new Promise((resolve) => { letAGo = resolve; });
  const aReady = new Promise((resolve) => { aAdded = resolve; });
  runner.run = async (options, signal) => {
    const [verb, action, name, url] = options.args;
    if (verb === "remote" && action === "add" && String(name).startsWith("branch-publish-check") && String(url).includes("/o/a")) {
      const outcome = await real(options, signal); aAdded(); await aHeld; return outcome;
    }
    return real(options, signal);
  };
  t.after(() => { runner.run = real; });
  const a = app.git.publish({ folder, url: "https://github.com/o/a.git", remote: "origin" }, AbortSignal.timeout(20_000));
  await aReady;
  const b = app.git.publish({ folder, url: "https://github.com/o/b.git", remote: "upstream" }, AbortSignal.timeout(20_000)).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 300));
  letAGo();
  await assert.rejects(a, /insteadOf.*redirect/, "A's own address was checked, not B's");
  await b;
  const origin = (() => { try { return execFileSync("git", ["config", "--get-all", "remote.origin.url"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } })();
  assert.equal(origin, "", "origin was never pointed at A's refused address");
});

test("Q101: settings for the pushed name that removing it would leave behind are refused before it is touched", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd });
  // A per-worktree push address survives `git remote remove`.
  execFileSync("git", ["remote", "add", "origin", "https://example.com/mine.git"], { cwd });
  execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd });
  execFileSync("git", ["config", "--worktree", "remote.origin.pushurl", "https://evil.example/x.git"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /publishing cannot replace/);
  assert.equal(execFileSync("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim(), "https://example.com/mine.git");
  // A section spelt in capitals is one Git cannot remove at all.
  execFileSync("git", ["config", "--worktree", "--unset", "remote.origin.pushurl"], { cwd });
  execFileSync("git", ["remote", "remove", "origin"], { cwd });
  const settings = execFileSync("git", ["rev-parse", "--git-path", "config"], { cwd, encoding: "utf8" }).trim();
  await writeFile(join(cwd, settings), `${await (await import("node:fs/promises")).readFile(join(cwd, settings), "utf8")}[Remote "origin"]\n\turl = https://example.com/mine.git\n`);
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /publishing cannot replace/);
  assert.equal(execFileSync("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim(), "https://example.com/mine.git");
});

test("Q101: a settings read that did not finish is not taken as none, and a stop during the check's add leaves no check remote", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd });
  const runner = app.git.runner, real = runner.run.bind(runner);
  t.after(() => { runner.run = real; });
  runner.run = async (options, signal) => (options.args[0] === "config" && options.args.includes("--show-scope") && options.args.at(-1).startsWith("^remote\\.origin")
    ? { ...(await real(options, signal)), status: "timed_out", exitCode: null } : real(options, signal));
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, AbortSignal.timeout(10_000)), /Could not read the Git settings for "origin"/);
  // A stop that lands while the check remote is being added: the add goes through, and the remote is still taken away.
  const stop = new AbortController();
  runner.run = async (options, signal) => {
    const outcome = await real(options, signal);
    if (options.args[0] === "remote" && options.args[1] === "add" && String(options.args[2]).startsWith("branch-publish-check")) {
      stop.abort();
      return { ...outcome, status: "cancelled" };
    }
    return outcome;
  };
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, stop.signal));
  assert.doesNotMatch(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }), /branch-publish-check/, "no check remote is left behind");
});

test("Q101: a settings read that failed for any reason but \"no such settings\" is not taken as none", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd });
  const runner = app.git.runner, real = runner.run.bind(runner);
  t.after(() => { runner.run = real; });
  // Git ends the read with exit 1 when there are no such settings; a settings file it cannot read ends it with another code.
  runner.run = async (options, signal) => (options.args[0] === "config" && options.args.includes("--show-scope") && options.args.at(-1).startsWith("^remote\\.origin")
    ? { ...(await real(options, signal)), status: "failed", exitCode: 128 } : real(options, signal));
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, AbortSignal.timeout(10_000)), /Could not read the Git settings for "origin"/);
});


test("Q98: git.push and publishing send the branch as refs/heads/<name>, the ref the contract walks", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd });
  const runner = app.git.runner, real = runner.run.bind(runner);
  const pushed = [];
  runner.run = async (options, signal) => { if (options.args[0] === "push") pushed.push(options.args.at(-1)); return real(options, signal); };
  t.after(() => { runner.run = real; });
  for (const branch of ["worktrees/self-x/HEAD", "ORIG_HEAD", "side"])
    await app.git.push({ folder, remote: "origin", branch }, AbortSignal.timeout(10_000)).catch(() => undefined);
  await app.git.publish({ folder, url: "https://github.com/o/p.git", remote: "upstream", branch: "main-worktree/HEAD" }, AbortSignal.timeout(10_000)).catch(() => undefined);
  assert.deepEqual(pushed, ["worktrees/self-x/HEAD", "ORIG_HEAD", "side", "main-worktree/HEAD"].map((name) => `refs/heads/${name}:refs/heads/${name}`));
});

test("Q103: a read of what removing the name would leave that does not finish counts as something left", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://example.com/mine.git"], { cwd });
  const runner = app.git.runner, real = runner.run.bind(runner);
  t.after(() => { runner.run = real; });
  runner.run = async (options, signal) => (options.args[0] === "config" && options.args[1] === "--file" && options.args[3] === "--get-regexp"
    ? { ...(await real(options, signal)), status: "timed_out", exitCode: null } : real(options, signal));
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, AbortSignal.timeout(10_000)), /publishing cannot replace/);
  assert.equal(execFileSync("git", ["config", "--local", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim(), "https://example.com/mine.git");
});

test("Q98: a push with no branch, or HEAD, sends the branch checked out, never a tag named HEAD", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "--local", "http.proxy", "http://127.0.0.1:9"); // should anything be sent, it never leaves this computer
  git("remote", "add", "origin", "https://github.com/o/r.git");
  const orphan = git("commit-tree", git("mktree"), "-m", "orphan");
  git("update-ref", "refs/tags/HEAD", orphan); // what `git tag HEAD` made in older Git; newer Git refuses the name
  const runner = app.git.runner, real = runner.run.bind(runner);
  const pushed = [];
  runner.run = async (options, signal) => { if (options.args[0] === "push") pushed.push(options.args.at(-1)); return real(options, signal); };
  t.after(() => { runner.run = real; });
  const signal = () => AbortSignal.timeout(10_000);
  await app.git.push({ folder, remote: "origin" }, signal()).catch(() => undefined);
  await app.git.push({ folder, remote: "origin", branch: "HEAD" }, signal()).catch(() => undefined);
  await app.git.publish({ folder, url: "https://github.com/o/p.git", remote: "upstream", branch: "HEAD" }, signal()).catch(() => undefined);
  assert.deepEqual(pushed, Array(3).fill("refs/heads/feature:refs/heads/feature"));
  // Detached, there is no branch to send: refused before anything is pushed or any remote is added.
  git("checkout", "-q", "--detach");
  await assert.rejects(app.git.push({ folder, remote: "origin" }, signal()), /HEAD is detached/);
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "HEAD" }, signal()), /HEAD is detached/);
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/q.git", remote: "other" }, signal()), /HEAD is detached/);
  assert.equal(pushed.length, 3, "nothing more was pushed");
  assert.doesNotMatch(git("remote"), /other/, "no remote was added");
});

test("Q98: sending to main or master asks first however the branch is written, or when it is the one checked out", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "--local", "http.proxy", "http://127.0.0.1:9");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  git("checkout", "-q", "-b", "main");
  const runner = app.git.runner, real = runner.run.bind(runner);
  const pushed = [];
  runner.run = async (options, signal) => { if (options.args[0] === "push") pushed.push(options.args.at(-1)); return real(options, signal); };
  t.after(() => { runner.run = real; });
  for (const branch of [undefined, "HEAD", "main", "refs/heads/main", "refs/heads/Master"])
    await assert.rejects(app.git.push({ folder, remote: "origin", branch }, AbortSignal.timeout(10_000)), /straight to "(main|Master)"/, String(branch));
  assert.deepEqual(pushed, [], "nothing is sent before the person says yes");
});

test("Q104: a push lands on the branch it names, never where an alias of main or a push mapping would send it", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-push-lands-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const cwd = join(root, "workspace", "work", "r"), bare = join(root, "remote.git");
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "first");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  git("remote", "add", "origin", bare);
  const landed = () => execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: bare, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  // An alias of main the owner made: a branch that is a symbolic ref to it.
  git("symbolic-ref", "refs/heads/trunk", "refs/heads/main");
  await app.git.push({ folder: "work/r", remote: "origin", branch: "trunk" }, AbortSignal.timeout(10_000));
  assert.deepEqual(landed(), ["refs/heads/trunk"], "on trunk, not on main");
  // A push mapping that sends feature to main.
  git("branch", "feature");
  git("config", "remote.origin.push", "refs/heads/feature:refs/heads/main");
  await app.git.push({ folder: "work/r", remote: "origin", branch: "feature" }, AbortSignal.timeout(10_000));
  assert.deepEqual(landed(), ["refs/heads/feature", "refs/heads/trunk"], "on feature, not on main");
});

test("Q109: a push from Branch's source sends exactly the commit the guard walked, even if the branch moves after", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-walked-push-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const source = join(workspace, "branch-agent-source"), folder = "branch-agent-source/.branch-worktrees/self-x";
  await mkdir(source, { recursive: true });
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-q", "-b", "main");
  git(source, "commit", "-q", "--allow-empty", "-m", "source");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "worktree", "add", "-q", "-b", "branch/self-x", join(workspace, folder));
  const worktree = join(workspace, folder);
  git(worktree, "commit", "-q", "--allow-empty", "-m", "the work");
  const walked = git(worktree, "rev-parse", "HEAD");
  const orphan = git(worktree, "commit-tree", git(worktree, "mktree"), "-m", "never walked");
  git(source, "config", "--local", "http.proxy", "http://127.0.0.1:9"); // nothing leaves this computer
  git(source, "remote", "add", "origin", "https://github.com/o/r.git");
  new ContractBook(app.store.sqlite).create(app.runtime.owner, { taskRunId: "run-1", sourceSha: base, worktreePath: folder, terms: {
    allowedPaths: ["**"], permissions: ["git.push", "github.publish_repo"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" },
    sendRepositories: ["o/r"] });
  const { registerGitRemote, registerGitHubProject } = await import("../dist/integrations/git-tools.js");
  registerGitRemote(app.registry, app.git);
  // Publishing is a push too: the repository it makes is a double, and the dead proxy refuses its send as well.
  registerGitHubProject(app.registry, { createRepo: async (input) => ({ repository: `o/${input.name}` }) }, app.git);
  // Another run moves the branch, or switches the worktree to another one, right after this push was walked.
  let move = () => undefined;
  const guard = app.registry.beforeTool;
  app.registry.beforeTool = async (...call) => { const held = await guard(...call); move(); return held; };
  const runner = app.git.runner, real = runner.run.bind(runner);
  const pushed = [];
  runner.run = async (options, signal) => { if (options.args[0] === "push") pushed.push(options.args.at(-1)); return real(options, signal); };
  t.after(() => { runner.run = real; app.registry.beforeTool = guard; });
  const run = app.store.createRun(app.runtime.owner, "push");
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  const moves = [() => git(worktree, "reset", "-q", "--hard", orphan), () => git(worktree, "switch", "-q", "-C", "moved", orphan)];
  // No branch, the branch by name, and HEAD (resolved by the guard, never re-read by the tool), for both ways of sending.
  // selfdev: publishing Branch's own source is refused outright, and a push sends only a branch/… line.
  const calls = [
    ["git.push", { folder, remote: "origin" }], ["git.push", { folder, remote: "origin", branch: "branch/self-x" }], ["git.push", { folder, remote: "origin", branch: "HEAD" }],
  ];
  for (const [tool, args] of calls)
    for (const next of moves) {
      git(worktree, "switch", "-q", "branch/self-x");
      git(worktree, "reset", "-q", "--hard", walked);
      move = next;
      await app.registry.execute(tool, args, context).catch(() => undefined); // the dead proxy refuses the send
    }
  assert.deepEqual(pushed, Array(6).fill(`${walked}:refs/heads/branch/self-x`), "the walked commit, to the walked branch");
});
