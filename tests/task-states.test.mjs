/* Q51: a task says what it is really doing, from its own recorded events and nothing else: working, waiting for
   the owner, waiting for a service or blocked, with the event's own words as the reason and the time it last
   recorded anything. It goes quiet ("no update for N min") when a working task records nothing for longer than a
   model or a tool may take. A task that stopped to ask stays in view until answered; the count of busy tasks does
   not grow. No percentage anywhere. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { signIn } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";
import { runActivity, staleAfterMs, taskState } from "../dist/activity.js";
import { createBranch, saveKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const T0 = Date.parse("2026-09-23T12:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const run = (status = "running") => ({ id: "r1", sessionId: "s1", prompt: "Tidy the folder", status, createdAt: at(0), updatedAt: at(0) });
let next = 0;
const ev = (seconds, kind, data = {}) => ({ id: `e${next++}`, runId: "r1", kind, data, createdAt: at(seconds) });
const state = (status, events, now = 10) => {
  const { state: name, why, reason, stale, until } = taskState(run(status), events, { now: T0 + now * 1000, staleMs: 90_000 });
  return { state: name, why, reason, stale, ...(until ? { until } : {}) };
};

test("Q51 working, from the model and tool events, with no reason made up", () => {
  assert.deepEqual(state("running", [ev(0, "run.started"), ev(1, "model.started"), ev(2, "tool.started", { name: "files.read", id: "t1", label: "Reading a.txt" })]),
    { state: "working", why: "tool.started", reason: "", stale: false });
});

test("Q51 a task that stopped to ask waits for the owner, with the question it asked", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "files.delete", id: "t1" }), ev(2, "policy.ask", { name: "files.delete", id: "t1", question: "Delete old.txt?" })];
  assert.deepEqual(state("needs_input", events), { state: "waiting-owner", why: "policy.ask", reason: "Delete old.txt?", stale: false });
  /* A plan waiting for an OK while the task still runs waits for the owner too. */
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "plan.awaiting_approval", { steps: ["a", "b"] })]).state, "waiting-owner");
  /* Branch closed on it and it can go on: still the owner's to answer. */
  assert.deepEqual(state("needs_input", [ev(0, "run.started"), ev(1, "run.can_continue", { note: "Branch closed during step 2" })]),
    { state: "waiting-owner", why: "run.can_continue", reason: "Branch closed during step 2", stale: false });
  /* However long the owner takes, a question is never "stale". */
  assert.equal(state("needs_input", events, 3600).stale, false);
});

test("Q51 a service wait says what it waits for and until when, and ends when work goes on", () => {
  const paused = [ev(0, "run.started"), ev(1, "rate.paused", { kind: "round", waitMs: 30_000, message: "Waiting for the next minute of requests" })];
  assert.deepEqual(state("running", paused),
    { state: "waiting-service", why: "rate.paused", reason: "Waiting for the next minute of requests", stale: false, until: at(31) });
  assert.equal(state("running", [...paused, ev(31, "rate.resumed", {})]).state, "working", "resumed is working again");
  const retry = state("running", [ev(0, "run.started"), ev(2, "model.retry_scheduled", { attempt: 1, maxRetries: 3, delayMs: 4000, status: 529, provider: "anthropic" })]);
  assert.deepEqual(retry, { state: "waiting-service", why: "model.retry_scheduled", reason: "anthropic", stale: false, until: at(6) });
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "model.loading", { waitSeconds: 20, message: "Loading the model" })]).why, "model.loading");
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "context.compacting", {})]).state, "waiting-service");
});

test("Q51 a move to another model keeps its reason, and the first model's cooldown is not shown as the task's wait", () => {
  const moved = state("running", [ev(0, "run.started"), ev(1, "model.fallback", {
    from: "a", to: "b", provider: "openai", model: "gpt-x", reason: "Overloaded", cooldownUntil: at(600) })]);
  assert.deepEqual(moved, { state: "waiting-service", why: "model.fallback", reason: "Overloaded", stale: false });
});

test("Q51 Q52 the French task and result words use the straight apostrophe most of fr.json uses, and say \"Mise à jour\"", async () => {
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const ours = Object.entries(fr).filter(([key]) => key.startsWith("task.") || key.startsWith("result."));
  assert.deepEqual(ours.filter(([, words]) => words.includes("\u2019")).map(([key]) => key), []);
  assert.equal(fr["task.updated"], "Mise à jour {time}", "the task is feminine, as in Arrêtée and Bloquée");
});

test("Q51 a task that stopped to ask with no owner event recorded still waits for the owner", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "files.read", id: "t1" })];
  assert.deepEqual(state("needs_input", events), { state: "waiting-owner", why: "needs_input", reason: "", stale: false });
  assert.deepEqual(state("needs_input", [ev(0, "run.started"), ev(1, "rate.paused", { waitMs: 30_000 })]),
    { state: "waiting-owner", why: "needs_input", reason: "", stale: false }, "a service wait before it stopped does not win");
});

test("Q51 a refusal blocks the task until anything moves on, and a failed tool is not a block", () => {
  const denied = [ev(0, "run.started"), ev(1, "policy.denied", { name: "shell.execute", id: "t1", reason: "Lockdown is on" })];
  assert.deepEqual(state("running", denied), { state: "blocked", why: "policy.denied", reason: "Lockdown is on", stale: false });
  assert.equal(state("running", [...denied, ev(2, "model.started")]).state, "working", "the model took the refusal and went on");
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "provider.refused", { error: "Credit exhausted" })]).reason, "Credit exhausted");
  /* A tool that failed is a result the model works with, not a wall. */
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "tool.started", { name: "web.fetch", id: "t1" }), ev(2, "tool.failed", { name: "web.fetch", id: "t1", error: "404" })]).state, "working");
});

test("Q51 a working task that records nothing for longer than a model or a tool may take has gone quiet", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "shell.execute", id: "t1" })];
  assert.equal(state("running", events, 60).stale, false, "a minute in is not quiet");
  assert.equal(state("running", events, 300).stale, true, "four minutes with nothing is");
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "policy.denied", { reason: "no" })], 3600).stale, false, "a block is not quiet, it is blocked");
  assert.equal(taskState(run(), events, { now: T0 + 300_000, staleMs: 90_000 }).lastUpdate, at(1), "the last update is the last event's time");
});

test("Q51 the same step reported twice is one step, and a finished task is finished", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "files.read", id: "t1", label: "Reading a.txt" }),
    ev(2, "tool.completed", { name: "files.read", id: "t1" }), ev(3, "tool.completed", { name: "files.read", id: "t1" })];
  const activity = runActivity(run(), events, { now: T0 + 5000, staleMs: 90_000 });
  assert.deepEqual(activity.steps.map((step) => [step.label, step.status]), [["Reading a.txt", "done"]]);
  assert.equal(activity.task.state, "working");
  for (const status of ["completed", "failed", "cancelled", "budget_exceeded"])
    assert.equal(taskState(run(status), events).state, "finished", status);
  assert.equal(JSON.stringify(activity).includes("percent"), false, "nothing says how much is left");
});

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-states-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  const owner = app.runtime.owner;
  /* A conversation whose newest task stopped to ask; an older one of its tasks that asked too; and one that is working. */
  const older = app.store.createRun(owner, "Rename the photos");
  app.store.event(older.id, "policy.ask", { name: "files.move", id: "t0", question: "Move 40 photos?" });
  app.store.finish(older.id, "needs_input", "");
  const asking = app.store.createRun(owner, "Rename the photos again", older.sessionId);
  app.store.event(asking.id, "policy.ask", { name: "files.move", id: "t1", question: "Move 41 photos?" });
  app.store.finish(asking.id, "needs_input", "");
  const working = app.store.createRun(owner, "Summarise the notes");
  app.store.event(working.id, "tool.started", { name: "files.read", id: "t2", label: "Reading notes.md" });
  return { app, server, call, older, asking, working };
}

test("Q51 the task list shows the one that waits for you; the busy count and other screens do not grow", async (t) => {
  const { call, older, asking, working } = await branch(t);
  const busy = await call("/api/activity");
  assert.deepEqual(busy.map((one) => one.runId), [working.id], "by default, running tasks only, as the busy count reads them");
  assert.equal(busy[0].task.state, "working");
  const all = await call("/api/activity?waiting=1");
  assert.deepEqual(all.map((one) => one.runId).sort(), [asking.id, working.id].sort(), "the older question a later task moved past is not listed");
  const waiting = all.find((one) => one.runId === asking.id);
  assert.deepEqual([waiting.task.state, waiting.task.why, waiting.task.reason], ["waiting-owner", "policy.ask", "Move 41 photos?"]);
  assert.equal(all.some((one) => one.runId === older.id), false);
});

test("Q51 the Activity pane reads the state in words, with no moving bar for a task that waits", async (t) => {
  const { server, asking } = await branch(t);
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  errors.length = 0; // what failed before the key was given is the login page's business
  /* Redesign: the new window's list of tasks is the status bar's "running" popover (data-act="tasks10",
     public/app/shell/usage.js tasksPop): a spinner while a task works, a clock while it waits, and what it is doing. */
  await page.locator('[data-act="tasks10"]').click();
  const pop = page.locator(".pop");
  await pop.waitFor({ state: "visible" });
  const rows = await pop.locator(".mi[role=menuitem]").evaluateAll((items) => items.map((row) => ({
    text: row.textContent, waits: Boolean(row.querySelector(".ico:not(:has(.spin))")) && !row.querySelector(".spin"), spins: Boolean(row.querySelector(".spin")) })));
  const busy = rows.find((row) => row.text.includes("Reading notes.md"));
  assert.ok(busy?.spins, `a working task keeps its step and moves (${JSON.stringify(rows)})`);
  // WINDOW BUG: public/app/shell/activity.js:15 reads GET /api/activity (running tasks only) and usage.js tasksPop never shows
  // the engine's words for a task's state (task.reason), so a task waiting for your answer is not in the list at all.
  const waiting = rows.find((row) => row.text.includes("Move 41 photos?"));
  assert.ok(waiting, `the task waiting for your answer is listed with its question (${JSON.stringify(rows)})`);
  assert.equal(waiting.spins, false, "no moving mark for a task that waits");
  // Redesign: replaced by the new window (no /i18n.js or /task-state.js; the French words are not drawn), and the old
  // "Updated … ago" line is not in prototype.html's popover.
  assert.deepEqual(errors, []);
});

/** A model that answers from a script, so a real task runs through the real runtime. */
function scripted(steps) {
  return { name: "scripted", async complete() { return steps.shift() ?? { content: "Done.", toolCalls: [] }; } };
}
async function realBranch(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-states-real-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  return { app, call };
}

test("Q51 a real task that asks the owner a question is listed as waiting for you, with that question", async (t) => {
  const { app, call } = await realBranch(t, [
    { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question: "Which folder should I clean, Downloads or Desktop?" }) }] },
  ]);
  const run = await app.runtime.run({ prompt: "clean up my files" });
  assert.equal(run.status, "needs_input");
  const listed = (await call("/api/activity?waiting=1")).find((one) => one.runId === run.id);
  assert.deepEqual([listed.task.state, listed.task.why, listed.task.reason],
    ["waiting-owner", "attention.needed", "Which folder should I clean, Downloads or Desktop?"]);
  /* The same set "Needs you" lists. */
  assert.deepEqual((await call("/api/state")).attention.map((one) => one.runId), [run.id]);
  /* Answered, it is no longer waiting. */
  await app.runtime.run({ prompt: "Downloads", sessionId: run.sessionId });
  assert.equal((await call("/api/activity?waiting=1")).some((one) => one.sessionId === run.sessionId), false);
});

test("Q51 a real refusal reads as blocked only until the model takes it and goes on", async (t) => {
  const { app, call } = await realBranch(t, [
    { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "notes.txt", content: "hello" }) }] },
    { content: "I may not write files here, so I stopped.", toolCalls: [] },
  ]);
  await call("/api/policy", { preset: "read-only" });
  const run = await app.runtime.run({ prompt: "write a note" });
  const events = app.store.events(run.id);
  const denied = events.findIndex((event) => event.kind === "policy.denied");
  assert.ok(denied >= 0, `the write was refused (${events.map((event) => event.kind).join(", ")})`);
  /* At the moment of the refusal the task is blocked, with the refusal's own words... */
  const then = taskState({ ...run, status: "running" }, events.slice(0, denied + 1));
  assert.equal(then.state, "blocked");
  assert.equal(then.why, "policy.denied");
  /* ...and the next thing it records is the model taking it: from there it works again. */
  const after = events.slice(denied + 1).find((event) => ["model.started", "tool.started"].includes(event.kind));
  assert.ok(after, "the model went on after the refusal");
  assert.equal(taskState({ ...run, status: "running" }, events.slice(0, events.indexOf(after) + 1)).state, "working");
  t.diagnostic(`blocked for ${Date.parse(after.createdAt) - Date.parse(events[denied].createdAt)} ms before the model went on`);
});

test("Q51 a question still unanswered stays listed however much other work finishes after it", async (t) => {
  const { app, call, asking } = await branch(t);
  const owner = app.runtime.owner;
  for (let i = 0; i < 105; i++) app.store.finish(app.store.createRun(owner, `Other task ${i}`).id, "completed", "done");
  assert.equal(app.store.runs(owner).some((run) => run.id === asking.id), false, "it is past the recent-history window");
  assert.ok((await call("/api/activity?waiting=1")).some((one) => one.runId === asking.id), "and still waiting for you");
});

/* The run ids "Needs you" lists, and those the Activity list shows as waiting for the owner, sorted. */
async function bothWaiting(call) {
  const needsYou = (await call("/api/state")).attention.map((one) => one.runId).sort();
  const activity = (await call("/api/activity?waiting=1")).filter((one) => one.task.state === "waiting-owner").map((one) => one.runId).sort();
  return { needsYou, activity };
}

test("Q51 Needs you keeps a question still unanswered however much other work finishes, as the Activity list does", async (t) => {
  const { app, call, older, asking } = await branch(t);
  const owner = app.runtime.owner;
  for (let i = 0; i < 105; i++) app.store.finish(app.store.createRun(owner, `Other task ${i}`).id, "completed", "done");
  const attention = (await call("/api/state")).attention;
  const item = attention.find((one) => one.runId === asking.id);
  assert.ok(item, "still in Needs you");
  assert.equal(item.question, app.store.run(asking.id).output, "with its question, as before");
  assert.equal(item.canContinue, undefined, "a question is answered, not continued");
  assert.equal(attention.some((one) => one.runId === older.id), false, "the older question a later task moved past is not listed");
  const { needsYou, activity } = await bothWaiting(call);
  assert.deepEqual(needsYou, [asking.id]);
  assert.deepEqual(needsYou, activity, "the same tasks as the Activity list's waiting ones");
});

test("Q51 a task Branch closed on, which can be continued, is listed as waiting for you to continue", async (t) => {
  const { app, call } = await branch(t);
  const closed = app.store.createRun(app.runtime.owner, "Sort the invoices");
  app.store.event(closed.id, "run.can_continue", { note: "Branch closed during step 2" });
  app.store.finish(closed.id, "interrupted", "");
  const listed = (await call("/api/activity?waiting=1")).find((one) => one.runId === closed.id);
  assert.deepEqual([listed?.task.state, listed?.task.why, listed?.task.reason], ["waiting-owner", "run.can_continue", "Branch closed during step 2"]);
  assert.equal((await call("/api/activity")).some((one) => one.runId === closed.id), false, "not counted as busy");
});

test("Q51 Needs you lists a task Branch closed on, saying it can be continued, as the Activity list does", async (t) => {
  const { app, call, asking } = await branch(t);
  const closed = app.store.createRun(app.runtime.owner, "Sort the invoices");
  app.store.event(closed.id, "run.can_continue", { note: "Branch closed during step 2" });
  app.store.finish(closed.id, "interrupted", "");
  const item = (await call("/api/state")).attention.find((one) => one.runId === closed.id);
  assert.deepEqual([item?.sessionId, item?.question, item?.canContinue], [closed.sessionId, "Branch closed during step 2", true]);
  const { needsYou, activity } = await bothWaiting(call);
  assert.deepEqual(needsYou, [asking.id, closed.id].sort());
  assert.deepEqual(needsYou, activity, "the same tasks as the Activity list's waiting ones");
  /* Without a note, it still says in words that it can be continued. */
  const quiet = app.store.createRun(app.runtime.owner, "Tidy the desk");
  app.store.finish(quiet.id, "interrupted", "");
  assert.match((await call("/api/state")).attention.find((one) => one.runId === quiet.id)?.question ?? "", /Continue it when you are ready/);
});

test("Q51 'no update' waits as long as the owner's own limits allow a silence", async (t) => {
  const { app, call, working } = await branch(t);
  /* A tool eight minutes into the ten minutes the owner allows has not gone quiet, on screen either. The store stamps
     events with the time they happen, so the test moves this one back (a disposable store). */
  app.store.db.prepare("UPDATE events SET created_at=? WHERE run_id=?").run(new Date(Date.now() - 8 * 60_000).toISOString(), working.id);
  const quiet = async () => (await call("/api/activity")).find((one) => one.runId === working.id).task.stale;
  assert.equal(await quiet(), true, "past the built-in limits, it has gone quiet");
  saveKnobs(app.store, app.runtime.owner, "commands", { toolTimeoutSeconds: 600 });
  assert.equal(await quiet(), false, "inside the limit the owner set, it has not");
  saveKnobs(app.store, app.runtime.owner, "commands", { toolTimeoutSeconds: null });
  const owner = app.runtime.owner, limits = app.runtime.reliability;
  const base = staleAfterMs(app.store, owner, limits);
  assert.ok(base >= limits.modelStallMs && base >= limits.toolTimeoutMs && base >= limits.localFirstReplyMs, `${base} covers every built-in limit`);
  saveKnobs(app.store, owner, "commands", { toolTimeoutSeconds: 600 });
  assert.equal(staleAfterMs(app.store, owner, limits) >= 600_000, true, "a longer tool limit the owner set");
  saveKnobs(app.store, owner, "limits", { localFirstReplySeconds: 1800 });
  assert.equal(staleAfterMs(app.store, owner, limits), 1_800_000 + 30_000, "a model on this computer starting its reply, with its grace");
});

test("Q58 a queued task shows it is waiting its turn, with position and what it waits behind", async (t) => {
  const { app, call, working } = await branch(t);
  const owner = app.runtime.owner;
  const sessionId = working.sessionId;
  // Mark session as active so queuedFollowUp doesn't drain them immediately (the runtime only drains when the session is free).
  app.runtime.activeSessions.add(sessionId);
  // Queue two messages while the conversation is busy (it has a working task)
  const q1 = app.runtime.followUp(sessionId, "First queued message");
  const q2 = app.runtime.followUp(sessionId, "Second queued message");
  assert.equal(q1.position, 1, "first queued message is at position 1");
  assert.equal(q2.position, 2, "second queued message is at position 2");
  // Remove active marker so queue can be checked via API
  app.runtime.activeSessions.delete(sessionId);
  // Check the activity list with waiting=1 includes queued tasks
  const activity = await call("/api/activity?waiting=1");
  const queued = activity.filter((one) => one.task?.state === "queued");
  assert.equal(queued.length, 2, "both queued messages are listed");
  const first = queued[0];
  assert.equal(first.prompt, "First queued message");
  assert.equal(first.task.position, 1);
  assert.ok(first.task.waitingBehind, "shows what it waits behind");
  const second = queued[1];
  assert.equal(second.prompt, "Second queued message");
  assert.equal(second.task.position, 2);
  assert.ok(second.task.waitingBehind, "waits behind something");
});

test("Q58 queuedActivity pure function positions three queued items correctly", async (t) => {
  const { queuedActivity } = await import("../dist/activity.js");
  const activity = { runId: "r1", sessionId: "s1", prompt: "Running task", status: "running",
    startedAt: "2026-09-23T16:00:00Z", current: "Working", steps: [],
    task: { state: "working", why: "run.started", reason: "", lastUpdate: "2026-09-23T16:00:10Z", stale: false } };
  const queued = [
    { id: "q1", prompt: "First queue message", createdAt: "2026-09-23T16:00:20Z" },
    { id: "q2", prompt: "Second queue message", createdAt: "2026-09-23T16:00:21Z" },
    { id: "q3", prompt: "Third queue message", createdAt: "2026-09-23T16:00:22Z" },
  ];
  const result = queuedActivity(activity, queued);
  assert.equal(result.length, 3, "all three are listed");
  assert.equal(result[0].task.position, 1);
  assert.ok(result[0].task.waitingBehind.includes("Running task"), "first waits behind running task");
  assert.equal(result[1].task.position, 2);
  assert.ok(result[1].task.waitingBehind.includes("First queue"), "second waits behind first");
  assert.equal(result[2].task.position, 3);
  assert.ok(result[2].task.waitingBehind.includes("Second queue"), "third waits behind second");
});

test("Q58 a queued task shows when it was queued in lastUpdate", async (t) => {
  const { app, call, working } = await branch(t);
  const owner = app.runtime.owner;
  const sessionId = working.sessionId;
  // Mark session as active so queued message doesn't drain immediately
  app.runtime.activeSessions.add(sessionId);
  const before = new Date().toISOString();
  const q = app.runtime.followUp(sessionId, "Queued now");
  const after = new Date().toISOString();
  // Remove active marker so queue can be checked
  app.runtime.activeSessions.delete(sessionId);
  const activity = await call("/api/activity?waiting=1");
  const queued = activity.find((one) => one.task?.state === "queued");
  assert.ok(queued?.task?.lastUpdate, "has a lastUpdate");
  assert.ok(Date.parse(queued.task.lastUpdate) >= Date.parse(before), "lastUpdate is after queue time");
  assert.ok(Date.parse(queued.task.lastUpdate) <= Date.parse(after), "lastUpdate is before now");
});

test("Q58 busy count excludes queued tasks (1 working + 2 queued = count is 1)", async (t) => {
  const { app, call, working } = await branch(t);
  const sessionId = working.sessionId;
  // Mark session as active so queued messages don't drain immediately
  app.runtime.activeSessions.add(sessionId);
  app.runtime.followUp(sessionId, "Queued message 1");
  app.runtime.followUp(sessionId, "Queued message 2");
  app.runtime.activeSessions.delete(sessionId);
  // Fetch activity and count items where status==="running" AND task.state !== "queued"
  const activity = await call("/api/activity?waiting=1");
  const busyCount = activity.filter((item) => item.status === "running" && item.task?.state !== "queued").length;
  assert.equal(busyCount, 1, "only the working task counts as busy, not the 2 queued");
});

test("Q58 when the task ahead finishes, the next queued message starts and the rest move up", async (t) => {
  /* A model that holds its first two answers until the test lets them go, so the queue can be watched moving. */
  const gates = [], opened = [];
  for (let i = 0; i < 2; i++) gates.push(new Promise((resolve) => opened.push(resolve)));
  let calls = 0;
  const provider = { name: "gated", async complete() { const mine = calls++; if (mine < 2) await gates[mine]; return { content: "Done.", toolCalls: [] }; } };
  const root = await mkdtemp(join(tmpdir(), "branch-q58-drain-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { opened.forEach((open) => open()); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((response) => response.json());
  const until = async (check) => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 25)); } throw new Error("timed out"); };
  const first = app.runtime.run({ prompt: "Sort the photos" });
  const running = await until(() => app.store.runs(app.runtime.owner).find((run) => run.status === "running" && calls === 1));
  app.runtime.followUp(running.sessionId, "Then rename them");
  app.runtime.followUp(running.sessionId, "Then back them up");
  const queuedNow = async () => (await call("/api/activity?waiting=1")).filter((one) => one.task?.state === "queued")
    .map((one) => [one.prompt, one.task.position, one.task.waitingBehind]);
  assert.deepEqual(await queuedNow(), [["Then rename them", 1, "Sort the photos"], ["Then back them up", 2, "Then rename them"]]);
  opened[0]();
  await first;
  /* The first queued message is now the task that works; the other moved up behind it. */
  const moved = await until(async () => { const list = await queuedNow(); return calls === 2 && list.length === 1 ? list : null; });
  assert.deepEqual(moved, [["Then back them up", 1, "Then rename them"]]);
  const busy = (await call("/api/activity")).map((one) => one.prompt);
  assert.deepEqual(busy, ["Then rename them"], "the one that moved up to work is the busy one");
});

test("Q58 a task that waits for the owner or a service, or is blocked, still holds the conversation", async () => {
  const { queuedActivity } = await import("../dist/activity.js");
  const ahead = (state) => ({ runId: "r1", sessionId: "s1", prompt: "Tidy the folder", status: "running",
    startedAt: at(0), current: null, steps: [], task: { state, why: "", reason: "", lastUpdate: at(1), stale: false } });
  const queued = [{ id: "q1", prompt: "Then sort it", createdAt: at(2) }, { id: "q2", prompt: "Then back it up", createdAt: at(3) }];
  const behind = (state) => queuedActivity(ahead(state), queued).map((one) => one.task.waitingBehind);
  assert.deepEqual(behind("waiting-owner"), ["Tidy the folder", "Then sort it"], "waiting for the owner");
  assert.deepEqual(behind("waiting-service"), ["Tidy the folder", "Then sort it"], "waiting for a service");
  assert.deepEqual(behind("blocked"), ["Tidy the folder", "Then sort it"], "blocked");
  assert.deepEqual(behind("finished"), ["", "Then sort it"], "a finished task holds nothing");
});

test("Q58 when the task ahead is cancelled, the next queued message starts and the rest move up", async (t) => {
  /* A model that holds its first two answers until the test lets them go, and gives up when its task is cancelled. */
  const gates = [], opened = [];
  for (let i = 0; i < 2; i++) gates.push(new Promise((resolve) => opened.push(resolve)));
  let calls = 0;
  const provider = { name: "gated", async complete(request) {
    const mine = calls++;
    if (mine < 2) await new Promise((resolve, reject) => {
      const signal = request.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      gates[mine].then(resolve);
    });
    return { content: "Done.", toolCalls: [] };
  } };
  const root = await mkdtemp(join(tmpdir(), "branch-q58-cancel-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { opened.forEach((open) => open()); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((response) => response.json());
  const until = async (check) => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 25)); } throw new Error("timed out"); };
  const first = app.runtime.run({ prompt: "Sort the photos" });
  const running = await until(() => app.store.runs(app.runtime.owner).find((run) => run.status === "running" && calls === 1));
  app.runtime.followUp(running.sessionId, "Then rename them");
  app.runtime.followUp(running.sessionId, "Then back them up");
  const queuedNow = async () => (await call("/api/activity?waiting=1")).filter((one) => one.task?.state === "queued")
    .map((one) => [one.prompt, one.task.position, one.task.waitingBehind]);
  assert.deepEqual(await queuedNow(), [["Then rename them", 1, "Sort the photos"], ["Then back them up", 2, "Then rename them"]]);
  /* The model's first answer is never let go: the task ends only because it is cancelled. */
  assert.equal(app.runtime.cancel(running.id), true, "the running task was cancelled");
  assert.equal((await first).status, "cancelled");
  const moved = await until(async () => {
    const list = await queuedNow(), busy = (await call("/api/activity")).map((one) => one.prompt);
    return JSON.stringify(list) === JSON.stringify([["Then back them up", 1, "Then rename them"]]) && busy.join() === "Then rename them" ? { list, busy } : null;
  });
  assert.deepEqual(moved.busy, ["Then rename them"], "the first queued message is the busy one");
  assert.deepEqual(moved.list, [["Then back them up", 1, "Then rename them"]], "the other moved up to position 1 behind it");
});

