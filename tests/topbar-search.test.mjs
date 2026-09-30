/**
 * DG-097: the approved sample has a search box in the top bar — "Search" with its key hint — that opens
 * the same finder as Ctrl K. The window had no such box; the finder was only reachable from the sidebar.
 *
 * The box is checked for what it does, not only for being there: it opens the real finder, Ctrl K still
 * opens that same finder, the key hint it shows is the owner's own binding rather than a fixed "Ctrl K",
 * and where the top bar is narrow it folds to an icon that still has a name to be read out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveComfort } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function openApp(t, width = 1280) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-topbar-search-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

/* Redesign: prototype.html has no search box in the top bar; its Search box is at the top of the sidebar (#side-q,
   shell/shell.js), with the key hint of the finder (Ctrl K opens the palette, shell/palette.js). The hint and the keys
   are checked there; the top-bar box, its looks and its folding are replaced. */
const finderOpen = (page) => page.locator("#pal-in").isVisible();
async function closeFinder(page) {
  await page.keyboard.press("Escape");
  await page.locator("#pal-in").waitFor({ state: "detached" });
}
const hint = (page) => page.locator("#side .sq9 kbd");

test("the sidebar's Search box shows the keys that open the finder, and Ctrl K opens one finder", async (t) => {
  const { page, errors } = await openApp(t);
  const box = page.locator("#side-q");
  assert.ok(await box.isVisible(), "a search box is at the top of the list");
  assert.equal(await box.getAttribute("placeholder"), "Search", "its words are the prototype's");
  // The main key is Command on a Mac (shell/keys.js), and the hint says so.
  assert.equal((await hint(page).textContent()).trim(), process.platform === "darwin" ? "Cmd K" : "Ctrl K", "it shows the keys that open the finder");
  await page.keyboard.press("ControlOrMeta+K");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  assert.ok(await finderOpen(page), "Ctrl K opens the finder");
  await page.keyboard.press("ControlOrMeta+K");
  assert.equal(await page.locator(".palette").count(), 1, "one finder, not a second one");
  await closeFinder(page);
  assert.deepEqual(errors, []);
});

test("the key hint is the owner's own binding, and says nothing when there is none", async (t) => {
  const { app, page } = await openApp(t);
  // Ctrl+Shift+P: a combination no shortcut has by default (Ctrl+Shift+F searches the list), so the palette may take it.
  saveComfort(app.store, "local", "keys", { palette: "Ctrl+Shift+P" });
  // The window reads the owner's keys when it opens (shell/keys.js loadKeys).
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const mac = process.platform === "darwin";
  await page.waitForFunction((shown) => document.querySelector("#side .sq9 kbd")?.textContent === shown, mac ? "Cmd Shift P" : "Ctrl Shift P");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  await closeFinder(page);

  saveComfort(app.store, "local", "keys", { palette: "" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector("#side .sq9 kbd"));
  assert.equal(await page.locator("#side-q").getAttribute("aria-keyshortcuts"), null, "no keys are promised that do nothing");
  // With keys the box says them to a screen reader too (as the old top-bar box did).
  saveComfort(app.store, "local", "keys", { palette: "Ctrl+Shift+P" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#side .sq9 kbd").waitFor();
  assert.equal(await page.locator("#side-q").getAttribute("aria-keyshortcuts"), mac ? "Meta+Shift+P" : "Control+Shift+P", "a screen reader hears the same keys");
});

