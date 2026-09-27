import test from "node:test";
import assert from "node:assert/strict";
import { proposeSchedule } from "../dist/schedule-words.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const now = new Date("2026-09-27T18:00:00Z");
const deps = { now, defaultTimezone: "UTC" };
test("once in two minutes is deterministic and confirmation preserves its absolute due time", async () => {
  const p = await proposeSchedule({ text: "once in two minutes, say 391", timezone: "UTC" }, deps);
  assert.equal(p.schedule.prompt, "say 391");
  assert.equal(p.firstRunAt, "2026-09-27T18:02:00.000Z");
  assert.equal(p.schedule.intervalMs, undefined);
  assert.equal(p.schedule.dailyAt, undefined);
  const confirmed = await proposeSchedule({ edit: { prompt: "say 391", dueAt: p.firstRunAt }, timezone: "UTC" }, { ...deps, now: new Date("2026-09-27T18:01:00Z") });
  assert.equal(confirmed.firstRunAt, p.firstRunAt);
  await assert.rejects(proposeSchedule({ edit: { prompt: "x", dueAt: now.toISOString(), dailyAt: "09:00" } }, deps), /cannot also repeat/);
  await assert.rejects(proposeSchedule({ edit: { prompt: "x", dueAt: now.toISOString() } }, deps), /future date/);
});

test("the timed one-time job fires once and becomes completed", async (t) => {
  const parent = join(tmpdir(), "Codex-session-files");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "schedule-once-"));
  let replies = 0;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { replies++; return { content: "391", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const p = await proposeSchedule({ text: "once in two minutes, say 391" }, deps);
  const saved = app.scheduler.create(app.runtime.context(), p.schedule);
  assert.equal((await app.scheduler.tick(new Date("2026-09-27T18:01:59Z"))).length, 0);
  assert.equal((await app.scheduler.tick(new Date(p.firstRunAt))).length, 1);
  assert.equal(app.store.list("schedules", "local").find((one) => one.id === saved.id).data.status, "completed");
  assert.equal((await app.scheduler.tick(new Date("2026-09-28T18:02:00Z"))).length, 0);
  assert.equal(replies, 1);
});

test("a repeating schedule whose task mentions a duration stays repeating", async () => {
  const daily = await proposeSchedule({ text: "every weekday at 8am, summarize the news in 5 minutes or less", timezone: "UTC" }, deps);
  assert.deepEqual(daily.schedule.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(daily.schedule.dailyAt, "08:00");
  assert.equal(daily.schedule.prompt, "summarize the news in 5 minutes or less");
  const once = await proposeSchedule({ text: "remind me in 3 hours to call mom", timezone: "UTC" }, deps);
  assert.equal(once.firstRunAt, "2026-09-27T21:00:00.000Z");
  assert.equal(once.schedule.prompt, "remind me to call mom");
});
