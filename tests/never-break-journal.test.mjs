/**
 * Never breaks, threats 3, 4 and 5: the task journal, carrying interrupted work on after a restart,
 * chat messages and timed jobs missed while Branch was down, and data formats with a way back.
 * Temporary folders and processes this file starts itself only; fake chat service, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, TelegramAdapter, Scheduler } from "../dist/index.js";
import { effectsOf, idempotencyKey, evidenceFor, checkEvidence, gitHead, TaskJournal } from "../dist/never-break/journal.js";
import { migrate, migrateDown, formatOf, DataTooNewError } from "../dist/never-break/migrations.js";
import { recoverAfterRestart, lateNote, releaseInterruptedSchedules } from "../dist/never-break/resume.js";
import { channelPosition } from "../dist/never-break/channel-position.js";
import { saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";
import { saveLongWorkSettings } from "../dist/long-work.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BRANCH_") && name !== "NODE_OPTIONS"));
/**
 * Windows will not delete an open database, so what a test opened (`closeFirst`) is closed, newest
 * first, in the same hook and before its folder is removed.
 */
const closers = new WeakMap();
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-journal-"));
  const list = [];
  closers.set(t, list);
  t.after(async () => { for (const close of list.reverse()) await close(); await discardTemp(root); });
  return root;
}
const closeFirst = (t, close) => closers.get(t).push(close);
const say = (content) => ({ content, toolCalls: [] });
function scripted(replies) {
  let index = 0;
  return { name: "scripted", async complete() { return replies[Math.min(index++, replies.length - 1)]; } };
}

/* ---------- pure pieces ---------- */

test("each call is classed by what it can do, and keyed so a repeat is recognised", async (t) => {
  assert.equal(effectsOf("files.read", "files.read"), "none");
  assert.equal(effectsOf("git.status", "git.read"), "none");
  assert.equal(effectsOf("files.write", "files.write"), "idempotent");
  assert.equal(effectsOf("email.send", "email.send"), "external");
  // selfdev (SELF-314): a GitHub look under a permission that can change things, and a push, are safe to do again.
  assert.equal(effectsOf("github.wait_for_checks", "github.manage"), "none");
  assert.equal(effectsOf("github.check_logs", "github.manage"), "none");
  assert.equal(effectsOf("git.push", "git.remote"), "idempotent");
  assert.equal(effectsOf("github.merge_pull_request", "github.manage"), "external");
  assert.equal(effectsOf("mcp.someone.tool", "mcp.call"), "external", "anything unknown is treated as reaching outside");
  const call = { id: "c1", name: "files.write", arguments: "{\"path\":\"a\"}" };
  assert.equal(idempotencyKey("r1", call), idempotencyKey("r1", { ...call }));
  assert.notEqual(idempotencyKey("r1", call), idempotencyKey("r2", call));

  const root = await temp(t);
  const written = await evidenceFor("files.write", { path: "a.txt", content: "hello" }, root);
  assert.deepEqual(written, { kind: "file", path: join(root, "a.txt"), before: null, intended: sha("hello") });
  assert.equal(await checkEvidence(written), "not-done");
  await writeFile(join(root, "a.txt"), "hello");
  assert.equal(await checkEvidence(written), "done");
  const edited = await evidenceFor("files.edit", { path: "a.txt" }, root);
  assert.equal(await checkEvidence(edited), "not-done", "unchanged since just before the edit");
  await writeFile(join(root, "a.txt"), "hello there");
  assert.equal(await checkEvidence(edited), "done");
  assert.equal(await evidenceFor("files.write", { path: "../outside.txt", content: "x" }, root), null);
  assert.equal(await checkEvidence(null), "unknown");

  await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, ".git", "packed-refs"), "# pack\naaaa refs/heads/main\n");
  assert.equal(await gitHead(root), "aaaa");
  const commit = await evidenceFor("git.commit", {}, root);
  await writeFile(join(root, ".git", "refs", "heads", "main"), "bbbb\n");
  assert.equal(await checkEvidence(commit), "done", "the branch moved on: the commit happened");
});

test("a missed timed job says why it is late", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  assert.equal(lateNote("2026-09-17T11:59:30Z", now), null);
  assert.match(lateNote("2026-09-17T11:30:00Z", now), /due 30 minutes ago, while Branch was not running, so it ran once now/);
  assert.match(lateNote("2026-09-17T07:00:00Z", now), /due 5 hours ago/);
});

/* ---------- data formats ---------- */

test("formats move forward on a copy, have a way back, and newer data is refused untouched", async (t) => {
  const root = await temp(t);
  const db = new DatabaseSync(join(root, "a.sqlite"));
  closeFirst(t, () => db.close());
  const steps = [
    { version: 1, readableBy: 1, up: (d) => d.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT)"), down: (d) => d.exec("DROP TABLE notes") },
    { version: 2, readableBy: 1, up: (d) => d.exec("ALTER TABLE notes ADD COLUMN tag TEXT"), down: (d) => d.exec("ALTER TABLE notes DROP COLUMN tag") },
  ];
  assert.deepEqual(migrate(db, steps.slice(0, 1), { backupTo: join(root, "b1.sqlite") }), { from: 0, to: 1, backup: null });
  db.exec("INSERT INTO notes(text) VALUES('kept')");
  const up = migrate(db, steps, { backupTo: join(root, "b2.sqlite") });
  assert.deepEqual(up, { from: 1, to: 2, backup: join(root, "b2.sqlite") });
  const copy = new DatabaseSync(join(root, "b2.sqlite"));
  assert.equal(formatOf(copy).version, 1, "the copy is the data as it was before the change");
  copy.close();
  assert.deepEqual(formatOf(db), { version: 2, readableBy: 1 });
  // The previous release (format 1) can still open format 2: it only added a column.
  assert.equal(migrate(db, steps.slice(0, 1), { backupTo: null }).to, 2);
  migrateDown(db, steps, 1);
  assert.equal(formatOf(db).version, 1);
  assert.deepEqual(db.prepare("SELECT * FROM notes").all().map((r) => ({ ...r })), [{ id: 1, text: "kept" }], "the way back keeps the work");
  const failing = [...steps, { version: 3, readableBy: 3, up: (d) => { d.exec("CREATE TABLE half(x)"); throw new Error("boom"); }, down: () => undefined }];
  assert.throws(() => migrate(db, failing, { backupTo: null }), /boom/);
  assert.equal(formatOf(db).version, 1, "a change that fails part-way leaves nothing behind");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='half'").get(), undefined);
  db.exec("PRAGMA user_version=3; UPDATE branch_format SET version=3, readable_by=3");
  assert.throws(() => migrate(db, steps, { backupTo: null }), (error) => error instanceof DataTooNewError && /newer version of Branch/.test(error.message));
});

test("Branch refuses to open saved work from a version it cannot read, and stamps its own", async (t) => {
  const root = await temp(t);
  const options = { workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("hi")]) };
  const first = await createBranch(options);
  assert.deepEqual(formatOf(first.store.sqlite), { version: 1, readableBy: 1 });
  first.store.sqlite.exec("PRAGMA user_version=7; UPDATE branch_format SET version=7, readable_by=1");
  await first.close();
  const tolerant = await createBranch(options);
  await tolerant.close();
  const db = new DatabaseSync(join(root, "d", "branch.sqlite"));
  db.exec("UPDATE branch_format SET readable_by=7");
  db.close();
  await assert.rejects(createBranch(options), /last opened by a newer version of Branch/);
  const again = new DatabaseSync(join(root, "d", "branch.sqlite"));
  assert.equal(formatOf(again).version, 7, "nothing was changed");
  again.close();
});

/* ---------- the journal in a running task ---------- */

test("every turn and tool call is written down, flushed, before it runs", async (t) => {
  const root = await temp(t);
  const call = { id: "w1", name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "one" }) };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([{ content: "", toolCalls: [call] }, say("done")]) });
  closeFirst(t, () => app.close());
  const run = await app.runtime.run({ prompt: "write it", onTextDelta: () => undefined });
  assert.equal(run.status, "completed");
  assert.deepEqual(app.neverBreak.journal.steps(run.id), [
    { kind: "turn", tool: "round 1", state: "finished", effects: null, callId: null },
    { kind: "tool", tool: "files.write", state: "finished", effects: "idempotent", callId: "w1" },
    { kind: "turn", tool: "round 2", state: "finished", effects: null, callId: null },
  ]);
});

test("a step that cannot be written down is not done, and the task says why", async (t) => {
  const root = await temp(t);
  let sent = 0;
  const call = { id: "s1", name: "chaos.send", arguments: "{}" };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([{ content: "", toolCalls: [call] }, say("done")]) });
  closeFirst(t, () => app.close());
  app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "send", parameters: z.object({}).strict(), execute: async () => { sent++; return {}; } });
  app.neverBreak.journal.failWrites = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  const run = await app.runtime.run({ prompt: "send it", onTextDelta: () => undefined });
  assert.equal(sent, 0, "nothing was sent that could not be recorded");
  assert.equal(run.status, "failed");
  assert.match(run.output, /could not write this step down.*ENOSPC.*disk may be full/);
  app.neverBreak.journal.failWrites = null;
  assert.equal((await app.runtime.run({ prompt: "and now", onTextDelta: () => undefined })).status, "completed", "the next task works once there is room");
});

/* ---------- killed mid-step, started again ---------- */

async function killedMidStep(t, plan, { mode = "on", waitFor }) {
  const root = await temp(t);
  await mkdir(join(root, "data"), { recursive: true });
  await saveGatewayConfig(join(root, "data"), GatewayConfigSchema.parse({ mode }));
  const env = { ...cleanEnv(), CHAOS_PLAN: JSON.stringify(plan), CHAOS_DELAY: "60000" };
  const script = resolve("tests/fixtures/never-break-task.mjs");
  const worker = spawn(process.execPath, [script, root, "work"], { env, stdio: ["ignore", "pipe", "inherit"] });
  closeFirst(t, () => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  for (let i = 0; i < 1200; i++) {
    const calls = await readFile(join(root, "calls.log"), "utf8").catch(() => "");
    if (calls.includes(waitFor)) break;
    await delay(50);
  }
  worker.kill("SIGKILL");
  await new Promise((done) => worker.once("exit", done));
  const recover = spawn(process.execPath, [script, root, "recover"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  recover.stdout.on("data", (c) => { out += c; });
  await new Promise((done) => recover.once("exit", done));
  const result = JSON.parse(out.trim().split("\n").pop());
  return { root, result, outbox: await readFile(join(root, "outbox.log"), "utf8").catch(() => ""),
    calls: await readFile(join(root, "calls.log"), "utf8") };
}

test("killed while only looking: the look is done again and the task finishes by itself", async (t) => {
  const { result, calls } = await killedMidStep(t, [{ id: "a", tool: "chaos.look", args: { n: 1 } }, { id: "b", tool: "chaos.look", args: { n: 2 } }], { waitFor: "look 1" });
  assert.equal(result.report[0].outcome, "resumed");
  assert.deepEqual(result.report[0].steps, [{ tool: "chaos.look", decision: "redo" }]);
  assert.ok(result.runs.some((run) => run.status === "completed" && run.output === "all done"), JSON.stringify(result.runs));
  assert.match(calls, /look 1[\s\S]*look 1[\s\S]*look 2/, "the look was repeated once and the next step followed");
  assert.equal((calls.match(/look 2/g) ?? []).length, 1);
});

test("killed while sending: nothing is sent twice, and the owner is asked", async (t) => {
  const { result, outbox } = await killedMidStep(t, [{ id: "a", tool: "chaos.send", args: { n: 1 } }], { waitFor: "send 1" });
  assert.equal(result.report[0].outcome, "asked");
  const asked = result.runs.find((run) => run.status === "needs_input");
  assert.match(asked.output, /stopped while it was .*may already have happened.*check first and carry on, or do it again/);
  assert.equal(outbox, "", "the send never finished, and it was not tried again by itself");
  assert.equal(result.steps[result.report[0].runId].find((s) => s.kind === "tool").state, "asked");
});

test("killed while writing a file: the file is checked, not guessed", async (t) => {
  const { result, root } = await killedMidStep(t, [
    { id: "a", tool: "files.write", args: { path: "note.txt", content: "hello" } },
    { id: "b", tool: "chaos.look", args: { n: 7 } },
  ], { waitFor: "look 7" });
  // The write finished before the kill; the look was cut off. Only the look is repeated.
  assert.deepEqual(result.report[0].steps, [{ tool: "chaos.look", decision: "redo" }]);
  assert.equal(await readFile(join(root, "workspace", "note.txt"), "utf8"), "hello");
});

test("with the switch at when needed, interrupted work waits for the owner", async (t) => {
  const { result, calls } = await killedMidStep(t, [{ id: "a", tool: "chaos.look", args: { n: 1 } }], { mode: "when-needed", waitFor: "look 1" });
  assert.equal(result.report[0].outcome, "offered");
  assert.equal((calls.match(/look 1/g) ?? []).length, 1, "nothing was done again without the owner");
  assert.ok(result.runs.every((run) => run.status === "interrupted"));
});

test("a file step checked after the fact: done is kept, not done is done", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("carried on")]) });
  closeFirst(t, () => app.close());
  const make = async (callId, path, content, landed) => {
    const run = app.store.createRun("local", `write ${path}`);
    app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [{ id: callId, name: "files.write", arguments: JSON.stringify({ path, content }) }] });
    const evidence = await evidenceFor("files.write", { path, content }, app.runtime.workspace);
    app.neverBreak.journal.begin({ runId: run.id, sessionId: run.sessionId, callId, tool: "files.write", arguments: JSON.stringify({ path, content }), key: "k", effects: "idempotent", evidence });
    if (landed) await writeFile(join(app.runtime.workspace, path), content);
    app.store.finish(run.id, "interrupted", "cut off");
    return run;
  };
  const landed = await make("c1", "landed.txt", "yes", true);
  const missing = await make("c2", "missing.txt", "later", false);
  const report = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  await Promise.all(report.map((r) => r.resumed));
  const byRun = Object.fromEntries(report.map((r) => [r.runId, r.steps[0].decision]));
  assert.equal(byRun[landed.id], "done");
  assert.equal(byRun[missing.id], "not-done");
  assert.equal(await readFile(join(app.runtime.workspace, "missing.txt"), "utf8"), "later", "the missing write was done");
  const said = (run) => app.store.messages(run.sessionId).find((m) => m.role === "tool").content;
  assert.match(said(landed), /already taken effect \(checked\)/);
  assert.match(said(missing), /"status":"redone"/);
  const again = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.deepEqual(again, [], "a task is settled once");
});

/* ---------- killed at an exact point: between the model's request and the step (mac5/resume-gap) ---------- */

/** The worker kills itself at `killAt` (see tests/fixtures/never-break-task.mjs); then Branch starts again on the same folder. */
async function killedAtPoint(t, plan, killAt, { mode = "on" } = {}) {
  const root = await temp(t);
  await mkdir(join(root, "data"), { recursive: true });
  await saveGatewayConfig(join(root, "data"), GatewayConfigSchema.parse({ mode }));
  const env = { ...cleanEnv(), CHAOS_PLAN: JSON.stringify(plan), CHAOS_DELAY: "0", CHAOS_KILL_AT: killAt };
  const script = resolve("tests/fixtures/never-break-task.mjs");
  const run = (phase) => new Promise((done) => {
    const child = spawn(process.execPath, [script, root, phase], { env, stdio: ["ignore", "pipe", "inherit"] });
    closeFirst(t, () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.once("exit", (code, signal) => done({ code, signal, out }));
  });
  const worker = await run("work");
  // Windows reports a killed process as a failed exit rather than by signal, so the fixture's note is what proves it.
  assert.ok(worker.signal === "SIGKILL" || (process.platform === "win32" && worker.code !== 0), `the worker was killed: ${JSON.stringify(worker)}`);
  assert.match(await readFile(join(root, "calls.log"), "utf8"), new RegExp(`killed at ${killAt}\n`), "it was killed at that exact point");
  const recovered = await run("recover");
  const result = JSON.parse(recovered.out.trim().split("\n").pop());
  const reopened = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([say("x")]) });
  const transcript = reopened.store.messages(reopened.store.run(result.runs[0].id).sessionId);
  await reopened.close();
  return { root, result, transcript, outbox: await readFile(join(root, "outbox.log"), "utf8").catch(() => ""),
    calls: await readFile(join(root, "calls.log"), "utf8") };
}
const finishedAll = (result) => result.runs.some((run) => run.status === "completed" && run.output === "all done");

test("killed after a file is truncated: the resumed model reads it before retrying the write", async (t) => {
  const { result, root, transcript } = await killedAtPoint(t, [
    { id: "e", tool: "files.write", args: { path: "two.txt", content: "second" } },
  ], "partial:e");
  assert.deepEqual(result.report[0].steps, [{ tool: "files.write", decision: "not-done" }]);
  assert.ok(finishedAll(result), JSON.stringify(result.runs));
  assert.equal(await readFile(join(root, "workspace", "two.txt"), "utf8"), "second");
  const refused = transcript.find((row) => row.role === "tool" && /read .* with files.read first/.test(row.content));
  assert.ok(refused, "the guard still refuses to overwrite a file the resumed task has not read");
  const calls = transcript.filter((row) => row.role === "assistant").flatMap((row) => row.toolCalls ?? []);
  assert.deepEqual(calls.map((call) => call.name), ["files.write", "files.write", "files.read", "files.write"]);
});

test("killed just after the model asked for a write, before it started: the write is done and the task finishes", async (t) => {
  const { result, root } = await killedAtPoint(t, [
    { id: "a", tool: "chaos.look", args: { n: 1 } },
    { id: "b", tool: "files.write", args: { path: "one.txt", content: "first" } },
    { id: "c", tool: "chaos.look", args: { n: 3 } },
  ], "saved:b");
  assert.equal(result.report[0].outcome, "resumed");
  assert.deepEqual(result.report[0].steps, [{ tool: "files.write", decision: "not-started" }]);
  assert.ok(finishedAll(result), JSON.stringify(result.runs));
  assert.equal(await readFile(join(root, "workspace", "one.txt"), "utf8"), "first", "the write that never started was done");
});

test("killed just after the model asked for a send, before it started: it is sent once and the task finishes", async (t) => {
  const { result, outbox, calls } = await killedAtPoint(t, [
    { id: "a", tool: "chaos.look", args: { n: 1 } },
    { id: "c", tool: "chaos.send", args: { n: 2 } },
    { id: "d", tool: "chaos.look", args: { n: 3 } },
  ], "saved:c");
  assert.equal((calls.match(/send 2/g) ?? []).length, 1, "the send was never started before the restart");
  assert.deepEqual(result.report[0].steps, [{ tool: "chaos.send", decision: "not-started" }]);
  assert.equal(outbox, "sent 2\n", "sent exactly once");
  assert.ok(finishedAll(result), JSON.stringify(result.runs));
});

test("killed after a send finished but before its result was saved: it is not sent again, and the conversation says it finished", async (t) => {
  const { result, outbox, transcript } = await killedAtPoint(t, [
    { id: "c", tool: "chaos.send", args: { n: 2 } },
    { id: "d", tool: "chaos.look", args: { n: 3 } },
  ], "result:c");
  assert.deepEqual(result.report[0].steps, [], "nothing was open");
  assert.equal(outbox, "sent 2\n");
  assert.ok(finishedAll(result), JSON.stringify(result.runs));
  const said = transcript.find((m) => m.role === "tool" && m.toolCallId === "c");
  assert.match(said.content, /"status":"finished".*finished just before Branch was restarted/);
});

test("with the switch at when needed, a send that never started is not sent, and the conversation says it was not done", async (t) => {
  const { result, outbox, transcript } = await killedAtPoint(t, [{ id: "c", tool: "chaos.send", args: { n: 2 } }], "saved:c", { mode: "when-needed" });
  assert.equal(result.report[0].outcome, "offered");
  assert.equal(outbox, "", "nothing was done without the owner");
  const said = transcript.find((m) => m.role === "tool" && m.toolCallId === "c");
  assert.match(said.content, /"status":"not-done".*before this step started/);
});

/** A run cut off in a turn that asked for several calls, built by hand. */
async function severalCalls(t, calls, register) {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("carried on")]) });
  closeFirst(t, () => app.close());
  const sent = [];
  app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "send", parameters: z.object({ n: z.number() }).strict(),
    execute: async ({ n }) => { sent.push(n); return { sent: n }; } });
  register?.(app);
  const run = app.store.createRun("local", "several at once");
  app.neverBreak.journal.turn(run.id, run.sessionId, 1);
  const toolCalls = calls.map((c) => ({ id: c.id, name: c.tool, arguments: JSON.stringify(c.args) }));
  const hook = journalHook(app.neverBreak.journal);
  hook.intend({ runId: run.id, sessionId: run.sessionId, calls: toolCalls.map((call) => ({ call, permission: app.registry.permissionOf(call.name) })) });
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls });
  for (const [index, c] of calls.entries()) {
    if (c.state === "intent") continue;
    // Started (and still running when Branch stopped): the hook is cut off by an aborted signal.
    await hook.around({ runId: run.id, sessionId: run.sessionId, call: toolCalls[index], permission: app.registry.permissionOf(c.tool),
      workspace: app.runtime.workspace, signal: AbortSignal.abort() }, async () => { throw new Error("cut off"); }).catch(() => undefined);
  }
  app.store.finish(run.id, "interrupted", "cut off");
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  await report.resumed;
  const said = (id) => app.store.messages(run.sessionId).find((m) => m.role === "tool" && m.toolCallId === id)?.content ?? "";
  return { app, report, sent, said, run };
}

test("a turn with several calls cut off during the first: calls after an unsettled one are not run ahead of it", async (t) => {
  const { report, sent, said, app } = await severalCalls(t, [
    { id: "s1", tool: "chaos.send", args: { n: 1 }, state: "started" },
    { id: "w2", tool: "files.write", args: { path: "later.txt", content: "later" }, state: "intent" },
  ]);
  assert.equal(report.outcome, "asked");
  assert.deepEqual(report.steps, [{ tool: "chaos.send", decision: "ask" }, { tool: "files.write", decision: "not-started" }]);
  assert.deepEqual(sent, [], "the cut-off send was not repeated");
  await assert.rejects(readFile(join(app.runtime.workspace, "later.txt")), "the write after it waits for the owner's answer");
  assert.match(said("w2"), /"status":"not-done"/);
});

test("a turn with several calls cut off during the first: a settled first call lets the ones after it run, once each", async (t) => {
  const { report, sent, said, app } = await severalCalls(t, [
    { id: "w1", tool: "files.write", args: { path: "first.txt", content: "one" }, state: "started" },
    { id: "s2", tool: "chaos.send", args: { n: 2 }, state: "intent" },
    { id: "s3", tool: "chaos.send", args: { n: 3 }, state: "intent" },
  ]);
  assert.equal(report.outcome, "resumed");
  assert.deepEqual(report.steps.map((s) => s.decision), ["not-done", "not-started", "not-started"]);
  assert.equal(await readFile(join(app.runtime.workspace, "first.txt"), "utf8"), "one");
  assert.deepEqual(sent, [2, 3], "each call that never started ran once, in order");
  assert.match(said("s2"), /"status":"redone"/);
});

test("a task from before intents were written keeps today's behaviour: a call with no journal entry is not run", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("carried on")]) });
  closeFirst(t, () => app.close());
  const sent = [];
  app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "send", parameters: z.object({ n: z.number() }).strict(),
    execute: async ({ n }) => { sent.push(n); return { sent: n }; } });
  const run = app.store.createRun("local", "from an older version");
  app.neverBreak.journal.turn(run.id, run.sessionId, 1);
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [
    { id: "o1", name: "files.write", arguments: JSON.stringify({ path: "old.txt", content: "old" }) },
    { id: "o2", name: "chaos.send", arguments: JSON.stringify({ n: 9 }) }] });
  app.store.finish(run.id, "interrupted", "cut off");
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  await report.resumed;
  assert.deepEqual(report.steps, []);
  assert.deepEqual(sent, [], "nothing is re-run without a journal entry saying it never started");
  await assert.rejects(readFile(join(app.runtime.workspace, "old.txt")));
  assert.match(app.store.messages(run.sessionId).find((m) => m.toolCallId === "o2").content, /"outcome":"unknown"/);
});

test("the calls a turn asks for are written down before the conversation holds them, and not saved when they cannot be", async (t) => {
  const root = await temp(t);
  const calls = [{ id: "k1", name: "chaos.check", arguments: "{}" }, { id: "k2", name: "chaos.check", arguments: "{}" }];
  const replies = [{ content: "", toolCalls: calls }, say("done"), { content: "", toolCalls: [{ id: "k3", name: "chaos.check", arguments: "{}" }] }];
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: { name: "scripted", async complete() { return replies.shift() ?? say("done"); } } });
  closeFirst(t, () => app.close());
  const seen = [];
  app.registry.register({ name: "chaos.check", permission: "chaos.send", description: "check", parameters: z.object({}).strict(), execute: async () => {
    seen.push(app.neverBreak.journal.open().map((step) => `${step.callId}:${step.state}`).join(","));
    return {};
  } });
  const run = await app.runtime.run({ prompt: "two at once", onTextDelta: () => undefined });
  assert.equal(run.status, "completed");
  assert.deepEqual(seen, ["k1:started,k2:intent", "k2:started"], "the second call is an intent, not started, while the first runs");
  assert.deepEqual(app.neverBreak.journal.steps(run.id).filter((s) => s.kind === "tool").map((s) => s.state), ["finished", "finished"]);

  let writes = 0;
  app.neverBreak.journal.failWrites = () => (++writes > 1 ? new Error("ENOSPC: no space left on device") : null);
  const failed = await app.runtime.run({ prompt: "and again", onTextDelta: () => undefined });
  app.neverBreak.journal.failWrites = null;
  assert.equal(failed.status, "failed");
  assert.match(failed.output, /disk may be full/);
  assert.equal(seen.length, 2, "nothing ran");
  assert.ok(!app.store.messages(failed.sessionId).some((m) => m.role === "assistant" && m.toolCalls?.length), "the request that could not be written down was not saved");
});

test("a task a chat app started is left for the chat app to send again", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("x")]) });
  closeFirst(t, () => app.close());
  const run = app.store.createRun("local", "from telegram");
  app.store.event(run.id, "channel.inbound", { channel: "tg", chatId: "1", messageId: "9" });
  app.store.finish(run.id, "interrupted", "cut off");
  const [only] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.equal(only.outcome, "left-for-chat");
  assert.deepEqual(await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "off" }), []);
});

/* ---------- chat messages and timed jobs missed while down ---------- */

function fakeTelegram(updates) {
  const offsets = [];
  const fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "branch_bot" } });
    if (method === "getUpdates") {
      offsets.push(body.offset);
      await delay(20);
      return Response.json({ ok: true, result: updates.filter((u) => u.update_id >= body.offset) });
    }
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  return { fetch, offsets };
}
const update = (id, text) => ({ update_id: id, message: { message_id: id, text, from: { id: 5, username: "owner" }, chat: { id: 5, type: "private" } } });

test("Telegram picks up where it had read to, so messages sent during a restart are answered once", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("x")]) });
  closeFirst(t, () => app.close());
  const position = channelPosition(app.store, "tg");
  const first = fakeTelegram([update(10, "one"), update(11, "two")]);
  const seen = [];
  const before = new TelegramAdapter({ id: "tg", token: "fake", fetch: first.fetch, position, pollTimeoutSeconds: 0 });
  await before.start(async (m) => { seen.push(m.text); });
  for (let i = 0; i < 100 && seen.length < 2; i++) await delay(10);
  await before.stop();
  assert.equal(position.load(), 12, "the position is saved after each handled message");

  // Branch was down; a third message arrived. The new adapter asks only for what came after.
  const second = fakeTelegram([update(10, "one"), update(11, "two"), update(12, "three")]);
  const after = new TelegramAdapter({ id: "tg", token: "fake", fetch: second.fetch, position: channelPosition(app.store, "tg"), pollTimeoutSeconds: 0 });
  await after.start(async (m) => { seen.push(m.text); });
  for (let i = 0; i < 100 && seen.length < 3; i++) await delay(10);
  await after.stop();
  assert.equal(second.offsets[0], 12);
  assert.deepEqual(seen, ["one", "two", "three"], "nothing answered twice, nothing lost");
});

test("Telegram never saves past a message still being handled, even when a later one finishes first", async () => {
  const saved = [];
  const position = { load: () => 0, save: (value) => saved.push(value) };
  const service = fakeTelegram([update(20, "slow"), update(21, "quick")]);
  const release = {};
  const slowDone = new Promise((done) => { release.slow = done; });
  const handled = [];
  const adapter = new TelegramAdapter({ id: "tg", token: "fake", fetch: service.fetch, position, pollTimeoutSeconds: 0 });
  await adapter.start(async (m) => { if (m.text === "slow") await slowDone; handled.push(m.text); });
  for (let i = 0; i < 100 && !handled.includes("quick"); i++) await delay(10);
  assert.deepEqual(handled, ["quick"]);
  assert.deepEqual(saved, [20], "the later message settled, but the slow one is still open, so a crash would read it again");
  release.slow();
  for (let i = 0; i < 100 && !handled.includes("slow"); i++) await delay(10);
  await adapter.stop();
  assert.equal(saved.at(-1), 22, "once both are done the position moves past them");
});

test("a repeating job cut off by a restart goes back on the list, and a missed turn runs once with a note", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("ran")]) });
  closeFirst(t, () => app.close());
  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000).toISOString();
  app.store.save("schedules", "local", "11111111-1111-4111-8111-111111111111", { kind: "task", prompt: "hourly", dueAt: threeHoursAgo,
    intervalMs: 3600_000, status: "interrupted", permissions: [], history: [] });
  const next = (data, when) => new Date(when.getTime() + Number(data.intervalMs)).toISOString();
  assert.equal(releaseInterruptedSchedules(app.store, next, now), 1);
  const released = app.store.get("schedules", "local", "11111111-1111-4111-8111-111111111111").data;
  assert.equal(released.status, "pending");
  assert.match(released.lastInterruption.note, /carries on at its next turn/);

  app.store.save("schedules", "local", "44444444-4444-4444-8444-444444444444", { kind: "task", prompt: "workdays",
    dueAt: threeHoursAgo, cron: "30 9 * * 1-5", timezone: "UTC", status: "interrupted", permissions: [], history: [] });
  let recoveredCron;
  const nextCronAt = new Date(now.getTime() + 24 * 3600_000).toISOString();
  assert.equal(releaseInterruptedSchedules(app.store, (data) => { recoveredCron = data.cron; return nextCronAt; }, now), 1);
  assert.equal(recoveredCron, "30 9 * * 1-5");
  assert.deepEqual([app.store.get("schedules", "local", "44444444-4444-4444-8444-444444444444").data.status,
    app.store.get("schedules", "local", "44444444-4444-4444-8444-444444444444").data.dueAt], ["pending", nextCronAt]);

  // Switch off: the job still runs once, exactly as before, with no note.
  app.store.save("schedules", "local", "33333333-3333-4333-8333-333333333333", { kind: "task", prompt: "missed while off", dueAt: threeHoursAgo,
    intervalMs: 3600_000, status: "pending", permissions: [], history: [] });
  const offRuns = await new Scheduler(app.store, app.runtime).tick(now);
  assert.equal(offRuns.length, 1);
  assert.equal(app.store.events(offRuns[0].id).some((e) => e.kind === "schedule.caught_up"), false, "off means the old behaviour");
  assert.equal("late" in app.store.get("schedules", "local", "33333333-3333-4333-8333-333333333333").data.history.at(-1), false);

  await saveGatewayConfig(join(root, "d"), GatewayConfigSchema.parse({ mode: "when-needed" }));
  app.store.save("schedules", "local", "22222222-2222-4222-8222-222222222222", { kind: "task", prompt: "missed", dueAt: threeHoursAgo,
    intervalMs: 3600_000, status: "pending", permissions: [], history: [] });
  const runs = await new Scheduler(app.store, app.runtime).tick(now);
  assert.equal(runs.length, 1, "three missed turns run once");
  const caught = app.store.events(runs[0].id).find((e) => e.kind === "schedule.caught_up");
  assert.match(caught.data.note, /due 3 hours ago/);
  const after = app.store.get("schedules", "local", "22222222-2222-4222-8222-222222222222").data;
  assert.ok(Date.parse(after.dueAt) > now.getTime(), "the next turn is in the future, not the missed ones");
});

/* ---------- integration review (17 September) ---------- */

import { openJournal, journalHook } from "../dist/never-break/journal.js";
import { heldReplay } from "../dist/never-break/resume.js";
import { readdir } from "node:fs/promises";

test("a journal that cannot be read is put aside, Branch still starts, and nothing carries on by itself", async (t) => {
  const root = await temp(t);
  const dataDir = join(root, "d");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "journal.sqlite"), "this is not a database at all, just rubbish bytes ".repeat(200));
  const nowhere = openJournal(join(root, "no-such-folder", "journal.sqlite"));
  assert.match(nowhere.reset ?? "", /could not be read/, "even a journal that cannot be made at all never stops the start");
  nowhere.journal.close();
  const opened = openJournal(join(dataDir, "journal.sqlite"));
  assert.match(opened.reset ?? "", /could not be read.*put aside/);
  opened.journal.close();
  assert.ok((await readdir(dataDir)).some((name) => name.startsWith("journal.sqlite.unreadable-")), "the damaged file is kept for a look");

  await writeFile(join(dataDir, "journal.sqlite"), "rubbish again ".repeat(400));
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on" }));
  const app = await createBranch({ workspace: join(root, "w"), dataDir, provider: scripted([say("carried on")]) });
  closeFirst(t, () => app.close());
  const run = app.store.createRun("local", "cut off while thinking");
  app.store.finish(run.id, "interrupted", "cut off");
  const [report] = await app.neverBreak.recoverOnStart(dataDir);
  assert.equal(report.outcome, "offered", "what was in flight is unknown, so the owner decides");

  // A readable journal with a damaged row: that row is treated as the riskiest kind, the rest still settle.
  app.neverBreak.journal.database.prepare("INSERT INTO steps(run_id,session_id,kind,call_id,tool,arguments,key,effects,evidence,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("r", "s", "tool", "c", "x.y", "{", "k", "weird", "{not json", "started", new Date().toISOString());
  const [step] = app.neverBreak.journal.open();
  assert.equal(step.effects, "external");
  assert.equal(step.evidence, null);
});

test("nothing secret is written to the journal, and a hidden step is never re-run from it", async (t) => {
  const root = await temp(t);
  const journal = new TaskJournal(join(root, "journal.sqlite"));
  closeFirst(t, () => journal.close());
  const hook = journalHook(journal, (text) => text.replace(/sk-[A-Za-z0-9]{20,}/g, "[hidden]"));
  const key = `sk-${"a".repeat(32)}`;
  const call = { id: "c1", name: "http.request", arguments: JSON.stringify({ url: "https://example.test", headers: { authorization: `Bearer ${key}` } }) };
  await assert.rejects(hook.around({ runId: "r1", sessionId: "s1", call, permission: "web.fetch", workspace: root, signal: AbortSignal.abort() },
    async () => { throw new Error("cut off"); }), /cut off/);
  const raw = await readFile(join(root, "journal.sqlite")).then((b) => b.toString("latin1")) +
    await readFile(join(root, "journal.sqlite-wal")).then((b) => b.toString("latin1"), () => "");
  assert.ok(!raw.includes(key), "the key is not in the journal file");
  const [open] = journal.open();
  assert.equal(open.redacted, true);
  assert.match(open.arguments, /\[hidden\]/);
  assert.equal(open.key, idempotencyKey("r1", call), "the repeat key still comes from the real call");

  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("x")]) });
  closeFirst(t, () => app.close());
  const run = app.store.createRun("local", "write with a key in it");
  const args = { path: "k.txt", content: "[hidden]" };
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify(args) }] });
  app.neverBreak.journal.begin({ runId: run.id, sessionId: run.sessionId, callId: "w1", tool: "files.write", arguments: JSON.stringify(args),
    key: "k", effects: "idempotent", evidence: null, redacted: true });
  app.store.finish(run.id, "interrupted", "cut off");
  await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  await assert.rejects(readFile(join(app.runtime.workspace, "k.txt")), "the hidden text was not written as if it were the content");
});

/** A chat app that never talks to the network: messages go in by hand, replies are kept. */
function handChat() {
  const chat = { id: "hand", kind: "hand", sent: [], deliver: null,
    botName: () => "hand", start: async (onMessage) => { chat.deliver = onMessage; },
    send: async (chatId, text) => { chat.sent.push({ chatId, text }); return String(chat.sent.length); }, stop: async () => undefined };
  return chat;
}
const handMessage = (text, messageId) => ({ channel: "hand", chatId: "7", chatKind: "direct", senderId: "owner-1", senderName: "Owner",
  text, addressed: true, messageId });

test("a chat task that may already have sent something is not done again when the chat app sends the message again", async (t) => {
  const root = await temp(t);
  const provider = { name: "scripted", requests: 0, async complete() { provider.requests++; return say("answered"); } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  closeFirst(t, () => app.close());
  const chat = handChat();
  await app.channels.attach(chat, { allowlist: ["owner-1"] });

  const run = app.store.createRun("local", "email Sam, then summarise");
  app.store.event(run.id, "channel.inbound", { channel: "hand", chatId: "7", messageId: "m1" });
  const done = app.neverBreak.journal.begin({ runId: run.id, sessionId: run.sessionId, callId: "e1", tool: "email.send",
    arguments: "{}", key: "k", effects: "external", evidence: null });
  app.neverBreak.journal.finish(done, "finished");
  app.store.finish(run.id, "interrupted", "cut off while summarising");
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.notEqual(report.outcome, "left-for-chat", "an email already went out");
  assert.notEqual(report.outcome, "resumed", "a chat task is not carried on by itself in the app");

  await chat.deliver(handMessage("email Sam, then summarise", "m1"));
  assert.equal(provider.requests, 0, "the task was not started again");
  assert.match(chat.sent.at(-1).text, /restarted while it was working on this.*not started again/);
  assert.equal(heldReplay(app.store, "local", { channel: "hand", chatId: "7", messageId: "m1" }), null, "the hold is used once");

  // A chat task that had only looked at things is still simply answered again.
  const looked = app.store.createRun("local", "what is on my list");
  app.store.event(looked.id, "channel.inbound", { channel: "hand", chatId: "7", messageId: "m2" });
  app.store.finish(looked.id, "interrupted", "cut off");
  const [second] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.equal(second.outcome, "left-for-chat");
  await chat.deliver(handMessage("what is on my list", "m2"));
  assert.equal(provider.requests, 1, "answered once, as a fresh task");

  app.store.save("settings", "local", "channel-replay:hand:7:old", { runId: "x", heldAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.equal(app.store.get("settings", "local", "channel-replay:hand:7:old"), undefined, "a hold nobody used is forgotten after a week");
});

/* #483: "carry on after a restart" (long work) ships on, so a task cut off by Branch closing is interrupted, to be carried
   on, even with the gateway off. Only with both off is it cancelled, as before. */
test("a task cut off by Branch closing is cancelled with the gateway and carrying on both off, and interrupted otherwise", async (t) => {
  for (const [mode, resumeAfterRestart] of [["off", false], ["off", true], ["on", false]]) {
    const root = await temp(t);
    await mkdir(join(root, "d"), { recursive: true });
    await saveGatewayConfig(join(root, "d"), GatewayConfigSchema.parse({ mode }));
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const provider = { name: "slow", complete: (request) => new Promise((_, reject) => {
      started();
      request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
    const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
    saveLongWorkSettings(app.store, app.runtime.owner, { resumeAfterRestart });
    const task = app.runtime.run({ prompt: "think for a long time", onTextDelta: () => undefined }).catch((error) => error);
    await waiting;
    await app.close();
    await task;
    const reopened = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("x")]) });
    const [run] = reopened.store.runs("local");
    await reopened.close();
    assert.equal(run.status, mode === "off" && !resumeAfterRestart ? "cancelled" : "interrupted", `gateway ${mode}, carrying on ${resumeAfterRestart}`);
  }
});
