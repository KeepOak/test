import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

const LOCALES = join(import.meta.dirname, "..", "public", "locales");

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-q78-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  return { page, errors };
}

// Redesign: Coming soon (sw:lang, the Language select on Settings › Appearance), checked at fc541c24.
test.skip("Q78: Settings › General page strings are localized to French", async (t) => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));

  // Check that all required keys exist and have French translations
  assert.ok(en["settings.deployment.safety-copies"], "English key for safety copies must exist");
  assert.ok(fr["settings.deployment.safety-copies"], "French key for safety copies must exist");
  assert.ok(en["settings.deployment.check-ready"], "English key for check ready must exist");
  assert.ok(fr["settings.deployment.check-ready"], "French key for check ready must exist");
  assert.ok(en["people.share.title"], "English key for people share title must exist");
  assert.ok(fr["people.share.title"], "French key for people share title must exist");

  const { page, errors } = await fixture(t);
  await openSettings(page, "general");

  // Wait for deployment card to be visible
  await page.locator("#deployment-card").waitFor({ state: "visible", timeout: 30000 });

  // Wait for the collab panel to render (it contains the "People who share this computer" title)
  await page.locator("[data-part='people']").waitFor({ state: "attached", timeout: 30000 });

  // Switch to French and wait for a neighbor that's already localized
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });

  // Wait for the French heading to appear (signals language has switched)
  await page.waitForFunction(() => {
    const heading = document.querySelector("#deployment-card h2");
    return heading && heading.textContent === "Comment Branch fonctionne sur cet ordinateur";
  }, { timeout: 30000 });

  // Get the text content of the visible settings page
  const pageText = await page.evaluate(() => {
    const page = document.querySelector(".lx-page:not([hidden])");
    return page ? page.innerText : "";
  });

  // Check that English strings are NOT on the page
  assert.ok(!pageText.includes("People who share this computer"), "English 'People who share this computer' should not appear");
  assert.ok(!pageText.includes("Safety copies"), "English 'Safety copies' should not appear");
  assert.ok(!pageText.includes("Check this computer is ready"), "English 'Check this computer is ready' should not appear");

  // Check that French strings ARE on the page
  assert.ok(pageText.includes(fr["people.share.title"]), `French translation of 'People who share this computer' should appear: ${fr["people.share.title"]}`);
  assert.ok(pageText.includes(fr["settings.deployment.safety-copies"]), `French translation of 'Safety copies' should appear: ${fr["settings.deployment.safety-copies"]}`);
  assert.ok(pageText.includes(fr["settings.deployment.check-ready"]), `French translation of 'Check this computer is ready' should appear: ${fr["settings.deployment.check-ready"]}`);

  // Q81: the safety-copies line is written by the card, not by data-t, so it must follow the switch too.
  await page.waitForFunction((words) => document.querySelector("#restore-points")?.textContent === words,
    fr["settings.deployment.no-safety-copy"], { timeout: 10000 });

  assert.deepEqual(errors, []);
});
