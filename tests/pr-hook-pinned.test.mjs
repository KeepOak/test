/**
 * A pull request from Branch's own source sends exactly the history its contract checked plus the one
 * new commit made on it, whatever else moves HEAD or the new branch meanwhile. Real Git in a real
 * self-development worktree; the push is a stand-in that reads what Git would send at that moment,
 * and GitHub is a stand-in too, so nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { createBranch, NetworkPolicy } from "../dist/index.js";
import { GitRunner } from "../dist/integrations/git-run.js";
import { pullRequestFromChanges, savePullRequestHookSettings } from "../dist/pr-hook.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const posixOnly = process.platform === "win32" && "real Git in a self-development worktree is exercised on macOS and Linux";
const folder = "branch-agent-source/.branch-worktrees/self-x";
const plain = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const scripted = () => ({ name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } });

/**
 * Branch's source with a self-development worktree whose contract allows `src/ui/**`: `walked` is the
 * worktree's commit, `other` is the tip of another branch two commits past it that adds a file the
 * contract does not allow, and the task's change is a new file under src/ui that is not committed yet.
 */
async function sourceWorktree(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-pr-pinned-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: scripted() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, source = join(workspace, "branch-agent-source"), worktree = join(workspace, folder);
  await mkdir(source, { recursive: true });
  plain(source, "init", "-q", "-b", "main");
  plain(source, "config", "user.name", "t");
  plain(source, "config", "user.email", "t@t");
  plain(source, "config", "http.proxy", "http://127.0.0.1:9"); // nothing leaves this computer
  plain(source, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  plain(source, "commit", "-q", "--allow-empty", "-m", "source");
  const base = plain(source, "rev-parse", "HEAD");
  plain(source, "worktree", "add", "-q", "-b", "self-x", worktree);
  await mkdir(join(worktree, "src", "ui"), { recursive: true });
  await writeFile(join(worktree, "src", "ui", "button.ts"), "export const button = 1;\n");
  plain(worktree, "add", "src");
  plain(worktree, "commit", "-q", "-m", "the work so far");
  const walked = plain(worktree, "rev-parse", "HEAD");
  plain(worktree, "switch", "-q", "-c", "owner-extra");
  await mkdir(join(worktree, ".github", "workflows"), { recursive: true });
  await writeFile(join(worktree, ".github", "workflows", "extra.yml"), "on: push\n");
  plain(worktree, "add", ".github");
  plain(worktree, "commit", "-q", "-m", "other work, part one");
  await writeFile(join(worktree, ".github", "workflows", "extra.yml"), "on: [push, pull_request]\n");
  plain(worktree, "commit", "-q", "-am", "other work, part two");
  const others = plain(worktree, "rev-list", `${walked}..HEAD`).split("\n");
  plain(worktree, "switch", "-q", "self-x");
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: base, worktreePath: folder, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["github.pull_request_from_changes", "github.open_pull_request"],
    expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "The new control is there", sideEffects: ["a draft pull request"],
    rollbackPlan: "Close the pull request" }, sendRepositories: ["acme/widgets"] });
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in for GitHub",
    parameters: z.object({}).passthrough(), execute: async (args) => args });
  app.store.projects.save(owner, { id: "branch-agent-self-x", name: "Branch Agent: self-x", instructions: "", modelPreset: null,
    repository: "acme/widgets", folder, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: "branch-agent-self-x" });
  const change = () => writeFile(join(worktree, "src", "ui", "new.ts"), "export const control = true;\n");
  await change();
  return { app, owner, worktree, walked, others, other: others[0], change };
}

/**
 * The hook's own dependencies with real Git. `before` runs just before each Git command (the push
 * included) and `after` right after one. The push itself is a stand-in: it reads the commit Git would
 * send at that moment and its history, then leaves what a real push leaves (the remote-tracking ref,
 * and the upstream when `--set-upstream` names a branch).
 */
function hookDeps(app, owner, hooks = {}) {
  const runner = new GitRunner();
  const calls = [], pushed = [], opened = [];
  const git = async (options, signal) => {
    const args = options.args;
    calls.push(args);
    await hooks.before?.(args);
    if (args[0] === "push") {
      const [from, to] = args.at(-1).split(":");
      const sent = plain(options.cwd, "rev-parse", "--verify", `${from}^{commit}`);
      pushed.push({ refspec: args.at(-1), sent, history: plain(options.cwd, "rev-list", sent).split("\n") });
      const name = to.replace(/^refs\/heads\//, "");
      plain(options.cwd, "update-ref", `refs/remotes/origin/${name}`, sent);
      if (args.includes("--set-upstream") && from.startsWith("refs/heads/")) {
        plain(options.cwd, "config", `branch.${from.slice("refs/heads/".length)}.remote`, args.at(-2));
        plain(options.cwd, "config", `branch.${from.slice("refs/heads/".length)}.merge`, to);
      }
      return { status: "completed", stdout: "", stderr: "", exitCode: 0, command: "git push" };
    }
    const outcome = await runner.run(options, signal);
    await hooks.after?.(args, options.cwd);
    return outcome;
  };
  return {
    calls, pushed, opened,
    value: { store: app.store, owner, files: app.files, git, registry: app.registry,
      policy: new NetworkPolicy({ allowPrivateAddresses: true }),
      runTool: async (name, args) => { opened.push({ name, args }); return { number: 7 }; } },
  };
}
const committed = (args) => args[0] === "--literal-pathspecs" && args[1] === "commit";
const ask = (name) => ({ name, title: "Add the new control", summary: "Why merge this: the new control is needed.",
  paths: ["src/ui/new.ts"], base: "redesign/window", signal: AbortSignal.timeout(60_000) });

test("from Branch's own source, the pull request sends the checked commit plus one new commit, and the new branch tracks what was sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, others } = await sourceWorktree(t);
    const d = hookDeps(app, owner);
    const opened = await pullRequestFromChanges(d.value, ask("pinned"));
    assert.equal(opened.branch, "branch/pinned");
    const made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    assert.equal(plain(worktree, "rev-parse", `${made}^`), walked, "one new commit, right on the checked one");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, made).split("\n"), ["src/ui/new.ts"]);
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "the new commit is what is sent");
    assert.equal(d.pushed[0].refspec.split(":")[1], "refs/heads/branch/pinned", "to a branch of the same name");
    assert.equal(others.some((commit) => d.pushed[0].history.includes(commit)), false);
    assert.deepEqual([plain(worktree, "config", "branch.branch/pinned.remote"), plain(worktree, "config", "branch.branch/pinned.merge")],
      ["origin", "refs/heads/branch/pinned"], "the new branch tracks the branch it was sent to, as before");
    assert.deepEqual(d.opened.map((each) => [each.name, each.args.head, each.args.base]), [["github.open_pull_request", "branch/pinned", "redesign/window"]]);
  });

test("from Branch's own source, the new branch starts at the commit the contract checked, wherever HEAD has been moved since",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, others, change } = await sourceWorktree(t);
    const moves = {
      "another branch is switched to": () => plain(worktree, "switch", "-q", "owner-extra"),
      "the branch in use is reset to other work": () => plain(worktree, "reset", "-q", "--hard", other),
    };
    let count = 0;
    for (const [what, move] of Object.entries(moves)) {
      plain(worktree, "switch", "-q", "-f", "self-x");
      plain(worktree, "reset", "-q", "--hard", walked);
      await change();
      let moved = false;
      const d = hookDeps(app, owner, { before: (args) => {
        if (!moved && args[0] === "switch" && args[1] === "--create") { moved = true; move(); }
      } });
      const head = `branch/pinned-${++count}`;
      await pullRequestFromChanges(d.value, ask(`pinned-${count}`));
      assert.equal(moved, true, what);
      assert.equal(d.pushed.length, 1, what);
      const [{ sent, history }] = d.pushed;
      assert.equal(others.some((commit) => history.includes(commit)), false, `${what}: the other work never reaches the push`);
      assert.equal(plain(worktree, "rev-parse", `${sent}^`), walked, `${what}: one new commit, right on the checked one`);
      assert.equal(plain(worktree, "rev-parse", `refs/heads/${head}`), sent, `${what}: the new branch holds what was sent`);
      assert.equal(d.opened.length, 1, what);
    }
  });

test("from Branch's own source, the push sends the new commit itself, wherever its branch points by the time Git sends",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, other, others } = await sourceWorktree(t);
    let made = "";
    const d = hookDeps(app, owner, {
      after: (args) => { if (committed(args)) made = plain(worktree, "rev-parse", "refs/heads/branch/pinned"); },
      before: (args) => { if (args[0] === "push") plain(worktree, "update-ref", "refs/heads/branch/pinned", other); },
    });
    await pullRequestFromChanges(d.value, ask("pinned"));
    assert.ok(made, "the commit was made");
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "the commit made is what is sent, not what the branch was moved to");
    assert.equal(d.pushed[0].refspec, `${made}:refs/heads/branch/pinned`);
    assert.equal(others.some((commit) => d.pushed[0].history.includes(commit)), false);
  });

test("from Branch's own source, a new branch that is not one new commit on the checked work is refused, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, other } = await sourceWorktree(t);
    const d = hookDeps(app, owner, {
      after: (args) => { if (committed(args)) plain(worktree, "update-ref", "refs/heads/branch/pinned", other); },
    });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a pull request naming a repository the contract was not made from is refused, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner } = await sourceWorktree(t);
    const d = hookDeps(app, owner);
    await assert.rejects(pullRequestFromChanges(d.value, { ...ask("pinned"), targetRepository: "mallory/widgets" }),
      /proposed only to acme\/widgets, where this worktree was made from, so no pull request is opened in mallory\/widgets/);
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, the push goes only to where origin pushed when the worktree was made; repointed, nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree } = await sourceWorktree(t);
    plain(worktree, "remote", "set-url", "--push", "origin", "git@github.com:mallory/widgets.git");
    const d = hookDeps(app, owner);
    await assert.rejects(pullRequestFromChanges(d.value, { ...ask("pinned"), targetRepository: "acme/widgets" }),
      /sent only to acme\/widgets, where this worktree was made from, and origin sends to mallory\/widgets, so nothing is sent/);
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, the new commit is read from its own branch, not from whatever HEAD points at by then",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    // Other work that sits right on the checked commit too, made the way Branch's own Git tools can.
    plain(worktree, "switch", "-q", "-c", "side");
    await writeFile(join(worktree, "src", "ui", "side.ts"), "export const side = 1;\n");
    plain(worktree, "add", "src/ui/side.ts");
    plain(worktree, "commit", "-q", "-m", "side work");
    const side = plain(worktree, "rev-parse", "HEAD");
    plain(worktree, "switch", "-q", "self-x");
    let made = "";
    const d = hookDeps(app, owner, {
      after: (args) => {
        if (!committed(args)) return;
        made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
        plain(worktree, "switch", "-q", "side");
      },
    });
    await pullRequestFromChanges(d.value, ask("pinned"));
    assert.equal(plain(worktree, "rev-parse", `${side}^`), walked);
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "the commit made, not the other branch HEAD was switched to");
    assert.equal(d.pushed[0].history.includes(side), false);
  });

test("from Branch's own source, a change outside the contract is still refused before any branch is made or anything sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree } = await sourceWorktree(t);
    await writeFile(join(worktree, "stray.mjs"), "export {};\n");
    const d = hookDeps(app, owner);
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")), /changed files are outside the contract's allowed paths: stray\.mjs/);
    assert.deepEqual(d.calls.filter((args) => ["switch", "push"].includes(args[0]) || committed(args)), []);
    assert.deepEqual(d.opened, []);
  });

test("from Branch's own source, the commit walked is the one HEAD was read as, even when HEAD moves to clean work before the walk",
  { skip: posixOnly }, async (t) => {
    // HEAD is read on work outside the contract, then moved to clean work before the walk. A walk that read
    // HEAD again would find nothing wrong and send the commit read first, with the other work under it.
    const { app, owner, worktree, walked, other, change } = await sourceWorktree(t);
    plain(worktree, "reset", "-q", "--hard", other);
    await change();
    let moved = false;
    const d = hookDeps(app, owner, { after: (args) => {
      if (!moved && args.join(" ") === "rev-parse --verify --quiet HEAD^{commit}") { moved = true; plain(worktree, "reset", "-q", "--hard", walked); }
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")), /changed files are outside the contract's allowed paths: \.github\/workflows\/extra\.yml/);
    assert.equal(moved, true, "HEAD was moved between the read and the walk");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

/** The hook reading which commit the new branch holds, right before that commit is sent. */
const readsBranch = (args, head) => args[0] === "rev-parse" && args.at(-1) === `refs/heads/${head}^{commit}`;

test("from Branch's own source, a new branch holding a merge is refused, even one on the checked commit that changes only the named file, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, others } = await sourceWorktree(t);
    let merge = "";
    const d = hookDeps(app, owner, { before: (args) => {
      if (merge || !readsBranch(args, "branch/pinned")) return;
      // The new commit's own tree, on the checked commit (first parent) and the other work (second parent).
      merge = plain(worktree, "commit-tree", "refs/heads/branch/pinned^{tree}", "-p", walked, "-p", other, "-m", "merge");
      plain(worktree, "update-ref", "refs/heads/branch/pinned", merge);
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(merge, "the branch held the merge when it was read");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, merge).split("\n"), ["src/ui/new.ts"],
      "against the checked commit, the merge changes only the named file");
    assert.equal(others.every((commit) => plain(worktree, "rev-list", merge).split("\n").includes(commit)), true, "its history holds the other work");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a new commit that sits on other work is refused, even when against the checked commit it changes only the named file",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, others } = await sourceWorktree(t);
    let moved = "";
    const d = hookDeps(app, owner, { before: (args) => {
      if (moved || !readsBranch(args, "branch/pinned")) return;
      // The other work, then the checked files again, then the new commit's own tree: one parent, but not the checked commit.
      const back = plain(worktree, "commit-tree", `${walked}^{tree}`, "-p", other, "-m", "the checked files again");
      moved = plain(worktree, "commit-tree", "refs/heads/branch/pinned^{tree}", "-p", back, "-m", "the new commit, on other work");
      plain(worktree, "update-ref", "refs/heads/branch/pinned", moved);
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(moved, "the branch held the commit on other work when it was read");
    assert.equal(plain(worktree, "rev-list", "--parents", "--max-count=1", moved).split(" ").length, 2, "one parent");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, moved).split("\n"), ["src/ui/new.ts"],
      "against the checked commit, it changes only the named file");
    assert.equal(others.every((commit) => plain(worktree, "rev-list", moved).split("\n").includes(commit)), true, "its history holds the other work");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a new commit that also changes a file the pull request does not name is refused, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, change } = await sourceWorktree(t);
    const extras = {
      "a file the contract does not allow": ".github/workflows/extra.yml",
      "a file the contract allows but the pull request does not name": "src/ui/stray.ts",
    };
    let count = 0;
    for (const [what, extra] of Object.entries(extras)) {
      plain(worktree, "switch", "-q", "-f", "self-x");
      plain(worktree, "reset", "-q", "--hard", walked);
      await change();
      const head = `branch/pinned-${++count}`;
      let amended = "";
      const d = hookDeps(app, owner, { before: async (args) => {
        if (amended || !readsBranch(args, head)) return;
        // The new commit, amended to hold one more file: still one commit, right on the checked one.
        await mkdir(dirname(join(worktree, extra)), { recursive: true });
        await writeFile(join(worktree, extra), "more\n");
        plain(worktree, "add", "--", extra);
        plain(worktree, "commit", "-q", "--amend", "--no-edit");
        amended = plain(worktree, "rev-parse", `refs/heads/${head}`);
      } });
      await assert.rejects(pullRequestFromChanges(d.value, ask(`pinned-${count}`)),
        /is not just one new commit on the checked work .*so nothing was sent/, what);
      assert.ok(amended, `${what}: the branch held the amended commit when it was read`);
      assert.equal(plain(worktree, "rev-parse", `${amended}^`), walked, `${what}: one commit, right on the checked one`);
      assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, amended).split("\n").sort(),
        [extra, "src/ui/new.ts"].sort(), `${what}: the named file and the other one`);
      assert.deepEqual(d.pushed, [], `${what}: nothing was sent`);
      assert.deepEqual(d.opened, [], `${what}: no pull request was opened`);
    }
  });

test("from Branch's own source, a new commit that also changes a submodule pointer the pull request does not name is refused, whatever the submodule settings say",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    let amended = "";
    const d = hookDeps(app, owner, { before: async (args) => {
      if (amended || !readsBranch(args, "branch/pinned")) return;
      // The new commit, amended to point a submodule at vendor/lib as well, with settings that say to
      // ignore that submodule: still one commit, right on the checked one.
      await writeFile(join(worktree, ".gitmodules"), "[submodule \"lib\"]\n\tpath = vendor/lib\n\turl = ./lib\n\tignore = all\n");
      plain(worktree, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
      plain(worktree, "commit", "-q", "--amend", "--no-edit");
      amended = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(amended, "the branch held the amended commit when it was read");
    assert.equal(plain(worktree, "rev-parse", `${amended}^`), walked, "one commit, right on the checked one");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", "--ignore-submodules=none", walked, amended).split("\n"),
      ["src/ui/new.ts", "vendor/lib"], "the named file and the submodule pointer");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a new commit holding only the named files is sent, with a file removed as well as one added and names written with ./",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    await rm(join(worktree, "src", "ui", "button.ts"));
    const d = hookDeps(app, owner);
    const opened = await pullRequestFromChanges(d.value, { ...ask("pinned"), paths: ["./src/ui/new.ts", "src/./ui/button.ts"] });
    assert.deepEqual(opened.files, ["./src/ui/new.ts", "src/./ui/button.ts"]);
    const made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    assert.equal(plain(worktree, "rev-parse", `${made}^`), walked, "one new commit, right on the checked one");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-status", walked, made).split("\n"),
      ["D\tsrc/ui/button.ts", "A\tsrc/ui/new.ts"]);
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "exactly the new commit is sent");
    assert.deepEqual(d.opened.map((each) => each.args.head), ["branch/pinned"]);
  });

/** What Git prints when Branch itself runs it there, with its own settings. */
async function branchSees(cwd, ...args) {
  const outcome = await new GitRunner().run({ cwd, args }, AbortSignal.timeout(20_000));
  assert.equal(outcome.status, "completed", outcome.stderr);
  return outcome.stdout.trim();
}

/**
 * Git can keep replacement objects (`refs/replace/`) and grafts (`info/grafts`) that change the parents
 * and files it shows for a commit, while a push sends the commit as it is stored. In Branch's own source
 * the check reads every commit as it is stored as well.
 */
test("from Branch's own source, the new commit is checked as Git stores it, whatever replacement Git keeps for it, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, change } = await sourceWorktree(t);
    // Each moves the new branch to another commit, which Git is then told to show as the commit made:
    // one parent, the checked commit, and only the named file.
    const moves = {
      "a commit that also changes a file the pull request does not name": async () => {
        await mkdir(join(worktree, ".github", "workflows"), { recursive: true });
        await writeFile(join(worktree, ".github", "workflows", "extra.yml"), "more\n");
        plain(worktree, "add", "--", ".github/workflows/extra.yml");
        plain(worktree, "commit", "-q", "--amend", "--no-edit");
        return plain(worktree, "rev-parse", "HEAD");
      },
      "a merge with other work": async (made) => plain(worktree, "commit-tree", `${made}^{tree}`, "-p", walked, "-p", other, "-m", "merge"),
    };
    let count = 0;
    for (const [what, move] of Object.entries(moves)) {
      plain(worktree, "switch", "-q", "-f", "self-x");
      plain(worktree, "reset", "-q", "--hard", walked);
      await change();
      const head = `branch/pinned-${++count}`;
      let held = "";
      const d = hookDeps(app, owner, { before: async (args) => {
        if (held || !readsBranch(args, head)) return;
        const made = plain(worktree, "rev-parse", `refs/heads/${head}`);
        held = await move(made);
        plain(worktree, "update-ref", `refs/heads/${head}`, held);
        plain(worktree, "replace", held, made);
      } });
      await assert.rejects(pullRequestFromChanges(d.value, ask(`pinned-${count}`)),
        /is not just one new commit on the checked work .*so nothing was sent/, what);
      assert.ok(held, `${what}: the branch held the other commit when it was read`);
      const shown = async (read) => ({
        parents: (await read("rev-list", "--parents", "--max-count=1", held)).split(" ").slice(1),
        files: (await read("diff-tree", "-r", "--no-commit-id", "--name-only", walked, held)).split("\n"),
      });
      const asMade = { parents: [walked], files: ["src/ui/new.ts"] };
      const stored = await shown((...args) => plain(worktree, "--no-replace-objects", ...args));
      assert.deepEqual(await shown((...args) => plain(worktree, ...args)), asMade, `${what}: Git's ordinary reads show the commit made`);
      assert.notDeepEqual(stored, asMade, `${what}: as stored, it is another commit`);
      assert.deepEqual(await shown((...args) => branchSees(worktree, ...args)), stored, `${what}: Branch's own reads show it as stored`);
      assert.deepEqual(d.pushed, [], `${what}: nothing was sent`);
      assert.deepEqual(d.opened, [], `${what}: no pull request was opened`);
      plain(worktree, "replace", "-d", held);
    }
  });

/**
 * A repository's own settings can ask Git to use replacement objects. In Branch's own source the check
 * still reads the new commit as it is stored.
 */
test("from Branch's own source, the new commit is checked as Git stores it even when the repository's own settings ask for replacements, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    plain(worktree, "config", "core.useReplaceRefs", "true");
    let held = "";
    const d = hookDeps(app, owner, { before: async (args) => {
      if (held || !readsBranch(args, "branch/pinned")) return;
      // Another commit on the checked one that also changes a file the pull request does not name,
      // which Git is then told to show as the commit made.
      const made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
      await mkdir(join(worktree, ".github", "workflows"), { recursive: true });
      await writeFile(join(worktree, ".github", "workflows", "extra.yml"), "more\n");
      plain(worktree, "add", "--", ".github/workflows/extra.yml");
      plain(worktree, "commit", "-q", "--amend", "--no-edit");
      held = plain(worktree, "rev-parse", "HEAD");
      plain(worktree, "update-ref", "refs/heads/branch/pinned", held);
      plain(worktree, "replace", held, made);
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(held, "the branch held the other commit when it was read");
    const files = async (read) => (await read("diff-tree", "-r", "--no-commit-id", "--name-only", walked, held)).split("\n");
    assert.deepEqual(await files((...args) => plain(worktree, ...args)), ["src/ui/new.ts"], "Git's ordinary reads show the commit made");
    assert.deepEqual(await files((...args) => branchSees(worktree, ...args)), [".github/workflows/extra.yml", "src/ui/new.ts"],
      "Branch's own reads show it as stored");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, the new commit is checked with the parents Git stores for it, whatever grafts Git keeps, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other } = await sourceWorktree(t);
    const grafts = join(plain(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "grafts");
    let merge = "";
    const d = hookDeps(app, owner, { before: async (args) => {
      if (merge || !readsBranch(args, "branch/pinned")) return;
      // A merge of the new commit's own tree with other work, which Git's grafts then list with one
      // parent, the checked commit.
      merge = plain(worktree, "commit-tree", "refs/heads/branch/pinned^{tree}", "-p", walked, "-p", other, "-m", "merge");
      plain(worktree, "update-ref", "refs/heads/branch/pinned", merge);
      await mkdir(dirname(grafts), { recursive: true });
      await writeFile(grafts, `${merge} ${walked}\n`);
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(merge, "the branch held the merge when it was read");
    assert.equal(plain(worktree, "rev-list", "--parents", "--max-count=1", merge), `${merge} ${walked}`,
      "Git's ordinary reads show one parent, the checked commit");
    assert.deepEqual(plain(worktree, "cat-file", "-p", merge).split("\n").filter((line) => line.startsWith("parent ")),
      [`parent ${walked}`, `parent ${other}`], "as stored, it is a merge with other work");
    assert.equal(await branchSees(worktree, "rev-list", "--parents", "--max-count=1", merge), `${merge} ${walked} ${other}`,
      "Branch's own reads show both parents");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, the pull request still sends exactly the new commit while Git keeps a replacement and a graft for other commits",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, others } = await sourceWorktree(t);
    plain(worktree, "replace", others[0], others[1]);
    const grafts = join(plain(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "grafts");
    await mkdir(dirname(grafts), { recursive: true });
    await writeFile(grafts, `${others[1]}\n`);
    const d = hookDeps(app, owner);
    const opened = await pullRequestFromChanges(d.value, ask("pinned"));
    const made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    assert.deepEqual(plain(worktree, "cat-file", "-p", made).split("\n").filter((line) => line.startsWith("parent ")), [`parent ${walked}`],
      "one new commit, right on the checked one");
    assert.deepEqual(d.pushed.map((each) => each.refspec), [`${made}:refs/heads/branch/pinned`], "exactly the new commit is sent");
    assert.deepEqual(opened.files, ["src/ui/new.ts"]);
    assert.deepEqual(d.opened.map((each) => each.args.head), ["branch/pinned"]);
  });

test("Git run in Branch's own source reads commits as stored, with no replacements, grafts or commit-graph file; elsewhere nothing changes",
  { skip: posixOnly }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "branch-pr-pins-"));
    t.after(() => discardTemp(root));
    // A stand-in Git that prints the two variables and the arguments it was given.
    const program = join(root, "git");
    await writeFile(program, '#!/bin/sh\nprintf \'%s\\n\' "replace=${GIT_NO_REPLACE_OBJECTS-unset}" "grafts=${GIT_GRAFT_FILE-unset}" "$@"\n', { mode: 0o755 });
    const runner = new GitRunner({ locate: async () => program });
    const given = async (cwd) => {
      await mkdir(cwd, { recursive: true });
      const outcome = await runner.run({ cwd, args: ["status"] }, AbortSignal.timeout(20_000));
      assert.equal(outcome.status, "completed", outcome.stderr);
      return outcome.stdout.split("\n");
    };
    const inSource = await given(join(root, "workspace", "branch-agent-source", ".branch-worktrees", "self-x"));
    assert.ok(inSource.includes("replace=1"), "no replacement objects");
    assert.ok(inSource.includes("core.useReplaceRefs=false"), "no replacement objects, whatever the repository's own settings say");
    const grafts = inSource.find((line) => line.startsWith("grafts="))?.slice("grafts=".length) ?? "";
    assert.ok(isAbsolute(grafts) && !existsSync(grafts), `grafts are read from a file that is not there (${grafts})`);
    assert.ok(inSource.includes("core.commitGraph=false"), "no commit-graph file");
    const elsewhere = await given(join(root, "workspace", "project"));
    assert.deepEqual(elsewhere.filter((line) => /^(replace|grafts)=/.test(line)), ["replace=unset", "grafts=unset"],
      "the owner's own repositories are unchanged");
    assert.equal(elsewhere.includes("core.commitGraph=false"), false);
    assert.equal(elsewhere.includes("core.useReplaceRefs=false"), false);
  });

/**
 * A commit-graph file keeps a copy of each commit's parents, and Git believes it over the commit
 * itself. One rewritten to list a merge with one parent must not be read in Branch's own source.
 */
test("Git run in Branch's own source reads a commit's parents from the commit, not from a rewritten commit-graph file",
  { skip: posixOnly }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "branch-pr-graph-"));
    t.after(() => discardTemp(root));
    const source = join(root, "workspace", "branch-agent-source");
    await mkdir(source, { recursive: true });
    plain(source, "init", "-q", "-b", "main");
    plain(source, "commit", "-q", "--allow-empty", "-m", "walked");
    const walked = plain(source, "rev-parse", "HEAD");
    plain(source, "commit", "-q", "--allow-empty", "-m", "other");
    const other = plain(source, "rev-parse", "HEAD");
    const merge = plain(source, "commit-tree", `${other}^{tree}`, "-p", walked, "-p", other, "-m", "merge");
    plain(source, "update-ref", "refs/heads/main", merge);
    plain(source, "-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable", "--no-changed-paths");
    // The file's chunk table names where each list starts; the merge's entry loses its second parent,
    // and the checksum at the end is written again so Git takes the file as it is.
    const graph = join(source, ".git", "objects", "info", "commit-graph");
    const bytes = await readFile(graph);
    const chunk = {};
    for (let i = 0; i <= bytes[6]; i++) chunk[bytes.toString("latin1", 8 + 12 * i, 12 + 12 * i)] = Number(bytes.readBigUInt64BE(12 + 12 * i));
    const count = bytes.readUInt32BE(chunk.OIDF + 255 * 4);
    const at = Array.from({ length: count }, (_, i) => bytes.toString("hex", chunk.OIDL + 20 * i, chunk.OIDL + 20 * i + 20)).indexOf(merge);
    assert.ok(at >= 0, "the merge is in the commit-graph file");
    bytes.writeUInt32BE(0x70000000, chunk.CDAT + 36 * at + 24);
    createHash("sha1").update(bytes.subarray(0, bytes.length - 20)).digest().copy(bytes, bytes.length - 20);
    await chmod(graph, 0o644);
    await writeFile(graph, bytes);
    assert.equal(plain(source, "rev-list", "--parents", "--max-count=1", merge), `${merge} ${walked}`,
      "Git's ordinary reads believe the rewritten file: one parent, the checked commit");
    assert.equal(await branchSees(source, "rev-list", "--parents", "--max-count=1", merge), `${merge} ${walked} ${other}`,
      "Branch's own reads show both parents, as stored");
  });
