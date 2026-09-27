/* DG-099: the top bar says where you are: in the new window a conversation's header names the conversation ("New
   conversation" before its first message) as its accessible heading, and a place names itself. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./new-window-places.mjs";

async function signedIn(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-topbar-crumbs-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
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
  errors.length = 0;
  return { page, errors };
}

/* Redesign: the prototype's header is not a crumb trail. Redesign (chrome pass, the owner's call): the title-bar row carries
   no brand and no face, and the conversation's name is not drawn there; the header is the conversation's own buttons in
   that row, and it keeps the name as its accessible heading ("New conversation" before the first message), so which
   conversation is open can still be told. A place names itself with its own heading. */
const crumbs = (page) => page.evaluate(() => {
  const shown = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden"
    && node.getBoundingClientRect().width > 1;
  const bar = document.querySelector(".titlebar");
  const head = bar.querySelector(".head");
  const heading = head?.querySelector('.who[role="heading"] > b');
  const place = [...document.querySelectorAll("#main .place h1")].find(shown);
  return {
    faces: [...bar.querySelectorAll(".av, .mark, .wordmark")].filter(shown).length,
    visibleName: [...bar.querySelectorAll(".who b")].filter(shown).length,
    thread: heading ? heading.textContent.trim() : null,
    title: place ? place.textContent.trim() : null,
    actions: head ? [...head.querySelectorAll("[data-act]")].filter(shown).map((b) => b.dataset.act) : [],
    rows: [...document.querySelectorAll("#main .head")].length,
  };
});

test("DG-099 at 1440 px a new conversation's header: no brand or face, its name as the heading, its buttons in the row", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const now = await crumbs(page);
  assert.equal(now.faces, 0, "no brand, mark or face in the title-bar row");
  assert.equal(now.visibleName, 0, "the name is not drawn in the row");
  assert.equal(now.title, null, "the place's own heading is not what shows in a conversation");
  assert.equal(now.thread, "New conversation");
  for (const act of ["pane", "find-open", "chatmenu"]) assert.ok(now.actions.includes(act), `${act} is in the title-bar row`);
  assert.equal(now.rows, 0, "no second header row above the conversation");
  assert.deepEqual(errors, []);
});

test("DG-099 a place shows its own name", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await openPlace(page, "library", "memory");
  await page.locator("#main .place h1").first().waitFor();
  const now = await crumbs(page);
  assert.match(now.title ?? "", /Library/);
  assert.equal(now.thread, null, "no conversation title outside a conversation");
  assert.deepEqual(errors, []);
});

test("DG-099 at 400 px the name stays the heading, the list's menu is in the row, and nothing scrolls sideways", async (t) => {
  const { page, errors } = await signedIn(t, 400);
  const now = await crumbs(page);
  assert.equal(now.thread, "New conversation");
  assert.equal(now.faces, 0, "no brand, mark or face in the title-bar row");
  assert.ok(now.actions.includes("side"), "the list's menu button is in the title-bar row");
  assert.equal(now.rows, 0, "no second header row above the conversation");
  await page.locator('.titlebar [data-act="side"]').click();
  await page.waitForFunction(() => document.getElementById("app").classList.contains("side-open"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});

test("DG-099 in French the new conversation's title is French", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  // A new conversation in the French window: the header says the French words for it.
  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  await page.waitForFunction((words) => [...document.querySelectorAll('.titlebar .head .who[role="heading"] > b')].some((node) => node.textContent.trim() === words),
    french["comfort.field.newConversation"]);
  const now = await crumbs(page);
  assert.notEqual(now.thread, "New conversation");
  assert.equal(now.thread, french["comfort.field.newConversation"]);
  assert.deepEqual(errors, []);
});
