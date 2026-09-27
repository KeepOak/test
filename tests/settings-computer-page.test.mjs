/**
 * DG-188, DG-051: Settings › Computer & browser has the approved sample's sections, in its order, with its
 * "N more with …" counts, with Show everything off and on, at 1440, 860 and 400 px. The first section lists the paired
 * devices from the same state the Devices card draws, in English and French. Proxy and trusted certificates stays
 * on the page, in Under the hood, never dropped into "More on this page".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** The sample's sections at Regular (Show everything off), and at Advanced (Show everything on). */
const REGULAR = ["Paired devices", "Your screen, keyboard and apps", "5 more with Advanced", "Running commands safely", "8 more with Advanced",
  "The browser", "4 more with Advanced", "Your other computers", "3 more with Advanced"];
const ADVANCED = ["Paired devices", "Your screen, keyboard and apps", "Running commands safely", "5 more with Technical",
  "The browser", "Your other computers", "1 more with Technical"];

/** The section headings and "N more" lines on show, in page order. */
const sections = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-computer :is(.sg-head-title, .sg-more)")]
  .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
  .map((node) => node.textContent.trim()));

/* The new window: Settings › Computer & browser is the prototype's page. Its sections at Regular and Advanced, at 1440,
   860 and 400 px, fitting the window; at Technical nothing is drawn twice; and "Computers they may use" lists the
   computers the owner paired, from the engine (GET /api/devices), not only this one. */
const pageHeads = (page) => page.locator(".set-col").locator("h1, h2, h3, h4").evaluateAll((all) =>
  all.filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
// The prototype (pass 17) adds "Phones lent to Branch" to the page itself, so it shows at every level.
const REGULAR_NOW = ["Computer & browser", "Computers they may use", "Which Trunk uses which", "On a computer", "The browser", "Phones lent to Branch"];
// Pass 17 adds "Where scripts run, more" at Advanced (whereB17("computer", 1, ...)).
const ADVANCED_NOW = [...REGULAR_NOW, "The browser, more", "Code", "On a computer, more", "Where scripts run, more"];

test("Computer & browser has the prototype's sections at Regular and Advanced, at every width", async (t) => {
  const { settingsWindow, openSettingsPage, setLevel } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "settings-computer" });
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 1000 });
    await openSettingsPage(page, "computer");
    await setLevel(page, "regular");
    assert.deepEqual(await pageHeads(page), REGULAR_NOW, `Regular at ${width} px`);
    await setLevel(page, "advanced");
    assert.deepEqual(await pageHeads(page), ADVANCED_NOW, `Advanced at ${width} px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `nothing scrolls sideways at ${width} px`);
  }
  assert.deepEqual(errors, []);
});

test("Computer & browser at Technical draws each section once", async (t) => {
  const { settingsWindow, openSettingsPage, setLevel } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "settings-computer" });
  await openSettingsPage(page, "computer");
  await setLevel(page, "technical");
  const heads = await pageHeads(page);
  assert.deepEqual(heads.filter((words, at) => heads.indexOf(words) !== at), [], `drawn twice: ${heads.join(" · ")}`);
  assert.deepEqual(errors, []);
});

test("Computers they may use lists a computer the owner paired", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "settings-computer", before: (app) => {
    app.devices.book.setMode({ mode: "on" });
    const offer = app.devices.book.invite();
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const { requestId } = app.devices.book.redeem({ offer: offer.id, code: offer.code, name: "Studio Mac", platform: "darwin", publicKey, offers: ["screen"] });
    app.devices.book.decide(requestId, true);
  } });
  await openSettingsPage(page, "computer");
  const section = page.locator(".set-col .sec", { has: page.getByRole("heading", { name: "Computers they may use", exact: true }) });
  await section.waitFor();
  await section.getByText("Studio Mac").waitFor({ timeout: 10000 });
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's sections, re-pointed above; no "N more" lines, no Show everything,
// no proxy card); "Where scripts run" is Coming soon (seg), and French waits on sw:lang, checked at fc541c24.
test.skip("Computer & browser: the sample's sections, counts and paired devices, at every width and in French", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-computer-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });

  /* One paired device, through the same book the Devices card reads. */
  app.devices.book.setMode({ mode: "on" });
  const offer = app.devices.book.invite();
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const { requestId } = app.devices.book.redeem({ offer: offer.id, code: offer.code, name: "Studio Mac", platform: "darwin", publicKey, offers: ["screen"] });
  app.devices.book.decide(requestId, true);

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const open = async (name) => {
    if (!(await page.locator("#settings-window").isVisible())) {
      const cog = page.locator(".lx-foot-line > .sg-gear:visible");
      if (!(await cog.count())) await page.locator("#rail-toggle").click();
      await cog.click();
    }
    await page.locator(`.lx-settings-link[data-page="${name}"]`).click();
  };
  const settle = async (want) => {
    await page.waitForFunction((list) => JSON.stringify([...document.querySelectorAll("#lx-page-computer :is(.sg-head-title, .sg-more)")]
      .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
      .map((node) => node.textContent.trim())) === JSON.stringify(list), want, { timeout: 15000 }).catch(() => undefined);
    return sections(page);
  };
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  await open("computer");
  const card = page.locator("#paired-devices-card");
  await card.locator(".devices-paired-row").waitFor({ timeout: 15000 });
  assert.equal(await card.getAttribute("data-sg-bucket"), "computer:paired", "the paired devices are the first section");
  assert.match(await card.locator(".devices-paired-row").innerText(), /Studio Mac[\s\S]*Mac computer · Not connected yet[\s\S]*Remove/);
  assert.equal(await card.locator("h1, h2, h3, h4").count(), 0, "the section's heading names the card; a device's name is not a heading");
  assert.equal(await card.getByRole("button", { name: "Pair a device" }).isVisible(), true);
  assert.equal(await page.locator("#comfort-network-card").getAttribute("data-sg-bucket"), "computer:under", "the proxy card keeps its home");

  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
    assert.deepEqual(await settle(REGULAR), REGULAR, `Show everything off at ${width} px`);
    await page.evaluate(() => globalThis.branchSettingsLevel.set("advanced"));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.everything), "on");
    assert.deepEqual(await settle(ADVANCED), ADVANCED, `Show everything on at ${width} px`);
    assert.equal(await wide(), false, `nothing scrolls sideways at ${width} px`);
  }

  /* DG-024, DG-025: where scripts run is saved as you go, and a place a script can run is not a heading. */
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  const sandbox = page.locator("#sandbox-card");
  await sandbox.locator("#sandbox-backends .card-row").first().waitFor({ timeout: 15000 });
  assert.equal(await sandbox.locator("h3, h4").count(), 0, "no option is drawn as a heading");
  assert.equal(await page.locator("#lx-page-computer button", { hasText: /^Save (where scripts run|this limit)$/ }).count(), 0, "no Save button");
  const sandboxes = () => fetch(new URL("/api/sandboxes", server.url), { headers: { authorization: `Bearer ${server.token}` } })
    .then((response) => response.json()).then((answer) => answer.settings);
  await page.locator("#sandbox-distro").fill("Ubuntu");
  await page.locator("#sandbox-distro").press("Tab");
  for (let i = 0; i < 100 && (await sandboxes()).distro !== "Ubuntu"; i++) await page.waitForTimeout(50);
  assert.equal((await sandboxes()).distro, "Ubuntu", "leaving the box saves it");
  await page.locator("#sandbox-windows").check();
  for (let i = 0; i < 100 && !(await sandboxes()).windowsSandbox; i++) await page.waitForTimeout(50);
  assert.equal((await sandboxes()).windowsSandbox, true, "the switch saves when it flips");

  /* In French; and Remove here is the same Remove as on the Devices card. */
  await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await open("appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await open("computer");
  await page.waitForFunction(() => document.getElementById("sg-bucket-computer-paired")?.textContent === "Appareils associés", null, { timeout: 15000 });
  await card.getByText("Ordinateur Mac").waitFor({ timeout: 15000 });
  await card.getByRole("button", { name: "Retirer" }).click();
  await card.locator(".devices-paired .field-note").waitFor({ timeout: 15000 });
  assert.deepEqual(app.devices.book.devices(), [], "Remove here is the same Remove as on the Devices card");
  assert.deepEqual(errors, []);
});
