/* The owner's live, interactive Branch browser in the window (public/app/chat/stage-browser-control.js), end to end: a
   real engine, Branch's real headless Chromium and a hidden headless window. The owner opens an address, clicks, types
   and scrolls in the page, opens, switches and closes tabs, goes Back, and a search that the browser's rules refuse is
   said in place. Then Take over on a working task's own window: the owner types into the page, the task's next step
   waits, and after Hand back the task carries on in the page as the owner left it. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { newWindow } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { savePolicy } from "../dist/policy.js";
import { saveComfort } from "../dist/comfort/settings.js";
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

assert.equal(typeof chromium.launch, "function");

const FIRST = `<!doctype html><meta charset="utf-8"><title>Fixture One</title><body style="margin:0">
  <label style="display:block;padding:20px">Name <input id="name" style="width:300px;height:40px;font-size:20px"></label>
  <button id="save" style="margin:20px;width:200px;height:50px" onclick="document.getElementById('out').textContent=document.getElementById('name').value">Save</button>
  <p id="out">Nothing saved</p><a href="/two">Two</a><div style="height:4000px"></div></body>`;
const SECOND = "<!doctype html><title>Fixture Two</title><h1>Two</h1>";

async function fixture(t, provider, pages = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-browser-window-"));
  const site = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    response.writeHead(200, { "content-type": "text/html" }).end(pages[path] ?? (path.startsWith("/two") ? SECOND : FIRST));
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const sid = app.store.createSession(app.runtime.owner);
  app.store.message(sid, { role: "user", content: "Browse for me" });
  app.store.message(sid, { role: "assistant", content: "Ready." });
  t.after(async () => { await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  const w = await newWindow(t, { app, root });
  await openChat(w.page, sid);
  await w.page.locator("#conversation .b").first().waitFor();
  /** The engine's own page behind the owner's active tab. */
  const enginePage = (index = 0) => {
    const control = browser.controls.forConversation(app.runtime.owner, sid);
    return control && browser.controlledPageTarget(control.binding, control.id, control.view().tabs[index])?.page;
  };
  const until = async (check, what) => {
    for (let i = 0; i < 200; i++) { try { if (await check()) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); }
    assert.fail(`timed out waiting for ${what}`);
  };
  return { ...w, app, browser, sid, origin, enginePage, until };
}

/** Where an element of the engine's page is drawn in the window: the frame is drawn whole, centred across, from the top. */
async function onFrame(w, selector) {
  // The view may be drawn again as control changes hands; measure a frame that is on screen now.
  let img = null;
  for (let i = 0; i < 50 && !img; i++) {
    await framed(w.page);
    img = await w.page.locator('#stage7 .owner-browser7-img[src^="data:image/jpeg"]:not([hidden])').boundingBox({ timeout: 1000 }).catch(() => null);
  }
  assert.ok(img, "the page's picture is on screen");
  const box = await w.enginePage().locator(selector).boundingBox(), size = w.enginePage().viewportSize();
  const scale = Math.min(img.width / size.width, img.height / size.height), left = img.x + (img.width - size.width * scale) / 2;
  return { x: left + (box.x + box.width / 2) * scale, y: img.y + (box.y + box.height / 2) * scale };
}
/* Click a box of the page and wait until the page's caret is in it, as a person would before typing: a click that
   landed while the view was being drawn again is made again. */
async function focusBox(w, selector, id) {
  for (let i = 0; i < 5; i++) {
    const at = await onFrame(w, selector);
    await w.page.mouse.click(at.x, at.y);
    for (let j = 0; j < 20; j++) {
      if (await w.enginePage().evaluate(() => document.activeElement?.id).catch(() => "") === id) return at;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.fail(`the page's ${id} box never got the caret`);
}
const framed = (page) => page.locator('#stage7 .owner-browser7-img[src^="data:image/jpeg"]:not([hidden])').waitFor({ timeout: 30000 });

test("the owner opens, clicks, types, scrolls, uses tabs and Back in Branch's browser, and a refused search is said in place", async (t) => {
  const w = await fixture(t, { name: "scripted", async complete() { return { content: "Unused", toolCalls: [] }; } });
  const { page } = w;
  await page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  const bar = page.locator("#stage7 #st-addr");
  await bar.fill(`${w.origin}/`);
  await bar.press("Enter");
  await framed(page);
  await page.locator("#stage7 .ob7-tabs").filter({ hasText: "Fixture One" }).waitFor();
  await page.locator("#stage7 .st7-top .pill").filter({ hasText: "You're driving" }).waitFor();
  assert.doesNotMatch(await page.locator("#stage7").innerText(), /Nothing open/);
  assert.equal(await page.locator('#stage7 [data-act="stage-take-browser"]').count(), 0, "no greyed Take over");

  const input = await focusBox(w, "#name", "name");
  await page.keyboard.type("héllo 世界");
  await w.until(async () => (await w.enginePage().inputValue("#name")) === "héllo 世界", "typed words in the page");
  const save = await onFrame(w, "#save");
  await page.mouse.click(save.x, save.y);
  await w.until(async () => (await w.enginePage().textContent("#out")) === "héllo 世界", "the click to reach the page's button");

  await page.mouse.move(input.x, input.y + 120);
  await page.mouse.wheel(0, 600);
  await w.until(async () => (await w.enginePage().evaluate(() => window.scrollY)) > 100, "the page to scroll");

  await page.locator('#stage7 [data-act="owner-browser-new-tab"]:not([disabled])').click();
  await w.until(async () => (await page.locator("#stage7 .ob7-tab").count()) === 2, "a second tab");
  await page.locator('#stage7 [data-act="owner-browser-tab"][data-index="0"]:not([disabled])').click();
  await page.locator('#stage7 [data-act="owner-browser-tab-close"][data-index="1"]:not([disabled])').click();
  await w.until(async () => (await page.locator("#stage7 .ob7-tab").count()) === 1, "the second tab to close");

  await bar.fill(`${w.origin}/two`);
  await bar.press("Enter");
  await page.locator("#stage7 .ob7-tabs").filter({ hasText: "Fixture Two" }).waitFor({ timeout: 30000 });
  await page.locator('#stage7 [data-act="owner-browser-back"]:not([disabled])').click();
  await page.locator("#stage7 .ob7-tabs").filter({ hasText: "Fixture One" }).waitFor({ timeout: 30000 });
  assert.equal(w.enginePage().url(), `${w.origin}/`);

  await bar.fill("branch browser search");
  await bar.press("Enter");
  await page.locator("#stage7 .ob7-status").filter({ hasText: /allowed origin/ }).waitFor({ timeout: 30000 });
  assert.equal(await bar.inputValue(), "branch browser search", "the refused words stay to be corrected");
  assert.deepEqual(w.errors, []);
});

test("Take over a working task's own window, type, and Hand back: the task carries on in the page as the owner left it", async (t) => {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const thinking = deferred(), gate = deferred();
  let rounds = 0, origin = "";
  const provider = { name: "scripted", async complete() {
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "open", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/` }) }] };
    if (rounds === 2) { thinking.resolve(); await gate.promise; return { content: "", toolCalls: [{ id: "save", name: "browser.click", arguments: JSON.stringify({ role: "button", name: "Save" }) }] }; }
    return { content: "Saved.", toolCalls: [] };
  } };
  t.after(() => gate.resolve()); // first, so a failed test never leaves its task waiting while the engine closes
  const w = await fixture(t, provider);
  origin = w.origin;
  const { page, app, sid } = w;
  const pending = app.runtime.run({ prompt: "Save the form", sessionId: sid });
  await thinking.promise;
  await page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  const take = page.locator('#stage7 .st7-top [data-act="owner-browser-adopt"]');
  await take.waitFor({ timeout: 30000 });
  await take.click();
  await framed(page);
  const back = page.locator('#stage7 .st7-top [data-act="owner-browser-handback"]');
  await back.waitFor({ timeout: 30000 });
  const input = await focusBox(w, "#name", "name");
  await page.keyboard.type("from the owner");
  await w.until(async () => (await w.enginePage().inputValue("#name")) === "from the owner", "the owner's words in the task's page");

  gate.resolve(); // the task's next step: press Save, while the owner still has the browser
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await w.enginePage().textContent("#out"), "Nothing saved", "the task's step waits for Hand back");
  await back.click();
  const finished = await pending;
  assert.equal(finished.status, "completed", JSON.stringify(finished).slice(0, 300));
  assert.equal(await w.enginePage().textContent("#out"), "from the owner", "the task carried on in the page as the owner left it");
  assert.deepEqual(w.errors, []);
});

const LOGIN = `<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="margin:0">
  <form onsubmit="event.preventDefault();document.body.innerHTML='<h1 id=done>Signed in</h1>'">
  <label style="display:block;padding:20px">Password <input id="pass" type="password" style="width:300px;height:40px"></label>
  <button id="go" style="margin:20px;width:200px;height:50px">Sign in</button></form><p id="words">Pick these words</p></body>`;

test("a task that reaches a sign-in page Needs you: the card and view say so, the owner signs in, and the task carries on without the password", async (t) => {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const thinking = deferred(), gate = deferred(), seen = [];
  let rounds = 0, origin = "";
  const provider = { name: "scripted", async complete(request) {
    seen.push(JSON.stringify(request));
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "open", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/login` }) }] };
    if (rounds === 2) { thinking.resolve(); await gate.promise; return { content: "", toolCalls: [{ id: "go", name: "browser.click", arguments: JSON.stringify({ role: "button", name: "Sign in" }) }] }; }
    return { content: "Signed in.", toolCalls: [] };
  } };
  t.after(() => gate.resolve()); // first, so a failed test never leaves its task waiting while the engine closes
  const w = await fixture(t, provider, { "/login": LOGIN });
  origin = w.origin;
  const { page, app, sid } = w;
  // The card in the conversation is the path under test, so the browser does not open full size by itself here.
  saveComfort(app.store, app.runtime.owner, "browser", { openFullSize: false });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const pending = app.runtime.run({ prompt: "Sign in for me", sessionId: sid });
  await thinking.promise;
  const card = page.locator("#main .card.comp7").filter({ hasText: "Waiting for you to sign in" });
  await card.waitFor({ timeout: 30000 });
  assert.match(await card.innerText(), /Needs you/);
  await card.locator('[data-act="stage-take-control"]').click();
  const tools = page.locator("#stage7 .tb7");
  await tools.waitFor({ timeout: 30000 });
  await framed(page);
  await focusBox(w, "#pass", "pass");
  await page.keyboard.type("FixtureOnlyPassword-9");
  await w.until(async () => (await w.enginePage().inputValue("#pass")) === "FixtureOnlyPassword-9", "the owner's password in the page");

  await w.enginePage().evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById("words")); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await tools.locator('[data-act="owner-browser-copy"]').click();
  await w.until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === "Pick these words", "the page's selected words on the owner's clipboard");

  gate.resolve();
  await tools.locator('[data-act="owner-browser-handback"]').click();
  const finished = await pending;
  assert.equal(finished.status, "completed", JSON.stringify(finished).slice(0, 300));
  assert.equal(await w.enginePage().textContent("#done"), "Signed in", "the task carried on after the owner signed in");
  assert.ok(seen.every((sent) => !sent.includes("FixtureOnlyPassword-9")), "the model never saw the password");
  assert.deepEqual(w.errors, []);
});

test("a task that starts browsing opens its browser full size once, and a view the owner closes stays closed", async (t) => {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const thinking = deferred(), gate = deferred();
  let rounds = 0, origin = "";
  const provider = { name: "scripted", async complete() {
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "open", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/` }) }] };
    if (rounds === 2) { thinking.resolve(); await gate.promise; }
    return { content: "Done.", toolCalls: [] };
  } };
  t.after(() => gate.resolve()); // first, so a failed test never leaves its task waiting while the engine closes
  const w = await fixture(t, provider);
  origin = w.origin;
  const pending = w.app.runtime.run({ prompt: "Look at the page", sessionId: w.sid });
  await thinking.promise;
  await w.page.locator("#stage7 .st7-title", { hasText: "browser" }).waitFor({ timeout: 30000 });
  await w.page.locator('#stage7 [data-act="stage-close"]').click();
  await w.page.locator("#stage7").waitFor({ state: "detached" });
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(await w.page.locator("#stage7").count(), 0, "closed by the owner, it stays closed for this task");
  gate.resolve();
  assert.equal((await pending).status, "completed");
  assert.deepEqual(w.errors, []);
});

test("SCREEN-019: words being composed with an input method survive the view being drawn again, and arrive whole", async (t) => {
  const w = await fixture(t, { name: "scripted", async complete() { return { content: "Unused", toolCalls: [] }; } });
  const { page } = w;
  await page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  const bar = page.locator("#stage7 #st-addr");
  await bar.fill(`${w.origin}/`);
  await bar.press("Enter");
  await framed(page);
  await focusBox(w, "#name", "name");
  await w.until(async () => (await page.evaluate(() => document.activeElement?.id)) === "ob7-keys", "the window's keyboard box to have the keys");
  await page.evaluate(() => { window.keysBox = document.getElementById("ob7-keys"); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  // The page renames itself mid-composition, so the view's head would be drawn again.
  await w.enginePage().evaluate(() => { document.title = "Renamed while composing"; });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(await page.evaluate(() => window.keysBox === document.getElementById("ob7-keys") && window.keysBox === document.activeElement), true,
    "the box being composed in is kept, with the keys, while the view waits");
  await cdp.send("Input.insertText", { text: "日本" });
  await w.until(async () => (await w.enginePage().inputValue("#name")).endsWith("日本"), "the composed words in the page");
  await page.locator("#stage7 .ob7-tabs").filter({ hasText: "Renamed while composing" }).waitFor({ timeout: 30000 });
  assert.deepEqual(w.errors, []);
});
