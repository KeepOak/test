/* DG-134: "Try a celebration" is the approved sample's row (design/Branch-Grown-Up.html, the achievements card's
   `.ctl.stack` of `.acts`): its label, the six tiers as small buttons (30px, 12.5px at 540, 9px corners) each with the
   tier's dot, three and three, and what each one does beside them. The sample squeezes the tiers to one a row on a
   narrow window; here they stay three and three and nothing leaves the card. A button still shows its celebration.
   Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettingFor } from "./places.mjs";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-celebration-row-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettingFor(page, "#delight-ach-on");
  await page.locator("#delight-ach-on").check();
  await page.locator(".delight-celebrate").waitFor({ state: "visible" });
  await page.locator(".delight-celebrate").scrollIntoViewIfNeeded();
  return { page, errors };
}

const row = (page) => page.evaluate(() => {
  const holder = document.querySelector(".delight-celebrate"), card = holder.closest("section, .card, [id$='-card']").getBoundingClientRect();
  const buttons = [...holder.querySelectorAll("button")];
  const boxes = buttons.map((b) => b.getBoundingClientRect());
  const tops = [...new Set(boxes.map((box) => Math.round(box.top)))];
  const first = getComputedStyle(buttons[0]), dot = getComputedStyle(buttons[0].querySelector(".delight-tier-dot"));
  const label = holder.querySelector(".delight-celebrate-label"), note = holder.querySelector(".delight-celebrate-note");
  return {
    label: label.textContent, labelType: `${getComputedStyle(label).fontSize} ${getComputedStyle(label).fontWeight}`,
    tiers: buttons.map((b) => b.textContent),
    rows: tops.length, perRow: tops.map((top) => boxes.filter((box) => Math.round(box.top) === top).length),
    button: { height: boxes[0].height, size: first.fontSize, weight: first.fontWeight, radius: first.borderRadius, padding: first.paddingLeft, shadow: first.boxShadow },
    dot: { size: `${dot.width}×${dot.height}`, round: dot.borderRadius, painted: dot.backgroundColor !== "rgba(0, 0, 0, 0)" || dot.backgroundImage !== "none" },
    dots: buttons.every((b) => b.querySelector(".delight-tier-dot")),
    note: note.textContent, noteSize: getComputedStyle(note).fontSize,
    beside: note.getBoundingClientRect().left > boxes.at(-1).right,
    inCard: [label, note, ...buttons].every((n) => { const box = n.getBoundingClientRect(); return box.left >= card.left - 0.5 && box.right <= card.right + 0.5; }),
    pageScrolls: document.documentElement.scrollWidth > innerWidth + 1,
  };
});

const ENGLISH = { label: "Try a celebration", tiers: ["Bronze", "Silver", "Gold", "Diamond", "Godly", "SSS+"] };
const NOTE = "Bronze and Silver appear small at the top right for a few seconds. Gold and above get a card and a party that grows with the rank. Keep things still shows a still card.";

// Redesign: replaced by the new window (prototype.html's Settings › Achievements has no "Try a celebration" row;
// celebrations come from what the engine earned, checked in achievement-medal-card).
for (const [width, beside] of [[1440, true], [860, false], [400, false]]) {
  test.skip(`DG-134 at ${width} px the tiers are three and three, the sample's small buttons with their dots${beside ? ", the note beside them" : ""}`, async (t) => {
    const { page, errors } = await fixture(t, width);
    const seen = await row(page);
    assert.deepEqual({ label: seen.label, tiers: seen.tiers }, ENGLISH);
    assert.equal(seen.labelType, "14px 520");
    assert.deepEqual({ rows: seen.rows, perRow: seen.perRow }, { rows: 2, perRow: [3, 3] });
    assert.deepEqual(seen.button, { height: 30, size: "12.5px", weight: "540", radius: "9px", padding: "11px", shadow: "none" });
    assert.deepEqual(seen.dot, { size: "9px×9px", round: "50%", painted: true });
    assert.equal(seen.dots, true);
    assert.deepEqual({ note: seen.note, size: seen.noteSize }, { note: NOTE, size: "12.5px" });
    if (beside) assert.equal(seen.beside, true, "wide, the note sits beside the tiers");
    /* The background card's row of built-in objects shares the old row's look, and keeps it. */
    assert.deepEqual(await page.evaluate(() => {
      const words = document.querySelector(".delight-tries > span"), probe = document.createElement("i");
      probe.style.color = "var(--muted)"; document.body.append(probe);
      const muted = getComputedStyle(probe).color; probe.remove();
      return { size: getComputedStyle(words).fontSize, muted: getComputedStyle(words).color === muted };
    }), { size: "13px", muted: true });
    assert.deepEqual({ inCard: seen.inCard, pageScrolls: seen.pageScrolls }, { inCard: true, pageScrolls: false });
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (no "Try a celebration" row in prototype.html); its French is Coming soon
// (sw:lang), checked at e5b8a610.
test.skip("DG-134 in French the row speaks French, and a tier still shows its celebration", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const words = await page.evaluate(async () => { const { t } = await import("/i18n.js"); return { label: t("delight.ach.try"), note: t("delight.ach.tryNote") }; });
  await page.waitForFunction((label) => document.querySelector(".delight-celebrate-label")?.textContent === label, words.label);
  const seen = await row(page);
  assert.deepEqual({ label: seen.label, note: seen.note }, words);
  assert.notEqual(words.note, NOTE, "French words of its own");
  await page.locator(".delight-try").filter({ hasText: "SSS+" }).click();
  await page.locator(".ach-party .ach-card").waitFor();
  assert.deepEqual(errors, []);
});
