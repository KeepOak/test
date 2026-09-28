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
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, firstCall) {
  const root = await mkdtemp(join(tmpdir(), "branch-wakeups-"));
  const prompts = [];
  let first = true;
  const provider = { name: "scripted", async complete(request) {
    const said = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const last = request.messages.at(-1);
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
  await assert.rejects(app.registry.execute("schedules.wake_later", { message: "x" }, mine), /inMinutes or at/);
});
