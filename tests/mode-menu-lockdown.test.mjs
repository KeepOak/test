/* The mode chip's menu, as the approved sample draws it: the four modes, then Lockdown as its own
   checkbox row tied to the one real Lockdown switch, then the two lines saying where new conversations
   start and where the other choices are. Shift+Tab in the message box moves to the next mode. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function windowFixture(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-mode-menu-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json();
  };
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { call, page, errors };
}
/* Redesign: the mode chip is the new window's [data-act="modemenu2"] in the message box (public/app/chat/chips.js); its
   menu is the popover (#app > .pop) with the four modes (data-act="set-mode") and the Lockdown switch (#pm-lock2),
   1:1 with the prototype's POPS.modemenu2. */
const chip = (page) => page.locator('#composer [data-act="modemenu2"]');
const chipSays = (page, words) => page.waitForFunction((w) => document.querySelector('#composer [data-act="modemenu2"]')?.textContent.trim() === w, words, { timeout: 10000 });
const newMenu = async (page) => {
  if (!(await page.locator("#app > .pop").count())) await chip(page).click();
  const menu = page.locator("#app > .pop");
  await menu.waitFor({ state: "visible" });
  return menu;
};
const open = async (page) => {
  if (await page.locator("#mode-menu").isHidden()) await page.locator('#composer [data-act="modemenu2"]').click();
  await page.locator("#mode-menu").waitFor({ state: "visible" });
};
const notes = (page) => page.locator("#mode-menu .mode-note").allInnerTexts();

/* Redesign: the new menu is the prototype's four modes, then "Applies to", then the Lockdown switch (a checkbox named
   Lockdown, its shield in the danger colour). "No approvals", "Use my setting" and the switch's own sentence are the old
   menu's (replaced by the new window). */
test("Lockdown is the menu's checkbox row, and it turns the one real switch on and off", async (t) => {
  const f = await windowFixture(t);
  const menu = await newMenu(f.page);
  assert.deepEqual((await menu.locator('[data-act="set-mode"] .mi-t').allInnerTexts()).map((s) => s.trim()), ["Auto", "Ask first", "Plan first", "Full access"]);
  const lock = menu.getByRole("checkbox", { name: "Lockdown", exact: true });
  assert.equal(await lock.isChecked(), false);
  const shield = await menu.locator(".row-in:has(#pm-lock2) > span").first().evaluate((node) => getComputedStyle(node).color);
  const bad = await f.page.evaluate(() => { const probe = document.createElement("i"); probe.style.color = "var(--bad)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
  assert.equal(shield, bad, "the shield is red");
  await lock.check();
  await chipSays(f.page, "Lockdown");
  assert.equal((await f.call("/api/lockdown")).on, true, "the real switch is on");
  const again = await newMenu(f.page);
  assert.equal(await again.getByRole("checkbox", { name: "Lockdown", exact: true }).isChecked(), true);
  assert.equal(await again.locator('[data-act="set-mode"][data-v="full"]').isDisabled(), true, "refusals are unchanged");
  await again.getByRole("checkbox", { name: "Lockdown", exact: true }).uncheck();
  await chipSays(f.page, "Ask first");
  assert.equal((await f.call("/api/lockdown")).on, false);
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (the two lines under the menu are not in the prototype's POPS.modemenu2).
test.skip("the two lines under the menu show in every state, truthfully, in English and French", async (t) => {
  const f = await windowFixture(t);
  const line1 = "New conversations start on Ask first. Branch's own setting (Settings › Permissions) is still No approvals.";
  const line2 = "Shift+Tab in the message box moves to the next mode. More choices (Just do it inside my workspace, Read only) are in Settings › Permissions.";
  for (const everything of ["on", "off"]) for (const theme of ["dark", "light"]) for (const width of [1440, 860, 400]) {
    await f.page.setViewportSize({ width, height: 900 });
    await f.page.evaluate(([e, th]) => { document.documentElement.dataset.everything = e; document.documentElement.dataset.theme = th; }, [everything, theme]);
    await open(f.page);
    const said = await notes(f.page);
    assert.deepEqual(said.slice(-2), [line1, line2], `${everything}/${theme}/${width}`);
    const box = await f.page.locator("#mode-menu").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, `the menu fits at ${width}px`);
    await f.page.keyboard.press("Escape");
  }
  await f.call("/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true });
  await f.page.evaluate(() => globalThis.branchConversationMode.refresh());
  await open(f.page);
  assert.equal((await notes(f.page)).at(-2), "New conversations start on No approvals. Branch's own setting (Settings › Permissions) is still No approvals.", "the live default, not a frozen one");
  await f.page.keyboard.press("Escape");
  await f.call("/api/lockdown", { on: true });
  await f.page.evaluate(() => globalThis.branchConversationMode.refresh());
  await open(f.page);
  assert.equal((await notes(f.page)).at(-1), line2, "still there under Lockdown");
  await f.call("/api/lockdown", { on: false });
  await f.page.keyboard.press("Escape");
  await f.page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await f.page.evaluate(() => globalThis.branchConversationMode.refresh());
  await open(f.page);
  assert.match((await notes(f.page)).at(-1), /^Maj\+Tab dans la zone de message passe au mode suivant\./);
  assert.deepEqual(f.errors, []);
});

/* Redesign: the prototype's Shift+Tab in the message box goes round the modes the person may pick, in the menu's order
   (Auto, Ask first, Plan first, Full access; a blocked one is left out), and keeps the cursor in the box. For the owner
   Full access is in that order, so "never to No approvals" and its sentence are replaced by the new window. The
   prototype's slash list (.slash6) keeps Tab for itself. */
test("Shift+Tab in the message box moves to the next mode it can pick, never to No approvals", async (t) => {
  const f = await windowFixture(t);
  await chipSays(f.page, "Ask first");
  await f.page.locator("#prompt").focus();
  for (const next of ["Plan first", "Full access", "Auto", "Ask first"]) {
    await f.page.keyboard.press("Shift+Tab");
    await chipSays(f.page, next);
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), "prompt", "the cursor stays in the message box");
  }
  await f.page.evaluate(() => { const list = document.createElement("div"); list.className = "slash6"; document.body.append(list); });
  await f.page.keyboard.press("Shift+Tab");
  await f.page.evaluate(() => document.querySelector(".slash6").remove());
  assert.equal((await chip(f.page).innerText()).trim(), "Ask first", "the slash list keeps Tab for itself");
  assert.deepEqual(f.errors, []);
});
