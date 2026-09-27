/* DG-055 (part of DG-190): "Saving progress before an allowance runs out" is the approved sample's own section on
   Data & usage (design/Branch-Grown-Up.html), right after what each connection has left, at the default level,
   not a line inside that card. Its switch still saves the question at 95% and comes back after a reload; the ring
   under the message box stays with the allowances. At 1440 and 400, with Show everything off and on. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function dataPage(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-save-progress-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((response) => response.json());
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
  errors.length = 0; // what failed before the key was given is the login page's business
  const open = async () => {
    await page.locator("body.sg-ready").waitFor();
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.locator("#settings-window").waitFor({ state: "visible" });
    /* As a link to the page reaches it: on a phone the page list is a strip, and this base may still draw it otherwise. */
    await page.evaluate(() => globalThis.branchLayout.go("settings:data"));
    await page.locator("#usage-save-card #glance-save-progress").waitFor({ state: "attached" });
  };
  await open();
  return { page, errors, call, open };
}
const everything = (page, on) => page.evaluate(async (value) => {
  const { applyAppearance, currentAppearance } = await import("/appearance.js");
  applyAppearance({ ...currentAppearance(), showEverything: value });
}, on).then(() => page.waitForFunction((value) => document.documentElement.dataset.everything === (value ? "on" : "off"), on));

/** The section heads on show, in order, by their words. */
const heads = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-data .sg-head")].filter((head) => head.checkVisibility())
  .map((head) => head.querySelector("h3")?.textContent.trim()));

/* ---------- the new window (public/app/**) ---------- */
async function openData(page) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="usage"]').click();
  await page.getByRole("heading", { name: "Data & usage", exact: true }).waitFor();
}
async function newDataPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-save-progress-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openData(page);
  return { page, errors, call };
}

// Redesign: replaced by the new window (the old sample's sections and Show everything; the prototype keeps the switch inside
// "What each connection has left" on Settings › Data & usage, checked below).
for (const width of [1440, 400]) for (const on of [false, true]) {
  test.skip(`DG-055 at ${width} px with Show everything ${on ? "on" : "off"}, saving progress is its own section after the allowances`, async (t) => {
    const { page, errors } = await dataPage(t, width);
    await everything(page, on);
    await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
    await page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "regular");
    const seen = await heads(page);
    const at = seen.indexOf("Saving progress before an allowance runs out");
    assert.equal(seen[at - 1], "What each connection has left", JSON.stringify(seen));
    assert.equal(await page.locator("#glance-save-progress").isVisible(), true, "its switch shows at the default level");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "nothing scrolls sideways");
    assert.deepEqual(errors, []);
  });
}

/* Redesign: the prototype's Settings › Data & usage keeps "Offer to save progress at 95%" (#u-ckpt) under "What each
   connection has left" (design/redesign/prototype.html, the usage page).
   WINDOW BUG: public/app/settings/pages/usage.js:96 draws that section as a heading only (LIMITS_EMPTY): no rows, no ring
   switch and no save-progress switch, live or greyed. */
test("DG-055 the switch still saves the question at 95%, and it comes back after a reload", async (t) => {
  const { page, errors, call } = await newDataPage(t);
  const before = (await call("/api/usage/glance/settings")).settings.saveProgress;
  const box = page.getByRole("checkbox", { name: "Offer to save progress at 95%", exact: true });
  await box.waitFor({ state: "visible", timeout: 10000 });
  assert.notEqual(await box.getAttribute("aria-disabled"), "true", "the switch is live");
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/usage/glance/settings");
  await box.click();
  assert.equal((await saved).ok(), true);
  const after = (await call("/api/usage/glance/settings")).settings.saveProgress;
  assert.notEqual(after, before);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openData(page);
  assert.equal(await page.getByRole("checkbox", { name: "Offer to save progress at 95%", exact: true }).isChecked(), after === "ask");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("DG-055 the section's heading is French in French", async (t) => {
  const { page, errors } = await dataPage(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const word = await page.evaluate(async () => (await import("/i18n.js")).t("settingsGrown.bucket.data.save"));
  assert.notEqual(word, "Saving progress before an allowance runs out");
  await page.waitForFunction((one) => document.querySelector('.sg-head[data-bucket="data:save"] h3')?.textContent.trim() === one, word);
  assert.deepEqual(errors, []);
});
