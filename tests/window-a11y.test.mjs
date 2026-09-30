/* UI-223: an automated accessibility check of the window's main places, in CI. axe-core (the standard engine, a
   dev-only dependency) runs in one headless window over a new conversation, a conversation with a reply, every place
   the list offers, Settings' pages at Technical, Settings' search results, the Ctrl K palette and the keyboard-shortcuts dialog, then the places
   and the main Settings pages again in the other light (the title bar's flip). Only violations
   fail it; "incomplete" (what axe cannot decide, such as contrast over the glass and the wallpaper) is not a failure.
   Every violation of the whole run is listed at once, with the place and the element.
   Headless, one window, no sleeps: the window is settled by counting requests in flight and two frames.
   Mutation: drop the aria-label from the Ctrl K list (shell/palette.js #pal-list) and "aria-input-field-name" goes red;
   put back .ach.locked{opacity:.55} and the Achievements page goes red on contrast. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium as _browserFile } from "playwright"; // a browser file, run one at a time (scripts/run-tests.mjs)
import { newWindow, openPlace } from "./new-window-places.mjs";
import { openSettingsPage, setLevel } from "./settings-window.mjs";

void _browserFile;
/* Given to the page through the test driver (the window's own rules allow no script it did not serve). */
const AXE = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const COUNT = () => {
  window.__inFlight = 0;
  const real = window.fetch;
  window.fetch = (...args) => { window.__inFlight++; return real(...args).finally(() => { window.__inFlight--; }); };
};
async function settle(page) {
  await page.waitForFunction(() => window.__inFlight === 0, null, { timeout: 20000, polling: 50 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}
/* axe over the whole document; each violation as "rule (impact): the element — what is wrong". */
async function check(page, where, found) {
  await settle(page);
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(AXE);
  const violations = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(" ")} ${n.html.slice(0, 100)} — ${n.failureSummary.split("\n").slice(1).join(" ").trim()}`)));
  for (const v of violations) found.push(`${where}: ${v}`);
}

test("the window's main places pass an automated accessibility check", { timeout: 300000 }, async (t) => {
  const provider = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const { page, errors } = await newWindow(t, { provider, width: 1280, height: 900 });
  // Checked at rest: under reduced motion nothing is caught half-faded (a card easing in reads as low contrast).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(COUNT);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const found = [];

  await check(page, "a new conversation", found);
  await page.locator("#prompt").fill("Say hello.");
  await page.locator("#prompt").press("Enter");
  await page.locator("#main .b").filter({ hasText: "Here it is." }).first().waitFor({ timeout: 20000 });
  await check(page, "a conversation with a reply", found);

  for (const place of ["overview", "inbox", "automations", "library", "team", "customize"]) {
    await openPlace(page, place);
    await check(page, place, found);
  }

  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  const pages = await page.locator('.set-nav [data-act="setpage"]').evaluateAll((all) => all.map((b) => b.dataset.v));
  for (const id of pages) {
    await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"]`).click(); // a page may link to another by the same act
    await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
    await check(page, `Settings › ${id}`, found);
  }
  await page.locator("#set-q").fill("theme");
  await page.locator(".set-found .set-hit").first().waitFor();
  await check(page, "Settings search results", found);
  await page.locator("#set-q").fill("");
  await page.locator(".set-back").click();

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#pal-in").waitFor();
  await check(page, "the Ctrl K palette", found);
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.locator(".dlg").waitFor();
  await check(page, "the keyboard shortcuts dialog", found);

  // The other light (the title bar's flip): the places and the main Settings pages again.
  await page.keyboard.press("Escape");
  const was = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.locator('[data-act="theme-flip"]').first().click();
  await page.waitForFunction((before) => getComputedStyle(document.body).backgroundColor !== before, was);
  const other = await page.evaluate(() => document.documentElement.dataset.theme || "flipped");
  for (const place of ["overview", "inbox", "automations", "library", "team", "customize"]) {
    await openPlace(page, place);
    await check(page, `${other} · ${place}`, found);
  }
  for (const id of ["general", "appearance", "models", "permissions", "computer", "achievements"]) {
    await openSettingsPage(page, "general");
    await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"]`).click();
    await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
    await check(page, `${other} · Settings › ${id}`, found);
  }

  const seen = [...new Set(found)];
  assert.deepEqual(seen, [], `${seen.length} accessibility violations:\n${seen.join("\n")}`);
  assert.deepEqual(errors, []);
});
