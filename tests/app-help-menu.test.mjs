/**
 * The menu bar's Help (attach-4), on every system once a window is open: "What can Branch do" and "About Branch", each
 * opened in the window. Pure halves (src/desktop/app-menu.ts) plus the window's side (public/app/shell/shell.js, through
 * the desktop's onHelp, stood in for here); the Electron wiring is in main.ts and preload.cts.
 * Mutations, each turns a test here red:
 * - src/desktop/app-menu.ts: leave Help out: the menu has no Help.
 * - public/app/shell/shell.js: drop the onHelp line: Help opens nothing in the window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
import { appMenuTemplate } from "../dist/desktop/app-menu.js";

const paste = { label: "Paste", click: () => undefined };

test("Help is on every system's menu bar once a window is open, and each item names what it opens", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const opened = [];
    const menu = appMenuTemplate(platform, paste, (item) => opened.push(item));
    const help = menu.at(-1);
    assert.equal(help.role, "help", platform);
    assert.deepEqual(help.submenu.map((one) => one.label), ["What can Branch do", "About Branch"], platform);
    for (const one of help.submenu) one.click();
    assert.deepEqual(opened, ["whatcan", "about"], platform);
    assert.equal(appMenuTemplate(platform, paste).some((one) => one.role === "help"), false, `${platform}: control: no window, no Help`);
  }
});

test("Help's items open What can Branch do and About Branch in the window", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-help-menu-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Hi.", toolCalls: [] }; } } });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  closing.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // What the desktop's preload gives the page: Help's item, as the menu bar sends it.
  await page.addInitScript(() => { window.branchDesktop = { onHelp: (callback) => { window.helpFromMenu = callback; } }; });
  await signIn(page, server);
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForFunction(() => typeof window.helpFromMenu === "function", null, { timeout: 30000 });

  await page.evaluate(() => window.helpFromMenu("about"));
  const about = page.getByRole("dialog", { name: "About Branch" });
  await about.waitFor({ timeout: 30000 });
  assert.match(await about.innerText(), new RegExp(`Branch Agent ${app.version ?? ""}`));
  await page.evaluate(() => window.helpFromMenu("whatcan"));
  await page.getByRole("dialog", { name: "What can Branch do" }).waitFor({ timeout: 30000 });
  assert.equal(await about.count(), 0, "one dialog at a time");
  assert.deepEqual(errors, []);
});
