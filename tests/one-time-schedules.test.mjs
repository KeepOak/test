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
