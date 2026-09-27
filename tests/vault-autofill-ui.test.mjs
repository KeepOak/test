/**
 * mac7/vault-autofill (R17-068): the "Filling a saved sign-in" card, reached the way a person
 * reaches it — the gear, then Secrets. It starts off, writes down a sign-in without any password
 * going near it, fits a 400-pixel window and reads in French. Headless browser only; no window
 * opens, and no password manager is ever asked anything, because nothing here fills a page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readVaultAutofillSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettings } from "./places.mjs";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

async function fixture(t, viewport) {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-autofill-ui-"));
  const provider = { name: "vault-autofill-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

const settings = (app) => readVaultAutofillSettings(app.store, app.runtime.owner);

/* The new window: Settings › Saved sign-ins lists what Branch may fill ("Branch may fill"), each with its website and
   the password masked, and draws nothing a password could be typed into. The list is the engine's
   (GET /api/vault-autofill/settings); the prototype has no form to write one down, so the sign-in is kept first. */
test("Saved sign-ins starts empty on a fresh install, lists a sign-in the engine keeps, and could never hold a password", async (t) => {
  const { app, page, errors, call } = await settingsWindow(t, { name: "vault-autofill-ui" });
  assert.equal(settings(app).mode, "off", "a fresh install fills nothing");
  assert.deepEqual(settings(app).logins, []);
  await openSettingsPage(page, "secrets");
  const col = page.locator(".set-col");
  await col.getByRole("heading", { name: "Branch may fill", exact: true }).waitFor();
  // The prototype has no empty-state words here (the lead, 2026-09-26): an empty list simply draws no masked sign-in.
  assert.equal(await col.locator(".prow .meta", { hasText: "••••••••" }).count(), 0, "no sign-in is listed on a fresh install");

  await call("/api/vault-autofill/settings", { mode: "when-needed", logins: [{ name: "shop", site: "example.com", service: "bitwarden", item: "My Shop" }] });
  assert.deepEqual(settings(app).logins.map((login) => login.name), ["shop"], "the engine kept the sign-in");
  await openSettingsPage(page, "general");
  await openSettingsPage(page, "secrets");
  const row = col.locator(".prow", { hasText: "shop" });
  await row.waitFor({ timeout: 10000 });
  assert.match(await row.innerText(), /example\.com/, "the sign-in's website is shown");
  assert.equal(await row.locator(".meta").textContent(), "••••••••", "the password is only ever masked");
  assert.equal(await col.locator('input[type="password"], textarea').count(), 0, "nothing here is a box a password could be typed into");
  assert.deepEqual(errors, []);
});

test("Saved sign-ins fits a 400-pixel window", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "vault-autofill-ui", width: 400, height: 900 });
  await openSettingsPage(page, "secrets");
  await page.locator(".set-col").getByRole("heading", { name: "Branch may fill", exact: true }).waitFor();
  const box = await page.locator(".set-col").boundingBox();
  assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 400, "the page fits inside 400 px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang), checked at fc541c24. The 400-pixel half is re-pointed above.
test.skip("the card fits a 400-pixel window and reads in French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  await openSettings(page, "secrets");
  const card = page.locator("#vault-autofill");
  await card.waitFor({ state: "visible" });
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#vault-autofill")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the vault-autofill card fits inside 400 px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#vault-autofill :is(p, label, button, span, h2, h3)")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t
      && node.id !== "vault-autofill-status" && !node.closest(".card-list-row")
      // DG-073: Settings' own "N more" line for the section may sit at the end of this card; it is counted words, said by settings-grown.js.
      && !node.closest(".sg-more-line"))
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, [], "every word on the card has a key");

  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettings(page, "secrets");
  await page.waitForFunction(() =>
    document.querySelector("label[for=vault-autofill-site]")?.textContent === "Le site auquel il appartient");
  // DG-189: the card has no heading of its own; its switch's label names it, as in the sample.
  assert.match(await card.locator("#vault-autofill-mode-label").innerText(), /identifiant enregistré/);
  assert.deepEqual(errors, []);
});
