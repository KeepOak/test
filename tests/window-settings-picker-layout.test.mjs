/* The owner: on Settings › Models the rows of model choices ("Everyday answers", "Sub-tasks and side jobs", "Model for
   decisions", ...) were painted over their own titles and notes, the title crushed to one word per line; and in
   "Retries and timeouts" the number boxes with a unit ("300 s", "12 KB") stood left of the ones without, a ragged column.
   A settings row (.ctl, public/app.css) keeps its title column at least min(180px, 40%) wide and its choices wrap in
   their own box; a number box (.num15) keeps a unit slot of one width, so every box in a card shares its right edge.
   Checked in a headless page at 900, 1280 and 1600 px, with connections named as long as real ones.
   Mutation: in public/app.css set .ctl back to grid-template-columns:minmax(0,1fr) auto, or drop the .num15 unit slot,
   and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage, setLevel } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const presets = [
  { id: "default", name: "ChatGPT · GPT-6 Sol", provider, model: "gpt-6-sol" },
  { id: "opus", name: "Claude · Opus 4.7 with long thinking", provider, model: "claude-opus" },
  { id: "router", name: "OpenRouter · Qwen3.6 Coder 480B", provider, model: "qwen3.6-coder" },
  { id: "mini", name: "ChatGPT · GPT-6 Mini", provider, model: "gpt-6-mini" },
];

/* Every visible settings row that holds a row of choices: its title's and note's text boxes (a Range, so text that spills
   out of a crushed column is still measured), and each choice's box. */
const pickerRows = (page) => page.evaluate(() => {
  const shown = (node) => node.getClientRects().length > 0;
  const textRects = (node) => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })); };
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
  return [...document.querySelectorAll(".set-col .ctl")].filter((row) => shown(row) && row.querySelector(".seg")).map((row) => {
    const label = row.querySelector(":scope > b"), note = row.querySelector(":scope > small"), seg = row.querySelector(".seg");
    return {
      title: label.textContent.trim(), row: box(row),
      label: box(label), texts: [...textRects(label), ...(note ? textRects(note) : [])],
      picker: box(seg), chips: [...seg.querySelectorAll("button")].filter(shown).map(box),
    };
  });
});
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/* The right edge of each number box, per settings card, for every card that has more than one. */
const numberEdges = (page) => page.evaluate(() => [...document.querySelectorAll(".set-col .sec")].map((sec) => ({
  title: sec.querySelector("h2")?.textContent.trim(),
  edges: [...sec.querySelectorAll(".num15 .inp")].filter((box) => box.getClientRects().length).map((box) => box.getBoundingClientRect().right),
  widths: [...sec.querySelectorAll(".num15 .inp")].filter((box) => box.getClientRects().length).map((box) => box.getBoundingClientRect().width),
})).filter((sec) => sec.edges.length > 1));

test("Settings › Models: choices never cover a row's title or note, and number boxes share one right edge", async (t) => {
  const { page, errors } = await newWindow(t, { options: { presets }, width: 1600, height: 900 });
  await openSettingsPage(page, "models");
  await setLevel(page, "technical");
  await page.locator('.set-col [data-act="mtab"][data-v="defaults"]').click();
  await page.locator('.set-col [data-act="mtab"][data-v="defaults"][aria-selected="true"]').waitFor();
  // The engine's reads (knobs, savings, decision models) draw their rows.
  await page.locator('.set-col .dm17d .seg[aria-label="Model for decisions"]').waitFor({ timeout: 20000 });
  await page.locator('.set-col .seg[aria-label="Sub-tasks and side jobs"] button').nth(4).waitFor({ timeout: 20000 });
  await page.locator(".set-col #m-toolkb").waitFor({ timeout: 20000 });

  for (const width of [900, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const rows = await pickerRows(page);
    const titles = rows.map((row) => row.title);
    for (const title of ["Everyday answers", "Planning and hard problems", "Quick and cheap jobs", "Summaries", "Sub-tasks and side jobs", "Planning model", "Model for decisions"])
      assert.ok(titles.includes(title), `${width}: the "${title}" row is drawn (${titles.join(" · ")})`);
    for (const row of rows) {
      for (const chip of row.chips) for (const text of row.texts)
        assert.ok(!overlaps(chip, text), `${width}: a choice in "${row.title}" covers its words: ${JSON.stringify({ chip, text })}`);
      assert.ok(row.label.width >= 120 || row.label.bottom <= row.picker.top + 0.5,
        `${width}: "${row.title}" keeps a readable title (${Math.round(row.label.width)} px wide, not above its choices)`);
      for (const chip of row.chips) assert.ok(chip.left >= row.picker.left - 0.5 && chip.right <= row.picker.right + 0.5, `${width}: "${row.title}" choices wrap inside their own box`);
      assert.ok(row.picker.left >= row.row.left - 0.5 && row.picker.right <= row.row.right + 0.5, `${width}: "${row.title}" choices stay inside the row`);
    }
    const cards = await numberEdges(page);
    assert.ok(cards.some((card) => card.title === "Retries and timeouts"), `${width}: the Retries and timeouts card is drawn`);
    for (const card of cards) {
      const spread = Math.max(...card.edges) - Math.min(...card.edges);
      assert.ok(spread <= 1, `${width}: "${card.title}" number boxes share one right edge (${card.edges.map(Math.round).join(", ")})`);
      assert.ok(Math.max(...card.widths) - Math.min(...card.widths) <= 1, `${width}: "${card.title}" number boxes are one width`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), `${width}: nothing scrolls sideways`);
  }
  assert.deepEqual(errors, []);
});
