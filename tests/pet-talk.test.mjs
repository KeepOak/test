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

test("news of the moment comes first, at every rank, in the order it matters, and never names a task", () => {
  assert.equal(say({ waiting: [{ runId: "r1" }], lockdown: true, running: [{ id: "r2" }] }).text, "A task is waiting for your answer. Review it in the Inbox.");
  assert.match(say({ connection: false, waiting: [{ runId: "r1" }] }).text, /^The connection to Branch is unavailable/, "an unreachable engine comes first");
  assert.match(say({ lockdown: true, running: [{ id: "r2" }] }).text, /^Lockdown is on/);
  assert.match(say({ noModel: true }).text, /^No model is connected yet/);
  assert.deepEqual(say({ noModel: true, owner: false }), petLine({ ...base, owner: false }, words), "a household person is not told to add a model");
  assert.match(say({ gateway: { running: true, problem: true } }).text, /^The Gateway reported a problem/);
  assert.deepEqual(say({ gateway: { running: true, problem: true }, owner: false }), petLine({ ...base, owner: false }, words), "nor about the Gateway");
  assert.match(say({ failed: "r3" }).text, /^The latest task in this conversation failed/);
  assert.equal(say({ running: [{ id: "r2" }] }).text, "A task is working.");
  assert.equal(say({ running: [{ id: "r2" }, { id: "r4" }] }).text, "2 tasks are working.");
  assert.notEqual(say({ running: [{ id: "r2" }] }).key, say({ running: [{ id: "r4" }] }).key, "other work is new news");
  for (const rank of ["Gold", "Diamond", "Godly"]) assert.equal(say({ rank, running: [{ id: "r2" }] }).kind, "news", `${rank} still hears the news`);
});

test("hints fit where the owner is, and name the owner's own keys", () => {
  const keys = { palette: "Ctrl K", sideList: "Ctrl B", focusPrompt: "Ctrl L" };
  assert.equal(say({ keys }).text, "Ctrl L focuses the conversation's message box.");
  assert.equal(say({ keys: { ...keys, focusPrompt: "Alt M" } }).text, "Alt M focuses the conversation's message box.", "a moved key is named as moved");
  assert.equal(say({ keys: { ...keys, focusPrompt: "" } }).text, "Ctrl B hides the list for more room.", "a key taken away is never named");
  assert.equal(say({ keys, view: "library" }).text, "Ctrl K opens search for conversations, documents and app actions.", "search is not promised to reach every setting");
  assert.equal(say({ view: "settings" }).text, "Search in Settings finds matching pages and settings.");
  assert.equal(say({ view: "inbox" }).text, "Review the exact request before answering in the Inbox.");
  assert.equal(say({ keys: {}, view: "library" }).text, "Hover anything to see what it does.");
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
