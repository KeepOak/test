/**
 * mac7/r17-g: the safety extras' cards, opened the way a person opens them, at 400 px wide, in a
 * headless browser against a scratch workspace. Every word has English and real French, and every
 * control has a name and a description.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isSoon, openSettingsPage, setLevel, settingsWindow } from "./settings-window.mjs";
import { openPlace } from "./new-window-places.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

// Redesign: public files deleted
test.skip("every word on the safety extras' cards has English and real French", async () => {
  const source = await readFile(new URL("safety-extras.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(safety\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 70);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/safety-extras.js" type="module"><\/script>/);
});

// Redesign: the old window's five safety cards (#safety-extras-card with its command check, the stop, codes, chain and
// add-on cards) left with that window. The prototype keeps the emergency stop in Settings › Permissions, "Locks and
// records" (Advanced; pressing it and letting it go stay greyed for review, public/app/settings/p17-permissions.js), and
// the record's check in Inbox › History ("Verify", POST /api/safety-extras/activity/verify). It has no command check,
// authenticator codes or add-on card, so none is drawn. What is left is checked the way a person meets it, at 400 px.
test("the emergency stop and the record's check sit in their homes, say what they do, stay safe, and nothing scrolls sideways", async (t) => {
  const { app, page, call, errors } = await settingsWindow(t, { name: "safety-ui", width: 400, height: 900,
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  const stopRow = () => page.locator(".set-col .ctl", { has: page.locator("b", { hasText: en["safety.stop.title"] }) }).first();

  await openSettingsPage(page, "permissions");
  await setLevel(page, "advanced");
  await stopRow().waitFor();
  const idle = stopRow().locator('[data-act="estopb17"]');
  assert.equal(await idle.innerText(), en["window.settings.p17-permissions.stop-everything"]);
  assert.ok((await stopRow().locator("small").innerText()).trim().length > 0, "the stop says what it does");
  assert.equal(await isSoon(idle), true, "pressing the stop from the window stays greyed for review");
  await idle.evaluate((button) => button.click());
  assert.equal((await call("/api/safety-extras")).stop.engaged, false, "a greyed press changes nothing");
  assert.equal(await wide(), false, "no sideways scrolling in Permissions");

  // Pressed elsewhere (the engine's own route), the window says so, and letting it go is never a press away here.
  await call("/api/safety-extras/stop", { tools: ["shell.execute"] });
  await openSettingsPage(page, "general");
  await openSettingsPage(page, "permissions");
  const release = stopRow().locator('[data-act="estoprelb17"]');
  await release.waitFor();
  assert.equal(await isSoon(release), true, "letting the stop go stays greyed: it loosens");
  await release.evaluate((button) => button.click());
  assert.equal((await call("/api/safety-extras")).stop.engaged, true, "and a press there lets nothing go");

  // The record: Inbox › History's Verify walks the chain and shows what the engine found.
  await page.locator('.settings [data-act="chat"]:visible').first().click(); // Settings' own way back, as the prototype's on a phone
  await openPlace(page, "inbox", "history");
  await page.locator('#main .place [data-act="verify15"]').click();
  await page.locator(".dlg #ver-t15", { hasText: en["window.inbox.intact"] }).waitFor();
  assert.equal((await app.safetyExtras.chain.verify(app.runtime.owner)).ok, true, "the engine agrees the record is unbroken");
  await page.keyboard.press("Escape");
  assert.equal(await wide(), false, "no sideways scrolling in Inbox");

  // Switching the language re-words the stop's row.
  await page.evaluate(async () => { const i18n = await import("/i18n.js"); await i18n.setLanguage("fr"); });
  await openSettingsPage(page, "permissions");
  await page.locator(".set-col .ctl", { has: page.locator("b", { hasText: fr["safety.stop.title"] }) }).first().waitFor();
  assert.equal(await page.locator('.set-col [data-act="estoprelb17"]').innerText(), fr["window.settings.p17-permissions.let-them-resume"]);
  assert.equal(await wide(), false, "French still fits 400 px");
  assert.deepEqual(errors, []);
});
