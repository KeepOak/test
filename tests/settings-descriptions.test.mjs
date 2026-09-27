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

/*
 * R17-S01 and R17-S04: every control in Settings says what it does, and every Settings card says how
 * far it reaches.
 *
 * This walks every Settings page (and every Models tab) the way a person does, and checks each
 * visible input, select and text box inside a card, as a fresh install shows them. It covers the
 * Settings window only — the audit row's home is "all Settings" — not the five places, and it does not
 * reach controls that only appear once something is switched on or unfolded (those still get their
 * descriptions from the same table, but nothing here proves it).
 *
 * A control passes when `aria-describedby` points at words on the page. That happens when:
 *   - the card writes its own note and links it (`<p class="field-note" id="x-note">`, and
 *     `aria-describedby="x-note"` on the control), or
 *   - a `.field-note` sits straight after the control (or after the label it is inside), or
 *   - the control has a row in public/settings-descriptions.js (with its words in en.json and fr.json).
 */

const LOCALES = join(import.meta.dirname, "..", "public", "locales");

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-describe-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  /* The page's own settling point is waited for on the very next line. The click itself
     therefore does not also wait on Playwright's generic after-the-click step, which on
     Chromium is a CDP round trip (`Page.enable`) and stalled for the whole thirty seconds on
     the loaded Windows checker. Nothing is waited for less: a real signal replaces a proxy. */
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 }); // phase2/accounts: was #settings-kit-files
  return { page, errors };
}

/** What is wrong on the Settings page that is open now. */
function auditOpenPage(where) {
  const shown = (node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  const name = (control) => control.id ? `#${control.id}` : `${control.tagName.toLowerCase()}[${control.name || control.type || ""}] in #${control.closest(".card")?.id || "?"}`;
  const purposed = (heading) => heading?.nextElementSibling?.tagName === "P" && !!heading.nextElementSibling.textContent.trim();
  /* The approved sample gives each section one heading and one purpose line, and its cards no heading of their own. A
     section is the .sg-head in front of its cards (public/settings-grown.js), matched by the card's data-sg-bucket. */
  const sectionHeading = (card) => {
    const bucket = card.dataset.sgBucket;
    if (!bucket || !card.parentElement) return null;
    const head = [...card.parentElement.children].find((node) => node.matches(".sg-head") && node.dataset.bucket === bucket);
    return head?.querySelector("h3.sg-head-title") ?? null;
  };
  const problems = [];
  for (const card of document.querySelectorAll(".lx-page:not([hidden]) .card")) {
    if (!shown(card)) continue;
    const heading = card.querySelector(card.classList.contains("settings-directory-card") ? "h3.settings-directory-title" : "h2, h3.settings-card-title");
    const cardName = card.id || heading?.textContent.trim() || "a card with no id";
    if (heading ? heading.nextElementSibling?.tagName !== "P" : !purposed(sectionHeading(card)))
      problems.push(`${where}: card ${cardName} needs its heading followed by one sentence saying what it is for`);
    if (!card.querySelector(":scope > .kit-scope[data-t]"))
      problems.push(`${where}: card ${cardName} has no scope chip (public/settings-describe.js adds it; give the card an <h2>)`);
    for (const control of card.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      if (!shown(control)) continue;
      const ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      const words = ids.map((id) => document.getElementById(id)?.textContent.trim() ?? "").join(" ");
      if (!words) problems.push(`${where}: ${name(control)} has no description. Add a row to public/settings-descriptions.js `
        + "(with words in public/locales/en.json and fr.json), or a <p class=\"field-note\"> right after it linked by aria-describedby");
    }
  }
  return problems;
}

/* The new window: walked the way a person walks it, at Technical (every page and every Models tab), every control on show
   in Settings has a name that says what it is, and every row of the prototype's (.ctl) has its title. */
test("R17-S01: every control in the new window's Settings is named, and every row has its title", async (t) => {
  const { settingsWindow, openSettingsPage, setLevel } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "describe" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  const ids = await page.locator('.set-nav [data-act="setpage"]').evaluateAll((all) => all.map((node) => node.dataset.v));
  assert.ok(ids.length >= 18, "the Settings pages moved; this test is looking in the wrong place");
  const problems = [];
  let checked = 0;
  for (const id of ids) {
    await openSettingsPage(page, id);
    const tabs = id === "models" ? await page.locator('.set-col [role="tab"]').count() : 1;
    for (let at = 0; at < tabs; at++) {
      if (id === "models") await page.locator('.set-col [role="tab"]').nth(at).click();
      await page.waitForTimeout(300);
      const found = await page.evaluate((where) => {
        const shown = (node) => node.getClientRects().length > 0;
        const named = (node) => (node.getAttribute("aria-label") || "").trim() || (node.getAttribute("aria-labelledby") || "").trim()
          || [...(node.labels ?? [])].some((label) => label.textContent.trim() || (label.getAttribute("aria-label") || "").trim()) || (node.getAttribute("title") || "").trim();
        const controls = [...document.querySelectorAll(".set-col :is(input:not([type=hidden]), select, textarea)")].filter(shown);
        const rows = [...document.querySelectorAll(".set-col .ctl")].filter(shown);
        return { count: controls.length,
          problems: [...controls.filter((node) => !named(node)).map((node) => `${where}: ${node.tagName.toLowerCase()}#${node.id || "?"} has no name`),
            ...rows.filter((row) => !row.querySelector(":scope > b")?.textContent.trim()).map((row) => `${where}: a row has no title`)] };
      }, id === "models" ? `models:${at}` : id);
      checked += found.count;
      problems.push(...found.problems);
    }
  }
  assert.ok(checked > 60, `only ${checked} controls were found; the walk is not reaching the pages`);
  assert.deepEqual(problems, []);
  assert.deepEqual(errors, []);
});

test("R17-S04: a headless card passes only inside a section with a heading and a purpose line", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const chip = '<p class="kit-scope" data-t="settings-kit.scope.everything">Applies to everything</p>';
  await page.setContent(`<div class="lx-page">
    <div class="sg-head" data-bucket="p:told"><div class="sg-head-words"><h3 class="sg-head-title">Told</h3><p>What this section is for.</p></div></div>
    <div class="card" id="in-told" data-sg-bucket="p:told">${chip}</div>
    <div class="sg-head" data-bucket="p:untold"><div class="sg-head-words"><h3 class="sg-head-title">Untold</h3></div><p class="sg-more-line"><button>2 more</button></p></div>
    <div class="card" id="in-untold" data-sg-bucket="p:untold">${chip}</div>
    <div class="card" id="alone">${chip}</div>
  </div>`);
  assert.deepEqual(await page.evaluate(auditOpenPage, "fixture"), [
    "fixture: card in-untold needs its heading followed by one sentence saying what it is for",
    "fixture: card alone needs its heading followed by one sentence saying what it is for",
  ]);
});

// Redesign: replaced by the new window (public/settings-descriptions.js is gone; the loop guard is Coming soon, sw:p-loop),
// and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("R17-S01: the descriptions are in English and real French, and show in the language chosen", async (t) => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  const { descriptions, switchDescription } = await import("../public/settings-descriptions.js");
  for (const [selector, key, english] of [...descriptions, ["(switch)", ...switchDescription]]) {
    assert.equal(en[key], english, `${selector}: en.json should say what settings-descriptions.js says`);
    assert.ok(fr[key] && fr[key] !== english, `${selector}: ${key} needs real French`);
  }
  const { page } = await fixture(t);
  await openSettings(page, "permissions");
  await page.locator("#loop-guard-mode").waitFor({ state: "visible" });
  const described = () => page.evaluate(() => {
    const id = document.getElementById("loop-guard-mode").getAttribute("aria-describedby");
    return document.getElementById(id)?.textContent;
  });
  assert.equal(await described(), en["describe.loop-guard"]);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction((words) => {
    const id = document.getElementById("loop-guard-mode").getAttribute("aria-describedby");
    return document.getElementById(id)?.textContent === words;
  }, fr["describe.loop-guard"]);
  const chips = await page.evaluate(() => [...document.querySelectorAll(".lx-page:not([hidden]) .kit-scope")].map((node) => node.textContent));
  assert.ok(chips.length && chips.every((words) => words.startsWith("S'applique")), "the scope chips follow the language");
});

