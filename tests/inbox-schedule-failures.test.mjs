/* TRUNK-122: a scheduled turn that failed shows in the Inbox's Needs you, and a later good turn clears it.
   Real engine, a headless window (public/app/places/inbox-schedules.js). */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow } from "./new-window-places.mjs";

assert.equal(typeof chromium.launch, "function");

const turn = (status, minutes) => ({ runId: null, status, trigger: "schedule",
  startedAt: new Date(Date.now() - minutes * 60_000).toISOString(), finishedAt: new Date(Date.now() - minutes * 60_000 + 1000).toISOString() });

test("the Inbox says when a scheduled turn failed, and only while that failure is the latest turn", async (t) => {
  const seed = (app) => {
    const base = { prompt: "Check the harbour prices\nand more", status: "pending", dueAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: [] };
    app.store.save("schedules", app.runtime.owner, "11111111-1111-4111-8111-111111111111", { ...base, history: [turn("completed", 30), turn("failed", 5)] });
    app.store.save("schedules", app.runtime.owner, "22222222-2222-4222-8222-222222222222",
      { ...base, prompt: "Water the ferns", history: [turn("failed", 30), turn("completed", 5)] });
  };
  const w = await newWindow(t, { seed });
  await w.page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  const failed = w.page.locator('[data-act="inbox-schedules-open"]');
  await failed.first().waitFor({ timeout: 30000 });
  assert.equal(await failed.count(), 1, "one failure notice");
  const text = await w.page.locator("#main .place").innerText();
  assert.match(text, /Check the harbour prices/);
  assert.doesNotMatch(text, /and more/, "only the first line of the words");
  assert.doesNotMatch(text, /Water the ferns/, "a later good turn clears the old failure");
  await failed.click();
  await w.page.waitForFunction(() => document.querySelector('#side .side-nav .nav[aria-current="true"][data-v="automations"]'), null, { timeout: 15000 });
  assert.deepEqual(w.errors, []);
});
