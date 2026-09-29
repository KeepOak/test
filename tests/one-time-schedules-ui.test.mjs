import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("rejected text survives redraw, and a once proposal is editable and confirmable", async (t) => {
  assert.equal(typeof chromium.launch, "function");
  const { page, app, errors } = await newWindow(t);
  await openPlace(page, "automations", "scheduled");
  const words = "when a penguin sneezes, say 391";
  await page.locator("#nl-in").fill(words);
  await page.locator('[data-act="nl-add"]').click();
  await page.getByText("Branch could not read when", { exact: false }).waitFor();
  await page.evaluate(async () => { const { renderNow } = await import("/app/core/dom.js"); renderNow(); });
  assert.equal(await page.locator("#nl-in").inputValue(), words);
  await page.locator("#nl-in").fill("once in two minutes, say 391");
  await page.locator('[data-act="nl-add"]').click();
  await page.locator('[data-act="ppset17d"][data-v="once"][aria-pressed="true"]').waitFor();
  assert.equal(await page.getByLabel("One-time date and time").getAttribute("type"), "datetime-local");
  await page.locator('[data-act="ppok17d"]').click();
  await page.waitForFunction(() => !document.querySelector(".prop17d"));
  const schedule = app.store.list("schedules", "local")[0].data;
  assert.equal(schedule.intervalMs, undefined);
  assert.equal(schedule.dailyAt, undefined);
  assert.equal(await page.locator("#nl-in").inputValue(), "");
  assert.deepEqual(errors, []);
});
