/**
 * Dogfood B14: the Talk button beside the microphone read "voice.talkStart". public/voice-talk.js drew it before the
 * words had loaded and never again. This opens the whole window, with everything shown, and looks for any visible
 * word or label that is still a key of public/locales/en.json; then it switches the language and back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const keys = new Set(Object.keys(JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"))));

async function openApp(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-raw-keys-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [{ id: "main", name: "Main", provider, model: "gpt-6-sol" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return page;
}
/** Every visible word, and every placeholder, title and label, with where it is. */
const shownWords = (page) => page.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const text = walk.currentNode.textContent.trim(), el = walk.currentNode.parentElement;
    if (text && el && el.offsetParent !== null) out.push([text, `${el.tagName.toLowerCase()}#${el.id}`]);
  }
  for (const el of document.querySelectorAll("[placeholder],[title],[aria-label]"))
    for (const name of ["placeholder", "title", "aria-label"]) { const value = el.getAttribute(name)?.trim(); if (value) out.push([value, `${el.tagName.toLowerCase()}#${el.id}@${name}`]); }
  return out;
});

/* Redesign: the new window (public/app/**). Every view it draws is walked: the conversation, each place and each
   Settings page. */
test("B14 no visible word in the new window is a raw locale key, in the conversation, the places and Settings", async (t) => {
  const page = await openApp(t);
  const raw = [];
  const look = async (where) => {
    await page.waitForTimeout(300);
    for (const [text, el] of await shownWords(page)) if (keys.has(text)) raw.push(`${text} (${where}: ${el})`);
  };
  await look("conversation");
  for (const place of ["overview", "inbox", "automations", "library", "team", "customize"]) {
    await page.locator(`#side [data-act="view"][data-v="${place}"]`).click();
    for (const tab of await page.locator(`#main [data-act="ptab"][data-place="${place}"]`).evaluateAll((els) => els.map((el) => el.dataset.v))) {
      await page.locator(`#main [data-act="ptab"][data-place="${place}"][data-v="${tab}"]`).click();
      await look(`${place} › ${tab}`);
    }
  }
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  for (const level of ["regular", "technical"]) {
    await page.locator(`[data-act="setlevel"][data-v="${level}"]`).click();
    for (const name of await page.locator('.set-nav [data-act="setpage"]').evaluateAll((els) => els.map((el) => el.dataset.v))) {
      await page.locator(`.set-nav [data-act="setpage"][data-v="${name}"]`).click();
      await look(`settings › ${name} (${level})`);
    }
  }
  assert.deepEqual(raw, [], "every shown word is a word, not a key");
});

// Redesign: Coming soon (voice, and the Language select sw:lang in Settings › Appearance), checked at ef021c57.
test.skip("B14 no visible word in the window is a raw locale key, and the Talk button follows the language", async (t) => {
  const page = await openApp(t);
  const talk = page.locator("#voice-talk");
  await talk.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("voice-talk")?.textContent === "Talk", null, { timeout: 30000 });
  const raw = (await shownWords(page)).filter(([text]) => keys.has(text)).map(([text, where]) => `${text} (${where})`);
  assert.deepEqual(raw, [], "every shown word is a word, not a key");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await talk.textContent(), "Parler", "drawn again in the new language");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  assert.equal(await talk.textContent(), "Talk");
});

// Redesign: Coming soon (Settings › Voice: every control, and the Language select sw:lang), checked at ef021c57.
// NAS 703fb96: the line under Talk was English only, and the wake word's and dictation's status lines kept the old
// language after a switch. Each is written again in the new language, and nothing the owner typed is touched.
test.skip("B14 the voice status lines follow the language: under Talk, the wake word and dictation", async (t) => {
  const page = await openApp(t);
  await openPlace(page, "settings:voice");
  await page.locator("#wake-word-form").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("wake-word-listening")?.textContent.trim()
    && document.getElementById("dictation-open")?.textContent.trim(), null, { timeout: 30000 });
  const lines = () => page.evaluate(() => ["wake-word-listening", "dictation-open"].map((id) => document.getElementById(id).textContent));
  const english = await lines();
  await page.locator("#wake-word-word").fill("branchy");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await page.locator("#voice-talk-status").textContent(), "Maintenez le bouton Parler et parlez", "under Talk, in French");
  const french = await lines();
  french.forEach((line, index) => assert.ok(line.trim() && line !== english[index], `written again in French: ${line}`));
  assert.equal(await page.locator("#wake-word-word").inputValue(), "branchy", "what the owner typed is left alone");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  assert.equal(await page.locator("#voice-talk-status").textContent(), "Hold the Talk button and speak");
  assert.deepEqual(await lines(), english, "and back in English");
});
