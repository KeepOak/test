/* UI-008 / OC-30 / OC-52 / OC-57–59: the window works at every size. One headless window visits a new conversation, a
   conversation with a reply and every place and every tab of it, at 400, 600, 900, 1280 and 1600 px wide (a zoomed
   window is a narrower one in CSS pixels: 1280 at 125 % is 1024, 900 at 150 % is 600), and German again at 600 and
   400 px, and checks, in one list:
   - nothing scrolls the page sideways, and no place hides content sideways;
   - the title-bar row is one row: nothing in it wraps onto a second line or leaves the row;
   - the status bar (the footer) is whole: every part inside the window and inside the bar, no part cut short;
   - a tab never cuts its own words ("Sig…"), and a row of tabs never paints tabs over each other.
   Settled by counting requests in flight and two frames, never by a sleep.
   Mutation: in public/app.css give .titlebar flex-wrap:wrap and a long place title, or .statusbar a fixed width of
   1400px, and this goes red at the narrow widths. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium as _browserFile } from "playwright"; // a browser file, run one at a time (scripts/run-tests.mjs)
import { newWindow } from "./new-window-places.mjs";

void _browserFile;
const WIDTHS = [1600, 1280, 900, 600, 400];
const PLACES = ["overview", "inbox", "automations", "library", "team", "customize"];
const COUNT = () => {
  window.__inFlight = 0;
  const real = window.fetch;
  window.fetch = (...args) => { window.__inFlight++; return real(...args).finally(() => { window.__inFlight--; }); };
};
async function settle(page) {
  await page.waitForFunction(() => window.__inFlight === 0, null, { timeout: 20000, polling: 50 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/* Everything wrong with the window as drawn now. */
const problems = (page) => page.evaluate(() => {
  const out = [], near = 0.5;
  const shown = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const box = (el) => el.getBoundingClientRect();
  const name = (el) => (el.getAttribute("aria-label") || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
  const overlap = (a, b) => a.left < b.right - near && b.left < a.right - near && a.top < b.bottom - near && b.top < a.bottom - near;
  const hidesSideways = (el) => el.scrollWidth - el.clientWidth > 1 && !["auto", "scroll"].includes(getComputedStyle(el).overflowX);
  if (document.documentElement.scrollWidth - innerWidth > 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  const place = document.querySelector("#main .place") ?? document.querySelector("#main");
  if (place && shown(place) && hidesSideways(place)) out.push(`the place hides content sideways (${place.scrollWidth} > ${place.clientWidth})`);

  const bar = document.querySelector(".titlebar");
  if (shown(bar)) {
    const row = box(bar);
    for (const el of bar.querySelectorAll("button, input, h1, h2, .head > *")) {
      if (!shown(el)) continue;
      const r = box(el);
      if (r.top < row.top - near || r.bottom > row.bottom + near) out.push(`title bar: "${name(el)}" leaves its row`);
    }
    for (const words of bar.querySelectorAll("h1, h2, b, .ttl, .title")) {
      if (!shown(words)) continue;
      const range = document.createRange(); range.selectNodeContents(words);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
      if (lines.size > 1) out.push(`title bar: "${name(words)}" wraps onto ${lines.size} lines`);
    }
  }

  const foot = document.querySelector("#statusbar");
  if (shown(foot)) {
    const f = box(foot);
    if (f.bottom > innerHeight + near || f.right > innerWidth + near || f.left < -near) out.push(`status bar leaves the window (${Math.round(f.left)}–${Math.round(f.right)}, bottom ${Math.round(f.bottom)})`);
    for (const el of foot.querySelectorAll(":scope > *")) {
      if (!shown(el)) continue;
      const r = box(el);
      if (r.right > f.right + near || r.left < f.left - near || r.bottom > f.bottom + near) out.push(`status bar: "${name(el)}" is cut off`);
      if (el.scrollWidth - el.clientWidth > 1) out.push(`status bar: "${name(el)}" cuts its words`);
    }
  }

  for (const list of document.querySelectorAll('#main [role="tablist"]')) {
    if (!shown(list)) continue;
    const tabs = [...list.querySelectorAll('[role="tab"]')].filter(shown);
    for (const tab of tabs) if (tab.scrollWidth - tab.clientWidth > 1) out.push(`tab "${name(tab)}" cuts its words`);
    for (const [i, a] of tabs.entries()) for (const b of tabs.slice(i + 1)) if (overlap(box(a), box(b))) out.push(`tabs "${name(a)}" and "${name(b)}" overlap`);
  }
  return [...new Set(out)];
});

test("every place, tab and width: no sideways scroll, a one-row title bar, a whole status bar, whole tabs", { timeout: 300000 }, async (t) => {
  const provider = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const { page, errors } = await newWindow(t, { provider, width: 1600, height: 900 });
  await page.addInitScript(COUNT);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#prompt").fill("Say hello.");
  await page.locator("#prompt").press("Enter");
  await page.locator("#main .b").filter({ hasText: "Here it is." }).first().waitFor({ timeout: 20000 });
  const reply = await page.evaluate(async () => (await import("/app/core/state.js")).S.chat);

  const found = [];
  const go = (view, tab) => page.evaluate(async ([view, tab, reply]) => {
    const [{ S }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    S.view = view;
    if (view === "chat") S.chat = tab === "new" ? null : reply;
    else if (tab) S.tabs[view] = tab;
    renderNow();
  }, [view, tab, reply]);
  const tabsOf = (view) => page.evaluate((view) => [...document.querySelectorAll(`#main [data-act="ptab"][data-place="${view}"], #main .place [data-act="ptab"]`)].map((b) => b.dataset.v), view);
  let visited = 0, tabbed = 0;
  // English at every width, then German (the longest words) at the two narrowest.
  const passes = [...WIDTHS.map((width) => ["en", width]), ["de", 600], ["de", 400]];
  for (const [lang, width] of passes) {
    if (lang !== "en" && await page.evaluate(() => document.documentElement.lang) !== lang) {
      await page.evaluate(async (lang) => (await import("/i18n.js")).setLanguage(lang), lang);
      await page.waitForFunction((lang) => document.documentElement.lang === lang, lang);
    }
    await page.setViewportSize({ width, height: 900 });
    for (const [view, tab] of [["chat", "new"], ["chat", "reply"]]) {
      await go(view, tab);
      await settle(page);
      visited++;
      for (const p of await problems(page)) found.push(`${lang} ${width}px · ${tab === "new" ? "a new conversation" : "a conversation"}: ${p}`);
    }
    for (const view of PLACES) {
      await go(view);
      await settle(page);
      const tabs = [...new Set(await tabsOf(view))];
      if (tabs.length) tabbed++;
      for (const tab of tabs.length ? tabs : [undefined]) {
        await go(view, tab);
        await settle(page);
        visited++;
        for (const p of await problems(page)) found.push(`${lang} ${width}px · ${view} › ${tab}: ${p}`);
      }
    }
  }
  assert.ok(visited >= WIDTHS.length * (2 + PLACES.length) && tabbed >= 4 * WIDTHS.length, `every place and tab was visited (${visited} views, ${tabbed} places with tabs)`);
  t.diagnostic(`${visited} views checked`);
  assert.deepEqual(found, [], `${found.length} layout problems:\n${found.join("\n")}`);
  assert.deepEqual(errors, []);
});
