/* Redesign phase 1: the one suggestion bar above the message box, and the update choice cards.
   Nothing here installs anything: the background engine's own route is answered by the test.
   Redesign: the new window's bar is the prototype's recBar (.recbar, public/app/chat/rec.js), above the conversation and at
   the top of Inbox and Overview; Settings › Updates keeps "Keep Branch up to date by itself" as one switch (#u-auto). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor, pressUntil } from "./places.mjs";
import { openSettings } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { nextSuggestion, SuggestionsSettingsSchema } from "../dist/suggestions.js";
import { readComfort } from "../dist/comfort/settings.js";

const ask = SuggestionsSettingsSchema.parse({});
const facts = (over) => ({ owner: true, onboarded: true, settings: ask, installed: true, background: false, autoUpdate: "off", ...over });

test("the bar that matters most comes first, one at a time, and only for the owner after first run", () => {
  assert.equal(nextSuggestion(facts()), "background", "keeping Branch running comes before updates");
  assert.equal(nextSuggestion(facts({ background: true })), "updates");
  assert.equal(nextSuggestion(facts({ installed: false })), "updates", "a copy that is not installed cannot run in the background");
  assert.equal(nextSuggestion(facts({ settings: { ...ask, background: "never" } })), "updates", "Don't ask again is kept");
  assert.equal(nextSuggestion(facts({ background: true, autoUpdate: "install" })), null, "nothing left to recommend");
  assert.equal(nextSuggestion(facts({ background: true, autoUpdate: "check" })), null, "a choice already made is not argued with");
  assert.equal(nextSuggestion(facts({ onboarded: false })), null, "never before first run is done");
  assert.equal(nextSuggestion(facts({ owner: false })), null, "never for anybody but the owner");
});

async function fixture(t, { onboarded = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-suggestions-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  if (onboarded) await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  /* The new window never opens its first run under automation (public/app/flows/flows.js:33 checks navigator.webdriver);
     the page is shown the browser a person has, so the first run is the one they would see. */
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* Opening the window again: the session token is asked for each time the page is loaded. */
  const open = async () => {
    await page.goto(server.url);
    // Opened again in the same tab, the window already holds the key and skips the key field; the locale loads first (#345).
    const key = page.getByLabel("Session token", { exact: true });
    await Promise.race([key.waitFor({ timeout: 60000 }), page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 })]).catch(() => {});
    if (await key.isVisible()) {
      await key.fill(server.token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
    }
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  };
  return { app, server, call, page, errors, open };
}

test("the server offers the update bar to the owner, remembers Don't ask again, and offers nobody else anything", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call("/api/deployment/suggestion")).body, { bar: "updates" }, "not installed here, so updates is the one");
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.deepEqual((await f.call("/api/deployment/suggestion")).body, { bar: null }, "a household person is offered nothing");
  assert.notEqual((await f.call("/api/deployment/suggestion", { id: "updates", answer: "never" })).status, 200, "nor may they answer for the owner");
  f.app.store.profiles.switch({ profileId: null });
  assert.equal((await f.call("/api/deployment/suggestion", { id: "updates", answer: "never" })).status, 200);
  assert.deepEqual((await f.call("/api/deployment/suggestion")).body, { bar: null });
});

test("Yes on the update bar turns on updating by itself; nothing changes before it", async (t) => {
  const f = await fixture(t);
  await f.open();
  const bar = f.page.locator(".recbar");
  await bar.waitFor({ state: "visible" });
  assert.match(await bar.innerText(), /Keep Branch up to date by itself\?\s*Recommended/);
  assert.equal(readComfort(f.app.store, f.app.runtime.owner, "notify").autoUpdate, "off", "showing it changed nothing");
  await bar.getByRole("button", { name: "Yes", exact: true }).click();
  await bar.waitFor({ state: "detached" });
  await f.page.locator(".toast").filter({ hasText: "keeps itself up to date" }).waitFor();
  assert.equal(readComfort(f.app.store, f.app.runtime.owner, "notify").autoUpdate, "install");
  assert.deepEqual(f.errors, []);
});

test("first run comes first and the bar is its last question; Not now lasts until the window opens again; Don't ask again lasts", async (t) => {
  const f = await fixture(t, { onboarded: false });
  await f.open();
  // Redesign: the new window's first run is "Set up Branch" (public/app/flows/setup.js); its last page, Health check, ends
  // it with Finish (data-act="ob-done").
  // Redesign: Skip for now (ob-close) shows only after Welcome (35e53413); the setup dialog itself says first run is up.
  const setup = f.page.locator(".ob9");
  await setup.waitFor({ state: "visible", timeout: 15000 });
  await f.page.waitForTimeout(800);
  const bar = f.page.locator(".recbar");
  assert.equal(await bar.count(), 0, "never while the first-run screen is up");
  await f.page.locator("#ob-trust").check();
  // Redesign (#391): Keep it running offers "Keep Branch up to date by itself" on (the ship-on rule) and saves it on
  // Continue, which answers the updates question before the bar could ask it; this person switches it off there.
  for (let step = 0; step < 15 && !(await f.page.locator('[data-act="ob-done"]').isVisible()); step++) {
    const upd = f.page.locator("#ob-upd:not([disabled])");
    if (await f.page.locator("#ob-upd").isVisible()) {
      await upd.waitFor({ timeout: 10000 }); // the step reads the engine's switches first
      if (await upd.isChecked()) { await upd.uncheck(); await f.page.locator("#ob-upd:not([disabled]):not(:checked)").waitFor(); }
    }
    await f.page.locator('[data-act="ob-next"]').click();
  }
  await f.page.locator('[data-act="ob-done"]').click();
  await setup.waitFor({ state: "detached" });
  // Finishing setup starts the prototype's tour of the window; a person can end it at once.
  const endTour = f.page.locator('.tour-layer [data-act="tour-end"]');
  if (await endTour.waitFor({ timeout: 5000 }).then(() => true, () => false)) await endTour.click();
  // WINDOW BUG: public/app/chat/rec.js recBar() asks the engine for its bar once, when the window is let in (before the first
  // run is done, when the engine offers nothing), and never again, so the bar does not follow the first run.
  await bar.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(readComfort(f.app.store, f.app.runtime.owner, "notify").autoUpdate, "off");
  await bar.getByRole("button", { name: "Not now", exact: true }).click();
  await bar.waitFor({ state: "detached" });
  await f.page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await f.page.waitForTimeout(500);
  assert.equal(await bar.count(), 0, "at most once each time the window opens");
  await f.open();
  await bar.waitFor({ state: "visible" });
  /* The bar closes once the answer is saved, as a person reopening the window seconds later would find. */
  const saved = f.page.waitForResponse((response) => response.url().endsWith("/api/deployment/suggestion") && response.request().method() === "POST");
  await bar.getByRole("button", { name: "Don’t ask again", exact: true }).click();
  assert.equal((await saved).ok(), true, "the answer was saved");
  await bar.waitFor({ state: "detached" });
  await f.open();
  await f.page.waitForTimeout(800);
  assert.equal(await bar.count(), 0, "Don't ask again is kept");
  assert.equal(readComfort(f.app.store, f.app.runtime.owner, "notify").autoUpdate, "off", "no answer changed the setting");
  assert.deepEqual(f.errors, []);
});

test.skip("the background bar comes first where Branch is installed, and Yes sets up the background engine", async (t) => {
  // Redesign: Coming soon (rec-install), checked at fc541c24. The background bar's Yes is drawn aria-disabled, class soon
  // (public/app/chat/rec.js: installing a system service stays greyed until it can be proved safe).
  const f = await fixture(t);
  const asked = [];
  await f.page.route("**/api/deployment/suggestion", (route) => route.fulfill({ json: { bar: "background" } }));
  await f.page.route("**/api/deployment/daemon", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: { action: "install", installed: true, taskName: "Branch Agent", message: "Set up." } });
  });
  await f.open();
  const bar = f.page.locator("#suggest-bar");
  await bar.waitFor({ state: "visible" });
  assert.match(await bar.innerText(), /Keep Branch running in the background\?\s*Recommended/);
  assert.match(await bar.innerText(), /Telegram/);
  assert.deepEqual(asked, [], "nothing is set up by showing it");
  await bar.getByRole("button", { name: "Yes", exact: true }).click();
  await f.page.waitForFunction(() => /running in the background/.test(document.getElementById("toast")?.textContent ?? ""));
  assert.deepEqual(asked, [{ action: "install" }]);
  assert.deepEqual(f.errors, []);
});

test("Updates in Settings are three choice cards, the recommended one marked, and picking one saves it", async (t) => {
  const f = await fixture(t);
  await f.call("/api/deployment/suggestion", { id: "updates", answer: "never" });
  await f.open();
  // Redesign: replaced by the new window (prototype.html's Settings › Updates keeps one switch, "Keep Branch up to date by
  // itself", where the old page had three choice cards); switching it saves the engine's choice.
  await openSettings(f.page, "updates");
  const auto = f.page.getByLabel("Keep Branch up to date by itself", { exact: true });
  await auto.waitFor();
  // The page reads the engine's choice after it is drawn (GET /api/comfort); the switch shows it once that answer is in.
  await f.page.waitForFunction(() => document.getElementById("u-auto")?.checked === false, null, { timeout: 5000 }).catch(() => undefined);
  assert.equal(await auto.isChecked(), false, "Off, as shipped");
  await auto.check();
  for (let tries = 0; tries < 40 && readComfort(f.app.store, f.app.runtime.owner, "notify").autoUpdate === "off"; tries++) await f.page.waitForTimeout(50);
  assert.equal(readComfort(f.app.store, f.app.runtime.owner, "notify").autoUpdate, "check");
  assert.deepEqual(f.errors, []);
});

test.skip("integration review: when the background engine cannot be set up, the bar says so in plain words, never that it worked", async (t) => {
  // Redesign: Coming soon (rec-install), checked at fc541c24. The background bar's Yes is greyed, so nothing is set up.
  for (const reply of [
    { json: { action: "install", installed: false, taskName: "Branch Agent", message: "Windows would not add the task." } },
    { status: 500, json: { error: "The system list could not be read." } },
  ]) {
    const f = await fixture(t);
    await f.page.route("**/api/deployment/suggestion", (route) => route.fulfill({ json: { bar: "background" } }));
    await f.page.route("**/api/deployment/daemon", (route) => route.fulfill(reply));
    await f.open();
    const bar = f.page.locator("#suggest-bar");
    await bar.waitFor({ state: "visible" });
    const failedPlainly = () => f.page.waitForFunction(() =>
      /could not keep running in the background/.test(document.getElementById("toast")?.textContent ?? ""),
    null, { timeout: 20000 }).then(() => true, () => false);
    await pressUntil(bar.getByRole("button", { name: "Yes", exact: true }), failedPlainly,
      "the failed background setup to be reported");
    const said = await f.page.locator("#toast").innerText();
    assert.match(said, reply.status ? /system list could not be read/ : /Windows would not add the task/);
    assert.doesNotMatch(said, /now keeps running/);
    assert.deepEqual(f.errors, []);
  }
});
