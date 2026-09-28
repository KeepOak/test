/* DG-061: Settings search results open under the approved sample's head (design/Branch-Grown-Up.html,
   `renderSettings`): "N results" as the page's heading, then "for “what was typed”", and "Nothing matches. Try a
   shorter word." when nothing does. In French the head, its plural and every indexed setting are French: a setting
   found before its control is drawn no longer falls back to the index's English. Headless only. */
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

async function settings(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-search-head-"));
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
  await openSettings(page);
  return { page, errors };
}

/* The new window: the prototype's Settings search (design/redesign/prototype.html renderSettings) narrows the list of
   pages to those whose name holds what was typed (or that hold a row that does, UI-091), says "No page matches." when
   none does, and gives every page back when the box is cleared. */
test("DG-061 search narrows the pages to those that match, says when none does, and clears", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const { page, errors } = await settingsWindow(t, { name: "search-head" });
  await openSettingsPage(page, "general");
  const pages = () => page.locator('.set-nav [data-act="setpage"]').evaluateAll((all) => all.map((node) => node.dataset.v));
  const all = await pages();
  assert.ok(all.length > 10, "every page is listed");
  const box = page.getByRole("textbox", { name: "Search settings", exact: true });
  await box.fill("voice");
  // UI-091: the list keeps the pages whose name or rows match, and the rows found are listed (settings/find.js).
  await page.waitForFunction((n) => document.querySelectorAll('.set-nav [data-act="setpage"]').length < n, all.length);
  const narrowed = await pages();
  assert.ok(narrowed.includes("voice") && narrowed.length < all.length, `the list narrows to what matches (${narrowed})`);
  await page.locator(".set-found .set-hit").first().waitFor();
  assert.equal(await box.inputValue(), "voice", "the box keeps what was typed while the list is drawn again");
  await box.fill("zzqqxx");
  await page.waitForFunction(() => document.querySelectorAll('.set-nav [data-act="setpage"]').length === 0);
  await page.locator(".set-nav").getByText("No page matches.", { exact: true }).waitFor({ timeout: 5000 });
  await box.fill("");
  await page.waitForFunction((n) => document.querySelectorAll('.set-nav [data-act="setpage"]').length === n, all.length);
  assert.deepEqual(errors, []);
});

const search = async (page, words) => {
  await page.locator("#lx-settings-search").fill(words);
  await page.waitForFunction((typed) => !typed || document.getElementById("sg-results"), words);
};

/** The head as drawn, and the results it counts: the cards on show plus everything "Also found" lists. */
const head = (page) => page.evaluate(() => {
  const box = document.getElementById("sg-results");
  const cards = [...document.querySelectorAll(".lx-page:not([hidden]) :is(.lx-subpanel > *, .lx-page > *)")]
    .filter((card) => !card.matches(".lx-page-title, .lx-page-intro, .lx-subtabs, .lx-subpanel, .lx-on-this-page, .sg-head, .lx-miss")
      && card.checkVisibility()).length;
  /* "Show all N" names the whole count when only the first few are listed. */
  const all = document.querySelector("#sg-found .sg-found-all");
  const also = all ? Number(all.textContent.match(/\d+/)[0]) : document.querySelectorAll("#sg-found .sg-found-item").length;
  return box && {
    first: box === document.getElementById("lx-settings-body").firstElementChild,
    role: box.getAttribute("role"),
    level: box.querySelector("h2") ? 2 : null,
    title: box.querySelector("h2")?.textContent, line: box.querySelector(".sg-results-for")?.textContent,
    lineShown: box.querySelector(".sg-results-for")?.checkVisibility(), counted: cards + also,
    empty: document.getElementById("lx-settings-empty")?.textContent ?? null,
  };
});

// Redesign: Coming soon (sw:lang), checked at fc541c24.
test.skip("DG-061 in French the head, its plural and the empty line are French", async (t) => {
  const { page, errors } = await settings(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await search(page, "voix");
  const seen = await head(page);
  const plural = await page.evaluate((n) => new Intl.PluralRules("fr").select(n), seen.counted);
  assert.equal(seen.title, `${seen.counted} ${plural === "one" ? "résultat" : "résultats"}`, "French plural, 0 and 1 singular");
  assert.equal(seen.line, "pour « voix »");
  await search(page, "zzqqxx");
  const none = await head(page);
  assert.equal(none.title, "0 résultat", "French counts nothing in the singular");
  assert.equal(none.empty, "Rien ne correspond. Essayez un mot plus court.");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (/settings-index.js is gone; the prototype searches page names), and French waits on
// sw:lang, Coming soon, checked at fc541c24.
test.skip("DG-061 every setting the search can find has French words, drawn or not", async (t) => {
  const { page, errors } = await settings(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const missing = await page.evaluate(async () => {
    const { SETTINGS_INDEX } = await import("/settings-index.js");
    const { fromEnglish } = await import("/i18n.js");
    return SETTINGS_INDEX.flatMap((row) => [row[3], row[6]]).filter((words) => words && fromEnglish(words) === null);
  });
  assert.deepEqual(missing, [], "no indexed setting or card title is left without French");
  /* And through the window: a chat app whose control is not drawn yet is found by its French name. */
  await search(page, "twitch");
  const found = await page.locator("#sg-found .sg-found-words b").allTextContents();
  assert.ok(found.includes("Chat Twitch"), `found in French (${found.join(", ")})`);
  assert.ok(!found.includes("Twitch chat"), "not in the index's English");
  assert.deepEqual(errors, []);
});

