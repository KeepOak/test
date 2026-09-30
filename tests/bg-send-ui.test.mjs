/**
 * RES-702, from OpenClaw 2.0: Ctrl+Enter in a new conversation's box starts it in the background. The person stays
 * where they are (the new-conversation page, then Settings while it works); the engine really has the conversation and
 * its task; when the task finishes the notification card names it, and its Open opens that conversation with the reply.
 * Enter in the same box still sends in the foreground. A real engine and window, a scripted model that holds the
 * background task until the test lets it finish, a hidden browser.
 * Mutation: send Ctrl+Enter the foreground way (the window follows the new conversation), or drop the card, and it goes red.
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
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const asked = "Collect the weekly numbers in the background please";
const reply = "The weekly numbers are ready.";

async function fixture(t) {
  let release;
  const gate = new Promise((done) => { release = done; });
  const root = await mkdtemp(join(tmpdir(), "branch-bgsend-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) {
      const last = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
      if (last.includes("weekly numbers")) { await gate; return { content: reply, toolCalls: [] }; }
      return { content: "Hello there.", toolCalls: [] };
    } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors, release };
}

const until = async (check, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) { const got = await check(); if (got) return got; if (Date.now() > end) return got; await new Promise((r) => setTimeout(r, 100)); }
};

test("Ctrl+Enter starts the new conversation in the background, the page stays, and the card opens it when it finishes", async (t) => {
  const { app, page, errors, release } = await fixture(t);
  await page.locator(".empty-chat").waitFor();
  await page.locator("#prompt").fill(asked);
  await page.locator("#prompt").press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("prompt")?.value === "");

  const run = await until(() => app.store.runs(app.runtime.owner).find((r) => r.prompt === asked));
  assert.ok(run, "the engine started the task");
  assert.ok(await page.locator(".empty-chat").isVisible(), "the window stayed on the new-conversation page");
  assert.equal(await page.locator("#conversation").count(), 0, "no conversation was opened in the foreground");

  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator(".set-nav").waitFor();
  assert.equal(await page.locator(".notif").count(), 0, "nothing is announced while it still works");
  release();

  const card = page.locator(".notif");
  await card.waitFor({ timeout: 60000 });
  assert.match(await card.textContent(), /weekly numbers are ready/, "the card says how it finished");
  assert.ok(await page.locator(".set-nav").isVisible(), "the person is still in Settings");
  await card.locator('[data-act="chat"]').click();
  await page.locator("#conversation .b .txt").filter({ hasText: reply }).waitFor({ timeout: 60000 });
  const messages = app.store.messages(run.sessionId).map((m) => `${m.role}:${m.content}`);
  assert.ok(messages.includes(`user:${asked}`) && messages.includes(`assistant:${reply}`), "the conversation holds the message and its reply");
  assert.deepEqual(errors, []);
});

test("Enter in the same box still sends in the foreground and opens the conversation", async (t) => {
  const { page, errors } = await fixture(t);
  await page.locator("#prompt").fill("Say hello");
  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation .b .txt").filter({ hasText: "Hello there." }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator(".empty-chat").count(), 0);
  assert.deepEqual(errors, []);
});

test("at most three background conversations wait at once; a fourth is refused with its words kept, and the window still reads", async (t) => {
  const { app, page, errors, release } = await fixture(t);
  for (let i = 1; i <= 3; i++) {
    await page.locator("#prompt").fill(`${i}: the weekly numbers`);
    await page.locator("#prompt").press("Control+Enter");
    await page.waitForFunction(() => document.getElementById("prompt")?.value === "");
  }
  /* Only these tasks are counted: the engine may run its own (the default Trunk's hello, #726). */
  const weekly = () => app.store.runs(app.runtime.owner).filter((r) => r.prompt.endsWith("the weekly numbers")).length;
  await until(() => weekly() === 3);
  await page.locator("#prompt").fill("4: the weekly numbers");
  await page.locator("#prompt").press("Control+Enter");
  await page.locator(".toast").filter({ hasText: "already working in the background" }).waitFor();
  assert.equal(await page.locator("#prompt").inputValue(), "4: the weekly numbers", "the refused words stay in the box");
  const read = await page.evaluate(async () => {
    const started = performance.now();
    const answer = await fetch("/api/state", { headers: { authorization: `Bearer ${sessionStorage.getItem("branch-token") ?? ""}` } }).catch(() => null);
    return { ms: performance.now() - started, got: !!answer };
  });
  assert.ok(read.got && read.ms < 5000, `a read still goes through while three wait (${Math.round(read.ms)} ms)`);
  assert.equal(weekly(), 3, "no fourth task started");
  release();
  assert.deepEqual(errors, []);
});

test("Alt with Ctrl+Enter starts nothing in the background: the words stay for a plain Enter", async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.locator("#prompt").fill("Say hello");
  await page.locator("#prompt").press("Alt+Control+Enter");
  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation .b .txt").filter({ hasText: "Hello there." }).waitFor({ timeout: 60000 });
  assert.equal(app.store.runs(app.runtime.owner).filter((r) => r.prompt === "Say hello").length, 1, "one foreground task, none in the background");
  assert.deepEqual(errors, []);
});
