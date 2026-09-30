/**
 * The lead's workbench (SELF-304, SELF-305): being woken instead of polling. A program left running wakes its own
 * conversation when it ends or prints a line asked for, and a wake-up set for later arrives in the same conversation,
 * each as a follow-up of the task that asked, so the owner's selected Full Access carries on without a question.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveBackgroundSettings } from "../dist/processes.js";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, firstCall) {
  const root = await mkdtemp(join(tmpdir(), "branch-wakeups-"));
  const prompts = [];
  let first = true;
  const provider = { name: "scripted", async complete(request) {
    const said = [...request.messages].reverse().find((m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>"))?.content ?? "";
    const last = request.messages.filter((m) => m.role !== "system" && !String(m.content).startsWith("<system-reminder>")).at(-1);
    if (last?.role === "tool") return { content: "Started; I will be told.", toolCalls: [] };
    prompts.push(said);
    if (first) { first = false; return { content: "", toolCalls: [{ id: "call-1", ...firstCall }] }; }
    return { content: "Noted.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = async (body) => (await fetch(new URL("/api/run", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return { app, run, prompts };
}
const until = async (check, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (check()) return true;
  return false;
};

test("a program left running wakes its conversation on a line asked for and when it ends, as the owner's own follow-up in the same conversation", async (t) => {
  const script = "console.log('compiling'); console.log('BUILD DONE in 1s'); setTimeout(() => process.exit(3), 300);";
  const { app, run, prompts } = await fixture(t, { name: "process.start",
    arguments: JSON.stringify({ program: "node", args: ["-e", script], name: "the build", wakeOnExit: true, wakeOnText: ["build done"], wakes: 1 }) });
  await saveBackgroundSettings(app.store, app.runtime.owner, { programs: { node: { path: process.execPath } } });
  const started = await run({ prompt: "Start the build and carry on", mode: "full" });
  assert.equal(started.status, "completed", started.output);
  assert.ok(await until(() => prompts.length >= 3), `woken twice: ${JSON.stringify(prompts)}`);
  assert.match(prompts[1], /printed a line you asked to be woken for:\nBUILD DONE in 1s/);
  assert.match(prompts[2], /"the build", failed \(exit code 3\)/);
  assert.match(prompts[2], /compiling/);
  const woken = app.store.runs(app.runtime.owner).filter((one) => one.sessionId === started.sessionId && one.id !== started.id);
  assert.equal(woken.length, 2);
  for (const one of woken) {
    const start = app.store.events(one.id).find((event) => event.kind === "run.started").data;
    // The owner's own task, in the owner's own window: its follow-up is the owner's too, so Full Access carries on.
    assert.equal(start.source, "owner");
    assert.equal(start.callerKind, "owner-here");
  }
  assert.ok(await until(() => woken.every((one) => app.store.run(one.id).status === "completed")));
});

test("a stopped program does not wake anyone, and no words means no line wake-ups", async (t) => {
  const { app, run, prompts } = await fixture(t, { name: "process.start",
    arguments: JSON.stringify({ program: "node", args: ["-e", "setInterval(() => console.log('tick'), 50)"], wakeOnExit: true }) });
  await saveBackgroundSettings(app.store, app.runtime.owner, { programs: { node: { path: process.execPath } } });
  const started = await run({ prompt: "Start it", mode: "full" });
  const [program] = app.processes.list({ sessionId: started.sessionId });
  await wait(300);
  await app.processes.stop(program.id);
  await wait(500);
  assert.equal(prompts.length, 1, "only the first message reached the model");
});

test("a wake-up set in a conversation arrives there when due, repeats as asked, and a missed turn comes once", async (t) => {
  const { app, run, prompts } = await fixture(t, { name: "schedules.wake_later",
    arguments: JSON.stringify({ message: "Check the pull requests again.", inMinutes: 30, everyMinutes: 30, times: 2 }) });
  const started = await run({ prompt: "Keep an eye on the pull requests", mode: "full" });
  assert.equal(started.status, "completed", started.output);
  const context = app.runtime.context({ runId: started.id });
  const [set] = (await app.registry.execute("schedules.wakeups", {}, context)).wakeups;
  assert.equal(set.left, 2);
  await app.scheduler.tick(new Date(Date.now() + 10 * 60_000));
  assert.equal(prompts.length, 1, "not due yet");
  // Branch was closed for three hours: the missed turns arrive as one, and the repeat moves on from now.
  const later = new Date(Date.now() + 3 * 60 * 60_000);
  await app.scheduler.tick(later);
  assert.ok(await until(() => prompts.length === 2), JSON.stringify(prompts));
  assert.match(prompts[1], /^Wake-up you set \(every 30 minutes; 1 more to come\): Check the pull requests again\./);
  const [moved] = (await app.registry.execute("schedules.wakeups", {}, context)).wakeups;
  assert.ok(Date.parse(moved.nextAt) > later.getTime(), "the next one is after now, not a backlog");
  await app.scheduler.tick(new Date(later.getTime() + 31 * 60_000));
  assert.ok(await until(() => prompts.length === 3));
  assert.deepEqual((await app.registry.execute("schedules.wakeups", {}, context)).wakeups, [], "the last one is gone");
  const woken = app.store.runs(app.runtime.owner).filter((one) => one.sessionId === started.sessionId && one.id !== started.id);
  assert.equal(woken.length, 2, "both in the same conversation");
});

test("wake-ups are per conversation: another one can neither see nor cancel them", async (t) => {
  const { app, run } = await fixture(t, { name: "schedules.wake_later", arguments: JSON.stringify({ message: "Look again.", inMinutes: 5 }) });
  const first = await run({ prompt: "Remind me", mode: "full" });
  const mine = app.runtime.context({ runId: first.id });
  const [entry] = (await app.registry.execute("schedules.wakeups", {}, mine)).wakeups;
  const other = await app.runtime.run({ prompt: "something else" });
  const theirs = app.runtime.context({ runId: other.id });
  assert.deepEqual((await app.registry.execute("schedules.wakeups", {}, theirs)).wakeups, []);
  await assert.rejects(app.registry.execute("schedules.cancel_wake", { id: entry.id }, theirs), /no wake-up with that number/);
  assert.deepEqual(await app.registry.execute("schedules.cancel_wake", { id: entry.id }, mine), { cancelled: true });
  await assert.rejects(app.registry.execute("schedules.wake_later", { message: "x" }, mine), /one of inMinutes, at or cron/);
});

test("the default Trunk's wake-up survives a restart and arrives in its conversation as that Trunk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wakeups-restart-"));
  let after;
  t.after(async () => { await after?.close(); await discardTemp(root); });
  const systems = [];
  let first = true;
  const provider = { name: "scripted", async complete(request) {
    systems.push(request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
    const said = [...request.messages].reverse().find((m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>"))?.content ?? "";
    if (request.messages.filter((m) => m.role !== "system" && !String(m.content).startsWith("<system-reminder>")).at(-1)?.role === "tool") return { content: "Set.", toolCalls: [] };
    if (first && /sync the plan/.test(said)) { first = false; return { content: "", toolCalls: [{ id: "w1", name: "schedules.wake_later",
      arguments: JSON.stringify({ message: "Sync the master plan.", cron: "*/30 * * * *", timezone: "America/New_York", times: 3 }) }] }; }
    return { content: `Heard: ${said.slice(0, 80)}`, toolCalls: [] };
  } };
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const before = await open();
  const home = before.trunks.ensureDefault(true);
  before.trunks.files.edit(home.id, { name: "USER.md", text: "WAKE-TRUNK-MARK-4410" });
  const set = await before.runtime.run({ prompt: "every 30 minutes sync the plan", trunkId: home.id, mode: "full" });
  assert.equal(set.status, "completed", set.output);
  const [entry] = (await before.registry.execute("schedules.wakeups", {}, before.runtime.context({ runId: set.id }))).wakeups;
  assert.equal(entry.cron, "*/30 * * * *");
  assert.equal(new Date(entry.nextAt).getUTCMinutes() % 30, 0, "a cron wake-up is due on its clock times");
  await before.close();

  after = await open();
  const context = after.runtime.context({ runId: set.id });
  assert.equal((await after.registry.execute("schedules.wakeups", {}, context)).wakeups.length, 1, "kept across the restart");
  await after.scheduler.tick(new Date(Date.parse(entry.nextAt) + 1000));
  const woken = () => after.store.runs(after.runtime.owner).filter((one) => one.sessionId === set.sessionId && one.id !== set.id);
  assert.ok(await until(() => woken().length === 1 && after.store.run(woken()[0].id).status === "completed"), "the wake-up ran after the restart");
  const run = after.store.run(woken()[0].id);
  assert.match(run.prompt, /^Wake-up you set \(on "\*\/30 \* \* \* \*" \(America\/New_York\); 2 more to come\): Sync the master plan\./);
  assert.match(systems.at(-1), /WAKE-TRUNK-MARK-4410/, "it runs as the default Trunk, with its own files");
  const [moved] = (await after.registry.execute("schedules.wakeups", {}, context)).wakeups;
  assert.equal(moved.left, 2);
  assert.ok(Date.parse(moved.nextAt) > Date.parse(entry.nextAt));
});

test("a wake-up that cannot be delivered is noted and tried again, and one whose conversation is gone is dropped", async () => {
  const { Wakeups, WakeLaterSchema } = await import("../dist/wakeups.js");
  const saved = new Map(), events = [];
  let owns = true, now = Date.parse("2026-09-28T12:00:00Z");
  const store = {
    run: () => ({ sessionId: "s1" }), ownsSession: () => owns,
    list: () => [...saved.entries()].map(([id, data]) => ({ id, data })),
    save: (_table, _owner, id, data) => saved.set(id, data), delete: (_table, _owner, id) => saved.delete(id),
    event: (runId, kind, data) => events.push({ runId, kind, data }),
  };
  let fail = true;
  const delivered = [];
  const wakeups = new Wakeups(store, "owner", (sessionId, text) => { if (fail) throw new Error("busy"); delivered.push(text); }, () => now);
  wakeups.set({ runId: "r1" }, { message: "Look again.", inMinutes: 1 });
  await wakeups.tick(new Date(now + 2 * 60_000));
  assert.equal(events.at(-1).kind, "wakeup.not_delivered");
  assert.equal(events.at(-1).data.willRetry, true);
  assert.equal(wakeups.list("s1").length, 1, "kept for another try");
  fail = false;
  await wakeups.tick(new Date(now + 8 * 60_000));
  assert.deepEqual(delivered, ["Wake-up you set: Look again."]);
  assert.equal(wakeups.list("s1").length, 0);
  fail = true;
  wakeups.set({ runId: "r1" }, { message: "Gone.", inMinutes: 1 });
  owns = false;
  await wakeups.tick(new Date(now + 2 * 60_000));
  assert.equal(wakeups.list("s1").length, 0, "its conversation is gone, so it is dropped");
  assert.equal(WakeLaterSchema.safeParse({ message: "x", cron: "0 9 * * *" }).success, false, "a cron needs a timezone");
  assert.equal(WakeLaterSchema.safeParse({ message: "x", cron: "0 9 * * *", timezone: "UTC", everyMinutes: 30 }).success, false);
});

test("a program commands may run can be left running and wakes its conversation, with no separate list", async (t) => {
  const { app, run, prompts } = await fixture(t, { name: "process.start",
    arguments: JSON.stringify({ program: "node", args: ["-e", "console.log('tests passed')"], name: "the tests", wakeOnExit: true }) });
  assert.deepEqual(app.processes.commandPrograms(), {}, "nothing while no shell is set up");
  // What the launch does when it sets up shell.execute (src/integrations/bootstrap.ts): the same list reaches process.start.
  app.ownClis.attach({ extra: () => ({}) }, ["node"], { node: { path: process.execPath, args: [] } });
  app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "Run a command (a stand-in for the launch's shell).",
    parameters: z.object({}).strict(), execute: async () => ({}) });
  const started = await run({ prompt: "Run the tests in the background", mode: "full" });
  assert.equal(started.status, "completed", started.output);
  assert.ok(await until(() => prompts.length >= 2), JSON.stringify(prompts));
  assert.match(prompts[1], /"the tests", finished \(exit code 0\)\. Its last lines:\ntests passed/);
  // Only a task that may run commands may leave one running, and a helper is never woken in its own conversation.
  const context = app.runtime.context({ runId: started.id });
  const noCommands = { ...context, permissions: new Set([...context.permissions].filter((one) => one !== "shell.execute")) };
  await assert.rejects(app.registry.execute("process.start", { program: "node", args: ["-e", "1"] }, noCommands), /not one of the programs/);
  // SELF-304: a task held to one folder leaves a command running only as the shell walls it (held-background-programs.test.mjs).
  await assert.rejects(app.registry.execute("process.start", { program: "node", args: ["-e", "1"] }, { ...context, writesConfinedTo: app.runtime.workspace }),
    /cannot be left running here/, "and with no shell that can wall it, nothing starts");
  await assert.rejects(app.registry.execute("process.start", { program: "node", args: ["-e", "1"] }, { ...noCommands, writesConfinedTo: app.runtime.workspace }),
    /not one of the programs/, "nor without commands");
  await assert.rejects(app.registry.execute("process.start", { program: "node", args: ["-e", "1"], wakeOnExit: true }, { ...context, depth: 1 }), /helper cannot be woken/);
  await assert.rejects(app.registry.execute("schedules.wake_later", { message: "x", inMinutes: 5 }, { ...context, depth: 1 }), /helper cannot set wake-ups/);
  // What a wake-up starts carries the tools of the task that asked for it, no more.
  const woke = app.store.runs(app.runtime.owner).find((one) => one.sessionId === started.sessionId && one.id !== started.id);
  const asked = app.store.events(started.id).find((e) => e.kind === "run.started").data.permissions;
  const carried = app.store.events(woke.id).find((e) => e.kind === "run.started").data.permissions;
  assert.ok(carried.every((one) => asked.includes(one)), "never more than the task that asked");
});
