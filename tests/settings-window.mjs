/* The new window's Settings, opened the way a person opens it: sign in with the session token, press the Settings
   button, pick a page from the list, pick how much to show. Shared by the Settings tests re-pointed at the redesign
   (design/redesign/CONTRACT.md rule 8). Headless only. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A signed-in new window over a fresh engine. `before(app)` runs before the server starts, `route(page)` before the
    page loads. */
export async function settingsWindow(t, { provider, width = 1440, height = 950, before, route, name = "settings" } = {}) {
  const root = await mkdtemp(join(tmpdir(), `branch-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  if (before) await before(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (route) await route(page);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, server, page, errors, call, root };
}

/** Settings › <page>, from the Settings button and the page list. */
export async function openSettingsPage(page, id) {
  if (!(await page.locator(".settings").count())) {
    // A narrow window folds the list (and its Settings button) away; there a person opens Settings with its shortcut.
    // (Choosing Settings from the slid-in list leaves the list over the page: tests/settings-phone-tabs.test.mjs.)
    if (await page.locator('[data-act="side"]').isVisible()) await page.keyboard.press("ControlOrMeta+Comma");
    else await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.locator(".settings").waitFor();
  }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
  await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
}

/** How much to show: "regular", "advanced" or "technical". */
export async function setLevel(page, level) {
  await page.locator(`[data-act="setlevel"][data-v="${level}"]`).click();
  await page.locator(`[data-act="setlevel"][data-v="${level}"][aria-pressed="true"]`).waitFor();
}

/* The open page's headings a person sees, in order, read in ONE turn in the page. A locator's evaluateAll finds the nodes
   and then runs its function on them in a second call; a redraw landing between the two (an engine read arriving)
   detached every node found, none was visible, and a drawn page read as [] (Checks: S6's "the choice is kept"). */
const shownIn = ([levels, list]) => {
  const shown = [...document.querySelectorAll(`.set-col :is(${levels})`)].filter((node) => node.checkVisibility())
    .map((node) => node.textContent.replace(/\s+/g, " ").trim());
  return list === undefined ? shown : JSON.stringify(shown) === list;
};
export const shownHeadings = (page, levels = "h1, h2, h3, h4") => page.evaluate(shownIn, [levels]);

/** Asserts the open page's headings are `want`, once drawn. Some sections are drawn only when the engine's reads land
    ("Decision models" once GET /api/decisions answers, settings/decisions17d.js), so the page is asked again (in the
    page, as Playwright's auto-retrying toHaveText does) until they match or `timeout` passes; then the headings are read
    once more and compared, so a page that is wrong still fails with the difference, and says what the window shows. */
export async function assertHeadings(page, want, message = "", { levels = "h1, h2, h3, h4", timeout = 15000 } = {}) {
  const drawn = await page.waitForFunction(shownIn, [levels, JSON.stringify(want)], { timeout }).then(() => true, () => false);
  const got = await shownHeadings(page, levels);
  const where = drawn ? "" : await page.evaluate(async () => {
    const { S } = await import("/app/core/state.js");
    return ` (the window shows ${JSON.stringify({ view: S.view, page: S.setPage, level: S.level, url: location.pathname + location.hash, pages: document.querySelectorAll(".set-col").length })})`;
  }).catch((error) => ` (the window could not be read: ${error.message})`);
  assert.deepEqual(got, want, `${message}${where}`);
}

/** A control drawn greyed out, "Coming soon" (contract rule 6). */
export const isSoon = (locator) => locator.evaluate((node) => node.getAttribute("aria-disabled") === "true" && node.classList.contains("soon"));
