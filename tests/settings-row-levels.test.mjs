/* DG-199: Settings levels each setting's row as the approved sample does (public/settings-row-levels.js, measured from
   design/Branch-Grown-Up.html), and "N more with …" counts what a section keeps out of sight row by row, as the
   sample counts it: each setting out of sight, in a card on show or not; a card with no setting rows counts for
   nothing, and a card shows at the lowest level of its rows (coordinator, 2026-09-23). The
   sample's Under the hood has no head and no "N more" line until something in it is on show, is Technical, and comes
   last. A row is only ever the words, the control and the note of one setting, never a title or a neighbour. Search
   and a link to one setting still show a row whatever the level. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsWindow, openSettingsPage, setLevel, isSoon } from "./settings-window.mjs";

/* The new window: Lockdown, the one switch that stops every Trunk, is within reach on Permissions at Regular, live. */
test("DG-199 Lockdown stays within reach at Regular on Permissions, and is live", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "row-levels" });
  await openSettingsPage(page, "permissions");
  await setLevel(page, "regular");
  const lock = page.locator(".set-col .danger").getByRole("button", { name: "Turn Lockdown on", exact: true });
  await lock.waitFor();
  assert.equal(await lock.isVisible(), true);
  assert.equal(await isSoon(lock).catch(() => false), false, "it is not greyed out");
  assert.deepEqual(errors, []);
});

async function settings(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-row-levels-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  /* Opened as a person opens it, not through the helper that also shows every card of the page. */
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  return { page, errors };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value));
const open = async (page, name) => {
  await page.evaluate((one) => globalThis.branchLayout.go(`settings:${one}`), name);
  await page.waitForTimeout(400);
};

