/* UI-010: a picture shown in a conversation is held as a blob only while that conversation is on screen. Starting a new
   conversation revokes it, so the window no longer keeps the file in memory. A headless window on a temporary Branch
   with a scripted model. Mutation: make ensureMediaScope in chat/media.js return at once: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, attachFiles } from "./new-window-places.mjs";

const dotPng = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("UI-010: leaving a conversation lets go of the pictures it was showing", { timeout: 180000 }, async (t) => {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-media-release-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Seen it.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);

  await attachFiles(page, [{ name: "dot.png", mimeType: "image/png", buffer: dotPng() }]);
  await page.locator("#attached .att").first().waitFor();
  await page.fill("#prompt", "here is a picture");
  await page.click("#send");
  // The conversation as the engine saved it (its messages carry ids) and the reply is in: its picture is fetched afresh.
  await page.waitForFunction(() => document.querySelector("#conversation .u[data-i15]") && !document.querySelector("#conversation .typing")
    && document.querySelector('#conversation img[src^="blob:"]'), null, { timeout: 60000 });
  const url = await page.locator('#conversation img[src^="blob:"]').first().getAttribute("src");
  const readable = (blob) => page.evaluate((u) => new Promise((done) => {
    const probe = new Image(); probe.onload = () => done(true); probe.onerror = () => done(false); probe.src = u;
  }), blob);
  assert.equal(await readable(url), true, "held while the conversation is shown");

  await page.evaluate(() => import("/app/core/actions.js").then((m) => m.run("newconv")));
  await page.waitForFunction(() => !document.querySelector('#conversation img[src^="blob:"]'));
  assert.equal(await readable(url), false, "let go once another conversation is shown");
  assert.deepEqual(errors, []);
});
