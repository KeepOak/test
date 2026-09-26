/* DG-065: the Settings list's icons are the approved sample's (design/Branch-Grown-Up.html, `.set-pages .nav .ico`):
   the same glyph for each page, 18px, a 1.7 stroke with round ends, in the link's own colour, 10px before its words.
   The paths below were read from the rendered sample (its "files" is Instructions here, "trunks-people" is Trunks);
   Accounts has no counterpart in the sample and keeps its own. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";
import { openSettingsPage, settingsWindow } from "./settings-window.mjs";

const SAMPLE = {
  "general": "M12.2 2h-.4a2 2 0 00-2 2v.2a2 2 0 01-1 1.7l-.4.3a2 2 0 01-2 0l-.2-.1a2 2 0 00-2.7.7l-.2.4a2 2 0 00.7 2.7l.2.1a2 2 0 011 1.7v.5a2 2 0 01-1 1.7l-.2.1a2 2 0 00-.7 2.7l.2.4a2 2 0 002.7.7l.2-.1a2 2 0 012 0l.4.3a2 2 0 011 1.7v.2a2 2 0 002 2h.4a2 2 0 002-2v-.2a2 2 0 011-1.7l.4-.3a2 2 0 012 0l.2.1a2 2 0 002.7-.7l.2-.4a2 2 0 00-.7-2.7l-.2-.1a2 2 0 01-1-1.7v-.5a2 2 0 011-1.7l.2-.1a2 2 0 00.7-2.7l-.2-.4a2 2 0 00-2.7-.7l-.2.1a2 2 0 01-2 0l-.4-.3a2 2 0 01-1-1.7V4a2 2 0 00-2-2zM12 15a3 3 0 100-6 3 3 0 000 6z",
  "assistant": "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  "instructions": "M7 3h7l5 5v13H7zM14 3v5h5",
  "appearance": "M5 19C5 10 10 5 19 5c0 9-5 14-14 14zM5 19l7-7",
  "notifications": "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  "models": "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  "voice": "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3",
  "permissions": "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z",
  "computer": "M3 5h18v11H3zM8 20h8M12 16v4",
  "secrets": "M15 8a4 4 0 11-3.9 5H7v3H4v-4l6.1-.1A4 4 0 0115 8zM16 8h.01",
  "data": "M12 3a9 9 0 110 18 9 9 0 010-18zM12 7a5 5 0 110 10 5 5 0 010-10zM12 11a1 1 0 110 2 1 1 0 010-2z",
  "advanced": "M14 6a4 4 0 005 5l-8 8a2 2 0 01-3-3l8-8a4 4 0 01-2-2z",
  "about": "M12 21v-9M12 12c0-4-3-6-7-6 0 4 3 6 7 6zM12 12c0-4 3-7 7-7 0 4-3 7-7 7z",
  "trunks": "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M16 11a3 3 0 100-6M21 20a6 6 0 00-4-5.6",
  "channels": "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  "connections": "M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4",
  "skills": "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  "memory": "M12 5a3 3 0 00-5.8-1A3 3 0 004 9a3 3 0 001 5.5A3 3 0 009 19a3 3 0 003-1M12 5a3 3 0 015.8-1A3 3 0 0120 9a3 3 0 01-1 5.5A3 3 0 0115 19a3 3 0 01-3-1M12 5v13",
  "automations": "M13 3 5 13h6l-1 8 8-10h-6z",
};

async function settings(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-nav-icons-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "general");
  return { page, errors };
}

const icons = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".lx-settings-link")]
  .filter((link) => link.getClientRects().length).map((link) => {
    const svg = link.querySelector("svg"), style = getComputedStyle(svg), box = svg.getBoundingClientRect();
    const words = svg.nextElementSibling.getBoundingClientRect();
    return [link.dataset.page, {
      d: [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d")).join(" "),
      size: `${box.width}x${box.height}`, stroke: style.strokeWidth, ends: style.strokeLinecap,
      ownColour: style.color === getComputedStyle(link).color, gap: Math.round(words.left - box.right),
    }];
  })));

// Redesign: the prototype's Settings list (design/redesign/prototype.html pass 17, `.set-nav .nav`) names each page by its
// words alone, under its group heading, with no icon; the test below holds the window to that.
test.skip("DG-065 every Settings page's icon is the sample's glyph, size, weight and colour", async (t) => {
  const { page, errors } = await settings(t);
  for (const look of ["forest", "daylight"]) {
    await page.evaluate(async (appearance) => {
      const { applyAppearance, currentAppearance } = await import("/appearance.js");
      applyAppearance({ ...currentAppearance(), appearance });
    }, look);
    const seen = await icons(page);
    const shown = Object.keys(SAMPLE).filter((name) => seen[name]);
    assert.ok(shown.length >= 15, `the pages are in the list (${shown.join(", ")})`);
    for (const name of shown) {
      const icon = seen[name];
      assert.equal(icon.d, SAMPLE[name], `${look}, ${name}: the sample's glyph`);
      assert.deepEqual({ size: icon.size, stroke: icon.stroke, ends: icon.ends, gap: icon.gap },
        { size: "18x18", stroke: "1.7px", ends: "round", gap: 10 }, `${look}, ${name}: the sample's size and weight`);
      assert.equal(icon.ownColour, true, `${look}, ${name}: drawn in its link's own colour, as the sample's`);
    }
  }
  /* The page on show keeps that: its icon is in its link's colour too, not a colour of its own. */
  await page.locator('.lx-settings-link[data-page="voice"]').click();
  assert.equal((await icons(page)).voice.ownColour, true, "the chosen page's icon follows its link");
  assert.deepEqual(errors, []);
});

test("DG-065 the Settings list names every page by its words, with no icon, as the prototype's does", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "nav-icons" });
  errors.length = 0;
  await openSettingsPage(page, "general");
  const links = await page.locator(".settings button.nav[data-act=\"setpage\"]").evaluateAll((all) => all.filter((link) => link.getClientRects().length)
    .map((link) => ({ page: link.dataset.v, words: link.textContent.trim(), icons: link.querySelectorAll("svg, img, .ico").length })));
  assert.ok(links.length >= 15, `the pages are in the list (${links.map((one) => one.page).join(", ")})`);
  assert.deepEqual(links.filter((one) => one.icons || !one.words).map((one) => one.page), [], "each page by its words alone");
  /* The page on show says so the prototype's way, and still carries no icon. */
  await openSettingsPage(page, "voice");
  assert.equal(await page.locator('.settings button.nav[data-v="voice"][aria-current="true"] svg').count(), 0);
  assert.deepEqual(errors, []);
});
