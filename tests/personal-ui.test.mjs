/**
 * R17-C: the cards for files, voice, devices and personal connectors, opened the way a person opens
 * them, at 400 px wide, in a headless browser against a scratch workspace. Every word on them is
 * behind a key with real French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openSettingsPage, setLevel, settingsWindow } from "./settings-window.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

// Redesign: public files deleted
test.skip("every word on the personal cards has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("personal.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(personal\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 50);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/personal.js" type="module"><\/script>/);
});

// Redesign: the old window's personal cards (#personal-accounts-card with its Google sign-in, and the files, mail, tunnel,
// voice, X and home cards) left with that window. The prototype keeps two of the personal parts as switches on its
// Settings pages: "Send files into chats" in Settings › Gateway and "Smart home" in Settings › Advanced (pass 17's "What
// it can do"); it has no "Your own accounts" card, so no Google sign-in is drawn. Those two are what a person can reach.
test("the personal switches sit in their homes, work from the window, and nothing scrolls sideways", async (t) => {
  const { app, page } = await settingsWindow(t, { name: "personal-ui", width: 400, height: 900,
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  for (const [home, id, part] of [["gateway", "f15-send-files-into-chats", "chat-files"], ["advanced", "f15-smart-home", "home-control"]]) {
    await page.locator(`button.nav[data-act="setpage"][data-v="${home}"]`).click();
    const box = page.locator(`.set-col #${id}`);
    await box.waitFor({ state: "attached" });
    assert.equal(app.personal.modes()[part], "off", `${part} ships off`);
    assert.equal(await box.isChecked(), false, `${id} shows the engine's off`);
    await box.check();
    for (let i = 0; i < 100 && app.personal.modes()[part] !== "when-needed"; i++) await page.waitForTimeout(50);
    assert.equal(app.personal.modes()[part], "when-needed", `${id} turns ${part} on as "when needed"`);
    assert.equal(await wide(), false, `no sideways scrolling in Settings › ${home}`);
  }
});
