/* wire-greyed: Settings › Advanced › Rewrite short notes was greyed ("the window has no note picker"); its Try it opens a
   dialog that picks one of the owner's notes and a style, shows the engine's suggestion, and keeps it over the note.
   Settings › Advanced › Web search was drawn greyed ("Branch takes the search service from its launch settings
   file"). It is live now: each service is a real choice the engine saves (POST /api/web-search), the row says what the
   pick needs (a key's secret name, or SearXNG's address), and the engine's own refusal is shown in its words.
   Mutation: in public/app/settings/pages/advanced.js drop the on("ad-search", …) handler, and the first case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const SUGGESTION = ["- the tower was measured", "- it is 41 m"].join("\n");
const quiet = { name: "scripted", async complete() { return { content: SUGGESTION, toolCalls: [] }; } };

async function advancedPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wire-advanced-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="advanced"]').click();
  // The page is shown once its reads are back (settings.js waitFirst), so its mark is waited for, not a fixed time.
  await page.locator('[data-act="setpage"][data-v="advanced"][aria-current="true"]').waitFor({ timeout: 20000 });
  await page.locator('[data-act="ad-search"]').first().waitFor({ timeout: 20000 });
  const read = (path = "web-search") => fetch(new URL(`/api/${path}`, server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());
  const post = (path, body) => fetch(new URL(`/api/${path}`, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  return { page, errors, read, post };
}

test("Web search is a live choice the engine keeps, and the row names the key it needs", async (t) => {
  const { page, errors, read } = await advancedPage(t);
  const brave = page.locator('[data-act="ad-search"][data-v="brave"]');
  assert.equal(await brave.getAttribute("aria-disabled"), null, "the Brave choice is not greyed");
  assert.equal(await page.locator('[data-act="ad-search"][data-v="duckduckgo"]').getAttribute("aria-pressed"), "true");
  await brave.click();
  await page.locator('[data-act="ad-search"][data-v="brave"][aria-pressed="true"]').waitFor();
  assert.equal((await read()).chosen.backend, "brave");
  const row = page.locator(".ctl", { has: brave });
  assert.match(await row.innerText(), /BRAVE_SEARCH_KEY/);
  assert.deepEqual(errors, []);
});

/* Drawn before its reads were back, Web search showed no choice pressed: on a slow runner the case above saw
   DuckDuckGo unpressed (stack-a, 2 of 3 runs on base). The engine's answer is held back here so the gap is always there. */
test("Advanced is shown with the engine's search choice pressed, even when its read is slow", async (t) => {
  const slow = (page) => page.route("**/api/web-search", async (route) => {
    if (route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const { page, errors } = await settingsWindow(t, { name: "wire-advanced-slow-read", route: slow });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const duck = page.locator('[data-act="ad-search"][data-v="duckduckgo"]');
  await duck.waitFor();
  assert.equal(await duck.getAttribute("aria-pressed"), "true", "the engine's choice is pressed when the page is first shown");
  assert.deepEqual(errors, []);
});

/* A live reload puts the open page back and draws it before any read (shell/liveupdate.js restoreOpen). Until the
   engine's choice is back, the choices wait and cannot be pressed; none is shown as the choice. */
test("Advanced drawn before its read shows the search choices waiting, then the engine's choice", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { page, errors } = await settingsWindow(t, { name: "wire-advanced-restore" });
  t.after(() => release());
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await page.route("**/api/web-search", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  await page.evaluate(() => sessionStorage.setItem("branch-live-restore",
    JSON.stringify({ view: "settings", setPage: "advanced", at: Date.now() })));
  await page.reload();
  const brave = page.locator('[data-act="ad-search"][data-v="brave"]');
  await brave.waitFor();
  assert.equal(await brave.isDisabled(), true, "waiting for the engine, a choice cannot be pressed");
  assert.equal(await brave.getAttribute("aria-busy"), "true");
  release();
  await page.locator('[data-act="ad-search"][data-v="duckduckgo"][aria-pressed="true"]:not([disabled])').waitFor();
  assert.equal(await brave.isDisabled(), false);
  assert.equal(await brave.getAttribute("aria-busy"), null);
  assert.deepEqual(errors, []);
});

test("SearXNG takes its address from the box, and without one the engine's refusal is shown", async (t) => {
  const { page, read } = await advancedPage(t);
  await page.locator('[data-act="ad-search"][data-v="searxng"]').click();
  await page.locator(".toast", { hasText: "address of your SearXNG" }).waitFor();
  assert.equal((await read()).chosen.backend, "duckduckgo", "nothing was saved");
  assert.equal(await page.locator("#ad-searx").isDisabled(), false);
  await page.locator("#ad-searx").fill("http://127.0.0.1:8888");
  await page.locator('[data-act="ad-search"][data-v="searxng"]').click();
  await page.locator('[data-act="ad-search"][data-v="searxng"][aria-pressed="true"]').waitFor();
  const saved = await read();
  assert.deepEqual([saved.chosen.backend, saved.chosen.searxngUrl], ["searxng", "http://127.0.0.1:8888"]);
});

test("Rewrite short notes picks a note, shows the suggestion and keeps it only when asked", async (t) => {
  const { page, errors, read, post } = await advancedPage(t);
  const { note } = await post("reach/notes", { title: "Survey", body: "the tower was measured again, it is 41 m tall" });
  const tryIt = page.locator('[data-act="ad-rewrite"]');
  assert.equal(await tryIt.getAttribute("aria-disabled"), null);
  await tryIt.click();
  await page.locator("#ad-rw-note").waitFor();
  await page.locator('[data-act="ad-rw-style"][data-v="list"]').click();
  await page.locator('[data-act="ad-rw-go"]').click();
  await page.locator(".dlg pre", { hasText: "it is 41 m" }).waitFor();
  assert.equal((await read("reach/notes")).notes[0].body, note.body, "a suggestion saves nothing");
  await page.locator('[data-act="ad-rw-keep"]').click();
  await page.waitForTimeout(800);
  assert.equal((await read("reach/notes")).notes[0].body, SUGGESTION);
  assert.deepEqual(errors, []);
});

test("Rewrite short notes opens nothing late: another dialog opened while the notes were read stays on screen", { timeout: 180000 }, async (t) => {
  let slow = false;
  const route = (page) => page.route("**/api/reach/notes", async (request) => {
    if (slow && request.request().method() === "GET") await new Promise((done) => setTimeout(done, 2500));
    await request.continue();
  });
  const { page, errors, call } = await settingsWindow(t, { route, name: "rewrite-late", provider: quiet });
  await call("/api/reach/notes", { title: "Survey", body: "the tower was measured again, it is 41 m tall" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  await openSettingsPage(page, "advanced");
  await page.locator('[data-act="ad-rewrite"]').waitFor();
  slow = true;
  const read = page.waitForResponse((response) => response.url().endsWith("/api/reach/notes"), { timeout: 15000 });
  await page.locator('[data-act="ad-rewrite"]').click();
  await page.locator('[data-act="ad-orders"]').first().click();
  await page.locator(".dlg").first().waitFor();
  const shown = await page.locator(".dlg h2").first().innerText();
  await read;
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#ad-rw-note").count(), 0, "the rewrite dialog did not open over the newer one");
  assert.equal(await page.locator(".dlg h2").first().innerText(), shown, "the dialog opened meanwhile is still the one shown");

  // Nothing open, then another dialog opened and closed while the notes were read: still nothing opens late.
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  const again = page.waitForResponse((response) => response.url().endsWith("/api/reach/notes"), { timeout: 15000 });
  await page.locator('[data-act="ad-rewrite"]').click();
  await page.locator('[data-act="ad-orders"]').first().click();
  await page.locator(".dlg").first().waitFor();
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  await again;
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".dlg").count(), 0, "opened and closed meanwhile: the rewrite dialog is not brought up late");

  // Closed while the kept version is being saved: the dialog is not opened again afterwards.
  slow = false;
  await page.locator('[data-act="ad-rewrite"]').click();
  await page.locator('.dlg [data-act="ad-rw-go"]').click();
  await page.locator('.dlg [data-act="ad-rw-keep"]').waitFor();
  let saving = false;
  await page.route("**/api/reach/notes", async (request) => {
    if (request.request().method() === "POST") { saving = true; await new Promise((done) => setTimeout(done, 2500)); }
    await request.continue();
  });
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/reach/notes") && response.request().method() === "POST", { timeout: 15000 });
  await page.locator('.dlg [data-act="ad-rw-keep"]').click();
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  await saved;
  await page.waitForTimeout(800);
  assert.equal(saving, true);
  assert.equal(await page.locator(".dlg").count(), 0, "closed during the save: not reopened");
  assert.deepEqual(errors, []);
});
