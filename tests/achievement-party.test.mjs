/* DG-077: a Gold achievement or better is the party card. It still sits over the conversation and never on the
   message box. Headless only.

   Redesign: the new window celebrates what the engine has earned and not yet celebrated (shell/celebrate.js, GET
   /api/delight/achievements "fresh"), 1:1 with prototype.html's `.ach-big`: a centred card near the top with the medal,
   the achievement's name, its line, the tier as a pill and "Nice" (the primary small button), with confetti behind.
   The old sample's copper "Gold achievement" eyebrow and its "Lovely" button (public/delight-achievements.js preview)
   are replaced by it, so the card is measured against the prototype's rule instead: 24px 28px padding, the name at
   18px, a small primary button. Each case earns a real achievement of the tier in the engine, switched on, before the
   window opens. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveDelightSettings } from "../dist/delight.js";
import { achievementCatalogue } from "../dist/achievements.js";
import { startServer } from "../dist/server.js";

// One real achievement of each tier, read from the engine's catalogue (tiers move as achievements are added).
const catalogue = achievementCatalogue();
const firstOf = (tier) => catalogue.find((a) => a.tier === tier);

async function fixture(t, width, tier, language) {
  const root = await mkdtemp(join(tmpdir(), "branch-achievement-party-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner, picked = firstOf(tier);
  saveDelightSettings(app.store, owner, { achievements: { on: true } });
  app.store.save("settings", owner, "delight-achievements", { got: { [picked.id]: "2026-09-25" }, fresh: [picked.id] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  if (language) await call("/api/look", { language }); // the engine's saved language, which the window follows
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  return { page, errors, picked, call };
}

/** The window looks for what the engine earned when it redraws (shell/celebrate.js check, at most every 10 s). The
    list's show/hide switch is pressed twice now and then, which redraws it and changes nothing, until the card shows. */
async function celebrated(page) {
  const card = page.locator(".ach-big .card");
  for (let i = 0; i < 40; i++) {
    if (await card.isVisible()) return;
    // Redesign: owner removed the toggle; the Places fold, pressed twice, redraws the same way and changes nothing
    await page.evaluate(() => { document.querySelector('[data-act="places14"]')?.click(); document.querySelector('[data-act="places14"]')?.click(); });
    await card.waitFor({ timeout: 1000 }).catch(() => undefined);
  }
  await card.waitFor({ timeout: 1000 });
}

const measure = (page) => page.evaluate(() => {
  const card = document.querySelector(".ach-big .card"), style = getComputedStyle(card), box = card.getBoundingClientRect();
  const button = card.querySelector("button"), b = getComputedStyle(button);
  const main = document.querySelector("#main").getBoundingClientRect(), form = document.getElementById("composer")?.getBoundingClientRect();
  return {
    padding: style.padding,
    name: { text: card.querySelector("b").textContent, size: getComputedStyle(card.querySelector("b")).fontSize },
    line: card.querySelector(":scope > span:not(.pill):not(.medal)").textContent,
    tier: card.querySelector(".pill").textContent,
    button: { words: button.textContent, primary: button.classList.contains("pri"), small: button.classList.contains("sm"), height: button.getBoundingClientRect().height, size: b.fontSize },
    overConversation: box.left >= main.left - 1 && box.right <= main.right + 1 && box.top >= main.top - 1,
    offMessageBox: !form || !form.height || box.bottom <= form.top || box.top >= form.bottom,
    inWindow: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
  };
});

for (const width of [1440, 400]) {
  test(`DG-077 at ${width} px a Gold achievement is the party card, over the conversation and off the message box`, async (t) => {
    const { page, errors, picked } = await fixture(t, width, "Gold");
    await celebrated(page);
    const seen = await measure(page);
    assert.equal(seen.padding, "24px 28px");
    assert.deepEqual(seen.name, { text: picked.name, size: "18px" });
    assert.equal(seen.line, picked.desc);
    assert.equal(seen.tier, "Gold");
    assert.equal(seen.button.words, "Nice");
    assert.deepEqual([seen.button.primary, seen.button.small], [true, true], "the prototype's small primary button");
    assert.deepEqual({ over: seen.overConversation, off: seen.offMessageBox, inside: seen.inWindow }, { over: true, off: true, inside: true });
    assert.equal(await page.locator(".ach-toast").count(), 0, "a Gold is not the small note");
    await page.getByRole("button", { name: "Nice", exact: true }).click();
    await page.locator(".ach-big").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  });
}

test("DG-077 the tier's words follow the language, and the highest tier is the same card", async (t) => {
  const { page, errors, picked, call } = await fixture(t, 1440, "SSS+", "fr");
  await celebrated(page);
  const seen = await measure(page);
  const french = (await call("/api/delight/achievements?lang=fr")).list.find((a) => a.id === picked.id);
  assert.equal(seen.name.text, french.name, "the engine's own French name");
  assert.equal(seen.line, french.desc);
  const words = await page.evaluate(async () => ({
    tier: (await import("/app/core/words.js")).say("SSS+"), nice: (await import("/i18n.js")).t("window.shell.celebrate.nice"),
  }));
  assert.equal(seen.tier, words.tier);
  assert.equal(seen.button.words, words.nice);
  assert.notEqual(seen.button.words, "Nice", "the button is in French");
  assert.deepEqual({ over: seen.overConversation, off: seen.offMessageBox, inside: seen.inWindow }, { over: true, off: true, inside: true });
  assert.deepEqual(errors, []);
});
