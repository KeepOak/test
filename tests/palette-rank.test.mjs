/* UP-UI-014: the palette ranks close matches ("nw conv" finds New conversation first) and a screen reader hears the
   highlighted choice: the box is a combobox whose aria-activedescendant follows the arrows. The scorer is loaded in
   Node; the combobox is checked in a headless window. Mutation: drop the aria-activedescendant line: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { paletteScore } from "../public/app/shell/palette-match.js";
import { newWindow } from "./new-window-places.mjs";

const rank = (query, labels) => labels.map((label) => ({ label, sub: "", score: paletteScore(query, { label, sub: "" }) }))
  .filter((one) => Number.isFinite(one.score)).sort((a, b) => b.score - a.score).map((one) => one.label);

test("UP-UI-014: abbreviated words find the right choice first, and letters out of order find nothing", () => {
  assert.equal(rank("nw conv", ["Settings", "Conversations", "New conversation", "New Trunk"])[0], "New conversation");
  assert.equal(rank("sett", ["Reset everything", "Settings"])[0], "Settings", "a word's start beats letters inside another");
  assert.deepEqual(rank("zq", ["Settings", "New conversation"]), []);
  assert.equal(rank("cafe", ["Café notes"])[0], "Café notes", "accents do not stop a match");
  assert.equal(paletteScore("", { label: "Anything", sub: "" }), 0, "an empty box lists everything");
  assert.equal(paletteScore("zzz", { label: "An engine hit", sub: "", found: true }), 0, "what the engine found stays listed");
});

test("UP-UI-014: the palette box is a combobox that names the highlighted option", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  await page.evaluate(() => import("/app/shell/palette.js").then((m) => m.openPalette()));
  const box = page.locator("#pal-in");
  await box.waitFor();
  assert.equal(await box.getAttribute("role"), "combobox");
  assert.equal(await box.getAttribute("aria-controls"), "pal-list");
  assert.equal(await box.getAttribute("aria-activedescendant"), "pal-option-0");
  await page.keyboard.press("ArrowDown");
  assert.equal(await box.getAttribute("aria-activedescendant"), "pal-option-1");
  assert.equal(await page.locator("#pal-option-1").getAttribute("aria-selected"), "true");
  await box.fill("nw conv");
  await page.waitForFunction(() => document.querySelector("#pal-option-0 .mi-t")?.textContent.length > 0);
  assert.match(await page.locator("#pal-option-0 .mi-t").innerText(), /new conversation/i);
  assert.deepEqual(errors, []);
});
