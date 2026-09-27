/* Redesign phase 1: every select opens a glass list, and owner-facing controls reuse their accessible
   descriptions as glass hover help. The native select stays the source of truth, so its label, value and
   change event are the ones everything else already uses. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, contextOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-glass-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  await fetch(new URL("/api/deployment/suggestion", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "updates", answer: "never" }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce", ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

/* The new window: the prototype's tips. An icon-only button explains itself on hover and on keyboard focus, in one tip
   of the window's own (never the system's title as well), gone on the next click; a button that says its own words
   needs none. */
test("an icon-only button explains itself in the window's tip on hover and on focus, once, and never with a system tip", async (t) => {
  const { settingsWindow } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "glass" });
  const gear = page.locator('[aria-label="Settings"][data-act="view"]');
  const tip = page.locator(".tipx");
  await gear.hover();
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), "Settings");
  assert.equal(await tip.count(), 1, "one tip");
  assert.equal(await gear.getAttribute("title"), null, "the system's tooltip is not shown as well");
  await page.mouse.move(700, 300);
  await page.mouse.down();
  await page.mouse.up();
  await tip.waitFor({ state: "detached" });
  await page.locator('.side-nav [data-act="view"][data-v="inbox"]').hover();
  await page.waitForTimeout(700);
  assert.equal(await tip.count(), 0, "a button that says its own words needs no tip");
  await gear.focus();
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), "Settings", "keyboard focus shows the same help");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no described-control glass help); its French half also waits on the Language
// select, Coming soon (sw:lang), checked at fc541c24.
test.skip("a described control reuses its live English and French help without changing its accessibility link", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  const control = f.page.locator("#policy-preset"), tip = f.page.locator("#glass-tip");
  const description = async () => control.evaluate((node) => (node.getAttribute("aria-describedby") || "")
    .split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" "));
  const linked = await control.getAttribute("aria-describedby");
  const english = await description();
  assert.ok(english, "the real setting has explanatory words");

  await control.hover();
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), english, "hover help reuses the accessible sentence");
  assert.equal(await control.getAttribute("aria-describedby"), linked, "the existing accessibility link is unchanged");

  await f.page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const french = await description();
  assert.ok(french && french !== english, "the source sentence changed with the language");
  assert.equal(await tip.innerText(), french, "open help refreshes as soon as its source language changes");
  await f.page.mouse.down();
  await f.page.mouse.up();
  await tip.waitFor({ state: "hidden" });
  await f.page.mouse.move(10, 10);
  await control.hover();
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), french, "the tooltip reads the current sentence instead of copying one");
  assert.equal(await control.getAttribute("aria-describedby"), linked);
  assert.deepEqual(f.errors, []);
});

// Redesign: Coming soon (sw:lang, the Language select it is about), checked at fc541c24; the prototype's tips close on a
// click, not Escape. Keyboard focus showing an icon button's tip is re-pointed above.
test.skip("keyboard focus shows the same help and Escape closes it", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#appearance-language");
  /* Focus help is synchronous. Read it and close it in the same browser turn so the Settings
     background refresh cannot replace the focused control between separate Playwright packets. */
  const state = await f.page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    const node = document.getElementById("appearance-language");
    const tip = document.getElementById("glass-tip");
    node.focus();
    const describedBy = node.getAttribute("aria-describedby") || "";
    const linkedWords = describedBy.split(/\s+/)
      .some((id) => document.getElementById(id)?.textContent?.trim());
    const beforeEscape = {
      focused: document.activeElement === node,
      described: Boolean(describedBy),
      linkedWords,
      visible: !tip.hidden,
      words: tip.textContent.trim(),
    };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { ...beforeEscape, hiddenAfterEscape: tip.hidden };
  });
  assert.equal(state.focused, true, "keyboard focus landed before the next background refresh");
  assert.equal(state.described, true, "the control has help to show");
  assert.equal(state.linkedWords, true, "the linked help has words");
  assert.match(state.words, /language of this window/i);
  assert.equal(state.visible, true, "keyboard focus shows its help immediately");
  assert.equal(state.hiddenAfterEscape, true, "Escape closes the help");
  assert.deepEqual(f.errors, []);
});

/* ---------------------------------------------------------------- integration review */

