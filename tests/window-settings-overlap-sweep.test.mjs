/* UI-095 / OC-52 / OC-62: no settings row is painted over itself, and nothing spills sideways, on any page, at any
   "How much to show" level, at 900, 1280 and 1600 px. PR #620 checked the Models rows; this visits every Settings page
   (and every Models tab) × Regular, Advanced, Technical × three widths, in one headless window, and reads each drawn row:
   - no two of its parts overlap: the title's and note's text (a Range, so text spilling out of a crushed column is still
     measured) and every control (switch, button, choice, box, pill, code);
   - every part stays inside its row and its card (a status pill or chip never spills out of a card, OC-62);
   - the page, the settings column and each card never scroll sideways;
   - the Settings list keeps its search box, pages and level buttons inside it, and the level box covers no page.
   Engine connections are named as long as real ones. The window is settled by counting the requests in flight (an init
   script around fetch) and two frames, never by a sleep. German, whose words run longest, is swept again at 900 px (it
   found the pet picker's "Gehäuseschnecke" pushing its card 10 px wide). Every failure of the sweep is listed at once.
   Mutation: in public/app.css set .ctl back to grid-template-columns:minmax(0,1fr) auto and the Models rows go red;
   give .pill a width of 900px and every card with a pill goes red. */
import test from "node:test";
import { chromium as _browserFile } from "playwright"; // a browser file, run one at a time (scripts/run-tests.mjs)
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage, setLevel } from "./settings-window.mjs";

void _browserFile;

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const presets = [
  { id: "default", name: "ChatGPT · GPT-6 Sol", provider, model: "gpt-6-sol" },
  { id: "opus", name: "Claude · Opus 4.7 with long thinking", provider, model: "claude-opus" },
  { id: "router", name: "OpenRouter · Qwen3.6 Coder 480B", provider, model: "qwen3.6-coder" },
  { id: "mini", name: "ChatGPT · GPT-6 Mini", provider, model: "gpt-6-mini" },
];

/* Requests in flight, counted in the page, so a settle waits for the engine's answers and the redraw after them. */
const COUNT = () => {
  window.__inFlight = 0;
  const real = window.fetch;
  window.fetch = (...args) => { window.__inFlight++; return real(...args).finally(() => { window.__inFlight--; }); };
};
async function settle(page) {
  await page.waitForFunction(() => window.__inFlight === 0, null, { timeout: 20000, polling: 50 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/* Everything wrong with the settings column as drawn now. */
const problems = (page) => page.evaluate(() => {
  const out = [], near = 0.5;
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const box = (el) => el.getBoundingClientRect();
  const overlap = (a, b) => a.left < b.right - near && b.left < a.right - near && a.top < b.bottom - near && b.top < a.bottom - near;
  const inside = (a, b) => a.left >= b.left - near && a.right <= b.right + near;
  const textRects = (el) => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5); };
  const name = (el) => (el.getAttribute("aria-label") || el.textContent || el.id || el.className || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
  const wide = (el) => el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflowX !== "auto" && getComputedStyle(el).overflowX !== "scroll";
  if (document.documentElement.scrollWidth - innerWidth > 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  /* The Settings list: its search box, pages and level buttons stay inside it, and the level box never covers a page
     (UI-093, UI-097). */
  const nav = document.querySelector(".set-nav");
  if (nav && shown(nav)) {
    const navBox = box(nav), level = nav.querySelector(".set-level");
    const parts = [...nav.querySelectorAll("button, input")].filter(shown);
    for (const el of parts) if (!inside(box(el), navBox)) out.push(`"${name(el)}" spills out of the Settings list`);
    if (level && shown(level)) for (const el of nav.querySelectorAll(".nav")) if (shown(el) && overlap(box(el), box(level))) out.push(`the level box covers "${name(el)}"`);
    const levels = [...nav.querySelectorAll(".set-level .seg button")].filter(shown);
    for (const [i, a] of levels.entries()) for (const b of levels.slice(i + 1)) if (overlap(box(a), box(b))) out.push(`level buttons "${name(a)}" and "${name(b)}" overlap`);
    for (const el of levels) if (el.scrollWidth - el.clientWidth > 1) out.push(`level button "${name(el)}" cuts its words`);
  }
  const col = document.querySelector(".set-col");
  if (!col) return ["no settings column"];
  for (const el of [document.querySelector(".set-page"), col]) if (el && wide(el)) out.push(`${el.className} is wider than itself (${el.scrollWidth} > ${el.clientWidth})`);
  const CONTROLS = "button, input:not([type=hidden]), select, textarea, .pill, code, .num15";
  for (const card of col.querySelectorAll(".sec")) {
    const where = card.querySelector(":scope > h2")?.textContent.trim() || "a card";
    if (!shown(card)) continue;
    if (wide(card)) out.push(`card "${where}" hides content sideways (${card.scrollWidth} > ${card.clientWidth})`);
    const cardBox = box(card);
    for (const el of card.querySelectorAll(CONTROLS)) if (shown(el) && !inside(box(el), cardBox)) out.push(`"${name(el)}" spills out of card "${where}"`);
  }
  for (const row of col.querySelectorAll(".ctl, .prow")) {
    if (!shown(row)) continue;
    const rowBox = box(row), title = (row.querySelector(":scope > b, :scope > .grow > b")?.textContent ?? "").trim().slice(0, 40) || name(row);
    const words = [...row.querySelectorAll(":scope > b, :scope > small, :scope > .grow > b, :scope > .grow > small")];
    const texts = words.flatMap((el) => textRects(el).map((r) => ({ what: `the words "${name(el)}"`, r })));
    // A link written inside the words ("… Save as a theme") is part of them, not a control laid over them.
    const all = [...row.querySelectorAll(CONTROLS)].filter((el) => shown(el) && !words.some((w) => w.contains(el)));
    const controls = all.filter((el) => !all.some((other) => other !== el && other.contains(el))).map((el) => ({ what: `"${name(el)}"`, r: box(el), el }));
    for (const c of controls) if (!inside(c.r, rowBox)) out.push(`${c.what} spills out of row "${title}"`);
    for (const [i, a] of controls.entries()) {
      for (const text of texts) if (overlap(a.r, text.r)) out.push(`${a.what} covers ${text.what} in row "${title}"`);
      for (const b of controls.slice(i + 1)) if (overlap(a.r, b.r)) out.push(`${a.what} overlaps ${b.what} in row "${title}"`);
    }
  }
  return [...new Set(out)];
});

test("every Settings page, level and width: no row paints over itself and nothing spills sideways", { timeout: 300000 }, async (t) => {
  const { page, errors } = await newWindow(t, { options: { presets }, width: 1600, height: 900 });
  await page.addInitScript(COUNT); // counted from the next load on; the window stays signed in across it
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingsPage(page, "general");
  const found = [];
  let visited = 0;
  for (const width of [1600, 1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    for (const level of ["regular", "advanced", "technical"]) {
      await setLevel(page, level);
      const pages = await page.locator('.set-nav [data-act="setpage"]').evaluateAll((all) => all.map((b) => b.dataset.v));
      for (const id of pages) {
        await openSettingsPage(page, id);
        const tabs = id === "models" ? await page.locator('.set-col [data-act="mtab"]').evaluateAll((all) => all.map((b) => b.dataset.v)) : [""];
        for (const tab of tabs) {
          if (tab) await page.locator(`.set-col [data-act="mtab"][data-v="${tab}"]`).click();
          await settle(page);
          visited++;
          for (const problem of await problems(page)) found.push(`${width}px · ${level} · ${id}${tab ? ` › ${tab}` : ""}: ${problem}`);
        }
      }
    }
  }
  // German's longer words, at the narrowest width.
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("de"));
  await page.waitForFunction(() => document.documentElement.lang === "de");
  for (const level of ["regular", "advanced", "technical"]) {
    await setLevel(page, level);
    const pages = await page.locator('.set-nav [data-act="setpage"]').evaluateAll((all) => all.map((b) => b.dataset.v));
    for (const id of pages) {
      await openSettingsPage(page, id);
      const tabs = id === "models" ? await page.locator('.set-col [data-act="mtab"]').evaluateAll((all) => all.map((b) => b.dataset.v)) : [""];
      for (const tab of tabs) {
        if (tab) await page.locator(`.set-col [data-act="mtab"][data-v="${tab}"]`).click();
        await settle(page);
        for (const problem of await problems(page)) found.push(`de · 900px · ${level} · ${id}${tab ? ` › ${tab}` : ""}: ${problem}`);
      }
    }
  }
  assert.ok(visited >= 3 * (19 + 20 + 21), `every page was visited (${visited})`);
  assert.deepEqual(found, [], `${found.length} layout problems:\n${found.join("\n")}`);
  assert.deepEqual(errors, []);
});
