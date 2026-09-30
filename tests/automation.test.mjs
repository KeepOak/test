import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, nextDailyOccurrence } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted() {
  const provider = { name: "scripted", requests: [], failNext: false, hold: null, async complete(request) {
    provider.requests.push(request);
    if (provider.hold) await provider.hold;
    if (provider.failNext) { provider.failNext = false; throw new Error("provider down"); }
    return { content: `Result ${provider.requests.length}`, toolCalls: [] };
  } };
  return provider;
}
function fakeChannel(id = "telegram") {
  const channel = { id, kind: "telegram", sent: [], botName: () => "TestBot", async start() {}, async stop() {},
    async send(chatId, text) { channel.sent.push({ chatId, text }); return `m${channel.sent.length}`; } };
  return channel;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-automation-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const context = app.runtime.context();
  return { app, root, provider, context };
}
const past = "2020-01-01T00:00:00.000Z";

test("scheduled results are delivered to a channel chat and the delivery is recorded", async (t) => {
  const { app, context } = await fixture(t);
  const channel = fakeChannel();
  await app.channels.attach(channel, { activation: "always", pairing: false, allowlist: [] });
  const delivered = app.scheduler.create(context, { prompt: "summarise the day", dueAt: past, kind: "task", deliverTo: { channel: "telegram", chatId: "501" } });
  const missing = app.scheduler.create(context, { prompt: "lost", dueAt: past, kind: "task", deliverTo: { channel: "signal", chatId: "1" } });
  const runs = await app.scheduler.tick(new Date("2020-01-02T00:00:00.000Z"));
  assert.equal(runs.length, 2);
  assert.deepEqual(channel.sent, [{ chatId: "501", text: "Result 1" }]);
  const first = app.store.get("schedules", "local", delivered.id).data;
  assert.equal(first.delivery.messageId, "m1");
  assert.equal(first.delivery.chatId, "501");
  assert.ok(app.store.events(first.runId).some((e) => e.kind === "delivery.sent" && e.data.messageId === "m1"));
  const second = app.store.get("schedules", "local", missing.id).data;
  assert.equal(second.status, "completed", "an undeliverable result does not fail the task");
  assert.match(second.delivery.error, /not connected/);
});

test("per-schedule history distinguishes finished, failed and running executions", async (t) => {
  const { app, context, provider } = await fixture(t);
  const record = app.scheduler.create(context, { prompt: "recurring", dueAt: past, kind: "task", intervalMs: 3600000 });
  await app.scheduler.tick(new Date("2020-01-01T01:00:00.000Z"));
  provider.failNext = true;
  await app.scheduler.tick(new Date("2020-01-01T03:00:00.000Z"));
  let history = app.store.get("schedules", "local", record.id).data.history;
  assert.deepEqual(history.map((h) => h.status), ["completed", "failed"]);
  assert.ok(history.every((h) => h.runId && h.finishedAt && h.trigger === "schedule"));
  let release;
  provider.hold = new Promise((resolve) => { release = resolve; });
  const running = app.scheduler.trigger("local", record.id, undefined, "local");
  await new Promise((resolve) => setTimeout(resolve, 50));
  history = app.store.get("schedules", "local", record.id).data.history;
  assert.equal(history.at(-1).status, "running");
  assert.equal(history.at(-1).trigger, "local");
  release(); provider.hold = null;
  const run = await running;
  assert.equal(run.status, "completed");
  history = app.store.get("schedules", "local", record.id).data.history;
  assert.deepEqual(history.map((h) => h.status), ["completed", "failed", "completed"]);
});

test("monitoring checks hand the previous result to the next run", async (t) => {
  const { app, context, provider } = await fixture(t);
  app.scheduler.create(context, { prompt: "Is the site up?", dueAt: past, kind: "check", intervalMs: 60000 });
  await app.scheduler.tick(new Date("2020-01-01T00:01:00.000Z"));
  const userText = (request) => request.messages.filter((m) => m.role === "user").at(-1).content;
  assert.ok(!userText(provider.requests[0]).includes("previous check"));
  await app.scheduler.tick(new Date("2020-01-01T00:03:00.000Z"));
  const second = userText(provider.requests[1]);
  assert.match(second, /Is the site up\?/);
  assert.match(second, /previous check at 2020-01-01T00:01:00\.000Z concluded: Result 1/);
});

test("daily schedules recur at a wall-clock time in their timezone, across a daylight-saving change", async (t) => {
  assert.equal(nextDailyOccurrence(new Date("2026-01-15T14:00:00.000Z"), "09:30", "America/New_York").toISOString(), "2026-01-15T14:30:00.000Z");
  assert.equal(nextDailyOccurrence(new Date("2026-01-15T14:30:00.000Z"), "09:30", "America/New_York").toISOString(), "2026-01-16T14:30:00.000Z");
  assert.equal(nextDailyOccurrence(new Date("2026-03-07T14:30:00.000Z"), "09:30", "America/New_York").toISOString(), "2026-03-08T13:30:00.000Z", "EDT begins");
  assert.equal(nextDailyOccurrence(new Date("2026-06-01T00:00:00.000Z"), "00:15", "Asia/Kolkata").toISOString(), "2026-06-01T18:45:00.000Z");
  const { app, context } = await fixture(t);
  assert.throws(() => app.scheduler.create(context, { prompt: "x", dueAt: past, kind: "task", dailyAt: "09:30" }), /needs a timezone/);
  assert.throws(() => app.scheduler.create(context, { prompt: "x", dueAt: past, kind: "task", dailyAt: "09:30", timezone: "Mars/Olympus" }), /Unknown timezone/);
  const record = app.scheduler.create(context, { prompt: "morning brief", dueAt: "2026-03-07T14:30:00.000Z", kind: "task", dailyAt: "09:30", timezone: "America/New_York" });
  await app.scheduler.tick(new Date("2026-03-07T14:30:00.000Z"));
  const data = app.store.get("schedules", "local", record.id).data;
  assert.equal(data.status, "pending");
  assert.equal(data.dueAt, "2026-03-08T13:30:00.000Z");
});

test("weekday, monthly and cron jobs remain pending at their next matching turn", async (t) => {
  const { app, context } = await fixture(t);
  const now = new Date("2026-03-06T14:30:00.000Z");
  const common = { dueAt: now.toISOString(), kind: "task", dailyAt: "09:30", timezone: "America/New_York" };
  const weekday = app.scheduler.create(context, { ...common, prompt: "workday", weekdays: [1, 2, 3, 4, 5] });
  const monthly = app.scheduler.create(context, { ...common, prompt: "month end", monthDay: 31 });
  const cron = app.scheduler.create(context, { prompt: "cron", dueAt: now.toISOString(), kind: "task",
    cron: "30 9 * * 1-5", timezone: "America/New_York" });
  assert.equal((await app.scheduler.tick(now)).length, 3);
  const data = (id) => app.store.get("schedules", "local", id).data;
  assert.deepEqual([data(weekday.id).status, data(weekday.id).dueAt], ["pending", "2026-03-09T13:30:00.000Z"]);
  assert.deepEqual([data(monthly.id).status, data(monthly.id).dueAt], ["pending", "2026-03-31T13:30:00.000Z"]);
  assert.deepEqual([data(cron.id).status, data(cron.id).dueAt], ["pending", "2026-03-09T13:30:00.000Z"]);
});

test("an authenticated webhook triggers a schedule with its payload; manual and script triggers work too", async (t) => {
  const { app, context, provider, root } = await fixture(t);
  const record = app.scheduler.create(context, { prompt: "handle the event", dueAt: "2999-01-01T00:00:00.000Z", kind: "task", webhook: true });
  const token = record.data.hookToken;
  assert.match(token, /^[a-f0-9]{48}$/);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const hook = (headers, body) => fetch(`${server.url}/hooks/${record.id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await hook({}, { a: 1 })).status, 401, "no token");
  assert.equal((await hook({ "x-branch-hook-token": "wrong" }, { a: 1 })).status, 401, "wrong token");
  const ok = await hook({ "x-branch-hook-token": token }, { event: "deploy.finished", sha: "abc123" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.status, "completed");
  assert.match(provider.requests.at(-1).messages.filter((m) => m.role === "user").at(-1).content, /handle the event[\s\S]*Triggering event payload \(JSON\): \{"event":"deploy.finished","sha":"abc123"\}/);
  const after = app.store.get("schedules", "local", record.id).data;
  assert.equal(after.dueAt, "2999-01-01T00:00:00.000Z", "a trigger does not move the schedule");
  assert.equal(after.status, "pending");
  assert.equal(after.history.at(-1).trigger, "webhook");
  const manual = await fetch(`${server.url}/api/schedules/${record.id}/trigger`, { method: "POST",
    headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: "{}" });
  assert.equal((await manual.json()).status, "completed");
  const view = await fetch(`${server.url}/api/schedules/${record.id}`, { headers: { authorization: "Bearer " + server.token, origin: server.url } });
  assert.equal((await view.json()).hookPath, `/hooks/${record.id}`);
  assert.equal((await fetch(`${server.url}/hooks/00000000-0000-0000-0000-000000000000`, { method: "POST" })).status, 401);
});

test("a hand or webhook trigger takes the schedule in one write, so a turn that started meanwhile is not doubled", async (t) => {
  const { app, context, provider } = await fixture(t);
  const record = app.scheduler.create(context, { prompt: "once only", dueAt: past, kind: "task", intervalMs: 3600000 });
  // The clock claims the schedule right after the trigger has looked at it (another process, or a tick in between).
  const read = app.store.get.bind(app.store);
  let interleaved = false;
  app.store.get = (table, owner, id) => {
    const found = read(table, owner, id);
    if (table === "schedules" && id === record.id && !interleaved) {
      interleaved = true;
      assert.ok(app.store.claimSchedule("local", record.id, new Date().toISOString()), "the other caller took it");
    }
    return found;
  };
  await assert.rejects(app.scheduler.trigger("local", record.id, undefined, "webhook"), /running right now/);
  assert.equal(provider.requests.length, 0, "the trigger did not start a second turn");
});

test("a trigger puts the schedule's own status back, and the same delivery key starts one turn", async (t) => {
  const { app, context, provider } = await fixture(t);
  const paused = app.scheduler.create(context, { prompt: "paused job", dueAt: past, kind: "task", intervalMs: 3600000 });
  app.store.save("schedules", "local", paused.id, { ...app.store.get("schedules", "local", paused.id).data, status: "paused" });
  await app.scheduler.trigger("local", paused.id, undefined, "local");
  assert.equal(app.store.get("schedules", "local", paused.id).data.status, "paused", "a paused job stays paused");
  assert.equal(app.store.get("schedules", "local", paused.id).data.statusBeforeTrigger, undefined);
  const once = app.scheduler.create(context, { prompt: "one-off", dueAt: past, kind: "task" });
  await app.scheduler.tick(new Date("2020-01-02T00:00:00.000Z"));
  assert.equal(app.store.get("schedules", "local", once.id).data.status, "completed");
  const first = await app.scheduler.trigger("local", once.id, undefined, "webhook", "delivery-1");
  const again = await app.scheduler.trigger("local", once.id, undefined, "webhook", "delivery-1");
  assert.equal(again.id, first.id, "the repeated delivery hands back the turn it already started");
  assert.equal(app.store.get("schedules", "local", once.id).data.status, "completed", "a finished one-off stays finished");
  const before = provider.requests.length;
  assert.equal((await app.scheduler.tick(new Date("2020-01-03T00:00:00.000Z"))).length, 0, "the clock does not run it again");
  assert.equal(provider.requests.length, before);
  const other = await app.scheduler.trigger("local", once.id, undefined, "webhook", "delivery-2");
  assert.notEqual(other.id, first.id, "a new delivery key is a new turn");
});
