import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

/* Redesign: the new window (public/app/**). Its first run's "Practice first" says practice mode in prototype.html's words;
   the conversation is sent from the message box (#prompt, #send) and answered by the offline demonstration; words said
   earlier are found from the sidebar's Search (its Messages); the window fits a phone. The acorn artwork, the old
   History reader and the "Remember something" box are not in the design (it remembers through its /learn command and
   the memory it proposes). */
test("browser UI connects, runs demo, finds it again, and fits mobile viewport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) }); // the first-run card (#323) is not what this is about
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#prompt").fill("Try the file workflow");
  await page.locator("#send").click();
  await page.locator("#conversation").getByText(/wrote, read, and verified/).first().waitFor({ timeout: 30000 });
  /* Found again by its words from the sidebar's Search, and opened. */
  await page.getByRole("button", { name: "New conversation, Trunk, room or automation" }).click();
  await page.getByRole("menuitem", { name: /^New conversation/ }).click();
  await page.locator("#side-q").fill("verified");
  const found = page.locator('#side [data-act="sr-msg"]').first();
  await found.waitFor({ timeout: 10000 });
  await found.click();
  await page.locator("#conversation").getByText(/wrote, read, and verified/).first().waitFor({ timeout: 10000 });
  if (process.env.BRANCH_SCREENSHOT_DIR) {
    await mkdir(process.env.BRANCH_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.BRANCH_SCREENSHOT_DIR, "branch-desktop.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.BRANCH_SCREENSHOT_DIR)
    await page.screenshot({ path: join(process.env.BRANCH_SCREENSHOT_DIR, "branch-mobile.png"), fullPage: true });
  /* "Practice first" and the demo model are gone (#359, the owner's decision): with no model the engine refuses in
     plain words and the window points to setup, which the engine's own tests check. */
  assert.deepEqual(errors, []);
});

