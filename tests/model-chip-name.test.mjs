/**
 * Dogfood B25 (Legion 2f2da94): the model chip showed the model's id ("gpt-6-sol"). It shows the catalogue's own name
 * ("GPT-6 Sol") where Branch has one, before and during a conversation, and the id for a model it has no name for.
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
import { modelDisplayName } from "../dist/models.js";

test("the catalogue names a ChatGPT model and nothing else", () => {
  assert.equal(modelDisplayName("chatgpt", "gpt-6-sol"), "GPT-6 Sol");
  assert.equal(modelDisplayName("chatgpt", "gpt-9-unknown"), null, "a model the list does not have keeps its id");
  assert.equal(modelDisplayName("openai-compatible", "gpt-6-sol"), null, "another route's model is not guessed at");
});

/* The new window's chip (public/app/chat/chips.js) reads "<model> · <level>", the level in lower case as the prototype's. */
const chipText = (page) => page.locator('#composer [data-act="modelmenu2"] .lbl').innerText().then((text) => text.trim());
async function served(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const answer = async () => ({ content: "ok", toolCalls: [] });
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    presets: [{ id: "main", name: "ChatGPT · GPT-6 Sol", provider: { name: "chatgpt", complete: answer }, model: "gpt-6-sol", reasoning: "medium" }] });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server };
}

test("dogfood B25: the chip names GPT-6 Sol by its name, before and during a conversation", async (t) => {
  const { server } = await served(t, "branch-chip-name-");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => /^GPT-6 Sol/.test(document.querySelector('#composer [data-act="modelmenu2"] .lbl')?.textContent.trim() ?? ""));
  assert.equal(await chipText(page), "GPT-6 Sol · medium", "before a first message");
  await page.locator("#prompt").fill("hello");
  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation .b .txt").first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /^GPT-6 Sol/.test(document.querySelector('#composer [data-act="modelmenu2"] .lbl')?.textContent.trim() ?? ""));
  assert.equal(await chipText(page), "GPT-6 Sol · medium", "and in the conversation");
  assert.deepEqual(errors, []);
});

/* Dogfood B26 (Legion 2f2da94), the engine's half: a first message that carries a Thinking level (POST /api/run reasoning)
   starts a conversation that keeps it as its own, and the workspace's default is untouched. The new window's chip saves
   the level new conversations start with instead (public/app/chat/chips.js), so its old-window half is not carried. */
test("dogfood B26: a first message's own Thinking level is the new conversation's", async (t) => {
  const { app, server } = await served(t, "branch-chip-think-");
  const response = await fetch(new URL("/api/run", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", reasoning: "high" }) });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.ok(run.sessionId, "the run names its conversation");
  assert.equal(app.runtime.models.session(app.runtime.owner, run.sessionId).reasoning, "high", "the conversation keeps Thorough as its own");
  assert.equal(app.runtime.models.settings(app.runtime.owner).reasoning ?? null, null, "the workspace's own default is untouched");
});
