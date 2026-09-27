/* DG-041: the Models page's tabs are the approved sample's line tabs (design/Branch-Grown-Up.html, `.tabs`/`.tab`),
   not pills: one row on a hairline that scrolls sideways instead of wrapping, the chosen tab underlined in copper, a
   focus ring that stays inside the row, and the same tab semantics as before. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettings } from "./places.mjs";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

/* The new window: Settings › Models' tabs are the prototype's (.tabs/.tab, rounded, the chosen one filled): a tab list
   in one row, the chosen tab showing its own panel, chosen from the keyboard too, and scrolling sideways on a phone. */
async function newModelsPage(t, width = 1440) {
  const opened = await settingsWindow(t, { name: "models-tabs", width, height: 900 });
  await openSettingsPage(opened.page, "models");
  await opened.page.locator('.set-col [role="tablist"] [role="tab"]').first().waitFor();
  return opened;
}
const tabRows = (page) => page.locator('.set-col [role="tab"]').evaluateAll((tabs) => new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size);

test("DG-041 the Models tabs are a tab list in one row, and the chosen tab shows its own panel", async (t) => {
  const { page, errors } = await newModelsPage(t);
  const tabs = page.locator('.set-col [role="tablist"] [role="tab"]');
  assert.deepEqual((await tabs.allInnerTexts()).map((words) => words.trim()), ["Connections", "Defaults", "On this computer", "Second opinion", "Media"]);
  assert.equal(await tabRows(page), 1, "one row");
  assert.equal(await page.locator('.set-col [role="tab"][aria-selected="true"]').count(), 1);
  const col = page.locator(".set-col");
  await col.getByRole("button", { name: "Add an account", exact: true }).waitFor();
  await tabs.filter({ hasText: "Defaults" }).click();
  await page.locator('.set-col [role="tab"][aria-selected="true"]', { hasText: "Defaults" }).waitFor();
  await col.getByText("Everyday answers", { exact: true }).waitFor();
  assert.equal(await col.getByRole("button", { name: "Add an account", exact: true }).count(), 0, "the Connections panel is not on show");
  assert.deepEqual(errors, []);
});

test("DG-041 a tab reached by keyboard is chosen with Enter", async (t) => {
  const { page, errors } = await newModelsPage(t);
  await page.waitForTimeout(1000); // the page has drawn what it loaded, as a person sees it before reaching for a tab
  const second = page.locator('.set-col [role="tab"]', { hasText: "Second opinion" });
  await second.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Second opinion", "the tab has the keyboard");
  await page.keyboard.press("Enter");
  await page.locator('.set-col [role="tab"][aria-selected="true"]', { hasText: "Second opinion" }).waitFor();
  assert.deepEqual(errors, []);
});

test("DG-041 at 400 px the Models tabs stay one row that scrolls sideways, and the page itself never does", async (t) => {
  const { page, errors } = await newModelsPage(t, 400);
  assert.equal(await tabRows(page), 1, "one row, not wrapped into two");
  assert.equal(await page.locator('.set-col [role="tablist"]').evaluate((row) => getComputedStyle(row).overflowX), "auto", "the row scrolls to its last tab");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, `the page is no wider than the window (${wide}px over)`);
  // The click scrolls the row to the tab itself, and finds the tab again if the page has just been drawn afresh.
  await page.locator('.set-col [role="tab"]').last().click();
  await page.locator('.set-col [role="tab"][aria-selected="true"]', { hasText: "Media" }).waitFor();
  assert.deepEqual(errors, []);
});

