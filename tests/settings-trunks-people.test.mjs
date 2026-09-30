/**
 * DG-193: Settings › Trunks & people has the approved sample's sections, in its order, with the same "N more with …"
 * lines, at 1440 and 400 and in both Show everything states; its switches save as you go and keep Customize ›
 * Specialists in step; its headings are French in French.
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

const REGULAR = ["Trunks", "3 more with Advanced", "Edit Trunk", "15 more with Advanced", "A person's card", "2 more with Advanced"];
const ADVANCED = ["Trunks", "Edit Trunk", "A person's card"];

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-trunks-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const cog = page.locator(".lx-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="trunks"]').click();
  await page.locator("#lx-page-trunks > #settings-person-card").waitFor({ state: "attached" });
  return { app, page, errors };
}
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-trunks .sg-head-title, #lx-page-trunks .sg-more")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
async function settle(page, want) {
  await page.waitForFunction((want) => [...document.querySelectorAll("#lx-page-trunks .sg-head-title, #lx-page-trunks .sg-more")]
    .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()).join("|") === want, want.join("|"), { timeout: 10000 }).catch(() => {});
}
async function level(page, pick) {
  await page.evaluate((pick) => globalThis.branchSettingsLevel.set(pick), pick);
  await page.waitForFunction((pick) => document.documentElement.dataset.settingsLevel === pick, pick);
}

/* The new window: the people half of the page is Settings › People, the prototype's page (its title and "Each person"),
   at 1440 and 400 px; Trunks are set up in the Team place, not in Settings. */
for (const width of [1440, 400]) {
  test(`People has the prototype's sections at ${width}px, and its links to Team`, async (t) => {
    const { settingsWindow, openSettingsPage, assertHeadings } = await import("./settings-window.mjs");
    const { page, errors } = await settingsWindow(t, { name: "settings-trunks", width, height: 950 });
    await openSettingsPage(page, "people");
    // The prototype's person card has its "May" section (what that person may do).
    await assertHeadings(page, ["People", "May", "Each person"], `${width} px`, { levels: "h1, h2, h3" });
    assert.deepEqual((await page.locator('.set-col [data-act="p-open-team"]').allInnerTexts()).map((words) => words.trim()),
      ["Groups", "Signing in from other devices", "What you share"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width} px fits`);
    assert.deepEqual(errors, []);
  });
}

for (const width of [1440, 400]) {
  // Redesign: replaced by the new window (the prototype has no "Trunks & people" page: People is re-pointed above, and
  // Trunks are set up in the Team place).
  test.skip(`Trunks & people has the sample's sections in order, Show everything off and on, at ${width}px`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await settle(page, REGULAR);
    assert.deepEqual(await outline(page), REGULAR);
    /* At Regular, the sample's two Trunks switches, and Edit Trunk's two ticks. */
    for (const id of ["settings-trunks-switch-trunks", "settings-trunks-switch-rooms", "settings-trunk-edit-commands", "settings-trunk-edit-hidden", "settings-person-role"])
      assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} shows at Regular`);
    assert.equal(await page.locator("#settings-trunks-switch-teach").isVisible(), false);
    await level(page, "advanced");
    await settle(page, ADVANCED);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.everything), "on");
    assert.deepEqual(await outline(page), ADVANCED);
    assert.equal(await page.locator("#settings-trunk-edit-keys").isVisible(), true);
    /* No heading but the section's own, and no directory left behind. */
    assert.equal(await page.locator("#lx-page-trunks .settings-trunks-card h2, #lx-page-trunks .settings-trunks-card h3, #lx-page-trunks .settings-directory-card").count(), 0);
    assert.deepEqual(errors, []);
  });
}

// Redesign: Coming soon (sw:lang), checked at fc541c24.
test.skip("Trunks & people's section headings are French in French", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("sg-bucket-trunks-person")?.textContent === "La fiche d'une personne");
  assert.equal(await page.locator("#sg-bucket-trunks-edit").textContent(), "Modifier un Trunk");
  assert.equal(await page.locator("#settings-trunks-switches .settings-trunks-open").textContent(), "Ouvrir Trunks");
  assert.deepEqual(errors, []);
});
