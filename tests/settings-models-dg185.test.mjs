/**
 * DG-185: Settings › Models opens on its Connection tab with the approved sample's sections, in order:
 * ChatGPT account · Check your connections · Your model connection · N more with Advanced · Other model services
 * · 8 more with Advanced. The other tabs keep their sections. A card that is its whole section is headed once.
 * Checked at 1440 and 400, at Regular (Show everything off) and Advanced (on), and in French.
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

const SECTIONS = ["ChatGPT account", "Check your connections", "Your model connection", "Other model services"];
const FRENCH = ["Compte ChatGPT", "Vérifier vos connexions", "Votre connexion au modèle", "Autres services de modèles"];

async function modelsPage(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-dg185-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, errors };
}
/** Opens Models the way a person does (the cog, then the page), so no card is peeked into sight. */
async function openModels(page) {
  if (!(await page.locator("#settings-window").isVisible())) {
    const cog = page.locator(".lx-foot-line > .sg-gear:visible");
    if (!(await cog.count())) await page.locator("#rail-toggle").click();
    await cog.click();
  }
  await page.locator('.lx-settings-link[data-page="models"]').click();
  await page.locator("#lx-models-connection").waitFor({ state: "visible" });
}
/** What a person sees on the Connection tab: section headings, every visible heading, and each "N more" line. */
const seen = (page) => page.evaluate(() => {
  const tab = document.getElementById("lx-models-connection");
  const shown = (node) => node.getClientRects().length > 0;
  const text = (node) => node.textContent.trim().replace(/\s+/g, " ");
  return {
    sections: [...tab.querySelectorAll(".sg-head-title")].filter(shown).map(text),
    headings: [...tab.querySelectorAll("h2, h3, h4")].filter(shown).map(text),
    more: [...tab.querySelectorAll(".sg-more-line:not([hidden])")].filter(shown).map((line) => [line.dataset.bucket, text(line)]),
  };
});

/* The new window: Settings › Models opens on its Connections tab under the page title; Advanced adds the prototype's
   sections, in order, each headed once; the five tabs stay, at 1440 and 400 px. */
for (const width of [1440, 400]) {
  test(`DG-185 at ${width}: Models opens on Connections, with the prototype's sections at each level, each headed once`, async (t) => {
    const { settingsWindow, openSettingsPage, setLevel } = await import("./settings-window.mjs");
    const { page, errors } = await settingsWindow(t, { name: "models-dg185", width, height: 900 });
    await openSettingsPage(page, "models");
    const heads = () => page.locator(".set-col").locator("h1, h2, h3, h4").evaluateAll((all) =>
      all.filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
    await setLevel(page, "regular");
    await page.locator('.set-col [role="tab"][aria-selected="true"]', { hasText: "Connections" }).waitFor();
    assert.deepEqual(await heads(), ["Models"]);
    assert.equal(await page.locator('.set-col [role="tab"]').count(), 5, "the Models tabs stay");
    await setLevel(page, "advanced");
    const advanced = await heads();
    // Pass 17 adds "Mixtures and savings" at Advanced (whereB17("models", 1, ...)), and its part D adds "Decision models"
    // after it (addSettings15('models', 1, ...)).
    assert.deepEqual(advanced, ["Models", "Budgets", "Models for smaller jobs", "Compare models", "Mixtures and savings", "Decision models"]);
    await setLevel(page, "technical");
    const technical = await heads();
    // The prototype draws the FINE15 rows first, then pass 17's (whereB17): Technical adds "Retries and timeouts" and
    // "Per connection" among the FINE15 rows, and "Connections, technical" after "Mixtures and savings"; part D's two
    // sections come last, in the order they were added (addSettings15('models', 1 | 2, ...)).
    assert.deepEqual(technical, ["Models", "Budgets", "Models for smaller jobs", "Compare models", "Retries and timeouts", "Per connection", "Mixtures and savings", "Connections, technical", "Decision models", "Decision models, technical"]);
    assert.equal(new Set(technical).size, technical.length, "no heading is drawn twice");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width} px fits`);
    assert.deepEqual(errors, []);
  });
}

for (const width of [1440, 400]) {
  // Redesign: replaced by the new window (the prototype's Connections tab has no ChatGPT, connection-check or services
  // sections and no "N more" lines; its sections are re-pointed above).
  test.skip(`DG-185 at ${width}: Models › Connection has the sample's sections, each headed once, at Regular and Advanced`, async (t) => {
    const { page, errors } = await modelsPage(t, width);
    await openModels(page);
    /* On the desktop app the model connection card is on show; the browser hides it until the app fills it in. */
    await page.evaluate(() => { document.getElementById("model-settings-form").hidden = false; });
    await page.waitForFunction(() => document.querySelector("#model-settings-form[data-sg-bucket]"));
    await page.waitForTimeout(300);
    const regular = await seen(page);
    assert.deepEqual(regular.sections, SECTIONS, "the sample's sections, in its order");
    assert.equal(new Set(regular.headings).size, regular.headings.length, `no heading is drawn twice: ${regular.headings.join(" · ")}`);
    assert.deepEqual(regular.more, [
      /* the sample's 7 also counts the Accounts card's 2 rows, which live on the Accounts page here */
      ["models:connection:connection", "5 more with Advanced"],
      ["models:connection:services", "8 more with Advanced"],
    ]);
    const tabs = await page.locator("#lx-page-models .lx-subtab").allInnerTexts();
    assert.equal(tabs.length, 5, "the Models tabs stay");

    await page.evaluate(() => globalThis.branchSettingsLevel.set("advanced"));
    await page.waitForTimeout(300);
    const advanced = await seen(page);
    assert.deepEqual(advanced.sections, SECTIONS, "Show everything keeps the same sections");
    assert.equal(new Set(advanced.headings).size, advanced.headings.length, `no heading is drawn twice: ${advanced.headings.join(" · ")}`);
    assert.deepEqual(errors, []);
  });
}

// Redesign: Coming soon (sw:lang), checked at fc541c24; search is tests/settings-search-head.test.mjs.
test.skip("DG-185: the Connection tab's sections have French words, and search still names the cards", async (t) => {
  const { page, errors } = await modelsPage(t, 1440);
  await openModels(page);
  await page.locator('.lx-settings-link[data-page="appearance"]').click();
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.locator('.lx-settings-link[data-page="models"]').click();
  await page.waitForFunction((words) => {
    const heads = [...document.querySelectorAll("#lx-models-connection .sg-head-title")].map((node) => node.textContent.trim());
    return JSON.stringify(heads) === JSON.stringify(words);
  }, FRENCH);
  /* Search shows cards without their sections, so a card keeps its own title there. */
  await page.locator(".lx-settings input[type=search]").first().fill("ChatGPT");
  await page.waitForFunction(() => {
    const title = document.querySelector("#chatgpt-card > h2");
    return title && title.getClientRects().length > 0;
  });
  assert.deepEqual(errors, []);
});
