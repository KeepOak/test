/* UI-099: every setting explains itself. Each titled Settings row, on every page at the most detailed level, carries a
   line saying what it does (its <small>), or a tip, or the reason it is held (core/why.js). Walked in English and in
   German, so a line drawn from English through say() is translated as well.
   Mutation: empty any row's <small> (say updates.js "What's new") and this goes red, naming the page and the row. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, setLevel } from "./settings-window.mjs";

const PAGES = ["general", "models", "accounts", "local", "usage", "instructions", "appearance", "voice", "notifications", "permissions",
  "people", "secrets", "computer", "chatapps", "gateway", "data", "updates", "self", "developer", "advanced", "achievements"];

const bareRows = (page) => page.evaluate(() => [...document.querySelectorAll("#main .ctl, #main label.prow")].map((row) => {
  const title = (row.querySelector(":scope > b") ?? row.querySelector(":scope > .grow > b"))?.textContent.trim() ?? "";
  const note = (row.querySelector(":scope > small") ?? row.querySelector(":scope > .grow > small"))?.textContent.trim() ?? "";
  const tip = row.dataset.tip || row.querySelector("[data-tip]")?.dataset.tip || row.dataset.whyText || "";
  return title && !note && !tip ? title : "";
}).filter(Boolean));

/* English left in a German window: the lines drawn from English through say() (developer.js, computer.js, rows17.js). */
const SAID = /Sends each task's traces|After a task changes a file|What the personal-details check catches|Ask in a conversation to change a setting/;
async function walk(page, german = false) {
  const bare = [];
  for (const id of PAGES) {
    const link = page.locator(`[data-act="setpage"][data-v="${id}"]`).first();
    if (!(await link.count())) continue;
    await link.click();
    await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).first().waitFor();
    await page.waitForTimeout(200); // a page reads the engine once it is shown
    for (const title of await bareRows(page)) bare.push(`${id}: ${title}`);
    if (german) for (const line of await page.locator("#main small").allTextContents()) if (SAID.test(line)) bare.push(`${id}: English "${line.slice(0, 40)}"`);
  }
  return bare;
}

test("every Settings row says what it does, in English and in German", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "rows-explained" });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator(".settings").waitFor();
  await setLevel(page, "technical");
  assert.deepEqual(await walk(page), [], "English");

  await call("/api/comfort", { card: "display", values: { language: "de" } }).catch(() => null);
  await page.evaluate(async () => { localStorage.setItem("branch-language", "de"); });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 30000 });
  if (!(await page.locator(".settings").count())) await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator(".settings").waitFor();
  assert.deepEqual(await walk(page, true), [], "German, the lines drawn through say() translated too");
  assert.deepEqual(errors, []);
});
