/* DG-116, DG-117, DG-118: the side panel card's own foot switch, the Terminal tab's "Open a terminal for me", and its
   close control and Escape, as in the approved sample. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

/* Redesign: the new window's side panel (chat/pane.js, #pane), opened by the conversation header's side-panel button.
   prototype.html's panel has no foot switch; its Terminal tab draws "Open a terminal for me" greyed out. */
async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-side-foot-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const run = app.store.createRun(app.runtime.owner, "Compare the quotes");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Here is a short answer." });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await openChat(page, run.sessionId);
  await page.locator("#conversation .b").first().waitFor();
  return { page, errors, sessionId: run.sessionId };
}
const paneToggle = (page) => page.locator('.head [data-act="pane"][data-p="activity"]');
async function openCard(page) {
  await paneToggle(page).click();
  await page.waitForFunction(() => document.getElementById("pane")?.hidden === false);
}
const tab = (page, id) => page.locator(`#pane .ptab[data-p="${id}"]`).click();

// Redesign: Coming soon (shell), checked at e5b8a610: the Terminal tab draws "Open a terminal for me" greyed out.
test.skip("DG-117 the Terminal tab offers Open a terminal for me, the sample's small button, joining this conversation safely", async (t) => {
  const { page, errors, sessionId } = await fixture(t);
  await openCard(page);
  await tab(page, "terminal");
  const open = page.locator("#panels-terminal-open");
  await open.waitFor();
  assert.equal((await open.textContent()).trim(), "Open a terminal for me");
  const shape = await open.evaluate((el) => { const s = getComputedStyle(el); return [el.getBoundingClientRect().height, s.fontSize, s.fontWeight, s.borderTopLeftRadius]; });
  assert.deepEqual(shape, [30, "12.5px", "540", "9px"], "the sample's small button");
  assert.equal(await page.locator("#panels-terminal-attach").isVisible(), false, "only the button until pressed");
  await open.click();
  assert.equal(await open.getAttribute("aria-expanded"), "true");
  const shown = await page.locator("#panels-terminal-attach code").textContent();
  assert.equal(shown, `branch chat --attach --session ${sessionId}`, "the existing way in: this conversation, through the same rules");
  /* It stays open across the tab's own redraws. */
  await page.waitForTimeout(3500);
  assert.equal(await page.locator("#panels-terminal-attach").isVisible(), true);
  await page.locator("#panels-terminal-open").click();
  assert.equal(await page.locator("#panels-terminal-attach").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("DG-118 the panel's own close puts it away, hands the keyboard back, and the title bar agrees", async (t) => {
  // Redesign: prototype.html's Escape closes a menu, a dialog, a note or Focus mode, not the side panel.
  const { page, errors } = await fixture(t);
  await openCard(page);
  const close = page.getByRole("button", { name: "Close the side panel", exact: true });
  await close.click();
  await page.waitForFunction(() => document.getElementById("pane")?.hidden === true);
  assert.deepEqual(errors, []);
  assert.equal(await paneToggle(page).getAttribute("aria-pressed"), "false", "the switch says closed (prototype.html: aria-pressed)");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.act), "pane", "the keyboard goes back to the side-panel switch");
  await openCard(page);
  assert.equal(await paneToggle(page).getAttribute("aria-pressed"), "true", "and open");
});

// Redesign: Coming soon (sw:lang), checked at e5b8a610.
test.skip("DG-115 in French all six tabs keep their names in the 340 px card", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  for (const id of ["activity", "browser", "terminal"]) {
    await tab(page, id);
    await page.waitForFunction(() => document.querySelector('.lx-pane-tab[data-pane="browser"] .lx-words')?.textContent === "Navigateur");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const words = await page.evaluate(() => [...document.querySelectorAll("#context-panel .lx-pane-tab .lx-words")]
      .map((word) => ({ text: word.textContent, shown: word.getClientRects().length > 0, cut: word.scrollWidth > word.clientWidth + 1 })));
    assert.equal(words.length, 6);
    assert.deepEqual(words.filter((word) => !word.shown || word.cut).map((word) => word.text), [], `${id}: every name shows whole`);
  }
  assert.deepEqual(errors, []);
});
