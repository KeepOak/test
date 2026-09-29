/**
 * QA retest 2026-09-28 (m5): every turn of a schedule opened a new conversation, so a job every two minutes filled Recent
 * with seven rows in fourteen minutes. A plain schedule's turns now go on in one conversation of its own; a turn starts a
 * new one only when that conversation is gone, in Recently Deleted, busy, or at its hourly limit. Node only: the real
 * dist/, a scripted model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const past = "2020-01-01T00:00:00.000Z";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-schedule-thread-"));
  let n = 0;
  const provider = { name: "scripted", async complete() { n++; return { content: `PING ${n}`, toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, context: app.runtime.context() };
}
const threadOf = (app, id) => app.store.get("schedules", "local", id).data.threadId;

test("a schedule's turns go on in one conversation of its own", async (t) => {
  const { app, context } = await fixture(t);
  const record = app.scheduler.create(context, { prompt: "say PING", dueAt: past, kind: "task", intervalMs: 3600000 });
  const first = await app.scheduler.trigger("local", record.id, undefined, "local");
  const second = await app.scheduler.trigger("local", record.id, undefined, "local");
  const third = await app.scheduler.trigger("local", record.id, undefined, "local");
  assert.equal(first.status, "completed");
  assert.equal(second.sessionId, first.sessionId, "the second turn is in the first turn's conversation");
  assert.equal(third.sessionId, first.sessionId);
  assert.equal(threadOf(app, record.id), first.sessionId, "the schedule knows its conversation");
  const replies = app.store.messages(first.sessionId).filter((m) => m.role === "assistant").map((m) => m.content);
  assert.deepEqual(replies, ["PING 1", "PING 2", "PING 3"], "every turn's answer is there, in order");
});

test("a turn starts a new conversation when the schedule's own is in Recently Deleted or busy", async (t) => {
  const { app, context } = await fixture(t);
  const record = app.scheduler.create(context, { prompt: "say PING", dueAt: past, kind: "task", intervalMs: 3600000 });
  const first = await app.scheduler.trigger("local", record.id, undefined, "local");
  app.store.conversations.delete("local", first.sessionId);
  assert.equal(app.store.conversations.inBin(first.sessionId), true, "control: the conversation is in Recently Deleted");
  const second = await app.scheduler.trigger("local", record.id, undefined, "local");
  assert.notEqual(second.sessionId, first.sessionId, "a deleted conversation is not brought back by a schedule");
  assert.equal(app.store.conversations.inBin(first.sessionId), true, "and stays deleted");
  assert.equal(threadOf(app, record.id), second.sessionId, "the new one is the schedule's from then on");

  const busy = app.store.createRun("local", "the owner is typing here", second.sessionId);
  assert.equal(app.store.run(busy.id).status, "running", "control: a task is running in the schedule's conversation");
  const third = await app.scheduler.trigger("local", record.id, undefined, "local");
  assert.equal(third.status, "completed", "the turn still runs");
  assert.notEqual(third.sessionId, second.sessionId, "in a conversation of its own this time");
});

test("a reminder is a note, and keeps no conversation", async (t) => {
  const { app, context } = await fixture(t);
  const reminder = app.scheduler.create(context, { prompt: "stand up", dueAt: past, kind: "reminder", intervalMs: 3600000 });
  await app.scheduler.trigger("local", reminder.id, undefined, "local");
  assert.equal(threadOf(app, reminder.id), undefined, "a reminder is a note, not a conversation");
});
