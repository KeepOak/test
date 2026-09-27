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
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

/*
 * The new window's Settings › Permissions draws the prototype's "Without asking, Trunks may…" switches, one per kind
 * of thing a Trunk does, in place of the old per-kind dropdowns. A screen reader must still tell them apart: each is
 * named by its kind, and each name is different.
 */
test("every Without-asking switch is named by the kind of thing it lets through, and no two share a name", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "kinds" });
  await openSettingsPage(page, "permissions");
  const section = page.locator(".sec", { has: page.getByRole("heading", { name: "Without asking, Trunks may…", exact: true }) });
  const switches = section.locator("input.sw");
  await switches.first().waitFor({ state: "visible", timeout: 30000 });
  const kinds = await switches.evaluateAll((all) => all.map((input) => input.getAttribute("aria-label") ?? ""));
  assert.ok(kinds.length >= 3, `only ${kinds.length} kinds were drawn; the list moved or did not load`);
  assert.equal(kinds.filter(Boolean).length, kinds.length, "every switch has a name");
  assert.equal(new Set(kinds).size, kinds.length, "the kinds have different names");
  for (const kind of kinds) {
    assert.equal(await page.getByRole("checkbox", { name: kind, exact: true }).count(), 1, `no single switch is named "${kind}"`);
    const said = await section.locator(".ctl", { has: page.getByRole("checkbox", { name: kind, exact: true }) }).locator("small").textContent();
    assert.ok(said.trim().length > 0, `"${kind}" lost the sentence that says what it does`);
  }
  assert.deepEqual(errors, []);
});

/*
 * Settings › Permissions, "a kind of thing at a time" (public/misc.js): one dropdown per kind of tool.
 * They had no name, so a screen reader announced the same "combo box, Leave as it is" six times
 * with nothing to tell them apart. Each is now named by its kind, and still says what the choice does.
 */
// Redesign: replaced by the new window (the "Without asking, Trunks may…" switches, re-pointed above, took the per-kind
// dropdowns' place; the French half also waits on the Language select, Coming soon (sw:lang), checked at fc541c24).
test.skip("every kind-of-tool dropdown is named by its kind, and still says what the choice does", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-kinds-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettings(page, "permissions");
  const selects = page.locator("#approval-categories select");
  await selects.first().waitFor({ state: "visible", timeout: 30000 });

  const kinds = await page.locator("#approval-categories .card-list-item > strong").allTextContents();
  assert.ok(kinds.length >= 3, `only ${kinds.length} kinds were drawn; the list moved or did not load`);
  assert.equal(await selects.count(), kinds.length, "one dropdown per kind");
  assert.equal(new Set(kinds).size, kinds.length, "the kinds have different names");
  for (const kind of kinds) {
    const choice = page.getByRole("combobox", { name: kind, exact: true });
    assert.equal(await choice.count(), 1, `no dropdown is named "${kind}"`);
    const described = await choice.evaluate((select) => (select.getAttribute("aria-describedby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(" "));
    assert.match(described, /One choice for every tool of this kind/, `"${kind}" lost its description`);
  }

  /* In French the kinds, and so the dropdowns' names, are French, without reopening the page. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.getByRole("combobox", { name: "Consulter des informations", exact: true }).waitFor({ state: "attached", timeout: 10000 });
  const french = await page.locator("#approval-categories .card-list-item > strong").allTextContents();
  assert.equal(french.length, kinds.length);
  assert.deepEqual(french.filter((name) => kinds.includes(name)), [], "every kind is in French after the switch");
  /* The switch throws every dropdown away and makes new ones; each new one must be described again. */
  for (const kind of french) {
    const choice = page.getByRole("combobox", { name: kind, exact: true });
    const described = await choice.evaluate((select) => (select.getAttribute("aria-describedby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(" "));
    assert.ok(described.length > 0, `"${kind}" lost its description when the language changed`);
  }
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
});

/*
 * A change of language redraws this list (above), which throws away the very dropdown the keyboard is
 * on. Without putting it back, a keyboard or screen-reader user is dropped to the top of the page in
 * the middle of deciding a permission. restoreCategoryFocus in public/misc.js cannot do this on its
 * own: it holds the old node, and the redraw detaches it.
 */
// Redesign: Coming soon (sw:lang), checked at fc541c24.
test.skip("the keyboard stays on the same kind of tool when the language changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-kind-focus-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettings(page, "permissions");
  await page.locator("#approval-categories select").first().waitFor({ state: "visible", timeout: 30000 });

  const kind = await holdAKind(page);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.getByRole("combobox", { name: "Consulter des informations", exact: true }).waitFor({ state: "attached", timeout: 10000 });
  const after = await page.evaluate(() => {
    const node = document.activeElement;
    return { kind: node?.dataset?.kind ?? null, tag: node?.tagName ?? null };
  });
  assert.equal(after.kind, kind, `the keyboard was dropped to <${after.tag?.toLowerCase()}> instead of staying on "${kind}"`);

  /* And it is never taken from wherever the person actually is -- the language they just chose. */
  const elsewhere = await page.evaluate(() => {
    const node = [...document.querySelectorAll("#lx-settings-body button, #lx-settings-body input, #lx-settings-body select")]
      .find((one) => !one.closest("#approval-categories") && !one.disabled && one.offsetParent);
    if (!node) return null;
    node.focus();
    node.dataset.kindFocusProbe = "1";
    return node.tagName;
  });
  assert.ok(elsewhere, "no other control on this page to hold the focus");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.getByRole("combobox", { name: "Look things up", exact: true }).waitFor({ state: "attached", timeout: 10000 });
  const kept = await page.evaluate(() => document.activeElement?.dataset?.kindFocusProbe === "1");
  assert.ok(kept, "the language change stole the focus from a control outside the kinds list");
});

test("every kind of tool has its name and sentence in English as the server says them, and in real French", async () => {
  const { categoryLabels } = await import("../dist/tool-categories.js");
  const locales = join(import.meta.dirname, "..", "public", "locales");
  const en = JSON.parse(await readFile(join(locales, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(locales, "fr.json"), "utf8"));
  for (const [kind, words] of Object.entries(categoryLabels)) {
    for (const part of ["label", "description"]) {
      const key = `toolKinds.kind.${kind}.${part}`;
      assert.equal(en[key], words[part], `${key}: en.json should say what src/tool-categories.ts says`);
      assert.ok(fr[key] && fr[key] !== words[part], `${key} needs real French`);
    }
  }
});

/**
 * Puts the keyboard on a kind of tool and waits until it stays there.
 *
 * Settings is still settling for about a second after it opens (public/settings-grown.js grows and
 * moves cards, holdScroll's 1200ms), and a card that moves takes the focus with it on trunk today.
 * That is not this file's subject, so the test waits for the page to be still rather than racing it.
 */
async function holdAKind(page) {
  for (let tries = 0; tries < 40; tries++) {
    const kind = await page.evaluate(() => {
      const select = document.querySelectorAll("#approval-categories select")[1];
      select?.focus();
      return select?.dataset.kind ?? null;
    });
    await page.waitForTimeout(200);
    if (kind && await page.evaluate(() => document.activeElement?.dataset?.kind ?? null) === kind) return kind;
  }
  throw new Error("Settings never stopped moving long enough to hold the keyboard on a kind of tool");
}
