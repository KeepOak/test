/* UP-UI-008: in an empty message box, Up brings back this conversation's earlier messages, newest first, and Down goes
   forward again and then back to the draft. Typing leaves the history. A headless window on a temporary Branch whose
   model answers at once. Mutation: drop initInputHistory from chat/chat.js: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

async function send(page, words, count) {
  await page.fill("#prompt", words);
  await page.click("#send");
  await page.waitForFunction((n) => document.querySelectorAll("#conversation .u[data-i15]:not(.umedia15)").length === n
    && !document.querySelector("#conversation .typing"), count, { timeout: 60000 });
}

test("UP-UI-008: Up and Down walk this conversation's own earlier messages", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  const box = page.locator("#prompt");
  await box.waitFor();
  await send(page, "first question", 1);
  await send(page, "second question", 2);
  await box.fill("");
  await box.focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await box.inputValue(), "second question");
  await page.keyboard.press("ArrowUp");
  assert.equal(await box.inputValue(), "first question");
  await page.keyboard.press("ArrowUp");
  assert.equal(await box.inputValue(), "first question", "the oldest stays");
  await page.keyboard.press("ArrowDown");
  assert.equal(await box.inputValue(), "second question");
  await page.keyboard.press("ArrowDown");
  assert.equal(await box.inputValue(), "", "back to the draft");
  await box.fill("a draft");
  await page.keyboard.press("ArrowUp");
  assert.equal(await box.inputValue(), "a draft", "a box with words in it is left alone");
  assert.deepEqual(errors, []);
});
