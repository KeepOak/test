/**
 * DG-194: Settings › Chat apps & devices has the approved sample's sections, in its order, with its "N more with …"
 * counts, with Show everything off and on, at 1440, 860 and 400 px, and in French. The setting cards live on this page
 * (the chat apps' own list stays in Customize › Chat apps), each card's title sits under its section's heading
 * (DG-008), and how chat apps are set up is kept the moment it changes, with no Save button (DG-025).
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

/** The sample's sections at Regular (Show everything off). Under the hood is not there at all. */
const REGULAR = ["Talk to Branch from your phone and chat apps", "42 more with Advanced", "Email and other pages", "8 more with Advanced",
  "While it works in a chat", "9 more with Advanced"];
const CARDS = {
  "channels:talk": ["telegram-setup-card", "channel-setup-card", "channels-more-form", "devices-card"],
  "channels:email": ["embeds-card", "personal-mail-card", "dashboard-card"],
  "channels:while": ["chat-live-form", "chat-permissions-form", "personal-files-card", "reach-chats-card"],
  "channels:under": ["reach-relay-card"],
};

const shown = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-channels :is(.sg-head-title, .sg-more)")]
  .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
  .map((node) => node.textContent.trim()));

// Redesign: replaced by the new window (the prototype's Settings has no "Chat apps & devices" page: chat apps are set up
// from Customize and the flows, and their switches are rows on Settings › Gateway, Coming soon (sw:f15-*), checked at fc541c24).
test.skip("Chat apps & devices: the sample's sections and counts, at every width, both levels and in French", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-channels-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.evaluate(() => globalThis.branchLayout.go("settings:channels"));
  await page.locator("#lx-page-channels #channel-setup-card #channel-core-switches").waitFor({ state: "attached", timeout: 20000 });
  for (const id of Object.values(CARDS).flat()) await page.locator(`#lx-page-channels > #${id}`).waitFor({ state: "attached", timeout: 20000 });

  const settle = async (want) => {
    await page.waitForFunction((list) => JSON.stringify([...document.querySelectorAll("#lx-page-channels :is(.sg-head-title, .sg-more)")]
      .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
      .map((node) => node.textContent.trim())) === JSON.stringify(list), want, { timeout: 15000 }).catch(() => undefined);
    return shown(page);
  };

  /* Every card is in its section, in the sample's order; nothing lands in "More on this page". */
  for (const [bucket, ids] of Object.entries(CARDS))
    for (const id of ids) assert.equal(await page.locator(`#${id}`).getAttribute("data-sg-bucket"), bucket, `${id} is in ${bucket}`);
  assert.equal(await page.locator("#lx-page-channels .sg-other:not(.sg-empty)").count(), 0, "no card without a section");
  assert.equal(await page.locator("#lx-page-channels .settings-directory-card").count(), 0, "no directory card: the settings are here");
  assert.equal(await page.locator("#lx-slot-customize-channels > #channels-card").count(), 1, "the chat apps' own list stays in Customize");

  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
    assert.deepEqual(await settle(REGULAR), REGULAR, `Show everything off at ${width} px`);
    await page.evaluate(() => globalThis.branchSettingsLevel.set("advanced"));
    const advanced = await shown(page);
    assert.deepEqual(advanced.filter((line) => !/more with/.test(line)),
      ["Talk to Branch from your phone and chat apps", "Email and other pages", "While it works in a chat"], `Show everything on at ${width} px`);
    assert.ok(advanced.every((line) => !/with Advanced/.test(line)), "at Advanced only Technical rows are left");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false,
      `nothing scrolls sideways at ${width} px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  const TECHNICAL = ["Talk to Branch from your phone and chat apps", "Email and other pages", "While it works in a chat", "Under the hood"];
  assert.deepEqual(await settle(TECHNICAL),
    TECHNICAL, "Under the hood is last, at Technical, and nothing is left out of sight");

  /* DG-008: a card's title is a settings card title, never the page-level h2 it was. */
  const levels = await page.evaluate(() => {
    const card = document.getElementById("channel-setup-card");
    return { section: document.getElementById("sg-bucket-channels-talk").tagName, card: card.querySelector(".settings-card-title")?.tagName };
  });
  assert.deepEqual(levels, { section: "H3", card: "H3" });

  /* DG-025: how chat apps are set up is kept as it changes, with no Save button. */
  assert.equal(await page.locator("#channel-setup-card button", { hasText: /^Save this setting$/ }).count(), 0, "no Save button");
  const mode = () => fetch(new URL("/api/channel-setup", server.url), { headers: { authorization: `Bearer ${server.token}` } })
    .then((response) => response.json()).then((answer) => answer.mode);
  await page.locator("#channel-setup-mode").selectOption("when-needed");
  for (let i = 0; i < 100 && (await mode()) !== "when-needed"; i++) await page.waitForTimeout(50);
  assert.equal(await mode(), "when-needed", "the choice is saved when it changes");

  /* The row for each chat app's switch goes to the chat apps' own list. */
  await page.locator("#channel-core-switches").click();
  await page.locator("#lx-slot-customize-channels > #channels-card").waitFor({ state: "visible", timeout: 15000 });

  /* In French. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.evaluate(() => { globalThis.branchSettingsLevel.set("regular"); globalThis.branchLayout.go("settings:channels"); });
  const french = ["Parler à Branch depuis votre téléphone et vos applications de discussion", "Pendant qu'il travaille dans une discussion"];
  await page.waitForFunction((words) => words.every((word) => [...document.querySelectorAll("#lx-page-channels .sg-head-title")]
    .some((node) => node.textContent === word)), french, { timeout: 15000 });
  assert.equal(await page.locator("#channel-core-switches").textContent(), "Ouvrir les applications de discussion");
  assert.deepEqual(errors, []);
});
