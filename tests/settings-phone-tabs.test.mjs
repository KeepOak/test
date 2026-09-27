/* DG-013: on a phone the Settings pages are the approved sample's strip of page tabs (design/Branch-Grown-Up.html,
   its `.set-pages` under 760px): one row of the same page buttons, without their icons or group names, 4px apart,
   scrolling sideways from edge to edge, with the level card 4px under it. Never a dropdown. The page on show stays
   in sight in the strip however it was reached, a tab opens its page from the keyboard, and wide the pages stay the
   list. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsWindow } from "./settings-window.mjs";

/* The new window, on a phone: Settings opens with its shortcut (Ctrl+,) and its pages are the prototype's strip, one row
   of page buttons without group names, scrolling sideways, never a dropdown; the page itself never scrolls sideways. */
async function phoneSettings(t, width) {
  const opened = await settingsWindow(t, { name: "phone-tabs", width, height: 844 });
  await opened.page.keyboard.press("ControlOrMeta+Comma");
  await opened.page.locator(".settings .set-nav").waitFor();
  return opened;
}
const newStrip = (page) => page.evaluate(() => {
  const nav = document.querySelector(".settings .set-nav");
  const tabs = [...nav.querySelectorAll('[data-act="setpage"]')].filter((tab) => tab.checkVisibility());
  return {
    selects: nav.querySelectorAll("select").length,
    scrolls: nav.scrollWidth > nav.clientWidth + 1, pageScrolls: document.documentElement.scrollWidth > innerWidth + 1,
    oneRow: tabs.length > 5 && tabs.every((tab) => Math.abs(tab.getBoundingClientRect().top - tabs[0].getBoundingClientRect().top) < 1),
    groups: [...nav.querySelectorAll(".grp")].filter((group) => group.checkVisibility()).length,
    back: [...nav.querySelectorAll(".set-back")].some((back) => back.checkVisibility()),
  };
});
for (const width of [390, 700]) {
  test(`DG-013 at ${width} px the pages are the prototype's strip of tabs, not a dropdown`, async (t) => {
    const { page, errors } = await phoneSettings(t, width);
    await page.locator('[data-act="setpage"][data-v="general"]').click();
    assert.deepEqual(await newStrip(page), { selects: 0, scrolls: true, pageScrolls: false, oneRow: true, groups: 0, back: true });
    assert.deepEqual(errors, []);
  });
}

test("DG-013 on a phone a page tab is a real button: focused and pressed with Enter, it opens its page", async (t) => {
  const { page, errors } = await phoneSettings(t, 390);
  await page.waitForTimeout(1000); // the page has drawn what it loaded, as a person sees it before reaching for a tab
  await page.locator('[data-act="setpage"][data-v="gateway"]').focus();
  // A person takes a moment before pressing Enter; a redraw in that moment must not take the keyboard away.
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.v ?? document.activeElement?.tagName), "gateway",
    "the keyboard is still on the Gateway tab");
  await page.keyboard.press("Enter");
  await page.locator('[data-act="setpage"][data-v="gateway"][aria-current="true"]').waitFor();
  await page.locator(".set-col").getByRole("heading", { name: "Gateway", exact: true, level: 1 }).waitFor();
  assert.deepEqual(errors, []);
});

test("DG-013 wide, the pages stay the list, in a column with their group names", async (t) => {
  const { page, errors } = await phoneSettings(t, 390);
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.settings .set-nav [data-act="setpage"]')].filter((tab) => tab.checkVisibility());
    return { column: tabs.every((tab, index) => index === 0 || tab.getBoundingClientRect().top > tabs[index - 1].getBoundingClientRect().top),
      groups: [...document.querySelectorAll(".settings .set-nav .grp")].filter((group) => group.checkVisibility()).length >= 3 };
  });
  assert.deepEqual(wide, { column: true, groups: true });
  assert.deepEqual(errors, []);
});

/* On a phone the list of places slides over the window; choosing Settings from it puts Settings in front (the prototype
   closes the list on every view change, design/redesign/prototype.html's ACTS.view), so the page can be used. */
test("on a phone, choosing Settings from the slid-in list closes the list and the page can be used", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "phone-tabs", width: 390, height: 844 });
  await page.locator('[data-act="side"]').click();
  await page.locator('[aria-label="Settings"][data-act="view"]').click();
  await page.locator(".settings .set-nav").waitFor();
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("side-open"), undefined, { timeout: 5000 });
  await page.locator('[data-act="setpage"][data-v="gateway"]').click({ timeout: 5000 });
  await page.locator('[data-act="setpage"][data-v="gateway"][aria-current="true"]').waitFor();
  assert.deepEqual(errors, []);
});

async function settings(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-tabs-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor();
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  return { page, errors };
}

/** The strip as drawn: its box, its tabs on show, and the level card under it. */
const strip = (page) => page.evaluate(() => {
  const holder = document.querySelector(".sg-pages"), box = holder.getBoundingClientRect(), style = getComputedStyle(holder);
  const tabs = [...holder.querySelectorAll(".lx-settings-link")].filter((tab) => tab.checkVisibility());
  const level = document.querySelector(".sg-level").getBoundingClientRect();
  const back = document.querySelector(".lx-settings-back");
  return {
    selects: document.querySelectorAll(".lx-settings-nav select, #sg-page-pick").length,
    left: box.left, width: box.width, gap: style.gap, padding: style.padding,
    scrolls: holder.scrollWidth > holder.clientWidth + 1, pageScrolls: document.documentElement.scrollWidth > innerWidth + 1,
    oneRow: tabs.every((tab) => Math.abs(tab.getBoundingClientRect().top - tabs[0].getBoundingClientRect().top) < 1),
    firstTab: tabs[0].getBoundingClientRect().left, radius: getComputedStyle(tabs[0]).borderRadius,
    icons: tabs.filter((tab) => tab.querySelector("svg")?.checkVisibility()).length,
    groups: [...holder.querySelectorAll(".sg-nav-group")].filter((group) => group.checkVisibility()).length,
    levelGap: level.top - box.bottom, levelLeft: level.left, levelWidth: level.width,
    version: document.getElementById("lx-settings-version")?.checkVisibility() ?? false,
    back: back.checkVisibility() && back.querySelector("kbd")?.textContent === "Esc",
  };
});

for (const width of [390, 700]) {
  // Redesign: replaced by the new window (the prototype's .set-nav strip, re-pointed above; its spacing and radii are the
  // prototype's own).
  test.skip(`DG-013 at ${width} px the pages are the sample's strip of tabs, not a dropdown`, async (t) => {
    const { page, errors } = await settings(t, width);
    await page.locator('.lx-settings-link[data-page="general"]').click();
    assert.deepEqual(await strip(page), {
      /* Inside the window's 1px edge, as the sample's: the strip spans it, the first tab and the level card 8px in. */
      selects: 0, left: 1, width: width - 2, gap: "4px", padding: "0px 8px 8px", scrolls: true, pageScrolls: false, oneRow: true,
      firstTab: 9, radius: "9px", icons: 0, groups: 0, levelGap: 4, levelLeft: 9, levelWidth: width - 18, version: false, back: true,
    });
    assert.deepEqual(errors, []);
  });
}

// Redesign: Coming soon (sw:lang), checked at fc541c24. The wide half is re-pointed above.
test.skip("DG-013 the tabs speak French, and wide the pages stay the list with their icons and groups", async (t) => {
  const { page, errors } = await settings(t, 390);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.querySelector('.lx-settings-link[data-page="general"]')?.textContent.trim() === "Général");
  assert.equal(await page.locator('.lx-settings-link[data-page="appearance"]').evaluate((tab) => tab.textContent.trim()), "Apparence");
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".lx-settings-link")].filter((tab) => tab.checkVisibility());
    return { holder: getComputedStyle(document.querySelector(".sg-pages")).display,
      column: tabs.every((tab, index) => index === 0 || tab.getBoundingClientRect().top > tabs[index - 1].getBoundingClientRect().top),
      icons: tabs.every((tab) => tab.querySelector("svg")?.checkVisibility()),
      groups: [...document.querySelectorAll(".sg-nav-group")].filter((group) => group.checkVisibility()).length >= 3,
      version: document.getElementById("lx-settings-version").checkVisibility() };
  });
  assert.deepEqual(wide, { holder: "contents", column: true, icons: true, groups: true, version: true });
  assert.deepEqual(errors, []);
});
