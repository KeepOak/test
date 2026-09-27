/**
 * Settings puts its cards in order after they are drawn (public/settings-grown.js, arrange). Moving a
 * card used to take it out of the page and put it back, and the browser drops keyboard focus from
 * anything that leaves the page: a person who had tabbed to a switch found the keyboard back at the top
 * of the window, about 100 ms after Settings opened. Moving a card must leave the keyboard where it was,
 * with moveBefore where the browser has it and by giving focus back where it has not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function fixture(t, { withoutMoveBefore = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-focus-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
  // A browser without moveBefore (Safari, older Chromium): the card is moved the old way.
  if (withoutMoveBefore) await page.addInitScript(() => { delete Element.prototype.moveBefore; });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  await openSettings(page, "general");
  return { page, errors };
}

/** Focuses the switch, then sends its card to the end of the page so Settings has to put it back. */
const focusAndDisplace = (page) => page.evaluate(async () => {
  const control = document.getElementById("start-with-windows");
  const card = control.closest(".card");
  const host = card.parentElement;
  control.focus();
  const before = card.previousElementSibling;
  // Moved with moveBefore where the browser has it, so the test itself does not drop the focus.
  const move = host.moveBefore ? (node) => host.moveBefore(node, null) : (node) => { host.append(node); control.focus(); };
  move(card);
  const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  await frames();
  await frames();
  return {
    putBack: card.previousElementSibling === before,
    focused: document.activeElement === control,
    active: document.activeElement?.id || document.activeElement?.tagName,
  };
});

/* The new window: a control a person reaches the moment Settings › General opens keeps the keyboard while the page
   draws what it loaded, and the next Tab moves on to a real control. Settings is not a dialog, so it does not keep
   the Tab inside (the prototype traps Tab only in dialogs and setup; "Show all" is General's last control). */
test("a control focused the moment Settings opens keeps the keyboard while the page settles (new window)", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "settings-focus" });
  await openSettingsPage(page, "general");
  const shortcuts = page.locator(".set-col").getByRole("button", { name: "Show all", exact: true });
  await shortcuts.focus();
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null), "Show all",
    `the keyboard stays on Show all (it went to ${await page.evaluate(() => document.activeElement?.tagName)})`);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body), true,
    "and the next Tab moves on to a control, not nowhere");
  assert.deepEqual(errors, []);
});

for (const withoutMoveBefore of [false, true]) {
  const how = withoutMoveBefore ? "without moveBefore" : "with moveBefore";
  // Redesign: replaced by the new window (Settings no longer moves cards into order after drawing them).
  test.skip(`a card Settings puts back in order keeps the keyboard on its switch (${how})`, async (t) => {
    const { page, errors } = await fixture(t, { withoutMoveBefore });
    await page.waitForTimeout(1500); // Settings has finished its own first arrangement.
    const result = await focusAndDisplace(page);
    assert.equal(result.putBack, true, "Settings put the card back where it belongs");
    assert.equal(result.focused, true, `the keyboard stays on the switch (it went to ${result.active})`);
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (#start-with-windows is the prototype's "Start with Windows", Coming soon
// (sw:g-start); re-pointed above on a live control).
test.skip("a switch focused the moment Settings opens keeps the keyboard while the page settles", async (t) => {
  const { page, errors } = await fixture(t);
  await page.locator("#start-with-windows").focus();
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "start-with-windows");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("#settings-window") !== null), true,
    "and the next Tab moves on inside Settings, not back to the top of the window");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (/i18n.js is gone; the language is Coming soon, sw:lang, checked at fc541c24).
test.skip("writing the page in the language it is already in changes nothing, so nothing watching the page wakes for it", async (t) => {
  const { page, errors } = await fixture(t);
  await page.waitForTimeout(1500);
  const changes = await page.evaluate(async () => {
    const { applyLanguage } = await import("/i18n.js");
    const seen = [];
    const watch = new MutationObserver((records) => { for (const r of records) seen.push(`${r.type} ${r.attributeName ?? ""} ${r.target.className ?? r.target.nodeName}`); });
    watch.observe(document.getElementById("settings-window"), { subtree: true, childList: true, attributes: true, characterData: true });
    applyLanguage();
    // Only what applying the language (and whatever it wakes on the spot) wrote: a refresh that happens to land in
    // the same moment on a slow machine is not this.
    for (const r of watch.takeRecords()) seen.push(`${r.type} ${r.attributeName ?? ""} ${r.target.className ?? r.target.nodeName}`);
    watch.disconnect();
    return seen;
  });
  assert.deepEqual(changes, [], "the same words were written again");
  assert.deepEqual(errors, []);
});
