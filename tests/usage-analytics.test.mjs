/**
 * MODEL-130: /usage shows the owner's per-account calls and plugin tool receipts for the month, and nothing for a
 * household person or a short-lived key. An in-memory store only; no model or plugin runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";
import { AccountUsageLedger } from "../dist/accounts/usage.js";
import { analyticsLines, usageAnalytics } from "../dist/accounts/usage-analytics.js";
import { asPerson } from "../dist/people/context.js";
import { underShortLivedKey } from "../dist/key-context.js";

function seeded() {
  const store = new Store(":memory:");
  const ledger = new AccountUsageLedger(store.sqlite);
  const now = new Date();
  ledger.record("local", "claude", "work", { input: 120, output: 30, costUsd: 0 }, now);
  ledger.record("local", "claude", "work", { input: 80, output: 20, costUsd: 0 }, now);
  ledger.record("local", "openai", "home", { input: 5, output: 1, costUsd: 0 }, now);
  ledger.record("someone-else", "claude", "theirs", { input: 9, output: 9, costUsd: 0 }, now);
  const run = store.createRun("local", "try the plugins");
  store.event(run.id, "tool.completed", { name: "plugin.weather.today" });
  store.event(run.id, "tool.completed", { name: "plugin.weather.week" });
  store.event(run.id, "tool.failed", { name: "plugin.weather.today" });
  store.event(run.id, "tool.stalled", { name: "plugin.notes.save" });
  store.event(run.id, "tool.completed", { name: "shell.run" });
  return { store, month: now.toISOString().slice(0, 7) };
}

test("MODEL-130: the owner sees this month's calls per account and each plugin's tool receipts", () => {
  const { store, month } = seeded();
  const analytics = usageAnalytics(store, "local", month);
  assert.equal(analytics.restricted, false);
  assert.deepEqual(analytics.accounts, [
    { pool: "claude", account: "work", requests: 2, input: 200, output: 50 },
    { pool: "openai", account: "home", requests: 1, input: 5, output: 1 },
  ]);
  assert.deepEqual(analytics.plugins, [
    { id: "weather", completed: 2, failed: 1, stalled: 0 },
    { id: "notes", completed: 0, failed: 0, stalled: 1 },
  ]);
  const text = analyticsLines(analytics).join("\n");
  assert.match(text, /claude \/ work: 2 completed call\(s\), 200 recorded tokens in, 50 out/);
  assert.match(text, /weather: 2 completed, 1 failed, 0 stalled/);
  assert.doesNotMatch(text, /theirs|shell/);
});

test("MODEL-130: another month has no receipts, and a bad month is refused", () => {
  const { store } = seeded();
  const other = usageAnalytics(store, "local", "1999-01");
  assert.deepEqual([other.accounts, other.plugins], [[], []]);
  assert.match(analyticsLines(other).join("\n"), /No per-account calls recorded[\s\S]*No plugin tool receipts recorded/);
  assert.throws(() => usageAnalytics(store, "local", "2026-13"), /YYYY-MM/);
});

test("MODEL-130: a household person or a short-lived key gets no account or plugin rows", () => {
  const { store, month } = seeded();
  const person = asPerson({ profileId: "kid", keyId: "k1" }, () => usageAnalytics(store, "local", month));
  const key = underShortLivedKey(() => usageAnalytics(store, "local", month));
  for (const analytics of [person, key]) {
    assert.equal(analytics.restricted, true);
    assert.deepEqual([analytics.accounts, analytics.plugins], [[], []]);
    assert.deepEqual(analyticsLines(analytics), []);
  }
});
