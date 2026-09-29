/**
 * QA retest 2026-09-28 (m9): with the model picker open, the chip's tip "Model and how long it thinks" came back over
 * the picker and covered its last row. A button whose menu is open shows no tip (core/ui.js showTip); once the menu is
 * closed its tip shows again. Node only: the real dist/ and public/, a scripted model, headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("the model chip's tip never covers the open picker, and comes back once it closes", async (t) => {
  const { page, errors } = await newWindow(t);
  await page.locator("#prompt").waitFor();
  const chip = page.locator('#composer [data-act="modelmenu2"]').first();
  const box = await chip.boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.locator(".tipx").waitFor({ timeout: 3000 }); // the tip on a plain hover
  await page.mouse.down(); await page.mouse.up();
  await page.locator(".pop").waitFor();
  for (const dx of [12, 20, 28]) { await page.mouse.move(box.x + dx, box.y + box.height / 2); await page.waitForTimeout(150); }
  await page.waitForTimeout(900); // past the tip's delay
  const covered = await page.evaluate(() => {
    const tip = document.querySelector(".tipx"), pop = document.querySelector(".pop");
    if (!tip || !pop) return null;
    const a = tip.getBoundingClientRect(), b = pop.getBoundingClientRect();
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom ? tip.textContent : `apart: ${tip.textContent}`;
  });
  assert.equal(covered, null, "no tip while the chip's menu is open");

  await page.keyboard.press("Escape");
  await page.locator(".pop").waitFor({ state: "detached" });
  await page.mouse.move(0, 0);
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.locator(".tipx").waitFor({ timeout: 3000 });
  assert.deepEqual(errors, []);
});
