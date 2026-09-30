/**
 * QA retest 2026-09-28 (m16): Automations › Saved prompts › Use put a prompt's body in the message box as it was saved,
 * blanks and all ("keep this note: {{input}}"), and sending it sent the braces to the model. Use now asks for each blank
 * in a labelled box first, as What can Branch do's Try it does, and puts the filled words in the box, not sent.
 * Node only: the real dist/ and public/, a scripted model, headless Chromium, port 0.
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

test("a saved prompt's Use asks for its blanks, then puts the filled words in the box", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-prompt-blanks-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const post = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  await post("/api/onboarding", { done: true });
  await post("/api/prompts/settings", { mode: "on" });
  await post("/api/prompts", { title: "Keep a note", body: "Keep this note for me: {{input}}. Today is {{today}}." });
  await post("/api/prompts", { title: "Plain one", body: "Summarise my week." });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, server);
  await openPlace(page, "automations", "procedures");
  const row = (title) => page.locator("#main .prow").filter({ hasText: title }).locator('[data-act="prompt-use"]');
  await row("Keep a note").click();
  const dialog = page.locator(".dlg").last();
  await dialog.getByText("Your text", { exact: true }).waitFor();
  await dialog.locator("textarea").fill("buy oat milk");
  await dialog.locator('[data-act="whatcan-prepare"]').click();
  await page.locator("#prompt").waitFor();
  const today = new Date().toLocaleDateString("en-CA");
  await page.waitForFunction((want) => document.querySelector("#prompt")?.value === want, `Keep this note for me: buy oat milk. Today is ${today}.`);
  assert.doesNotMatch(await page.locator("#prompt").inputValue(), /\{\{/, "no blank is left in the box");

  await openPlace(page, "automations", "procedures");
  await row("Plain one").click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Summarise my week.");
  assert.equal(await page.locator(".dlg").count(), 0, "a prompt with no blank goes straight to the box");
  assert.deepEqual(errors, []);
});
