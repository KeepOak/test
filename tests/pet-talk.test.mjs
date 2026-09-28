/* OC-41 / OC-51 / UI-068 / UI-069: the pet's words come from what is happening, not two fixed lines, and its hints shrink
   with the owner's rank. public/app/shell/pettalk.js is pure, so its rules are checked here directly, and the window
   half (the pat says the moment's news; the label promises a tip only while hints come) in a headless window.
   Mutation: in pettalk.js HINTING add "Gold" and the Gold case goes red; drop the HINT_EVERY check and the "within the
   hour" case goes red; move the hint above the news and "news beats a hint" goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { petLine, hintDue, HINT_EVERY } from "../public/app/shell/pettalk.js";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage } from "./settings-window.mjs";

const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
const words = (key, values = {}) => {
  assert.ok(key in en, `the line ${key} is in the locale files`);
  return en[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
};
const at = Date.parse("2026-09-28T12:00:00Z");
const base = { waiting: [], lockdown: false, noModel: false, running: [], view: "chat", owner: true, keys: { palette: "Ctrl K", sideList: "Ctrl B" },
  rank: "Bronze", tipsOn: true, lastHint: 0, at };
const say = (change) => petLine({ ...base, ...change }, words);

test("news of the moment comes first, at every rank, in the order it matters", () => {
  assert.equal(say({ waiting: [{ who: "Ledger" }], lockdown: true, running: [{ who: "Scout" }] }).text, "Ledger needs a yes. It’s in your Inbox.");
  assert.match(say({ lockdown: true, running: [{ who: "Scout" }] }).text, /^Lockdown is on/);
  assert.match(say({ noModel: true }).text, /^No model is connected yet/);
  assert.deepEqual(say({ noModel: true, owner: false }), petLine({ ...base, owner: false }, words), "a household person is not told to add a model");
  assert.equal(say({ running: [{ who: "Scout" }] }).text, "Scout is working on it.");
  assert.equal(say({ running: [{ who: "Scout" }, { who: "Ledger" }] }).text, "2 tasks are working.");
  for (const rank of ["Gold", "Diamond", "Godly"]) assert.equal(say({ rank, running: [{ who: "Scout" }] }).kind, "news", `${rank} still hears the news`);
});

test("hints fit where the owner is, and name the owner's own keys", () => {
  assert.equal(say({}).text, "Ctrl K finds anything, even one switch in Settings.");
  assert.equal(say({ keys: { palette: "Alt P", sideList: "Ctrl B" } }).text, "Alt P finds anything, even one switch in Settings.", "a moved key is named as moved");
  assert.equal(say({ keys: { palette: "", sideList: "Ctrl B" } }).text, "Ctrl B hides the list for more room.", "a key taken away is never named");
  assert.equal(say({ view: "settings" }).text, "Search in Settings finds any switch, not just pages.");
  assert.equal(say({ view: "library" }).text, "Hover anything to see what it does.");
  assert.equal(say({}).kind, "hint");
});

test("hints shrink with rank: Bronze and Silver at most hourly, Gold and above never, none while tips are off", () => {
  for (const rank of ["Bronze", "Silver"]) {
    assert.equal(say({ rank }).kind, "hint", `${rank} gets a hint`);
    assert.equal(say({ rank, lastHint: at - HINT_EVERY + 60000 }), null, `${rank}: not again within the hour`);
    assert.equal(say({ rank, lastHint: at - HINT_EVERY }).kind, "hint", `${rank}: again after an hour`);
  }
  for (const rank of ["Gold", "Diamond", "Godly", "SSS+"]) assert.equal(say({ rank }), null, `${rank} gets no hints`);
  assert.equal(say({ tipsOn: false }), null, "Show tips and pop-ups off: no hints");
  assert.equal(hintDue({ rank: "Silver", tipsOn: true, lastHint: 0, at }), true);
});

test("in the window, a pat says the moment's news and the label promises a tip only while hints come", async (t) => {
  const f = await newWindow(t);
  await openSettingsPage(f.page, "appearance");
  await f.page.locator('[data-act="petset"][data-v="squirrel"]').first().click();
  await f.page.locator('[data-act="petset"][data-v="squirrel"][aria-pressed="true"]').first().waitFor();
  await f.page.locator(".set-back").click();
  const pet = f.page.locator("#side #pet-cv");
  await pet.waitFor({ timeout: 20000 });
  assert.match(await pet.getAttribute("aria-label"), /Click for a tip\.$/, "Bronze: a tip is on offer");
  // Lockdown really on in the engine, and the window showing it. (Adding the "locked" class by hand raced the window's own
  // Lockdown read, which puts the class back in step with the engine: seen on Linux CI as the Bronze tip instead.)
  assert.equal((await f.call("/api/lockdown", { on: true })).on, true);
  await f.page.locator("#app.locked").waitFor({ timeout: 15000 });
  await pet.click();
  await f.page.locator("#pet-say:not([hidden])").waitFor();
  assert.match(await f.page.locator("#pet-say").textContent(), /^Lockdown is on/);
  assert.equal((await f.call("/api/lockdown", { on: false })).on, false);
  await f.page.locator("#app:not(.locked)").waitFor({ timeout: 15000 });
  // Tips off: no tip is promised.
  await f.call("/api/onboarding", { popups: false });
  await f.page.reload();
  await pet.waitFor({ timeout: 20000 });
  assert.match(await pet.getAttribute("aria-label"), /Click to pat\.$/);
  assert.deepEqual(f.errors, []);
});
