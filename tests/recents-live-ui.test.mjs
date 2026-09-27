/**
 * Dogfood B10: a task started from the terminal or another program did not show in the window's Recents until a
 * reload; only the window's own tasks told Recents to look again. The window's regular refresh now notices a task
 * starting or ending anywhere and Recents follows. The new window reads the conversation list again on every engine
 * event (public/app/main.js, core/state.js refresh), so this checks its side list (#side) does the same.
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

test("dogfood B10: a task started outside the window shows in Recents while it runs, without a reload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-recents-live-"));
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  const provider = { name: "scripted", async complete() { await held; return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), presets: [{ id: "main", name: "S", provider, model: "m" }] });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { answer(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const recents = () => page.evaluate(() => document.getElementById("side")?.innerText ?? "");
  await page.waitForTimeout(1500); // the rail has drawn once, with nothing in it
  assert.doesNotMatch(await recents(), /zebra crossing/);
  // Started the way a terminal or another program does: straight at the API, not from this window.
  const outside = app.runtime.run({ prompt: "zebra crossing report" });
  await page.waitForFunction(() => /zebra crossing/.test(document.getElementById("side")?.innerText ?? ""),
    undefined, { timeout: 15000 });
  answer();
  assert.equal((await outside).status, "completed");
  assert.deepEqual(errors, []);
});
