/**
 * Wave mac2 (goal-undo): goal mode, the hidden snapshot store, and going back to an earlier message.
 * Every workspace here is a temporary folder; git runs only inside those folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, SnapshotStore, systemGit, parseNameStatus, insideWorkTree, snapshotExcludes, snapshotCaps, secretName,
  GoalMode, parseGoalCommand, goalDoneScore, goalStuckRounds, goalUndoSettings, saveGoalUndoSettings,
} from "../dist/index.js";
import { locateGit } from "../dist/integrations/git-run.js";
import { startServer } from "../dist/server.js";
/* The old window's goal.js and rewind.js went with it (#291). Their pure page helpers are tested only while they exist;
   the new window's goal strip and rewind are proved against the engine by design/redesign/tools/verify-places.cjs and
   verify-conv-messages.cjs. Everything the engine does here keeps running. */
const oldWindow = await Promise.all([import("../public/goal.js"), import("../public/rewind.js")]).catch(() => null);
const oldGone = oldWindow ? false : "the old window's goal.js and rewind.js were removed with it (#291); the new window is verified against the engine instead";
const { parseGoalLine, stripModel, formatElapsed } = oldWindow?.[0] ?? {};
const { isUndoThat } = oldWindow?.[1] ?? {};
const userEntries = (view) => (view?.messages ?? []).filter((m) => m.role === "user").map((m) => ({ messageId: m.messageId, content: m.content }));

const locale = async (name) => JSON.parse(await readFile(new URL(`../public/locales/${name}.json`, import.meta.url), "utf8"));
const translator = (words) => (key, values = {}) => {
  assert.ok(key in words, `no words on file for ${key}`);
  return words[key].replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
};
const en = translator(await locale("en"));
const fr = translator(await locale("fr"));
const gitPath = await locateGit();
const noGit = { skip: gitPath ? false : "git is not installed on this machine" };

/** Cleanups run newest first, so an app is closed before its folder is removed (Windows needs that). */
const cleanups = new WeakMap();
function later(t, cleanup) {
  let list = cleanups.get(t);
  if (!list) {
    list = [];
    cleanups.set(t, list);
    t.after(async () => { for (const step of list.reverse()) await step(); });
  }
  list.push(cleanup);
}
async function temp(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-goal-undo-${name}-`));
  later(t, () => discardTemp(root));
  return root;
}
const exists = (path) => stat(path).then(() => true, () => false);

/* ---------- the hidden snapshot store ---------- */

test("snapshot store: git is called with its own git dir and work tree, never the workspace's", async (t) => {
  const root = await temp(t, "argv");
  const calls = [];
  const fake = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "init") await mkdir(args.at(-1), { recursive: true }).then(() => writeFile(join(args.at(-1), "HEAD"), "ref: x\n"));
    return { ok: true, stdout: args.includes("write-tree") ? "a".repeat(40) + "\n" : "", stderr: "" };
  };
  const store = new SnapshotStore(join(root, "private", "snapshots"), join(root, "workspace"), fake);
  assert.equal(await store.take(), "a".repeat(40));
  assert.deepEqual(calls[0].args, ["init", "--quiet", "--bare", store.gitDir]);
  assert.ok(store.gitDir.startsWith(join(root, "private", "snapshots")));
  const worked = calls.filter((call) => call.args[2] === "--git-dir" && call.args[4] === "--work-tree");
  const pathspecs = join(store.gitDir, "branch-pathspecs");
  assert.deepEqual(worked.map((call) => call.args.slice(6)), [
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    ["add", "--all", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"], ["write-tree"]]);
  for (const call of worked) {
    assert.equal(call.args[0], "-c");
    assert.match(call.args[1], /^core\.excludesFile=.*does-not-exist$/, "the owner's global ignore file is not read");
    assert.deepEqual(call.args.slice(2, 6), ["--git-dir", store.gitDir, "--work-tree", join(root, "workspace")]);
  }
  assert.equal(await readFile(pathspecs, "utf8"), ".\0");
  assert.match(await readFile(join(store.gitDir, "info", "attributes"), "utf8"), /^\* -text -filter /, "bytes are kept exactly");
  const excludes = await readFile(join(store.gitDir, "info", "exclude"), "utf8");
  for (const line of [".env", "*.pem", "id_rsa*", "node_modules/"]) assert.ok(excludes.split("\n").includes(line), line);
  assert.deepEqual(snapshotExcludes.slice(0, 2), [".env", ".env.*"]);
  for (const name of [".env", ".env.local", ".ssh", ".aws", "aws-credentials.json", "secrets.yaml", "id_rsa", "id_ed25519.pub", "a.pem", "a.key", "a.p12", "a.pfx"])
    assert.ok(secretName.test(name), `the one rule every snapshot is checked against covers ${name}`);
  await assert.rejects(store.restore("not-a-tree; rm -rf /"), /not valid/);
});

test("snapshot store: without git it says so in plain words", async (t) => {
  const root = await temp(t, "nogit");
  const store = new SnapshotStore(join(root, "s"), root, null);
  assert.equal(await store.available(), false);
  await assert.rejects(store.take(), /need Git, which is not installed/);
});

test("snapshot store: a snapshot that fails turns snapshots off for the launch, and says why", async (t) => {
  const root = await temp(t, "slow");
  let adds = 0;
  const fake = async (args) => {
    if (args[0] === "init") await mkdir(args.at(-1), { recursive: true }).then(() => writeFile(join(args.at(-1), "HEAD"), "ref: x\n"));
    if (args.includes("add")) { adds++; return { ok: false, stdout: "", stderr: "fatal: took too long" }; }
    return { ok: true, stdout: "", stderr: "" };
  };
  const store = new SnapshotStore(join(root, "s"), root, fake);
  assert.equal(await store.available(), true);
  await assert.rejects(store.take(), /Snapshots are off until Branch restarts.*took too long/);
  assert.equal(await store.available(), false);
  await assert.rejects(store.take());
  assert.equal(adds, 1, "it does not try again on every task");
});

test("snapshot helpers: name-status parsing and staying inside the work tree", async (t) => {
  assert.deepEqual(parseNameStatus("M\0a.txt\0A\0new dir/b.txt\0D\0gone.txt\0"),
    { changed: ["a.txt", "new dir/b.txt", "gone.txt"], added: ["new dir/b.txt"] });
  const root = await temp(t, "inside");
  assert.equal(insideWorkTree(root, "a/b.txt"), join(root, "a", "b.txt"));
  assert.throws(() => insideWorkTree(root, "../outside.txt"), /Refused/);
  assert.throws(() => insideWorkTree(root, "."), /Refused/);
  await mkdir(join(root, "real"));
  await symlink(join(root, "real"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => insideWorkTree(root, "link/file.txt"), /behind a link/);
});

test("snapshot store with the real git: a plain folder goes back exactly, secrets are never kept", noGit, async (t) => {
  const root = await temp(t, "real");
  const work = join(root, "workspace");
  await mkdir(join(work, "sub"), { recursive: true });
  await writeFile(join(work, "a.txt"), "first\r\nline\n");
  await writeFile(join(work, "sub", "b.txt"), "kept");
  await writeFile(join(work, ".env"), "TOKEN=do-not-copy");
  const git = systemGit();
  const store = new SnapshotStore(join(root, "private", "snapshots"), work, git);
  const id = await store.take();
  const listed = await git(["--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", id], root, 10000);
  assert.deepEqual(listed.stdout.trim().split("\n").sort(), ["a.txt", "sub/b.txt"]);
  await writeFile(join(work, "a.txt"), "changed by a command");
  await writeFile(join(work, ".env"), "TOKEN=changed");
  await writeFile(join(work, "made.txt"), "new");
  await (await import("node:fs/promises")).rm(join(work, "sub"), { recursive: true });
  const back = await store.restore(id);
  assert.equal(await readFile(join(work, "a.txt"), "utf8"), "first\r\nline\n", "bytes come back exactly, line endings too");
  assert.equal(await readFile(join(work, "sub", "b.txt"), "utf8"), "kept");
  assert.equal(await exists(join(work, "made.txt")), false, "a file made since is taken away");
  assert.equal(await readFile(join(work, ".env"), "utf8"), "TOKEN=changed", "an excluded file is never touched");
  assert.deepEqual(back.removed, ["made.txt"]);
  assert.equal(await exists(join(work, ".git")), false, "nothing is written into the workspace");
});

test("snapshot store with the real git: a workspace .gitignore cannot bring a secret back in, nor .gitattributes change bytes", noGit, async (t) => {
  const root = await temp(t, "negate");
  const work = join(root, "workspace");
  await mkdir(join(work, "keys"), { recursive: true });
  await writeFile(join(work, ".gitignore"), "!.env\n!my-secret.txt\n!*.pem\n");
  await writeFile(join(work, ".gitattributes"), "* text=auto eol=lf\n");
  await writeFile(join(work, ".env"), "TOKEN=abc");
  await writeFile(join(work, "my-secret.txt"), "hush");
  await writeFile(join(work, "keys", "server.pem"), "PEM");
  await writeFile(join(work, "crlf.txt"), "one\r\ntwo\r\n");
  const store = new SnapshotStore(join(root, "private"), work, systemGit());
  const id = await store.take();
  const listed = await systemGit()(["--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", id], root, 30000);
  assert.deepEqual(listed.stdout.trim().split("\n").sort(), [".gitattributes", ".gitignore", "crlf.txt"]);
  const secrets = await systemGit()(["--git-dir", store.gitDir, "grep", "-l", "TOKEN=abc", id], root, 30000);
  assert.equal(secrets.stdout, "", "the secret's bytes are not in the store at all");
  await writeFile(join(work, "crlf.txt"), "changed");
  await store.restore(id);
  assert.equal(await readFile(join(work, "crlf.txt"), "utf8"), "one\r\ntwo\r\n", "the exact bytes come back");
  assert.equal(await readFile(join(work, ".env"), "utf8"), "TOKEN=abc", "a secret is left where it is");
});

test("snapshot store with the real git: a file over the size cap is left out, and too many files stops snapshots", noGit, async (t) => {
  const root = await temp(t, "caps");
  const work = join(root, "workspace");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "small.txt"), "ok");
  await writeFile(join(work, "big.bin"), Buffer.alloc(2048));
  const saved = { ...snapshotCaps };
  later(t, () => Object.assign(snapshotCaps, saved));
  snapshotCaps.fileBytes = 1024;
  const store = new SnapshotStore(join(root, "private"), work, systemGit());
  const id = await store.take();
  const listed = await systemGit()(["--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", id], root, 30000);
  assert.deepEqual(listed.stdout.trim().split("\n"), ["small.txt"]);
  snapshotCaps.files = 1;
  await assert.rejects(store.take(), /Snapshots are off until Branch restarts.*more than 1 files/);
  assert.equal(await store.available(), false);
});

test("snapshot store with the real git: the owner's own repository is left exactly as it was", noGit, async (t) => {
  const root = await temp(t, "repo");
  const work = join(root, "workspace");
  await mkdir(work, { recursive: true });
  const git = systemGit();
  const inRepo = (args) => git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], work, 10000);
  assert.ok((await inRepo(["init", "--quiet"])).ok);
  await writeFile(join(work, "tracked.txt"), "one");
  await writeFile(join(work, ".gitignore"), "ignored.log\n");
  await writeFile(join(work, "ignored.log"), "noise");
  assert.ok((await inRepo(["add", "tracked.txt", ".gitignore"])).ok);
  assert.ok((await inRepo(["commit", "--quiet", "-m", "start"])).ok);
  await writeFile(join(work, "tracked.txt"), "two, not staged");
  const head = (await inRepo(["rev-parse", "HEAD"])).stdout;
  const index = await readFile(join(work, ".git", "index"));
  const statusBefore = (await inRepo(["status", "--porcelain"])).stdout;
  const store = new SnapshotStore(join(root, "private", "snapshots"), work, git);
  const id = await store.take();
  await writeFile(join(work, "tracked.txt"), "three");
  await store.restore(id);
  assert.equal(await readFile(join(work, "tracked.txt"), "utf8"), "two, not staged");
  assert.equal(await readFile(join(work, "ignored.log"), "utf8"), "noise");
  assert.equal((await inRepo(["rev-parse", "HEAD"])).stdout, head);
  assert.deepEqual(await readFile(join(work, ".git", "index")), index, "the repository's own index is untouched");
  assert.equal((await inRepo(["status", "--porcelain"])).stdout, statusBefore);
});

/* ---------- going back to an earlier message ---------- */

/** A conversation of two tasks; each "command" writes into the workspace behind the file tools' back. */
async function twoTurns(t, name, options = {}) {
  const root = await temp(t, name);
  const workspace = join(root, "workspace");
  const steps = { first: async () => writeFile(join(workspace, "notes.txt"), "one"),
    second: async () => { await writeFile(join(workspace, "notes.txt"), "two"); await writeFile(join(workspace, "extra.txt"), "x"); } };
  const { snapshots: _mode, ...branchOptions } = options;
  const app = await createBranch({ workspace, dataDir: join(root, "private"), ...branchOptions,
    provider: { name: "scripted", async complete(request) {
      const said = request.messages.at(-1).content;
      if (!options.skipCommands) await steps[said]?.();
      return { content: `done ${said}`, toolCalls: [] };
    } } });
  later(t, () => app.close());
  saveGoalUndoSettings(app.store, "local", { snapshots: options.snapshots ?? "on" });
  const one = await app.runtime.run({ prompt: "first" });
  const two = await app.runtime.run({ prompt: "second", sessionId: one.sessionId });
  const users = userEntries(app.store.sessionView("local", one.sessionId));
  return { app, root, workspace, sessionId: one.sessionId, one, two, users };
}
const view = (app, id) => app.store.sessionView("local", id).messages;

test("rewind both: files changed by a command and the conversation go back, and undo puts both forward", noGit, async (t) => {
  const { app, workspace, sessionId, users } = await twoTurns(t, "both");
  assert.equal(users.length, 2);
  const before = view(app, sessionId);
  const result = await app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "both" });
  assert.equal(result.messagesRemoved, 2);
  assert.equal(result.files.method, "snapshot");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "one");
  assert.equal(await exists(join(workspace, "extra.txt")), false);
  assert.deepEqual(view(app, sessionId).map((m) => m.content), ["first", "done first"]);
  assert.equal((await app.rewinds.status("local", sessionId)).undo.id, result.id);

  // The edited message is sent as usual, and "undo that" still restores the original.
  await app.runtime.run({ prompt: "edited", sessionId });
  const undone = await app.rewinds.unrevert("local", sessionId);
  assert.equal(undone.messagesRestored, 2);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "two");
  assert.equal(await readFile(join(workspace, "extra.txt"), "utf8"), "x");
  assert.deepEqual(view(app, sessionId), before, "the same messages come back with the same numbers");
  assert.equal((await app.rewinds.status("local", sessionId)).undo, null);
  await assert.rejects(app.rewinds.unrevert("local", sessionId), /no rewind to undo/);
});

test("rewind conversation only leaves files alone; files only leaves the conversation alone", noGit, async (t) => {
  const { app, workspace, sessionId, users } = await twoTurns(t, "split");
  await app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "conversation" });
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "two");
  assert.equal(view(app, sessionId).length, 2);
  await app.rewinds.unrevert("local", sessionId);
  const files = await app.rewinds.rewind("local", sessionId, { messageId: users[0].messageId, restore: "files" });
  assert.equal(files.messagesRemoved, 0);
  assert.equal(view(app, sessionId).length, 4);
  assert.equal(await exists(join(workspace, "notes.txt")), false, "back to before the first task made it");
  await app.rewinds.unrevert("local", sessionId);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "two");
});

test("rewind lifts out a summary that reached past the cut, refuses busy or foreign conversations", noGit, async (t) => {
  const { app, sessionId, users, two } = await twoTurns(t, "guards");
  const rowOf = (id) => app.store.sqlite.prepare("SELECT id FROM messages WHERE source_id=?").get(id).id;
  app.store.saveCompaction(sessionId, rowOf(users[1].messageId) + 1, "a summary of the future");
  await app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "conversation" });
  assert.equal(app.store.workingMessages(sessionId).summary, null, "no summary of what was taken back");
  await app.rewinds.unrevert("local", sessionId);
  assert.equal(app.store.workingMessages(sessionId).summary, "a summary of the future");

  await assert.rejects(app.rewinds.rewind("someone-else", sessionId, { messageId: users[1].messageId, restore: "both" }), /not found/);
  await assert.rejects(app.rewinds.rewind("local", sessionId, { messageId: 999999, restore: "both" }), /not in this conversation/);
  await assert.rejects(app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "everything" }));
  app.store.sqlite.prepare("UPDATE tasks SET status='running' WHERE id=?").run(two.id);
  await assert.rejects(app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "both" }), /still working/);
  assert.equal(view(app, sessionId).length, 4, "a refused rewind changes nothing");
});

test("without git: files come back from the per-file copies and the answer says what was not covered", async (t) => {
  const { app, workspace, sessionId, users, two } = await twoTurns(t, "copies", { snapshotGit: null, skipCommands: true });
  await writeFile(join(workspace, "notes.txt"), "one");
  const history = app.store.workspaceHistory;
  await history.before("notes.txt", { runId: two.id });
  await writeFile(join(workspace, "notes.txt"), "two");
  await history.before("made.txt", { runId: two.id });
  await writeFile(join(workspace, "made.txt"), "new");
  assert.equal((await app.rewinds.status("local", sessionId)).method, "copies");
  const result = await app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "files" });
  assert.equal(result.files.method, "copies");
  assert.match(result.files.note, /Git is not installed/);
  // The old window's sentence for this result (describeRewind) went with it; the new window shows the engine's own note.
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "one");
  assert.equal(await exists(join(workspace, "made.txt")), false);
  await app.rewinds.unrevert("local", sessionId);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "two");
  assert.equal(await readFile(join(workspace, "made.txt"), "utf8"), "new");
});

/* ---------- goal mode ---------- */

test("the goal command is read the same way on the page and in the app", { skip: oldGone }, () => {
  for (const [line, wanted] of [
    ["/goal make the tests pass --max 3", { objective: "make the tests pass", maxRounds: 3 }],
    ["/GOAL  tidy the notes", { objective: "tidy the notes", maxRounds: 6 }],
    ["/goal ship it --max=20", { objective: "ship it", maxRounds: 20 }],
  ]) {
    assert.deepEqual(parseGoalCommand(line), wanted);
    assert.deepEqual(parseGoalLine(line), wanted);
  }
  assert.equal(parseGoalCommand("make the tests pass"), null);
  assert.equal(parseGoalLine("/goals are nice"), null);
  assert.throws(() => parseGoalCommand("/goal"), /Say what the goal is/);
  assert.throws(() => parseGoalCommand("/goal x --max 21"));
  const tooMany = parseGoalLine("/goal x --max 0");
  assert.equal(en(tooMany.error, tooMany.values), "--max takes a whole number from 1 to 20.");
  const empty = parseGoalLine("/goal --max 3");
  assert.match(en(empty.error, empty.values), /Say what the goal is/);
});

test("the strip shows rounds, score, what is missing, time and the right buttons, in either language", { skip: oldGone }, () => {
  const goal = { objective: "Tidy", status: "working", round: 2, maxRounds: 6, score: 0.456, missing: ["tests"], elapsedMs: 65_000, reason: "" };
  const model = stripModel(goal, en);
  assert.equal(model.heading, "Working toward the goal");
  assert.equal(model.rounds, "Round 2 of 6");
  assert.equal(model.scoreText, "Score 0.46 of 1");
  assert.equal(model.elapsed, "Worked for 1 min 05 sec");
  assert.deepEqual(model.actions, [{ action: "pause", label: "Pause" }, { action: "stop", label: "Stop" }]);
  assert.deepEqual(stripModel({ ...goal, status: "paused" }, en).actions.map((a) => a.action), ["resume", "stop"]);
  for (const status of ["done", "blocked", "stopped", "limit", "unknown"])
    assert.deepEqual(stripModel({ ...goal, status }, en).actions.map((a) => a.label), ["Hide"]);
  assert.equal(stripModel({ ...goal, score: null }, en).scoreText, "Not scored yet");
  const french = stripModel(goal, fr);
  assert.equal(french.rounds, "Tour 2 sur 6");
  assert.equal(french.elapsed, "A travaillé 1 min 05 s");
  assert.deepEqual(french.actions.map((a) => a.label), ["Mettre en pause", "Arrêter"]);
  assert.equal(formatElapsed(3_725_000, en), "1 hr 02 min");
  assert.equal(formatElapsed(9_000, fr), "9 s");
  assert.ok(isUndoThat("Undo that.") && isUndoThat("  undo that ") && !isUndoThat("undo that file please"));
  assert.ok(isUndoThat("Annule ça!", ["undo that", fr("rewind.undoPhrase")]));
  for (const key of ["rewind.edit", "rewind.send", "rewind.undo", "rewind.legend", "rewind.choice.both", "rewind.choice.conversation",
    "rewind.choice.files", "rewind.cancel", "rewind.editLabel", "rewind.empty", "rewind.saving", "rewind.wentBackEarlier",
    "goal.button", "goal.buttonTitle", "goal.commandHelp", "goal.missing"]) {
    assert.ok(en(key) && fr(key));
    assert.notEqual(en(key), fr(key), `${key} is translated`);
  }
  assert.equal(en("rewind.putBack", { messages: 2, files: 1 }), "Put back. Messages: 2. Files: 1.");
});

/** A real app whose model replies "working" and whose grader gives the scores in turn. */
async function goalApp(t, name, scores, reply = () => "working on it") {
  const root = await temp(t, name);
  const graded = [];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"), snapshotGit: null,
    provider: { name: "scripted", async complete(request) {
      if (request.responseFormat?.name === "goal_grade" || /judging whether a goal/.test(request.messages.at(-1).content)) {
        graded.push(request.messages.at(-1).content);
        const score = scores[Math.min(graded.length - 1, scores.length - 1)];
        return { content: JSON.stringify({ score, missing: score >= goalDoneScore ? [] : [`part ${graded.length}`], blocked: false }), toolCalls: [] };
      }
      return { content: reply(request.messages.at(-1).content), toolCalls: [] };
    } } });
  later(t, () => app.close());
  saveGoalUndoSettings(app.store, "local", { goal: "on" });
  return { app, graded };
}
async function settled(app, sessionId) {
  for (let i = 0; i < 400; i++) {
    const goal = app.goals.status(sessionId);
    if (goal && !["working"].includes(goal.status)) return goal;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("the goal never settled");
}

test("goal mode keeps going past interim replies until the judge says done", async (t) => {
  const { app, graded } = await goalApp(t, "done", [0.3, 0.9]);
  const started = await app.goals.start({ objective: "Write the summary" });
  assert.equal(started.status, "working");
  const goal = await settled(app, started.sessionId);
  assert.equal(goal.status, "done");
  assert.equal(goal.round, 2);
  assert.equal(goal.score, 0.9);
  assert.equal(graded.length, 2);
  const said = app.store.messages(started.sessionId).filter((m) => m.role === "user").map((m) => m.content);
  assert.match(said[0], /^Goal: Write the summary/);
  assert.match(said[1], /Round 2 of 6[\s\S]*Still missing:\n- part 1/);
  assert.throws(() => app.goals.stop(started.sessionId), /already finished/);
});

test("goal mode stops at the round limit, when stuck, and when the model says it is blocked", async (t) => {
  const limited = await goalApp(t, "limit", [0.1, 0.2, 0.3]);
  const one = await limited.app.goals.start({ objective: "Climb", maxRounds: 3 });
  const atLimit = await settled(limited.app, one.sessionId);
  assert.equal(atLimit.status, "limit");
  assert.equal(atLimit.round, 3);

  const stuck = await goalApp(t, "stuck", [0.4]);
  const two = await stuck.app.goals.start({ objective: "Spin", maxRounds: 10 });
  const flat = await settled(stuck.app, two.sessionId);
  assert.equal(flat.status, "blocked");
  assert.equal(flat.round, 1 + goalStuckRounds);
  assert.match(flat.reason, /No progress/);

  const blocked = await goalApp(t, "blocked", [0.5], () => "BLOCKED: I need the server password from you");
  const three = await blocked.app.goals.start({ objective: "Deploy" });
  const waiting = await settled(blocked.app, three.sessionId);
  assert.equal(waiting.status, "blocked");
  assert.equal(waiting.round, 1);
  assert.match(waiting.reason, /server password/);
  assert.equal(blocked.graded.length, 0, "a round that says it is blocked is not graded");
});

test("goal mode uses the declared completion checks as part of the judge", async (t) => {
  let round = 0;
  const { app } = await goalApp(t, "checks", [0.95], () => (++round >= 2 ? "banana bread is ready" : "almost there"));
  const started = await app.goals.start({ objective: "Bake", checks: { mustMention: ["banana"] } });
  const goal = await settled(app, started.sessionId);
  assert.equal(goal.status, "done");
  assert.equal(goal.round, 2);
  const second = app.store.messages(started.sessionId).filter((m) => m.role === "user")[1].content;
  assert.match(second, /does not mention "banana"/);
});

/** A runtime whose rounds finish only when the test says so. */
function heldRuntime(owner = "local") {
  const rounds = [];
  const cancelled = [];
  return {
    rounds, cancelled, owner, workspace: tmpdir(),
    async run(options) {
      const run = { id: `run-${rounds.length + 1}`, sessionId: options.sessionId ?? "00000000-0000-4000-8000-000000000001", owner, prompt: options.prompt, status: "completed", output: "step", createdAt: "", updatedAt: "" };
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      rounds.push({ options, finish });
      options.onStarted?.(run);
      options.signal?.addEventListener("abort", () => finish("cancelled"));
      const status = await done;
      return { ...run, status: status ?? "completed" };
    },
    cancel(id) { cancelled.push(id); return true; },
    context() { return {}; },
    async shaped() { return { status: "resolved", value: { score: 0.2 + 0.1 * rounds.length, missing: ["more"], blocked: false }, reasked: false }; },
  };
}
async function fakeStore(t) {
  const root = await temp(t, "store");
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "p"), snapshotGit: null });
  later(t, () => app.close());
  saveGoalUndoSettings(app.store, "local", { goal: "when-needed" });
  return app.store;
}
const tick = () => new Promise((done) => setTimeout(done, 5));

test("pause lets the working round finish and waits; resume carries on; stop cancels the round", async (t) => {
  const runtime = heldRuntime();
  let now = 1_000;
  const goals = new GoalMode(runtime, await fakeStore(t), () => now);
  const started = await goals.start({ objective: "Hold", maxRounds: 5 });
  const id = started.sessionId;
  now += 4_000;
  assert.equal(goals.pause(id).status, "paused");
  now += 60_000; // time paused does not count
  runtime.rounds[0].finish();
  await tick();
  assert.equal(runtime.rounds.length, 1, "no new round while paused");
  const paused = goals.status(id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.elapsedMs, 4_000);
  assert.equal(paused.round, 1);

  assert.equal((await goals.resume(id)).status, "working");
  await tick();
  assert.equal(runtime.rounds.length, 2);
  assert.match(runtime.rounds[1].options.prompt, /Round 2 of 5/);
  now += 1_000;
  const stopped = goals.stop(id);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.elapsedMs, 5_000);
  assert.deepEqual(runtime.cancelled, ["run-2"]);
  await tick();
  assert.equal(runtime.rounds.length, 2);
  assert.equal(goals.status(id).status, "stopped");
  await assert.rejects(goals.resume(id), /Only a paused goal/);
});

test("a goal Branch was closed on shows as paused and can be resumed", async (t) => {
  const store = await fakeStore(t);
  const id = "00000000-0000-4000-8000-000000000002";
  store.save("settings", "local", `goal:${id}`, { sessionId: id, objective: "Left over", status: "working", round: 2, maxRounds: 2,
    score: 0.5, best: 0.5, flatRounds: 0, missing: [], reason: "", checks: null, startedAt: "", elapsedMs: 10, activeSince: 5, lastRunId: "run-x" });
  const runtime = heldRuntime();
  const goals = new GoalMode(runtime, store, () => 100);
  const seen = goals.status(id);
  assert.equal(seen.status, "paused");
  assert.match(seen.reason, /closed/);
  assert.equal((await goals.resume(id)).maxRounds, 3, "one more round is allowed when it had run out");
  await tick();
  assert.equal(runtime.rounds.length, 1);
  assert.equal(runtime.rounds[0].options.sessionId, id);
});

test("the goal and rewind routes answer only for the owner's conversations", noGit, async (t) => {
  const { app, root, sessionId, users } = await twoTurns(t, "http");
  const server = await startServer(app, { dataDir: join(root, "private"), port: 0 });
  later(t, () => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await call(`/api/sessions/${sessionId}/goal`)).body, { goal: null });
  assert.deepEqual((await call("/api/goal-undo/settings")).body, { goal: "off", snapshots: "on" });
  const refused = await call("/api/goals", { objective: "Say hello" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Goal mode is off/);
  assert.equal((await call("/api/goal-undo/settings", { goal: "sometimes" })).status, 400);
  assert.deepEqual((await call("/api/goal-undo/settings", { goal: "on" })).body, { goal: "on", snapshots: "on" });
  assert.equal((await call(`/api/sessions/${sessionId}/rewind`)).body.method, "snapshot");
  const went = await call(`/api/sessions/${sessionId}/rewind`, { messageId: users[1].messageId, restore: "both" });
  assert.equal(went.status, 200);
  assert.equal(went.body.messagesRemoved, 2);
  assert.equal((await call(`/api/sessions/${sessionId}/unrevert`, {})).body.messagesRestored, 2);
  const stranger = "00000000-0000-4000-8000-00000000abcd";
  assert.equal((await call(`/api/sessions/${stranger}/goal`)).status, 400);
  assert.equal((await call(`/api/sessions/${stranger}/rewind`, { messageId: 1, restore: "both" })).status, 400);
  assert.equal((await call(`/api/sessions/${sessionId}/goal`, { action: "explode" })).status, 400);
  const started = await call("/api/goals", { objective: "Say hello", maxRounds: 1 });
  assert.equal(started.status, 200);
  assert.match(started.body.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok((await call(`/api/sessions/${started.body.sessionId}/goal`)).body.goal);
  const unauthenticated = await fetch(`${server.url}/api/sessions/${sessionId}/rewind`);
  assert.equal(unauthenticated.status, 401);
  await settled(app, started.body.sessionId);
});

/* ---------- the three-way switches ---------- */

test("switches: everything ships off; off takes no snapshot and refuses a goal", async (t) => {
  const { app, root, workspace, sessionId, users } = await twoTurns(t, "off", { snapshots: "off" });
  const fresh = await createBranch({ workspace: join(root, "fresh-w"), dataDir: join(root, "fresh-p"), snapshotGit: null });
  later(t, () => fresh.close());
  assert.deepEqual(goalUndoSettings(fresh.store, "local"), { goal: "off", snapshots: "off" }, "a fresh install is off");
  saveGoalUndoSettings(fresh.store, "local", { goal: "on" });
  assert.deepEqual(saveGoalUndoSettings(fresh.store, "local", { snapshots: "when-needed" }), { goal: "on", snapshots: "when-needed" },
    "saving one switch leaves the other as it was");
  assert.equal(await exists(join(root, "private", "snapshots")), false, "no snapshot store is even set up");
  const trees = app.store.sqlite.prepare("SELECT tree FROM turn_snapshots WHERE session_id=?").all(sessionId);
  assert.deepEqual(trees.map((row) => row.tree), [null, null]);
  const status = await app.rewinds.status("local", sessionId);
  assert.equal(status.method, "copies");
  assert.equal(status.snapshots, "off");
  assert.match(status.note, /switched off/);
  const result = await app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "files" });
  assert.equal(result.files.method, "none", "the command's change is not covered while snapshots are off");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "two");
  await assert.rejects(app.goals.start({ objective: "Anything" }), /Goal mode is off/);
  assert.throws(() => saveGoalUndoSettings(app.store, "local", { snapshots: "always" }));
  // The old window's goal-button helpers (MODES, showsGoalButton) went with it (#291).
});

test("switches: snapshots when needed are taken just before a task's first change, once", noGit, async (t) => {
  const { app, workspace, sessionId, users, two } = await twoTurns(t, "needed", { snapshots: "when-needed" });
  const treeOf = (runId) => app.store.sqlite.prepare("SELECT tree FROM turn_snapshots WHERE run_id=?").get(runId).tree;
  assert.equal(treeOf(two.id), null, "nothing is recorded when a task starts");
  await app.runtime.askHooks(two.id, { tool: "files.read" });
  assert.equal(treeOf(two.id), null, "a call that only reads records nothing");
  await writeFile(join(workspace, "notes.txt"), "before the change");
  await Promise.all([app.runtime.askHooks(two.id, { tool: "files.write" }), app.runtime.askHooks(two.id, { tool: "files.write" })]);
  const first = treeOf(two.id);
  assert.match(first, /^[0-9a-f]{40}/, "the first call that can change something records the workspace");
  await writeFile(join(workspace, "notes.txt"), "after the change");
  await app.runtime.askHooks(two.id, { tool: "files.write" });
  assert.equal(treeOf(two.id), first, "later calls in the same task record nothing more");
  const result = await app.rewinds.rewind("local", sessionId, { messageId: users[1].messageId, restore: "files" });
  assert.equal(result.files.method, "snapshot");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before the change");
});
