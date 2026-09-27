/**
 * Q206: Branch's own nudge to the model after an empty reply was stored as a user message, so a reopened conversation
 * showed "You: Your last reply was empty…". It is now marked as Branch's (`from: "branch"`): the model still gets it,
 * and the conversation never shows it as the owner's words. A headless browser and a scripted model.
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

const prompt = "List the folder for me";

test("a nudge after an empty reply reaches the model but is never shown as the owner's words", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-nudges-not-you-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  const seen = [];
  const replies = [
    { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] },
    { content: "", toolCalls: [] },
    { content: "I listed the folder; it is empty.", toolCalls: [] },
  ];
  const provider = { name: "scripted", async complete(request) { seen.push(request.messages.at(-1)); return replies[Math.min(seen.length, 3) - 1]; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt });
  assert.match(seen[2].content, /Your last reply was empty/, "the model is still nudged");
  const stored = app.store.workingMessages(run.sessionId).rows.map((row) => row.message).filter((message) => message.role === "user");
  assert.deepEqual(stored.map((message) => message.from ?? "owner"), ["owner", "branch"], "the nudge is kept, marked as Branch's");

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).first().click();
  await page.getByText("I listed the folder; it is empty.").first().waitFor({ timeout: 30000 });
  // The new window draws the owner's words as #conversation .u (public/app/chat/chat.js user()).
  const mine = await page.locator("#conversation .u").allInnerTexts();
  assert.equal(mine.length, 1, `only the owner's own message is shown as theirs (${mine.join(" | ")})`);
  assert.doesNotMatch(await page.locator("#conversation").innerText(), /Your last reply was empty/);
  // The reply after a nudge is still matched to the task the owner's words started (public/app/chat/messages.js runFor).
  const reply = page.locator("#conversation .b").filter({ hasText: "I listed the folder; it is empty." }).last();
  await reply.locator(`[data-act="inspect"][data-run="${run.id}"]`).waitFor({ state: "attached", timeout: 15000 });
  // NAS's Q206 review: Edit opens on the owner's own message (the new window matches it by message id).
  await page.locator("#conversation .u").first().hover();
  await page.locator('#conversation .u [data-act="u-edit"]').first().click();
  await page.locator("#rw-text").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#rw-text").inputValue(), prompt);
  assert.deepEqual(errors, []);
});

test("the nudge after a failed answer check is marked as Branch's too", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-nudges-check-"));
  let round = 0;
  const provider = { name: "scripted", async complete() { return { content: ++round === 1 ? "Some number." : "The total is 12.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "add it up", checks: { mustMention: ["total"], maxRetries: 1 } });
  const users = app.store.workingMessages(run.sessionId).rows.map((row) => row.message).filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.match(users[1].content, /did not pass its check/);
  assert.equal(users[1].from, "branch");
});

test("the terminal's history, the knowledge digest and the owner's turn count leave Branch's nudges out (NAS's Q206 LOW)", async (t) => {
  const { historyLines } = await import("../dist/terminal-commands.js");
  const { conversationDigest } = await import("../dist/knowledge-cards.js");
  const { ownerTurns } = await import("../dist/reflection/evidence.js");
  const root = await mkdtemp(join(tmpdir(), "branch-nudges-readers-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  let round = 0;
  const replies = [
    { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] },
    { content: "", toolCalls: [] },
    { content: "I listed the folder; it is empty.", toolCalls: [] },
  ];
  const provider = { name: "scripted", async complete() { return replies[Math.min(++round, 3) - 1]; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt });
  const messages = app.store.messages(run.sessionId);
  assert.ok(messages.some((message) => message.from === "branch"), "the conversation holds a nudge");
  assert.doesNotMatch(historyLines(app.runtime, run.sessionId).join("\n"), /Your last reply was empty/);
  assert.doesNotMatch(conversationDigest(messages), /Your last reply was empty/);
  assert.equal(ownerTurns(messages), 1);
});
