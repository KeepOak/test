/* DG-014: a Bronze or Silver achievement arrives as the approved sample's small medal card (design/Branch-Grown-Up.html,
   `.ach-pop.small`): top-right, a rounded glass card with its tier eyebrow, and never over the top bar's buttons at
   1440, 860 and 400 wide. Gold and above keep their party. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveDelightSettings } from "../dist/delight.js";
import { achievementCatalogue } from "../dist/achievements.js";
import { startServer } from "../dist/server.js";

/* Redesign: the new window celebrates what the engine has earned and not yet celebrated (shell/celebrate.js, GET
   /api/delight/achievements "fresh"), 1:1 with prototype.html: Bronze and Silver arrive as the small note (.ach-toast,
   a pill under the title bar's middle that leaves by itself), Gold and up as the big card with confetti (.ach-big,
   "Nice" closes it). The old top-right glass medal card, its copper eyebrow and click-to-dismiss are replaced by it.
   Each case earns the achievement in the engine, switched on, before the window opens. */
// One real achievement of each tier, read from the engine's catalogue: tiers are cut by how hard each one is, so an
// achievement added later can move another into the next tier (pass 17's pets moved "Night Owl by daylight" to Bronze).
const catalogue = achievementCatalogue();
const firstOf = (tier) => catalogue.find((a) => a.tier === tier);
const PICKED = { Bronze: firstOf("Bronze"), Silver: firstOf("Silver"), Gold: firstOf("Gold") };
const EARNED = Object.fromEntries(Object.entries(PICKED).map(([tier, a]) => [tier, a.id]));
async function fixture(t, width, tiers = []) {
  const root = await mkdtemp(join(tmpdir(), "branch-medal-card-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  saveDelightSettings(app.store, owner, { achievements: { on: true } });
  const got = Object.fromEntries(tiers.map((tier) => [EARNED[tier], "2026-09-25"]));
  app.store.save("settings", owner, "delight-achievements", { got, fresh: tiers.map((tier) => EARNED[tier]) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  const fresh = async () => (await (await fetch(new URL("/api/delight/achievements", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json()).fresh.map((a) => a.id);
  return { page, errors, fresh };
}

/** The window looks for what the engine earned when it redraws (shell/celebrate.js check, on each draw, at most every
    10 s). A person using the window redraws it all the time; here the Places fold is pressed twice now and
    then, which redraws it and changes nothing, until the celebration shows. (That nothing is looked for without a redraw
    is reported as a window bug with the port.) */
async function celebrated(page, selector, text) {
  const target = text ? page.locator(selector, { hasText: text }) : page.locator(selector);
  for (let i = 0; i < 40; i++) {
    if (await target.first().isVisible()) return;
    // Redesign: owner removed the toggle; the Places fold, pressed twice, redraws the same way and changes nothing
    await page.evaluate(() => { document.querySelector('[data-act="places14"]')?.click(); document.querySelector('[data-act="places14"]')?.click(); });
    await target.first().waitFor({ timeout: 1000 }).catch(() => undefined);
  }
  await target.first().waitFor({ timeout: 1000 });
}

/* The note as a person meets it: what it covers in the title bar, whether it is inside the window, its words. */
const note = (page) => page.evaluate(() => {
  const el = document.querySelector(".ach-toast"), box = el.getBoundingClientRect();
  const overlaps = (r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
  const controls = [...document.querySelectorAll(".titlebar :is(button, a, input, [role=status], .who b)")]
    // Redesign: the conversation's name is no longer drawn in the title bar; it stays only as a 1px accessible heading,
    // which covers nothing and is not counted. Every drawn control still is.
    .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && node.getBoundingClientRect().width > 1)
    .filter((node) => overlaps(node.getBoundingClientRect())).map((node) => node.dataset.act || node.getAttribute("aria-label") || node.className || node.tagName);
  const cut = [...el.querySelectorAll("span, b")].some((node) => node.scrollWidth > node.clientWidth + 1);
  return { covered: controls, inWindow: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
    text: el.innerText, cut, role: el.getAttribute("role") };
});

for (const width of [1440, 860, 400]) {
  test(`DG-014 at ${width} px a Bronze achievement is the small note, read out, covering none of the title bar`, async (t) => {
    const { page, errors, fresh } = await fixture(t, width, ["Bronze"]);
    await celebrated(page, ".ach-toast");
    const seen = await note(page);
    assert.deepEqual(seen.covered, [], "it covers none of the title bar's buttons");
    assert.equal(seen.inWindow, true, "inside the window");
    assert.ok(seen.text.includes(`Achievement unlocked · ${PICKED.Bronze.name} · Bronze`), `its name and its tier: ${seen.text}`);
    assert.equal(seen.cut, false, "the achievement's name is not cut short");
    assert.equal(seen.role, "status", "still read out when it arrives");
    assert.equal(await page.locator(".ach-big").count(), 0, "a Bronze is not a party");
    let left = await fresh();
    for (let i = 0; i < 20 && left.includes(EARNED.Bronze); i++) { await page.waitForTimeout(250); left = await fresh(); }
    assert.equal(left.includes(EARNED.Bronze), false, "the engine is told, so it never shows again");
    assert.deepEqual(errors, []);
  });
}

test("DG-014 a Silver is the same note, and Gold still gets its party instead", async (t) => {
  const { page, errors } = await fixture(t, 1440, ["Silver"]);
  await celebrated(page, ".ach-toast");
  const seen = await note(page);
  assert.ok(seen.text.includes(`${PICKED.Silver.name} · Silver`), seen.text);
  assert.deepEqual(seen.covered, []);
  assert.deepEqual(errors, []);
  const gold = await fixture(t, 1440, ["Gold"]);
  await celebrated(gold.page, ".ach-big .card", PICKED.Gold.name)
    .catch(() => assert.fail("Gold keeps its party card"));
  assert.equal(await gold.page.locator(".ach-toast").count(), 0, "a Gold is not the small note");
  await gold.page.getByRole("button", { name: "Nice", exact: true }).click();
  await gold.page.locator(".ach-big").waitFor({ state: "detached" });
  assert.deepEqual(gold.errors, []);
});

/* The old window's preview and measures, for the skipped bodies below. */
const celebrate = (page, tier) => page.evaluate(async (rank) => (await import("/delight-achievements.js")).preview(rank), tier);

const measure = (page) => page.evaluate(() => {
  const note = document.getElementById("ach-note"), box = note.getBoundingClientRect(), style = getComputedStyle(note);
  const eyebrow = note.querySelector(".ach-lines small"), name = note.querySelector(".ach-lines b");
  const copper = getComputedStyle(document.body).getPropertyValue("--copper-text").trim();
  const probe = document.createElement("i");
  probe.style.color = copper;
  document.body.append(probe);
  const copperRgb = getComputedStyle(probe).color;
  probe.remove();
  const overlaps = (r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
  const bar = document.querySelector("main > header");
  const controls = [...bar.querySelectorAll("button, a, input, [role=status], .status-pill, h1")]
    .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
    .filter((el) => overlaps(el.getBoundingClientRect())).map((el) => el.id || el.className || el.tagName);
  return {
    top: box.top, left: box.left, rightGap: innerWidth - box.right, width: box.width, barBottom: bar.getBoundingClientRect().bottom,
    covered: controls, inWindow: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
    radius: style.borderTopLeftRadius, glass: style.backdropFilter, round: style.borderRadius === "999px",
    eyebrow: { text: eyebrow.textContent, transform: getComputedStyle(eyebrow).textTransform, colour: getComputedStyle(eyebrow).color, copperRgb },
    nameCut: name.scrollWidth > name.clientWidth + 1, role: note.getAttribute("role"),
  };
});

// Redesign: replaced by the new window (prototype.html's .ach-toast: a centred pill under the title bar that leaves by
// itself, not the top-right glass medal card with a copper eyebrow; the live tests above check the rest).
for (const width of [1440, 860, 400]) {
  test.skip(`DG-014 at ${width} px a Bronze achievement is the top-right medal card with its tier eyebrow, under the top bar`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await celebrate(page, "Bronze");
    await page.locator("#ach-note").waitFor();
    const seen = await measure(page);
    assert.deepEqual(seen.covered, [], "it covers none of the top bar's buttons");
    assert.ok(seen.top >= seen.barBottom, `it sits under the top bar (${seen.top} for a bar ending at ${seen.barBottom})`);
    assert.ok(seen.rightGap >= 8 && seen.rightGap <= 24, `it keeps to the right edge (${seen.rightGap}px from it)`);
    assert.ok(seen.left > width / 2 - 1 || width <= 400, `on the right, not centred (${seen.left})`);
    assert.equal(seen.inWindow, true, "inside the window");
    assert.equal(seen.radius, "14px", "the sample's rounded card, not a pill");
    assert.match(seen.glass, /blur\(12px\)/, "the sample's glass");
    assert.equal(seen.eyebrow.text, "Bronze achievement", "the tier eyebrow");
    assert.equal(seen.eyebrow.transform, "uppercase", "set in small capitals as the sample does");
    assert.equal(seen.eyebrow.colour, seen.eyebrow.copperRgb, "in copper");
    assert.equal(seen.nameCut, false, "the achievement's name is not cut short");
    assert.equal(seen.role, "status", "still read out when it arrives");
    /* A click puts it away. */
    await page.locator("#ach-note").click();
    await page.locator("#ach-note").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (prototype.html's .ach-toast: a centred pill under the title bar that leaves by
// itself, not the top-right glass medal card with a copper eyebrow; the live tests above check the rest).
test.skip("DG-014 a Silver is the same card, and Gold still gets its party instead", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await celebrate(page, "Silver");
  await page.locator("#ach-note").waitFor();
  const seen = await measure(page);
  assert.equal(seen.eyebrow.text, "Silver achievement");
  assert.deepEqual(seen.covered, []);
  await celebrate(page, "Gold");
  await page.locator(".ach-party .ach-card").waitFor({ timeout: 5000 }).catch(() => assert.fail("Gold keeps its party card"));
  assert.deepEqual(errors, []);
});
