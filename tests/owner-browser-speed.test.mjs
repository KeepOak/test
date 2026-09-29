/* How quickly the owner's live browser in the window answers (public/app/chat/stage-browser-control.js): from a click
   on the picture to the picture that shows it, and from a key to the picture with the letter in it. Real engine, Branch's
   real headless Chromium, and a hidden headless window. Each round waits for the page itself to have changed and then
   for the first picture drawn after that, so a picture that was merely on its way does not count. */
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
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

assert.equal(typeof chromium.launch, "function");
const PAGE = `<!doctype html><meta charset="utf-8"><title>Speed</title><body style="margin:0;font:40px sans-serif">
  <button id="hit" style="width:600px;height:200px;font-size:40px" onclick="this.textContent = 'Clicked ' + (++window.n || (window.n = 1))">Click me</button>
  <input id="box" style="display:block;width:600px;height:80px;font-size:40px">
  <textarea id="area" style="display:block;width:600px;height:120px;font-size:30px"></textarea></body>`;

/* A page with a lot to draw: many coloured blocks of text, as a real site has, so the picture costs what it would. */
const BUSY = `<!doctype html><meta charset="utf-8"><title>Busy</title><body style="margin:0;font:14px sans-serif">
  <button id="hit" style="width:600px;height:120px;font-size:40px" onclick="this.textContent = 'Clicked ' + (++window.n || (window.n = 1))">Click me</button>
  <div>${Array.from({ length: 400 }, (_, i) => `<span style="display:inline-block;width:150px;padding:4px;background:linear-gradient(${i * 7}deg,hsl(${i * 37 % 360},70%,60%),hsl(${i * 53 % 360},60%,40%));color:#fff">Item ${i} with some words</span>`).join("")}</div></body>`;
const median = (list) => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

test("click to picture and key to picture in the owner's live browser", { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-browser-speed-"));
  const site = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" }).end(request.url === "/busy" ? BUSY : PAGE));
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Unused", toolCalls: [] }; } } });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const sid = app.store.createSession(app.runtime.owner);
  app.store.message(sid, { role: "user", content: "Browse for me" });
  app.store.message(sid, { role: "assistant", content: "Ready." });
  t.after(async () => { await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  const w = await newWindow(t, { app, root });
  const { page } = w;
  await openChat(page, sid);
  await page.locator("#conversation .b").first().waitFor();
  await page.locator('.head [data-act="stage"][data-v="browser"]').first().click();
  const bar = page.locator("#stage7 #st-addr");
  await bar.fill(`${origin}/`);
  await bar.press("Enter");
  const img = '#stage7 .owner-browser7-img[src^="data:image/jpeg"]:not([hidden])';
  await page.locator(img).waitFor({ timeout: 30000 });
  const enginePage = () => { const control = browser.controls.forConversation(app.runtime.owner, sid);
    return browser.controlledPageTarget(control.binding, control.id, control.view().tabs[0]).page; };
  // In the window: every picture that is drawn, with when it was drawn.
  await page.evaluate(() => {
    window.__drawn = [];
    new MutationObserver((changes) => { for (const change of changes) if (change.attributeName === "src") {
      const node = change.target; const at = performance.now();
      node.decode?.().then(() => requestAnimationFrame(() => window.__drawn.push({ at, painted: performance.now(), src: node.getAttribute("src")?.length ?? 0 })), () => undefined);
    } }).observe(document.getElementById("app"), { attributes: true, subtree: true, attributeFilter: ["src"] });
    // And every input sent and every view read, with when each started and ended.
    window.__calls = []; window.__inflight = 0; window.__keys = [];
    document.addEventListener("keydown", () => window.__keys.push(performance.now()), true);
    const fetched = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const path = String(url), kind = /panels\/browser\/action/.test(path) ? "action" : /panels\/browser\?/.test(path) ? "view" : null;
      const started = performance.now();
      if (kind === "action") window.__inflight++;
      const call = { kind, started, ended: 0, withPage: false, ok: false };
      try {
        const response = await fetched(url, init);
        call.ok = response.ok;
        if (kind === "action") call.withPage = !!(await response.clone().json().catch(() => ({}))).view;
        return response;
      } finally { call.ended = performance.now(); if (kind) window.__calls.push(call); if (kind === "action") window.__inflight--; }
    };
  });
  const where = async (selector) => {
    let box = null;
    for (let i = 0; i < 50 && !box; i++) box = await page.locator(img).boundingBox({ timeout: 1000 }).catch(() => null); // redrawn as it changes
    const target = await enginePage().locator(selector).boundingBox(), size = enginePage().viewportSize();
    const scale = Math.min(box.width / size.width, box.height / size.height), left = box.x + (box.width - size.width * scale) / 2;
    return { x: left + (target.x + target.width / 2) * scale, y: box.y + (target.y + target.height / 2) * scale };
  };
  /** One round: act, wait until the engine's page shows it, then the first picture drawn after that moment. */
  /**
   * One round: act (timed from its last input), wait until the engine's page shows it, then find the first picture
   * read by a view that started after the last input had reached the page, and when it was painted.
   */
  const round = async (label, act, done) => {
    const before = await page.evaluate(() => window.__calls.length);
    await act();
    const last = await page.evaluate(() => performance.now());
    for (let i = 0; i < 400 && !(await done()); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(await done(), `${label}: the page never showed it`);
    for (let i = 0; i < 400; i++) {
      const found = await page.evaluate(({ before, last }) => {
        if (window.__inflight) return null; // every input has had its answer
        const calls = window.__calls.slice(before), inputs = calls.filter((c) => c.kind === "action");
        const input = inputs.at(-1);
        if (!input || input.started < last - 1000) return null;
        // The input's own answer brings the page as it is afterwards; a window without that reads it in a view after.
        // The picture that shows the input: its own answer's when it brought the page, else the next view's.
        const view = calls.find((c) => c.kind === "view" && c.started >= input.ended);
        const from = input.withPage ? input.ended - 1 : view ? view.ended - 1 : null;
        const drawn = from === null ? null : window.__drawn.find((d) => d.at >= from);
        return drawn ? { total: drawn.painted - last, input: input.ended - last, view: view ? view.ended - view.started : 0, inputs: inputs.length,
          // An input refused because the page moved on meanwhile is sent again after a fresh look; only answered ones count.
          withPage: inputs.filter((c) => c.ok).every((c) => c.withPage) } : null;
      }, { before, last });
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`${label}: no picture after the change`);
  };
  const clicks = [], keys = [];
  for (let i = 1; i <= 8; i++) {
    const at = await where("#hit");
    await new Promise((r) => setTimeout(r, 300));
    clicks.push(await round(`click ${i}`, () => page.mouse.click(at.x, at.y), async () => (await enginePage().textContent("#hit")) === `Clicked ${i}`));
  }
  const box = await where("#box");
  await page.mouse.click(box.x, box.y);
  for (let i = 0; i < 20 && await enginePage().evaluate(() => document.activeElement?.id) !== "box"; i++) await new Promise((r) => setTimeout(r, 100));
  for (let i = 1; i <= 8; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const letters = "abcdefgh".slice(0, i);
    keys.push(await round(`key ${i}`, () => page.keyboard.press(letters.at(-1)), async () => (await enginePage().inputValue("#box")) === letters));
  }
  // Quick succession, as a person clicks twice or types a word: from the last one to the picture that shows them all.
  const quick = [];
  for (let r = 0; r < 4; r++) {
    await new Promise((res) => setTimeout(res, 300));
    const at = await where("#hit"), before = Number((await enginePage().textContent("#hit")).replace(/\D/g, "")) || 0;
    quick.push(await round(`three clicks ${r}`, async () => { for (let i = 0; i < 3; i++) { if (i) await new Promise((res) => setTimeout(res, 60)); await page.mouse.click(at.x, at.y); } },
      async () => Number((await enginePage().textContent("#hit")).replace(/\D/g, "")) >= before + 3)); // a quick second click counts as a double click
  }
  const words = [];
  await page.mouse.click(box.x, box.y);
  for (let r = 0; r < 4; r++) {
    await new Promise((res) => setTimeout(res, 300));
    const had = await enginePage().inputValue("#box");
    words.push(await round(`word ${r}`, () => page.keyboard.type(" branch", { delay: 40 }), async () => (await enginePage().inputValue("#box")) === `${had} branch`));
  }
  // Letters, a key and more letters typed at full speed reach the page in the order they were typed.
  const area = await where("#area");
  await page.mouse.click(area.x, area.y);
  for (let i = 0; i < 20 && await enginePage().evaluate(() => document.activeElement?.id) !== "area"; i++) await new Promise((r) => setTimeout(r, 100));
  await page.keyboard.type("ab"); await page.keyboard.press("Enter"); await page.keyboard.type("cd"); await page.keyboard.press("Enter"); await page.keyboard.type("ef");
  const typed = ["ab", "cd", "ef"].join("\n");
  for (let i = 0; i < 100 && await enginePage().inputValue("#area") !== typed; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await enginePage().inputValue("#area"), typed, "in the order typed");
  // The same click on a page with a lot to draw.
  await bar.fill(`${origin}/busy`);
  await bar.press("Enter");
  await page.locator("#stage7 .ob7-tabs").filter({ hasText: "Busy" }).waitFor({ timeout: 30000 });
  const busy = [];
  for (let i = 1; i <= 6; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const at = await where("#hit");
    busy.push(await round(`busy click ${i}`, () => page.mouse.click(at.x, at.y), async () => (await enginePage().textContent("#hit")) === `Clicked ${i}`));
  }
  const line = (name, list) => `${name}: input answered ${Math.round(median(list.map((r) => r.input)))} ms, view ${Math.round(median(list.map((r) => r.view)))} ms, `
    + `painted ${Math.round(median(list.map((r) => r.total)))} ms after the last input (each: ${list.map((r) => Math.round(r.total)).join(", ")}; inputs sent: ${list.map((r) => r.inputs).join(", ")})`;
  console.log(line("click", clicks));
  console.log(line("key", keys));
  console.log(line("three clicks", quick));
  console.log(line("a word", words));
  console.log(line("click on a busy page", busy));
  // Every input's answer brought the page as it is afterwards, so no picture waits on a second request; a single key
  // goes out at once rather than after a pause for more letters. The budgets are loose on purpose: a slow CI machine
  // must not fail them, a return of the old waits (a second request, a pause before typing) would.
  const all = [...clicks, ...keys, ...quick, ...words, ...busy];
  // From each single key in the page to its input leaving the window: no pause to wait for more letters.
  const waits = await page.evaluate(() => window.__keys.map((at) => (window.__calls.find((c) => c.kind === "action" && c.started >= at)?.started ?? Infinity) - at));
  const leave = median(waits.slice(0, 8));
  console.log(`key to input sent: ${Math.round(leave)} ms`);
  assert.ok(leave < 50, `a key goes out at once (${Math.round(leave)} ms)`);
  assert.ok(all.every((r) => r.withPage), "each input's answer brings the page");
  assert.ok(median(keys.map((r) => r.input)) < 250 && median(clicks.map((r) => r.total)) < 400 && median(keys.map((r) => r.total)) < 400,
    "click and key to picture stay quick");
  assert.deepEqual(w.errors, []);
});
