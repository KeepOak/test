/* SCREEN-025 (find, zoom): the owner's browser finds words on the page and zooms it, as its own inputs, within bounds.
   A headless Chromium page with set content; no site is visited and no desktop is driven.
   Mutation: return found: true without looking in browser-owner-input.ts: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { OwnerInputSchema, ownerPageInput } from "../dist/integrations/browser-owner-input.js";

test("SCREEN-025: find says whether the words are on the page, and zoom scales it within 50-200%", { timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent("<p>The quick brown fox jumps over the lazy dog.</p><p>Another fox.</p>");
  const input = (value) => ownerPageInput(page, OwnerInputSchema.parse(value), () => {});
  assert.deepEqual(await input({ kind: "find", text: "lazy dog" }), { done: true, found: true });
  assert.equal(await page.evaluate(() => getSelection().toString()), "lazy dog", "the match is selected on the page");
  assert.deepEqual(await input({ kind: "find", text: "zebra" }), { done: true, found: false });
  assert.deepEqual(await input({ kind: "zoom", factor: 1.5 }), { done: true, zoom: 1.5 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).zoom), "1.5");
  for (const bad of [{ kind: "zoom", factor: 3 }, { kind: "zoom", factor: 0.1 }, { kind: "find", text: "" }, { kind: "find", text: "x".repeat(301) }])
    assert.equal(OwnerInputSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
});
