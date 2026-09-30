/* UP-UI-007: the @ list filters as you type, Up and Down move the highlight, Enter picks it, and it works where the
   caret is, not only at the end. A headless window on a temporary Branch.
   Mutation: in chat/messages.js pickMention, append to the end of the text again: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

const shown = (page) => page.locator('.pop [data-act="mention-pick"]:not([hidden])');
const selected = (page) => page.locator('.pop [aria-selected="true"]').getAttribute("data-v");

test("UP-UI-007: @ in the middle of a message filters, moves with the arrows, and Enter inserts at the caret", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  const box = page.locator("#prompt");
  await box.waitFor();
  await box.fill("ask about it");
  await box.evaluate((el) => el.setSelectionRange(4, 4));
  await page.keyboard.type("@");
  await shown(page).first().waitFor();
  const all = await shown(page).count();
  assert.ok(all >= 2, "the whole list is offered");
  const first = await selected(page);
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await selected(page), first, "Down moves the highlight");
  await page.keyboard.press("ArrowUp");
  assert.equal(await selected(page), first, "and Up moves it back");
  await page.keyboard.type("dif");
  await page.waitForFunction(() => [...document.querySelectorAll('.pop [data-act="mention-pick"]')].filter((n) => !n.hidden).length === 1);
  assert.equal(await selected(page), "diff", "only the match is left, and it is highlighted");
  assert.equal(await box.inputValue(), "ask @difabout it", "typing stayed in the box");
  await page.keyboard.press("Enter");
  assert.equal(await box.inputValue(), "ask @diff about it", "the mention went in where the caret was");
  assert.equal(await box.evaluate((el) => el.selectionStart), "ask @diff ".length, "and the caret sits after it");
  assert.equal(await page.locator('.pop [data-act="mention-pick"]').count(), 0, "the list closed");
  assert.deepEqual(errors, []);
});

test("UP-UI-007: non-matching mention rows are hidden with display:none", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  const box = page.locator("#prompt");
  await box.waitFor();

  // Type @ to open mention picker
  await box.fill("test ");
  await box.evaluate((el) => el.setSelectionRange(5, 5));
  await page.keyboard.type("@");

  // Wait for mention list to appear
  const shownItems = shown(page);
  await shownItems.first().waitFor();

  // Get total count of mention items
  const totalBefore = await page.locator('.pop [data-act="mention-pick"]').count();
  assert.ok(totalBefore > 1, "multiple mention items exist");

  // Type a filter that matches only one item
  await page.keyboard.type("d");

  // Wait for filtering to apply
  await page.waitForFunction(
    () => [...document.querySelectorAll('.pop [data-act="mention-pick"]')].filter((n) => !n.hidden).length === 1
  );

  // Check that non-matching items have display:none
  const hiddenItems = await page.locator('.pop [data-act="mention-pick"][hidden]').all();
  assert.ok(hiddenItems.length > 0, "some items are hidden");
  for (const item of hiddenItems) {
    const computedStyle = await item.evaluate((el) => window.getComputedStyle(el).display);
    assert.equal(computedStyle, "none",
      `hidden mention item must have display:none (not ${computedStyle})`);
  }

  // Verify that all non-matching items are not visible
  const visibleNonMatching = await page.locator('.pop [data-act="mention-pick"][hidden]:visible').count();
  assert.equal(visibleNonMatching, 0, "non-matching mention items are not visible");

  assert.deepEqual(errors, []);
});
