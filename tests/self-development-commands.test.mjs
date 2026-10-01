/**
 * Q12: commands and Branch's own source. A command's text cannot be read reliably (globs, variables),
 * so it is never parsed. The folder it runs in is judged exactly where the shell tool runs it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { ContractBook, contractGuard } from "../dist/self-development-contract.js";
import { gitFoldersUnder, sweepNewGitFolders } from "../dist/integrations/shell.js";
import { EditChecks } from "../dist/coding/format-on-edit.js";
import { wallReport } from "../dist/sandbox-backends.js";
import { sandboxExecPath, seatbeltArgs } from "../dist/sandbox-seatbelt.js";
import { execFileSync } from "node:child_process";
import { AuditLog } from "../dist/audit.js";
import { ToolRegistry } from "../dist/registry.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";

const sha = "e".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const original = "export const main = 1;\n";

/** A real Branch with a shell (`sh`), Branch's source checked out, a worktree, and a model that runs the given commands. */
export async function withSource(t, options = {}) {
  let commands = [];
  const root = await mkdtemp(join(tmpdir(), "branch-self-commands-"));
  let at = 0;
  const provider = { name: "scripted", async complete() {
    const call = commands[at++];
    return call ? { content: "", toolCalls: [{ id: `c${at}`, name: "shell.execute", arguments: JSON.stringify(call) }] } : { content: "Done.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const config = join(root, "integrations.json");
  await writeFile(config, JSON.stringify({ shell: { executables: { sh: { path: "/bin/sh", args: [] } }, timeoutMs: 10000 } }));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "off", unmatchedCommands: "allow" });
  await mkdir(join(workspace, "branch-agent-source", "src"), { recursive: true });
  await writeFile(join(workspace, "branch-agent-source", "src", "main.ts"), original);
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  const project = options.project ?? "notes";
  if (project !== "none") app.store.projects.save(owner, { id: project === "notes" ? "notes" : "branch-agent-remove-button", name: project, instructions: "",
    modelPreset: null, repository: "", folder: project === "notes" ? "notes" : worktree, profile: null, knowledgeBases: [], branch: "" });
  if (project !== "none") app.store.projects.setActive(owner, { active: project === "notes" ? "notes" : "branch-agent-remove-button" });
  if (options.permissions) new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**", "notes.txt"], permissions: options.permissions, expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "done",
    sideEffects: [], rollbackPlan: "Remove the worktree" } });
  /** One fresh conversation whose model runs this one command. */
  const command = async (call) => {
    commands = [call]; at = 0;
    const run = await app.runtime.run({ prompt: "Run it" });
    const events = app.store.events(run.id);
    return { run, failed: events.filter((event) => event.kind === "tool.failed").map((event) => event.data.error)[0] ?? null,
      result: events.find((event) => event.kind === "tool.completed")?.data.result ?? null };
  };
  return {
    app, workspace, command,
    protectedFile: () => readFile(join(workspace, "branch-agent-source", "src", "main.ts"), "utf8"),
    refusals: () => app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused"),
  };
}

test("a command's folder is judged where the shell runs it, not inside the active project", { skip: process.platform === "win32" }, async (t) => {
  const branch = await withSource(t, { permissions: ["files.write"] });
  for (const cwd of [worktree, "branch-agent-source"]) {
    const { failed } = await branch.command({ executable: "sh", args: ["-c", "echo PWNED > marker.txt"], cwd });
    assert.match(failed ?? "", /self-development contract/, cwd);
  }
  assert.equal(existsSync(join(branch.workspace, worktree, "marker.txt")), false, "nothing written in the worktree");
  assert.equal(existsSync(join(branch.workspace, "branch-agent-source", "marker.txt")), false, "nothing written in the checkout");
  assert.equal(branch.refusals().length, 2);
});

/** NAS's repro: a glob names the protected checkout, so no reading of the command's text could catch it. */
export const globRepro = { executable: "sh", args: ["-c", "for f in branch?agent-source/src/main.ts; do echo PWNED >> $f; done"] };

test("while Branch's source is checked out, a command outside a worktree is refused and audited, whatever its text", { skip: process.platform === "win32" }, async (t) => {
  const branch = await withSource(t, { project: "none" });
  const { failed, result } = await branch.command(globRepro);
  assert.equal(result, null, "the command never ran");
  assert.match(failed ?? "", /While Branch's own source is checked out in this workspace, a command runs only inside the active self-development worktree/);
  assert.equal(await branch.protectedFile(), original, "the protected file is unchanged");
  const [entry] = branch.refusals();
  assert.match(entry?.subject ?? "", /^shell\.execute in /);
  assert.equal(entry.source, "system");
});

test("a command in the worktree, listed in its contract, runs behind the real OS sandbox with writes held to the folder it runs in",
  { skip: process.platform === "win32" || !(await wallReport()).available }, async (t) => {
  const branch = await withSource(t, { project: "worktree", permissions: ["shell.execute"] });
  // Run from src/ui, which the contract's src/ui/** covers whole: writes are held to that folder.
  const { failed, result } = await branch.command({ executable: "sh", cwd: `${worktree}/src/ui`,
    args: ["-c", "echo ok > inside.txt; echo PWNED >> ../../../../src/main.ts; for f in ../../../../src/main.ts; do echo PWNED >> $f; done; echo x > ../../package.json"] });
  assert.equal(failed, null, failed);
  assert.equal(await readFile(join(branch.workspace, worktree, "src", "ui", "inside.txt"), "utf8"), "ok\n", "a write in the allowed folder works");
  assert.equal(await branch.protectedFile(), original, "the sandbox blocked the write to the protected checkout");
  assert.equal(existsSync(join(branch.workspace, worktree, "package.json")), false, "and the write outside the allowed folder");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.target.cwd.endsWith(join("self-remove-button", "src", "ui")), true);
  // From the worktree itself the contract's src/ui/** does not cover the folder, so it is refused first.
  const { failed: wide } = await branch.command({ executable: "sh", cwd: worktree, args: ["-c", "ls"] });
  assert.match(wide ?? "", /works on the whole of the worktree/);
});

/** The guard alone with a stand-in sandbox check: `confinement` is a test double for "this computer can hold writes to one folder". */
function guardWith(t, confinement, scope = worktree) {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), "branch-self-confine-"));
    t.after(() => discardTemp(root));
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, worktree), { recursive: true });
    const db = new DatabaseSync(":memory:");
    const book = new ContractBook(db), log = new AuditLog(db), registry = new ToolRegistry();
    registry.pathScope = () => scope;
    for (const [name, permission] of [["shell.execute", "shell.execute"], ["code.run", "code.execute"], ["process.start", "process.manage"]])
      registry.register({ name, permission, description: "double", parameters: z.object({ cwd: z.string().optional() }).passthrough(), execute: async () => ({}) });
    book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: { allowedPaths: ["src/**"],
      permissions: ["shell.execute", "code.run", "process.start"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } });
    const guard = contractGuard({ store: { audit: log, get: () => undefined, events: () => [] }, owner: "local", workspace, registry, book, git: async () => { throw new Error("no git"); }, confinement });
    return { guard, log, workspace };
  })();
}

test("the stand-in sandbox: available holds the command to the worktree, missing refuses every command plainly", async (t) => {
  const yes = await guardWith(t, async () => true);
  const held = await yes.guard("shell.execute", { cwd: `${worktree}/src` }, { runId: "r" });
  assert.equal(held.writesConfinedTo, join(yes.workspace, worktree, "src"), "held to the folder it runs in");
  await assert.rejects(yes.guard("code.run", { cwd: worktree }, { runId: "r" }), /cannot hold the program it starts to one folder/);
  // SELF-304: a program left running is walled by the shell the same way, so it is held to the folder it runs in too.
  const left = await yes.guard("process.start", { cwd: `${worktree}/src` }, { runId: "r" });
  assert.equal(left.writesConfinedTo, join(yes.workspace, worktree, "src"));
  const no = await guardWith(t, async () => false);
  await assert.rejects(no.guard("shell.execute", { cwd: `${worktree}/src` }, { runId: "r" }),
    /commands are refused on this computer: it has no sandbox that can hold a command's writes to one folder/);
  assert.equal(no.log.list("local", { action: "self_development.contract" }).length, 1);
});

test("the shell still refuses a cwd with .. or a full path, as before the shared resolver", { skip: process.platform === "win32" }, async (t) => {
  const branch = await withSource(t, { project: "none" });
  // No self-development checkout here would change the answer: take the checkout away for this one.
  await rm(join(branch.workspace, "branch-agent-source"), { recursive: true, force: true });
  for (const cwd of ["notes/../notes", join(branch.workspace, "notes")]) {
    const { failed, result } = await branch.command({ executable: "sh", args: ["-c", "echo x > made.txt"], cwd });
    assert.equal(result, null, cwd);
    assert.match(failed ?? "", /Path denied: traversal/, cwd);
  }
  assert.equal(existsSync(join(branch.workspace, "notes", "made.txt")), false);
});

/**
 * Q155: the Git that really runs. /usr/bin/git on macOS is a shim that starts xcodebuild first, which took 2-3 s here
 * and, on a loaded runner, past the command's 10 s: the shell was cut off before its ordinary writes.
 */
function realGit() {
  try { return execFileSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "/usr/bin/git"; }
  catch { return "/usr/bin/git"; }
}

test("on Linux a held command sees /run and the home empty, but for the folders of the programs it runs",
  { skip: process.platform !== "linux" || !(await wallReport()).available }, async (t) => {
  const branch = await withSource(t, { project: "worktree", permissions: ["shell.execute"] });
  // Full paths: this shell is given no search path. The home is read from the system, not the environment.
  const script = [
    'h=$(/usr/bin/getent passwd "$(/usr/bin/id -u)" | /usr/bin/cut -d: -f6)',
    'echo "HOME=$h"', "/bin/ls -A /run", "echo SPLIT", '/bin/ls -A "$h"', "echo END"].join("; ");
  const { failed, result } = await branch.command({ executable: "sh", cwd: `${worktree}/src/ui`, args: ["-c", script] });
  assert.equal(failed, null, failed);
  const out = String(result?.stdout ?? "");
  assert.match(out, /^HOME=\/\S+\n[\s\S]*SPLIT\n[\s\S]*END\n$/, `the listing really ran: ${out} ${String(result?.stderr ?? "")}`);
  const [run, home] = out.replace(/^HOME=.*\n/, "").replace(/END\n$/, "").split("SPLIT\n");
  assert.equal(run.trim(), "", "nothing of /run shows: no message bus, no package daemon, no per-user sockets");
  // Only the first folder on the way to a program's own folder (a version manager's, say) may show in the home.
  const allowed = new Set([".nvm", ".local", ".volta", ".asdf", ".fnm", ".n", "bin", "lib"]);
  for (const name of home.trim().split("\n").filter(Boolean)) assert.ok(allowed.has(name), `${name} in the home is hidden`);
});

test("on Linux a held command given a file it could not see is refused before it runs, saying why and what works instead",
  { skip: process.platform !== "linux" || !(await wallReport()).available }, async (t) => {
  const branch = await withSource(t, { project: "worktree", permissions: ["shell.execute"] });
  const loose = join(branch.workspace, "..", "loose.sh");
  await writeFile(loose, "echo ran\n");
  const { failed, result } = await branch.command({ executable: "sh", cwd: `${worktree}/src/ui`, args: [loose] });
  assert.equal(result, null, "nothing ran");
  assert.match(failed ?? "", /loose\.sh is in \/tmp, which a command held to its folder cannot see \(only its worktree and the folders of the programs it runs are shown there\), so it did not run\. Move the file into the worktree and run it from there\./);
});

test("a held command cannot make a .git anywhere in its folder: the real sandbox refuses it", { skip: process.platform !== "darwin" || !(await wallReport()).available }, async (t) => {
  const branch = await withSource(t, { project: "worktree", permissions: ["shell.execute"] });
  const { failed, result } = await branch.command({ executable: "sh", cwd: `${worktree}/src/ui`,
    // The shell starts with no PATH of its own, so the programs are named in full.
    // The ordinary writes come first, so the controls below never depend on how long the refused steps take.
    args: ["-c", `echo ok > fine.txt; /bin/mkdir -p z && echo ok > z/also.txt; /bin/mkdir -p x/.git; echo '[core] fsmonitor = /tmp/evil' > x/.git/config; /bin/mkdir -p y && ${realGit()} init -q y; /bin/mkdir -p w/.GIT v/.Git; echo ran-to-the-end`] });
  assert.equal(failed, null, failed);
  assert.notEqual(result?.status, "timed_out", `the command was cut off after ${result?.durationMs} ms, before its checks could mean anything`);
  assert.match(String(result?.stdout ?? ""), /ran-to-the-end/, "the whole command ran (the programs really ran)");
  assert.doesNotMatch(result.stderr, /Branch removed the \.git/, "the sandbox refused it: nothing was left for the sweep");
  const ui = join(branch.workspace, worktree, "src", "ui");
  assert.equal(existsSync(join(ui, "fine.txt")), true, "an ordinary write in the folder works");
  assert.equal(existsSync(join(ui, "z", "also.txt")), true, "and so does an ordinary new folder");
  for (const planted of ["x/.git/config", "x/.git", "y/.git", "w/.GIT", "v/.Git"]) assert.equal(existsSync(join(ui, planted)), false, planted);
});

test("where the sandbox cannot refuse it (Linux), a .git a held command made is removed afterwards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-sweep-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "old", ".git"), { recursive: true });
  const before = await gitFoldersUnder(root);
  await mkdir(join(root, "x", "deep", ".git"), { recursive: true });
  await writeFile(join(root, "x", "deep", ".git", "config"), "[core]\n\tfsmonitor = /tmp/evil\n");
  await mkdir(join(root, "w", ".GIT"), { recursive: true });
  await writeFile(join(root, "y.txt"), "kept");
  assert.deepEqual((await sweepNewGitFolders(root, before)).sort(), [join("w", ".GIT"), join("x", "deep", ".git")].sort(), "any case");
  assert.equal(existsSync(join(root, "x", "deep", ".git")), false, "the planted one is gone");
  assert.equal(existsSync(join(root, "old", ".git")), true, "one that was there before stays");
  await assert.rejects(gitFoldersUnder(root, 2), /too many files for Branch to check/);
});

test("with no project active, a command whose folder is in a worktree is still refused (on any computer)", async (t) => {
  // The stand-in sandbox says yes, so only the rule that a command runs from the active worktree can refuse it.
  const none = await guardWith(t, async () => true, "");
  await assert.rejects(none.guard("shell.execute", { cwd: `${worktree}/src` }, { runId: "r" }),
    /a command runs only inside the active self-development worktree/);
  const other = await guardWith(t, async () => true, "notes");
  await assert.rejects(other.guard("shell.execute", { cwd: `${worktree}/src` }, { runId: "r" }),
    /a command runs only inside the active self-development worktree/);
  // selfdev: the task that prepared the worktree keeps its conversation's project, and may run commands in it by cwd.
  const own = await other.guard("shell.execute", { cwd: `${worktree}/src` }, { runId: "run-1" });
  assert.equal(own.writesConfinedTo, join(other.workspace, worktree, "src"), "held to the folder it runs in");
});

test("no formatter runs after an edit while Branch's own source is checked out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-format-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const workspace = app.runtime.workspace;
  app.coding.setMode("format-on-edit", "on");
  const formatter = join(root, "bin", "fmt");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(formatter, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const calls = [];
  const checks = new EditChecks({ store: app.store, owner: app.runtime.owner, files: app.coding["deps"].files,
    runner: async (run) => { calls.push(run); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
    areas: () => app.runtime.protectedAreas, servers: { enabled: () => false }, trusted: () => true, wall: () => ({ network: "none" }),
    walled: async (run, start) => run(start) });
  await checks.save({ formatters: { fmt: { path: formatter, args: ["{file}"], extensions: [".ts"] } } });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "x");
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "edit").id });
  assert.equal((await checks.check("src/a.ts", context)).formatter, "fmt");
  assert.equal(calls.length, 1, "with no checkout the formatter runs");
  await mkdir(join(workspace, "branch-agent-source"), { recursive: true });
  const held = await checks.check("src/a.ts", context);
  assert.match(held.note ?? "", /Branch's own source is checked out in this workspace, and no formatter runs while it is/);
  assert.equal(calls.length, 1, "with the checkout there it does not");
});

test("only a held command's sandbox refuses .git; an ordinary walled command keeps its repositories", { skip: process.platform !== "darwin" }, async (t) => {
  // The sandbox matches paths as the system names them (/private/var, not /var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-self-wall-")));
  t.after(() => discardTemp(root));
  const run = (held) => {
    const workspace = join(root, held ? "held" : "plain");
    execFileSync("/bin/mkdir", ["-p", workspace, join(root, "scratch")]);
    const args = seatbeltArgs({ workspace, network: "none", temp: [join(root, "scratch")], held },
      { executable: "/bin/sh", args: ["-c", "/bin/mkdir -p proj/.git deep/a/.Git; echo ok > ok.txt"] });
    try { execFileSync(sandboxExecPath, args, { cwd: workspace, stdio: "ignore" }); } catch { /* a refused mkdir exits non-zero */ }
    return (path) => existsSync(join(workspace, path));
  };
  const plain = run(false);
  assert.equal(plain("ok.txt"), true);
  assert.equal(plain("proj/.git"), true, "an ordinary walled command may make a repository");
  const held = run(true);
  assert.equal(held("ok.txt"), true);
  assert.equal(held("proj/.git"), false);
  assert.equal(held("deep/a/.Git"), false, "in any case");
});
