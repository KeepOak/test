/**
 * r17-b: the cards for suggestions, standing orders, loops, procedures, what waits, "from now on" and
 * readiness, opened the way a person opens them, at 400 px wide, in a headless browser against a
 * scratch workspace. Every word on them is behind a key with real French.
 *
 * Redesign: the old cards (public/autonomy.js) are replaced by prototype.html's Automations › Scheduled, which has
 * "Standing orders and loops" (each order kept or paused from the window) and, at Advanced, "Running on its own, more"
 * with "Ready to run alone?" (public/app/places/automations17.js). The prototype has no "Suggested automations" card
 * with blueprints, no switch card per part, no "from now on" question card in Inbox and no Customize home for
 * readiness, so those promises went with the old cards; the rest are kept on the new window below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newWindow, openPlace, openSettings } from "./new-window-places.mjs";
import { setLevel } from "./settings-window.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the automation cards has English and real French, and no colour is written down", async () => {
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  // The same words in both languages on purpose: "Hooks" is used in French too, and "version {version}".
  const cognates = new Set(["window.places.automations17.hooks", "window.places.automations.version-version"]);
  for (const file of ["automations17.js", "automations.js"]) {
    const source = await readFile(new URL(`app/places/${file}`, PUBLIC), "utf8");
    const keys = [...new Set([...source.matchAll(/\bt\("([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]))];
    assert.ok(keys.length > 40, `${file}: ${keys.length} keys`);
    assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !cognates.has(key))), [], file);
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, `${file}: no colour written down`);
  }
});

test("the cards sit in their homes, a standing order is paused from the window, and nothing scrolls sideways", async (t) => {
  let orderId = "";
  const { page, errors, call } = await newWindow(t, { width: 400, height: 900, seed: (branch) => {
    branch.autonomy.setMode("orders", { mode: "on" });
    branch.autonomy.setMode("readiness", { mode: "on" });
    orderId = branch.autonomy.orders.create({ name: "Tidy the inbox", authority: "Sort new mail into folders.", start: { kind: "manual" } }).id;
    // A skill that says what it needs, and has none of it here (tests/autonomy.test.mjs's readiness skill).
    branch.store.skills.install(branch.runtime.owner, { document: "---\nname: pr-helper\ndescription: Helps with pull requests.\nmetadata:\n"
      + "  requires-bins: branch-no-such-program\n  install-npm: no-such-program\n---\nUse gh to open pull requests.\n" });
  } });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  // Automations › Scheduled: the standing order is there, and pausing it from the window pauses it in the engine.
  const place = await openPlace(page, "automations", "scheduled");
  const orders = place.locator(".orders-b17");
  assert.equal(await orders.locator("h2").textContent(), "Standing orders and loops");
  await orders.locator(".prow", { hasText: "Tidy the inbox" }).waitFor({ timeout: 20000 });
  await orders.locator(`[data-act="orderb17"][data-id="${orderId}"][data-v="pause"]`).click();
  let status = "";
  for (let i = 0; i < 100 && status !== "paused"; i++) {
    status = (await call("/api/autonomy/orders")).orders.find((o) => o.id === orderId)?.status;
    if (status !== "paused") await page.waitForTimeout(50);
  }
  assert.equal(status, "paused", "the engine holds the order paused");
  await orders.locator(`[data-act="orderb17"][data-id="${orderId}"][data-v="resume"]`).waitFor({ timeout: 20000 });
  assert.equal(await wide(), false, "no sideways scrolling in Automations");

  // At Advanced: "Ready to run alone?" opens the engine's readiness list.
  await openSettings(page);
  await setLevel(page, "advanced");
  await page.locator(".set-nav .set-back").click(); // back to the conversation, where the side list opens as usual
  const again = await openPlace(page, "automations", "scheduled");
  const readiness = again.locator('[data-k="readiness"]');
  await readiness.click();
  const dialog = page.locator(".scrim .dlg, .dlg").filter({ hasText: "Ready to run alone?" }).first();
  await dialog.waitFor({ timeout: 20000 });
  const skills = (await call("/api/autonomy/readiness")).skills;
  assert.equal(skills.length, 1, "the engine checked the one skill");
  assert.equal(await dialog.locator(".demo-b17 .prow").count(), skills.length, "one row for each skill the engine checked");
  const row = await dialog.locator(".demo-b17 .prow").first().innerText();
  assert.match(row, /pr-helper/);
  assert.ok(row.includes(skills[0].missing[0].fix), `what is missing, in the engine's words: ${row}`);
  assert.equal(await wide(), false, "no sideways scrolling with the dialog open");
  assert.deepEqual(errors, []);
});
