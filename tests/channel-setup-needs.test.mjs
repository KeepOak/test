/**
 * QA retest 2026-09-28: Customize › Channels promised "Two minutes to set up" on every popular chat app, Signal included
 * (a separate program you install and link to your phone) and WhatsApp (a Meta developer app); first run said "About two
 * minutes". Each popular card now says what that app really needs, in every language the window speaks, and no card
 * promises a time. Node only: the real dist/ and public/, headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { recipes } from "../dist/channel-setup/recipes.js";
import { signIn, openPlace } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";

const locale = async (lang) => JSON.parse(await readFile(new URL(`../public/locales/${lang}.json`, import.meta.url), "utf8"));

test("every popular chat app says what it needs, in every language, and none promises a time", async () => {
  const en = await locale("en");
  const popular = recipes().filter((recipe) => recipe.family === "core").map((recipe) => recipe.id);
  assert.ok(popular.includes("signal") && popular.includes("whatsapp"));
  for (const lang of ["fr", "de", "es"]) {
    const other = await locale(lang);
    for (const id of popular) {
      const key = `window.channels.needs.${id}`;
      assert.ok(en[key] && other[key] && other[key] !== en[key], `${lang} ${key}`);
    }
  }
  for (const id of popular) assert.doesNotMatch(en[`window.channels.needs.${id}`], /minute|quick|second/i, id);
  assert.match(en["window.channels.needs.signal"], /signal-cli/);
});

test("Customize › Channels shows each card's own needs, and no card says two minutes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-channel-needs-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: '{"done":true}' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, server);
  await openPlace(page, "customize", "channels");
  const signal = page.locator('#main [data-act="ch-open"][data-v="signal"] small');
  await signal.waitFor({ timeout: 30000 });
  assert.equal(await signal.innerText(), "signal-cli, which you install, linked to your phone");
  assert.equal(await page.locator('#main [data-act="ch-open"][data-v="whatsapp"] small').innerText(), "A WhatsApp Business number and a Meta developer app");
  assert.doesNotMatch(await page.locator("#main .ch-grid12").innerText(), /two minutes/i);
  assert.deepEqual(errors, []);
});
