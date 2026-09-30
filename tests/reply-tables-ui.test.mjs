/* UI-270: a Markdown table in a reply can be sorted by a column and filtered, in place, and Reset puts it back.
   Headless, one window, no sleeps. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

const table = "| City | Pop |\n| --- | --- |\n| Lyon | 5 |\n| Accra | 12 |\n| Oslo | 3 |";
const provider = { name: "scripted", async complete() { return { content: `Here:\n\n${table}`, toolCalls: [] }; } };
const cities = (page) => page.locator("#conversation table tbody tr:not([hidden]) td:first-child").allInnerTexts();

test("a reply's table sorts by a column, filters its rows and resets", async (t) => {
  const { app, page, errors } = await newWindow(t, { provider });
  const run = await app.runtime.run({ prompt: "cities please" });
  await page.reload();
  await page.locator(`#side .row[data-id="${run.sessionId}"]`).click();
  await page.locator("#conversation table .reply-table-sort").first().waitFor();
  assert.deepEqual(await cities(page), ["Lyon", "Accra", "Oslo"]);
  await page.locator("#conversation table .reply-table-sort").nth(1).click();
  assert.deepEqual(await cities(page), ["Oslo", "Lyon", "Accra"], "Pop ascending, as numbers");
  assert.equal(await page.locator("#conversation table th").nth(1).getAttribute("aria-sort"), "ascending");
  await page.locator("#conversation table .reply-table-sort").nth(1).click();
  assert.deepEqual(await cities(page), ["Accra", "Lyon", "Oslo"], "then descending");
  await page.locator(".reply-table-filter input").fill("o");
  assert.deepEqual(await cities(page), ["Lyon", "Oslo"], "the filter keeps the rows with the words");
  await page.locator(".reply-table-controls button").click();
  assert.deepEqual(await cities(page), ["Lyon", "Accra", "Oslo"], "Reset shows every row in its own order");
  assert.deepEqual(errors, []);
});
