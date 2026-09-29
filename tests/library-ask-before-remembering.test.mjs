/**
 * QA retest 2026-09-28 (m11): "approve memory changes" (src/memory-review.ts requireApproval) had no control in the
 * window; the Library said "Trunks suggest what to remember and you decide" while every note was kept at once. Library ›
 * Memory now has the switch, says what happens without it, and switching it on sends the whole setting so the other
 * half (review) is kept. Node only: the real dist/ and public/, headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, openPlace } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";

test("Library › Memory switches Ask me before remembering, and a note then waits for Accept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ask-before-remembering-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  app.store.review.configure("local", { review: true, requireApproval: false });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: '{"done":true}' });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, server);
  await openPlace(page, "library", "memory");
  const ask = page.locator("#mem-ask15");
  await ask.waitFor();
  assert.equal(await ask.isChecked(), false, "it shows the engine's setting");
  assert.match(await page.locator("#main .memst15").innerText(), /Trunks remember what you ask them to/, "and says what happens now");
  await ask.click();
  for (let i = 0; i < 50 && !app.store.review.settings("local").requireApproval; i++) await page.waitForTimeout(100);
  assert.deepEqual(app.store.review.settings("local"), { review: true, requireApproval: true }, "switched on, with the other half kept");
  await page.waitForFunction(() => /you decide/.test(document.querySelector("#main .memst15")?.textContent ?? ""));

  const saved = await app.runtime.executeTool("memory.put", { text: "I prefer teal", source: "Owner preference", kind: "preference" });
  assert.equal(saved.staged, true, "a note now waits for the owner");
  assert.equal(app.store.list("memory", "local").length, 0);
  await ask.click();
  for (let i = 0; i < 50 && app.store.review.settings("local").requireApproval; i++) await page.waitForTimeout(100);
  assert.equal(app.store.review.settings("local").requireApproval, false, "and it switches off again");
  assert.deepEqual(errors, []);
});
