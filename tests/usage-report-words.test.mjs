/* DG-170: the usage report's "How far back" choice reads words, never its keys. It was drawn before the words
   loaded, and with nothing to redraw it by it kept showing "usage.report.range.7d". It must read words after a cold
   load, and in French after a change of language. Headless only. */
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

/* The new window: Settings › Data & usage's report reads words after a cold load: its Period choices are the prototype's,
   and no key shows anywhere on the page. */
test("DG-170 the usage report's period reads words, not keys", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "usage-words" });
  await openSettingsPage(page, "usage");
  const period = page.locator(".set-col").getByRole("group", { name: "Period", exact: true });
  await period.waitFor();
  assert.deepEqual((await period.getByRole("button").allInnerTexts()).map((words) => words.trim()), ["7 days", "30 days", "90 days"]);
  assert.deepEqual((await page.locator(".set-col").innerText()).match(/(?:usage\.report|counters)\.[a-z][\w-]*/g) ?? [], [], "no key shows");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the period is the prototype's segments, re-pointed above; #usage-report-range and
// the counters card are gone), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("DG-170 the usage report's range reads words, not keys, in English and in French", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage-words-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "data");
  /* Every key either card shows as text, shown or not (text runs together, so no word boundary), and the range's choices. */
  const read = () => page.evaluate(() => ({
    keys: [...document.querySelectorAll("#usage-report-card, #counters-card")].flatMap((card) => card.textContent.match(/(?:usage\.report|counters)\.[a-z][\w-]*/g) ?? []),
    range: [...document.getElementById("usage-report-range").options].map((option) => option.textContent),
  }));
  assert.deepEqual(await read(), { keys: [], range: ["The last 7 days", "The last 30 days", "The last 90 days"] });
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("usage-report-range").options[0].textContent === "Les 7 derniers jours", null, { timeout: 5000 }).catch(() => undefined);
  assert.deepEqual(await read(), { keys: [], range: ["Les 7 derniers jours", "Les 30 derniers jours", "Les 90 derniers jours"] });
  assert.deepEqual(errors, []);
});
