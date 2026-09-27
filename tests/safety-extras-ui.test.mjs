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

// Redesign: the old window's five safety cards (#safety-extras-card with its command check, the stop, codes, chain and
// add-on cards) left with that window. The prototype keeps the emergency stop in Settings › Permissions, "Locks and
// records" (Advanced; pressing it is live, and letting it go is live only while "every task" is the one level held,
// public/app/settings/p17-permissions.js), and
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
  // #416: stopping only makes things safer, so it is a press away, behind one confirmation.
  assert.equal(await isSoon(idle), false, "pressing the stop from the window is live");
  await idle.click();
  await page.locator('.dlg [data-act="estopgob17"]').click();
  await stopRow().locator('[data-act="estoprelb17"]').waitFor();
  assert.equal((await call("/api/safety-extras")).stop.everything, true, "the press stopped every task");
  assert.equal(await wide(), false, "no sideways scrolling in Permissions");

  // With only "every task" held, letting it go is live and lets go of that one level.
  const release = stopRow().locator('[data-act="estoprelb17"]');
  assert.equal(await isSoon(release), false, "letting go of only every task is live");
  await release.click();
  await stopRow().locator('[data-act="estopb17"]').waitFor();
  assert.equal((await call("/api/safety-extras")).stop.engaged, false, "tasks may resume");

  // Pressed elsewhere with another level too (a tool stop), letting go would let that go as well: it stays greyed here.
  await call("/api/safety-extras/stop", { everything: true, tools: ["shell.execute"] });
  await openSettingsPage(page, "general");
  await openSettingsPage(page, "permissions");
  const held = stopRow().locator('[data-act="estoprelb17-soon"]');
  await held.waitFor();
  assert.equal(await isSoon(held), true, "letting go of more than every task stays greyed: it loosens");
  await held.evaluate((button) => button.click());
  const after = (await call("/api/safety-extras")).stop;
  assert.equal(after.engaged, true, "and a press there lets nothing go");
  assert.deepEqual(after.tools, ["shell.execute"], "the tool stop is still held");

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
  assert.equal(await page.locator('.set-col [data-act="estoprelb17-soon"]').innerText(), fr["window.settings.p17-permissions.let-them-resume"]);
  assert.equal(await wide(), false, "French still fits 400 px");
  assert.deepEqual(errors, []);
});
