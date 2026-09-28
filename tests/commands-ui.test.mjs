/**
 * The shared commands in the app window and on the dashboard, used the way a person uses them:
 * typing "/" in the message box, the card in Settings › General, and the dashboard's command line.
 * Headless browser only; no window opens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { saveDashboardSettings } from "../dist/dashboard-api.js";
import { lockdownState } from "../dist/lockdown.js";
import { openPlace } from "./places.mjs"; // used by the skipped old-window tests

async function fixture(t, viewport = { width: 1280, height: 900 }, mode = "on") {
  const root = await mkdtemp(join(tmpdir(), "branch-commands-ui-"));
  const provider = { name: "commands-ui", calls: 0, complete: async () => { provider.calls += 1; return { content: "Done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  if (mode) saveCommandSettings(app.store, app.runtime.owner, { mode });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, server, page, errors, provider };
}
const submit = (page) => page.locator("#send").click();
/** The command's answer, drawn in the conversation (public/app/chat/chat.js command()). */
const answered = (page, text) => page.locator("#conversation").getByText(text).first().waitFor({ timeout: 20000 });

/* Redesign: the new window's "/" list is the prototype's (.slash6 over the composer, public/app/chat/messages.js). */
test("typing / lists the window's commands, and Tab fills one in", async (t) => {
  const { page, errors } = await fixture(t);
  await page.locator("#prompt").fill("/");
  await page.locator("#prompt").press("End");
  await page.keyboard.type("to");
  const menu = page.locator(".slash6");
  await menu.waitFor({ state: "visible" });
  assert.match(await menu.textContent(), /\/tokens/);
  assert.doesNotMatch(await menu.textContent(), /\/switch|\/exit/, "terminal-only commands are not offered here");
  await page.locator("#prompt").press("Tab");
  assert.equal(await page.locator("#prompt").inputValue(), "/tokens ");
  assert.equal(await menu.count(), 0);
  assert.deepEqual(errors, []);
});

/* Redesign: a command's answer is drawn in the conversation, not in a toast. */
test("a command runs without reaching the model, and a place command opens the place", async (t) => {
  const { app, page, errors, provider } = await fixture(t);
  const before = app.store.runs(app.runtime.owner).map((run) => run.id).sort();
  await page.locator("#prompt").fill("/status");
  await submit(page);
  await answered(page, "When to check with you");
  assert.equal(provider.calls, 0, "nothing was sent to the model");
  assert.deepEqual(app.store.runs(app.runtime.owner).map((run) => run.id).sort(), before, "no command started a task");
  await page.locator("#prompt").fill("/lockdown on");
  await submit(page);
  await answered(page, "Lockdown is on");
  assert.equal(lockdownState(app.store, app.runtime.owner).on, true);
  await page.locator("#prompt").fill("/go library memory");
  await submit(page);
  // As in the prototype, a place command opens the place at once and says nothing there (the lead, 2026-09-26).
  await page.locator('#main [data-act="ptab"][data-place="library"][data-v="memory"][aria-selected="true"]').waitFor({ timeout: 10000 });
  assert.equal(provider.calls, 0, "no command reached the model");
  assert.deepEqual(errors, []);
});

/* Redesign: with the switch off the prototype's list still opens, and offers only what the engine lists for the window
   when off: the commands the window always had (GET /api/commands?surface=window, listed). */
test("with the switch off the list offers only the commands the window always had, and /help lists them", async (t) => {
  // Batch A: this computer's window ships the switch on (src/commands/settings.ts windowShipsAs), so off is saved here.
  const { page, errors } = await fixture(t, undefined, "off");
  await page.locator("#prompt").fill("/");
  await page.locator("#prompt").dispatchEvent("input");
  const menu = page.locator(".slash6");
  await menu.waitFor({ state: "visible" });
  // /prompts is the prompt library's own command, and that library ships on (src/prompt-library.ts).
  assert.deepEqual(await menu.locator("[role=option] b").allTextContents(), ["/help", "/model", "/goal", "/prompts"]);
  await page.locator("#prompt").fill("/to");
  await page.locator("#prompt").dispatchEvent("input");
  await page.waitForTimeout(500);
  assert.equal(await menu.count(), 0, "/tokens is not offered with the switch off");
  await page.locator("#prompt").fill("/help");
  await submit(page);
  await answered(page, "Commands you can type here");
  const text = await page.locator("#conversation").innerText();
  const lines = text.slice(text.lastIndexOf("Commands you can type here")).split("\n").slice(1).filter((line) => line.startsWith("/")).map((line) => line.split(" ")[0]);
  assert.deepEqual(lines, ["/help", "/model", "/goal"], "goal mode (public/goal.js) brought /goal to the window before this table");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24; the card itself is replaced by the new window.
test.skip("the commands card is written in French when French is chosen", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await openPlace(page, "settings:general");
  await page.locator("#commands-card h2").filter({ hasText: "Commandes tapées" }).waitFor();
  assert.deepEqual(errors, []);
});

test("the dashboard's command line answers, and a key that may only look can still ask", async (t) => {
  const { app, server, page, errors } = await fixture(t);
  saveDashboardSettings(app.store, app.runtime.owner, { mode: "when-needed" });
  await page.goto(server.url + "/dashboard");
  const input = page.locator("#db-command");
  await input.waitFor({ state: "visible" });
  await input.fill("/status");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator("#db-command-answer").filter({ hasText: "Nothing is working right now" }).waitFor();
  const read = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read" }).token;
  await page.evaluate((key) => sessionStorage.setItem("branch-token", key), read);
  await page.reload();
  await input.waitFor({ state: "visible" });
  await input.fill("/whoami");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator("#db-command-answer").filter({ hasText: "may only look" }).waitFor();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(sideways, false);
  assert.deepEqual(errors, []);
});
