/**
 * Kept answers and the clock (src/request-cache.ts). The environment line gives the model the local time to the minute
 * (src/environment.ts), and the kept-answer key used to hash it whole: the same request a minute later never matched,
 * so the cache almost never answered and a test that asked twice across a minute boundary failed. The key now leaves
 * the hour and minute out but keeps the date, and a question about the time, or an answer that says a clock time, is
 * never kept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { environmentLine } from "../dist/environment.js";
import { RequestCache, requestHash, saveCacheSettings, saysAClockTime, withoutClock } from "../dist/request-cache.js";
import { createBranch } from "../dist/index.js";

const facts = { device: "desk", system: "Windows 11", host: "desktop", window: "shown", channel: null, timeZone: "America/New_York" };
const at = (time) => ({ role: "system", content: environmentLine({ ...facts, time }) });
const request = (time, question = "What is the capital of France?") => ({ provider: "p", model: "m", reasoning: null, maxTokens: 100,
  messages: [{ role: "system", content: "You are Branch." }, at(time), { role: "user", content: question }], tools: [] });

test("the same request either side of a minute boundary has one key; a new day or another question does not", () => {
  assert.equal(requestHash(request("Mon, 28 Sept 2026, 13:59")), requestHash(request("Mon, 28 Sept 2026, 14:00")));
  assert.notEqual(requestHash(request("Mon, 28 Sept 2026, 13:59")), requestHash(request("Tue, 29 Sept 2026, 13:59")), "the date stays in");
  assert.notEqual(requestHash(request("Mon, 28 Sept 2026, 13:59")), requestHash(request("Mon, 28 Sept 2026, 13:59", "And of Spain?")));
  assert.equal(withoutClock("Local time: Mon, 28 Sept 2026, 09:05 (UTC). Use it."), "Local time: Mon, 28 Sept 2026 (UTC). Use it.");
  assert.equal(withoutClock("The meeting is at 09:05 (room 4)."), "The meeting is at 09:05 (room 4).", "only the environment line's clock goes");
});

test("a time question and an answer that says a clock time are never kept; other answers are kept across the minute", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-kept-clock-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "workspace"),
    provider: { name: "scripted", async complete() { return { content: "unused", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true, mode: "on", ttlMinutes: 60 });
  const cache = new RequestCache(app.store, app.runtime.owner);
  const plain = { content: "Paris.", toolCalls: [] };

  assert.equal(cache.keep(request("Mon, 28 Sept 2026, 13:59"), plain), true);
  assert.equal(cache.look(request("Mon, 28 Sept 2026, 14:00"))?.content, "Paris.", "kept across the minute boundary");

  for (const question of ["What time is it?", "what's the date", "Is the shop open now?", "What should I do today?", "at 3 o'clock?"]) {
    assert.equal(cache.keep(request("Mon, 28 Sept 2026, 13:59", question), { content: "Some answer.", toolCalls: [] }), false, question);
    assert.equal(cache.look(request("Mon, 28 Sept 2026, 13:59", question)), null, question);
  }
  for (const answer of ["It is 13:59.", "Around 2 pm.", "At 3 o'clock.", "Call at 9am tomorrow"]) {
    assert.equal(saysAClockTime(answer), true, answer);
    assert.equal(cache.keep(request("Mon, 28 Sept 2026, 13:59", "When does the train leave?"), { content: answer, toolCalls: [] }), false, answer);
  }
  assert.equal(saysAClockTime("There are 12 apples and 3 pears."), false);
  assert.equal(saysAClockTime("Paris is the capital."), false);
});
