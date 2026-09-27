/**
 * Words to a schedule, confirmed (src/schedule-words.ts, POST /api/schedules/propose). The common ways
 * of saying when are read with no model; only words that cannot be read go to the model, whose answer
 * is checked the same way; nothing is saved until POST /api/schedules. Temporary folders and a
 * scripted model only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readScheduleWords, proposeSchedule, notASchedule } from "../dist/schedule-words.js";

const THURSDAY = new Date("2026-09-17T10:00:00Z");

test("the design's clock ideas are read with no model, and its event ideas are not a schedule", () => {
  const read = (text) => readScheduleWords(text);
  assert.deepEqual(read("every weekday at 8, check my inbox for invoices"),
    { prompt: "check my inbox for invoices", recurrence: { dailyAt: "08:00", weekdays: [1, 2, 3, 4, 5] }, time: "said" });
  assert.deepEqual(read("every weekday at 7:30, send me the weather, my calendar and what needs me").recurrence, { dailyAt: "07:30", weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(read("every morning at 8, sort new mail into needs me, later and noise").recurrence, { dailyAt: "08:00" });
  assert.deepEqual(read("every Friday at 5, move files older than six months from Downloads to Downloads/Archive").recurrence, { dailyAt: "17:00", weekdays: [5] });
  assert.deepEqual(read("every night at 2, check the backup finished and tell me only if it did not").recurrence, { dailyAt: "02:00" });
  assert.deepEqual(read("every Sunday, find blurry and duplicate photos and ask me before removing any").recurrence, { dailyAt: "09:00", weekdays: [0] });
  assert.deepEqual(read("every day, check the price on a product page and tell me only when it drops").recurrence, { dailyAt: "09:00" });
  assert.deepEqual(read("every hour, check a page and tell me only what changed since last time").recurrence, { intervalMs: 3_600_000 });
  assert.deepEqual(read("every month, check my card statement and tell me if a subscription price went up").recurrence, { dailyAt: "09:00", monthDay: 1 });
  assert.deepEqual(read("every Friday at 4, summarise what my Trunks did this week").recurrence, { dailyAt: "16:00", weekdays: [5] });
  assert.deepEqual(read("remind me to stretch every 15 minutes"), { prompt: "remind me to stretch", recurrence: { intervalMs: 900_000 }, time: "said" });
  assert.deepEqual([read("every Sunday, find photos").time, read("every evening, lock up").time, read("every morning, sort mail").recurrence.dailyAt], ["none", "guessed", "08:00"]);
  assert.deepEqual(read("on Mondays and Thursdays at 9:15 am water the plants").recurrence, { dailyAt: "09:15", weekdays: [1, 4] });
  assert.deepEqual(read("every evening, check the doors are locked").recurrence, { dailyAt: "18:00" });
  for (const event of ["when a receipt arrives by email, file it in Receipts by the month it was paid",
    "three days before a bill is due, remind me in Telegram", "after each calendar meeting, write notes and follow-ups into Library",
    "remind me to call mum on friday", "every weekday at 8", "water the plants each wednesday evening around half six"])
    assert.equal(read(event), null, event);
});

test("a proposal is a schedule the schedule's own schema accepts, with its first run worked out", async () => {
  const { schedule, firstRunAt, words, source } = await proposeSchedule({ text: "every weekday at 8, check my inbox for invoices", timezone: "UTC" },
    { now: THURSDAY, defaultTimezone: "UTC" });
  assert.equal(source, "words");
  assert.equal(firstRunAt, "2026-09-18T08:00:00.000Z", "the next weekday at eight");
  assert.deepEqual(schedule, { prompt: "check my inbox for invoices", kind: "task", timezone: "UTC", dailyAt: "08:00",
    weekdays: [1, 2, 3, 4, 5], dueAt: firstRunAt, daysOff: "run" });
  assert.match(words, /^Every weekday at 08:00 \(UTC\), first on Fri 18 Sept?, 08:00$/);
  const edited = await proposeSchedule({ edit: { prompt: "Check my inbox", dailyAt: "17:30", weekdays: [2] }, timezone: "UTC" }, { now: THURSDAY, defaultTimezone: "UTC" });
  assert.deepEqual([edited.source, edited.time, edited.cron, edited.firstRunAt], ["edit", "said", "30 17 * * 2", "2026-09-22T17:30:00.000Z"], "the card's edit is read again, first run and all");
  await assert.rejects(proposeSchedule({ text: "every day at 9, x", edit: { prompt: "x", dailyAt: "09:00" } }, { now: THURSDAY, defaultTimezone: "UTC" }), /either the words or the edited schedule/);
  await assert.rejects(proposeSchedule({ edit: { prompt: "x", dailyAt: "09:00", gate: {} } }, { now: THURSDAY, defaultTimezone: "UTC" }), /Unrecognized key/);
  await assert.rejects(proposeSchedule({ text: "x", timezone: "Mars/Olympus" }, { now: THURSDAY, defaultTimezone: "UTC" }), /Unknown timezone/);
  await assert.rejects(proposeSchedule({ text: "when a PDF lands in Downloads, summarise it" }, { now: THURSDAY, defaultTimezone: "UTC" }),
    new RegExp(notASchedule.slice(0, 40)));
});

test("only words the reader cannot read go to the model, and its answer is checked and cannot carry more", async () => {
  const asked = [];
  const answer = (value) => async (question, shape) => { asked.push({ question, shape }); return { status: "resolved", value, reasked: false }; };
  const fields = { isSchedule: true, prompt: "water the plants", repeat: "weekly", time: "18:30", days: [3], monthDay: 0, intervalMinutes: 0 };
  const byModel = await proposeSchedule({ text: "water the plants each wednesday evening around half six", timezone: "UTC" },
    { now: THURSDAY, defaultTimezone: "UTC", askModel: answer(fields) });
  assert.equal(byModel.source, "model");
  assert.deepEqual([byModel.schedule.weekdays, byModel.schedule.dailyAt, byModel.schedule.prompt], [[3], "18:30", "water the plants"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].shape.name, "schedule_reading");
  assert.equal(JSON.stringify(asked[0].shape.schema).includes("deliverTo"), false);

  await proposeSchedule({ text: "every weekday at 8, check my inbox", timezone: "UTC" }, { now: THURSDAY, defaultTimezone: "UTC", askModel: answer(fields) });
  assert.equal(asked.length, 1, "words the reader can read never reach the model");
  const refuse = (value) => proposeSchedule({ text: "water the plants sometime", timezone: "UTC" }, { now: THURSDAY, defaultTimezone: "UTC", askModel: answer(value) });
  await assert.rejects(refuse({ ...fields, isSchedule: false }), new RegExp(notASchedule.slice(0, 40)));
  await assert.rejects(refuse({ ...fields, deliverTo: { channel: "telegram", chatId: "1" } }), new RegExp(notASchedule.slice(0, 40)), "an extra field is refused, never passed on");
  await assert.rejects(refuse({ ...fields, prompt: "  " }), new RegExp(notASchedule.slice(0, 40)));
});

test("the route proposes and saves nothing; the owner's yes is POST /api/schedules; a key and a household person are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-schedule-words-"));
  const said = [];
  const provider = { name: "scripted", async complete(request) {
    said.push(request);
    return { content: JSON.stringify({ isSchedule: true, prompt: "tidy the desk", repeat: "daily", time: "17:45", days: [], monthDay: 0, intervalMinutes: 0 }), toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const proposed = await call("/api/schedules/propose", { text: "every weekday at 8, check my inbox for invoices", timezone: "Europe/Paris" });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body.proposal.schedule.dailyAt, "08:00");
  assert.equal(said.length, 0, "no model for words the reader can read");
  assert.equal((await call("/api/schedules")).body.schedules.length, 0, "a proposal saves nothing");

  const byModel = await call("/api/schedules/propose", { text: "tidy the desk before I leave work", timezone: "UTC" });
  assert.equal(byModel.status, 200, JSON.stringify(byModel.body));
  assert.deepEqual([byModel.body.proposal.source, byModel.body.proposal.schedule.dailyAt], ["model", "17:45"]);
  assert.equal(said.length, 1);
  assert.equal(said[0].tools.length, 0, "the model is asked with no tools");
  const spent = app.store.sqlite.prepare("SELECT t.status, u.estimated_input AS input FROM tasks t JOIN usage u ON u.run_id = t.id WHERE t.prompt = ?").get("Reading a schedule from your words");
  assert.ok(spent && spent.status === "completed" && spent.input > 0, "what the side question spent is kept in the usage, like any model call");

  const saved = await call("/api/schedules", proposed.body.proposal.schedule);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await call("/api/schedules")).body.schedules.length, 1);

  assert.equal((await call("/api/schedules/propose", { text: "x", extra: 1 })).status, 400, "the body is strict");
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("/api/schedules/propose", { text: "every day at 9, stretch" }, key)).status, 401);
  const person = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: person.id, pin: "2468" });
  const refused = await call("/api/schedules/propose", { text: "every day at 9, stretch" });
  assert.deepEqual([refused.status, /belongs to the owner/.test(refused.body.error)], [400, true]);
  app.store.profiles.switch({ profileId: null });
});
