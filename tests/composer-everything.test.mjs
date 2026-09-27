/* DG-175 (owner-reported): with Show everything on, the message box was the old tall panel: a big "+", the
   Temporary and Ask-me-questions-first tick boxes, the "Your assistant" dropdown, New conversation and a big Send.
   The approved sample (design/Branch-Grown-Up.html) keeps one slim bar whatever is shown; with everything shown at
   Advanced or Technical it adds a line of small chips under it (its `.c-foot .fchip.full-only`). Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-composer-everything-"));
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
  return { page, errors };
}
const everything = (page, on) => page.evaluate(async (value) => {
  const { applyAppearance, currentAppearance } = await import("/appearance.js");
  applyAppearance({ ...currentAppearance(), showEverything: value });
}, on).then(() => page.waitForFunction((value) => document.documentElement.dataset.everything === (value ? "on" : "off"), on));

/** What the owner's screenshot showed beside the box, and the two round buttons' size. */
const inline = (page) => page.evaluate(() => {
  const shown = (selector) => [...document.querySelectorAll(selector)].some((node) => node.checkVisibility());
  const round = (id) => { const box = document.getElementById(id).getBoundingClientRect(); return Math.round(box.width) === 34 && Math.round(box.height) === 34; };
  return {
    extras: ["#temporary-toggle", "#ask-first-toggle", "#composer-specialist", "#composer-attach", "#composer-media", "#new-session"].filter(shown),
    plusRound: round("lx-plus"), sendRound: round("send"),
    bar: Math.round(document.getElementById("chat-form").getBoundingClientRect().height),
  };
});

for (const width of [1440, 860, 400]) {
  // Redesign: replaced by the new window (Show everything: the calm and full windows are one window, and its slim bar and
  // the chips under it were the old sample's, design/Branch-Grown-Up.html; the message box is the prototype's).
  test.skip(`DG-175 at ${width} px with Show everything on the box is the sample's slim bar, nothing beside it`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await everything(page, true);
    assert.deepEqual(await inline(page), { extras: [], plusRound: true, sendRound: true, bar: 48 });
    assert.deepEqual(errors, []);
  });
}

/** The + menu as drawn: its rows in order, a ✓ on each chosen one, and whether it fits the window. */
const plusMenu = async (page) => {
  await page.locator("#lx-plus").click();
  await page.locator("#lx-plus-menu").waitFor({ state: "visible" });
  return page.evaluate(() => {
    const menu = document.getElementById("lx-plus-menu"), box = menu.getBoundingClientRect();
    return {
      rows: [...menu.querySelectorAll(".lx-more-head, [role^=menuitem]")].map((row) =>
        `${row.textContent.trim()}${row.getAttribute("aria-checked") === "true" ? " ✓" : ""}`),
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    };
  });
};
/* Redesign: the new window's + menu (public/app/chat/plus.js, the prototype's POPS.plusmenu) as drawn: its rows in order,
   and whether it fits the window. */
const plusMenuNew = async (page) => {
  await page.locator('#composer [data-act="plusmenu"]').click();
  await page.locator("#app > .pop").waitFor({ state: "visible" });
  return page.evaluate(() => {
    const menu = document.querySelector("#app > .pop"), box = menu.getBoundingClientRect();
    return {
      rows: [...menu.querySelectorAll(".ph, [role^=menuitem], .row-in > span:first-child")].map((row) => row.textContent.replace(/\s+/g, " ").trim()),
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    };
  });
};

/* Redesign: the new window is one window; its + menu is the prototype's short one, which fits the window. */
test("DG-175 the calm window's + menu stays the sample's short one", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const { rows, fits } = await plusMenuNew(page);
  assert.equal(fits, true, "the menu fits the window");
  assert.equal(rows.includes("How it should work"), false, JSON.stringify(rows));
  assert.deepEqual(errors, []);
});
