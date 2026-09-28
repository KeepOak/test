/* DG-189 and DG-053: Settings › Secrets has the approved sample's sections, in its order: "Keys your commands use",
   then "Passwords and keys", which opens with where Branch reads saved sign-ins from. No card below a section has a
   heading of its own, so the page reads page title, then section titles, whatever the width, level or language.
   The password-manager tiles say only what Branch knows (switched on or not, a Keychain here or not) and save as you
   go. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readCredentialSettings } from "../dist/credential-cli.js";
import { openPlace } from "./places.mjs";
import { settingsWindow, openSettingsPage, setLevel } from "./settings-window.mjs";

/* The new window: Settings › Saved sign-ins is the prototype's page, a title and one section ("Branch may fill"), at
   every width and level; no card below it has a heading of its own, and it fits. */
test("DG-189 Saved sign-ins shows the prototype's headings at every width and level, and fits", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "secrets-page" });
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const one of ["regular", "advanced", "technical"]) {
      await openSettingsPage(page, "secrets");
      await setLevel(page, one);
      const headings = await page.locator(".set-col").locator("h1, h2, h3, h4").evaluateAll((all) =>
        all.filter((node) => node.getClientRects().length > 0).map((node) => `${node.tagName} ${node.textContent.trim()}`));
      // Pass 17 adds "Where passwords come from" from Advanced up (whereB17("secrets", 1, ...)).
      assert.deepEqual(headings, ["H1 Saved sign-ins", "H2 Branch may fill", ...(one === "regular" ? [] : ["H2 Where passwords come from"])], `${width} px, ${one}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${width} px fits`);
    }
  }
  assert.deepEqual(errors, []);
});

/* Where Branch reads saved sign-ins from: the page says only what Branch knows. A fresh engine reads from no password
   manager, so the page must not say one is connected; and nothing on it could hold a password. */
test("DG-053 Saved sign-ins says only what Branch knows about the password manager, and holds no password", async (t) => {
  const { app, page, errors } = await settingsWindow(t, { name: "secrets-page" });
  assert.equal(readCredentialSettings(app.store, app.runtime.owner).enabled, false, "a fresh install reads from no password manager");
  await openSettingsPage(page, "secrets");
  const col = page.locator(".set-col");
  await col.getByRole("heading", { name: "Saved sign-ins", exact: true }).waitFor();
  // RES-710: the one switch (Fill saved sign-ins) is a checkbox, which holds no text.
  assert.equal(await col.locator("input:not([type=checkbox]), textarea, select").count(), 0, "nothing here could hold a password");
  assert.doesNotMatch(await col.innerText(), /Bitwarden is connected/, "Branch is not reading from Bitwarden, so the page must not say it is connected");
  assert.deepEqual(errors, []);
});

async function settings(t, before) {
  const root = await mkdtemp(join(tmpdir(), "branch-secrets-page-"));
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
  if (before) await before(page);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  /* Opened as a person opens it, not through the helper that also shows every card of the page. */
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  return { app, page, errors };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value));
const secrets = async (page) => {
  await page.evaluate(() => globalThis.branchLayout.go("settings:secrets"));
  await page.locator("#secret-managers-grid .secret-manager").first().waitFor();
  await page.waitForTimeout(300);
};
/** The headings a person sees on the page, and its "N more" line. */
const seen = (page) => page.evaluate(() => {
  const shown = (node) => node.getClientRects().length > 0;
  const host = document.getElementById("lx-page-secrets");
  return {
    headings: [...host.querySelectorAll("h1, h2, h3, h4")].filter(shown).map((node) => `${node.tagName} ${node.textContent.trim()}`),
    more: [...host.querySelectorAll(".sg-more")].filter(shown).map((node) => node.textContent.trim()),
  };
});

/* The Keychain card shows only where the computer has a Keychain, so the answer is given here, both ways: the page's
   headings are the sample's with the card on show (as on a Mac) and without it, whatever computer runs the test. */
for (const available of [true, false]) {
  // Redesign: replaced by the new window (the prototype's Saved sign-ins has no Keychain card and no "N more" line;
  // its headings are checked above; the French half also waits on the Language select, Coming soon (sw:lang)).
  test.skip(`DG-189 the page shows the sample's headings at every width and level, and no card heading of its own (Keychain ${available ? "here" : "not here"})`, async (t) => {
    const { page, errors } = await settings(t, (page) => page.route("**/api/keychain/settings", (route) => route.fulfill({
      json: { enabled: false, mode: "off", entries: [], available, references: [] } })));
    const hiddenAtRegular = available ? "3 more with Advanced" : "1 more with Technical";
    for (const width of [1440, 860, 400]) {
      await page.setViewportSize({ width, height: 950 });
      for (const [one, more] of [["regular", [hiddenAtRegular]], ["advanced", null]]) {
        await level(page, one);
        await secrets(page);
        if (available && one === "advanced") assert.equal(await page.locator("#keychain-card").isVisible(), true, `${width} px: the Keychain card is on show`);
        // The Keychain card is placed and filled by its own script on its own schedule, and the "N more" line counts it
        // only once it is (measured with the CPU slowed, as on GitHub's Windows machines). Wait for the count to settle.
        for (let tries = 0; more && tries < 100 && JSON.stringify((await seen(page)).more) !== JSON.stringify(more); tries++)
          await page.waitForTimeout(100);
        const { headings, more: line } = await seen(page);
        assert.deepEqual(headings, ["H2 Secrets", "H3 Keys your commands use", "H3 Passwords and keys"], `${width} px, ${one}`);
        if (more) assert.deepEqual(line, more, `${width} px, ${one}: what is out of sight`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${width} px fits`);
      }
    }
    if (available) {
      /* The card's words are its switch's label, in English and in French. */
      assert.equal(await page.locator("#keychain-card").getAttribute("aria-labelledby"), "keychain-card-label");
      assert.equal(await page.locator("#keychain-card-mode").evaluate((node) => node.labels[0].textContent), "Passwords from your Mac's Keychain");
      await openPlace(page, "settings:appearance");
      await page.locator("#appearance-language").selectOption("fr");
      await page.waitForFunction(() => document.getElementById("keychain-card-label")?.textContent === "Mots de passe du trousseau de votre Mac");
    }
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (the prototype's status box took the password-manager tiles' place; what it
// may say is checked above; the French half also waits on the Language select, Coming soon (sw:lang)).
test.skip("DG-053 where Branch reads saved sign-ins from: truthful tiles that save as you go, and French", async (t) => {
  const { app, page, errors } = await settings(t);
  await level(page, "regular");
  await secrets(page);
  const tiles = page.locator("#secret-managers .secret-manager");
  const words = () => tiles.evaluateAll((all) => all.map((tile) => [tile.querySelector("b").textContent, tile.querySelector(".secret-manager-pill").textContent]));
  const keychain = process.platform === "darwin" ? "Available" : "Only on a Mac";
  assert.deepEqual(await words(), [["Your Mac's Keychain", keychain], ["Bitwarden", "Not set up"], ["1Password", "Not set up"]]);
  assert.equal(await page.locator("#secret-managers input").count(), 0, "nothing here could hold a password");

  await page.locator("#secret-managers-bitwarden").click();
  await page.locator("#secret-managers-status", { hasText: "Saved." }).waitFor();
  assert.deepEqual(await words(), [["Your Mac's Keychain", keychain], ["Bitwarden", "On"], ["1Password", "Not set up"]]);
  let saved = readCredentialSettings(app.store, app.runtime.owner);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.services, ["bitwarden"]);
  assert.equal(await page.locator("#secret-managers-bitwarden").getAttribute("title"), "Branch stops reading from it. Nothing in your password manager is changed.");

  await page.locator("#secret-managers-bitwarden").click();
  await page.waitForFunction(() => document.querySelector("#secret-managers-bitwarden")?.textContent === "Set up");
  saved = readCredentialSettings(app.store, app.runtime.owner);
  assert.equal(saved.enabled, false, "the last one off turns reading from a password manager off");
  assert.deepEqual(saved.services, []);

  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await secrets(page);
  await page.waitForFunction(() => document.querySelector("#secret-managers-title")?.textContent === "Où Branch lit les identifiants enregistrés");
  const { headings } = await seen(page);
  assert.deepEqual(headings.slice(1), ["H3 Les clés de vos commandes", "H3 Mots de passe et clés"]);
  assert.deepEqual(errors, []);
});

