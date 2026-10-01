/* "Real or greyed, never fake": a row that describes how Branch always works is plain words, not a switch or a button
   drawn greyed. These keys were greyed controls whose own reason said "not a setting" (the greyed sweep,
   briefs/status/greyed-remaining.md); each is now drawn as its title and that sentence (settings/rows15.js fact15, or the
   sentence beside the live controls), with no control.
   The test walks every Settings page at the most detailed level and the places, dialogs and menu those rows sat in,
   collects every greyed control, resolves its key the way core/why.js reasonFor does, and fails on any key below; and it
   checks each row is still there, as words.
   Mutation: draw any one of them again as a greyed switch (say advanced.js "Follow-up tasks" back to an
   <input class="sw" id="f15-follow-up-tasks">) and this goes red, naming the key and where. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, setLevel } from "./settings-window.mjs";
import { openPlace } from "./new-window-places.mjs";

/* Drawn as a row of words (data-fact) on a Settings page. */
const SETTINGS_FACTS = [
  "f15-share-memory-between-trunks", "f15-procedures-that-start-themselves", "f15-use-what-the-trigger-sent",
  "f15-projects-pick-up-matching-work", "f15-follow-up-tasks", "f15-always-read-in-full", "f15-deep-research-reports",
  "f15-edit-documents-exactly", "f15-tables-and-charts-from-spreadsheets", "f15-code-map", "f15-load-tools-only-when-needed",
  "f15-portable-mode", "f15-save-task-trajectories", "f15-hold-back-keys-found-in-answers", "when-tools-are-loaded",
  "pp-own", "f15-listening",
];
/* Said beside live controls, or in a place, a dialog or a menu. */
const ELSEWHERE = ["f15-status-line-script", "pp-may", "si-lock", "grp-talk", "d17-handoffcli", "d17-hooks-go", "prompt-try", "scope"];
const NOT_A_SETTING = [...SETTINGS_FACTS, ...ELSEWHERE];

const SETTINGS_PAGES = ["general", "models", "accounts", "local", "usage", "instructions", "appearance", "voice", "notifications",
  "permissions", "people", "secrets", "computer", "chatapps", "gateway", "data", "updates", "self", "developer", "advanced", "achievements"];

/** Every greyed control on the page now, by the key its reason is read from (core/why.js reasonFor's order). */
const greyedKeys = (page) => page.evaluate(async () => {
  const { reason } = await import("/app/core/why.js");
  const keyOf = (el) => {
    const row = el.matches(".pat15") ? el : el.closest(".ctl, .prow, .tile, .fld, .row, .cl-offer17d, .ko-banner, .comp7-card, .status") ?? el.closest(".acts, .chips8");
    const tries = [el.dataset.why, el.id, el.dataset.act, el.dataset.sw && el.dataset.sw !== "set" ? el.dataset.sw : "", row?.dataset.why];
    return tries.find((k) => k && reason(k)) ?? tries.find(Boolean) ?? "";
  };
  return [...document.querySelectorAll(".soon, [aria-disabled='true'], :disabled")].map(keyOf);
});
/** The sentence kept for a key (window.why.<key>), as the window says it. */
const words = (page, key) => page.evaluate(async (k) => (await import("/app/core/why.js")).reason(k), key);
/** Presses a window action the way a click on its button would (core/actions.js reads the pressed element's data). */
const act = (page, name, data = {}) => page.evaluate(([n, d]) => {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.act = n;
  Object.assign(b.dataset, d);
  document.body.append(b);
  b.click();
  b.remove();
}, [name, data]);

test("rows about how Branch always works are words, never a greyed control", async (t) => {
  const { page, errors } = await settingsWindow(t, { width: 1440, height: 950, name: "not-a-setting" });
  const seen = [], facts = new Set();
  const look = async (where) => {
    for (const key of await greyedKeys(page)) if (NOT_A_SETTING.includes(key)) seen.push(`${key} in ${where}`);
    for (const key of await page.locator("[data-fact]").evaluateAll((els) => els.map((e) => e.dataset.fact))) facts.add(key);
  };

  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator(".settings").waitFor();
  await setLevel(page, "technical");
  for (const id of SETTINGS_PAGES) {
    const link = page.locator(`[data-act="setpage"][data-v="${id}"]`).first(); // a page may be listed twice (a shortcut row)
    if (!(await link.count())) continue;
    await link.click();
    await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).first().waitFor();
    await page.waitForTimeout(150);
    await look(`settings/${id}`);
    if (id === "developer") assert.ok((await page.locator('[data-act="dv-status"]').first().locator("xpath=ancestor::div[contains(@class,'ctl')]").innerText()).includes(await words(page, "f15-status-line-script")), "the status line row says there is no script of yours");
    if (id === "people") assert.ok(await page.getByText(await words(page, "pp-may")).count(), "May says it follows from the role");
  }
  assert.deepEqual(SETTINGS_FACTS.filter((k) => !facts.has(k)), [], "every one is still a row, as words");
  await page.locator(".set-back").click();

  await openPlace(page, "team", "signin");
  await page.locator('#main [data-fact="si-lock"]').waitFor({ timeout: 10000 });
  await look("team/signin");
  await openPlace(page, "customize", "specialists");
  await page.getByText(await words(page, "d17-handoffcli")).waitFor();
  await look("customize/specialists");
  await act(page, "grp-new");
  await page.locator('.dlg [data-fact="grp-talk"]').waitFor();
  await look("the new group dialog");
  await act(page, "dlg-close");
  await act(page, "prompt-new");
  await page.locator(".dlg #pr-name").waitFor();
  assert.ok(await page.locator(".dlg").getByText(await words(page, "prompt-try")).count(), "the new prompt dialog says where to try two models");
  await look("the new prompt dialog");
  await act(page, "dlg-close");
  await openPlace(page, "automations", "triggers");
  await page.locator('#main [data-act="demob17"][data-k="hooks"]').click();
  await page.locator(".dlg .demo-b17").waitFor({ state: "attached" });
  assert.equal(await page.locator('.dlg [data-act^="demodob17"]').count(), 0, "hooks run on their events only: no Run the checks");
  assert.ok((await page.locator(".dlg .lead-b17").innerText()).includes(await words(page, "d17-hooks-go")));
  await act(page, "dlg-close");
  await page.locator('#side [data-act="newconv"], #side [data-act="newmenu"]').first().click();
  await page.locator('.pop [data-act="newconv"]').click().catch(() => {});
  await page.locator('[data-act="modemenu2"]').first().click();
  await page.locator(".pop .scope15").waitFor();
  assert.equal(await page.locator('.pop [data-act="scope"]').count(), 0);
  await look("the mode menu");

  assert.deepEqual(seen, []);
  assert.deepEqual(errors, []);
});
