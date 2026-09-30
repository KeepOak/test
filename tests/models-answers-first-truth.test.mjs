/**
 * QA retest 2026-09-28, pass 2: Settings › Models › Connections put "Answers first" on the Claude Code list's account
 * while qwen on this computer answered, so two places said "Answers first". A list's "Answers first" and "Next in line"
 * are now said only while that list answers (GET /api/accounts pools[].answering, #748).
 * Node only: the real dist/ and public/, stand-in connections that are never called, headless Chromium.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";

const POOL = "openai-next", LOCAL = "qwen-here";
const answer = async () => ({ content: "ok", toolCalls: [] });

test("Models › Connections says Answers first only where the next answer comes from", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-answers-first-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI (work)", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI (work)", model: "gpt-4o-mini", catalogId: "openai", provider: { name: "openai-chat", complete: answer } });
  app.runtime.models.register({ id: LOCAL, name: "Qwen here", model: "qwen2.5:7b",
    provider: { name: "ollama", complete: answer, embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1" }) } });
  app.runtime.models.configure(owner, { activePreset: LOCAL });
  app.store.save("settings", owner, "onboarding", { done: true });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const accounts = async () => (await fetch(new URL("/api/accounts", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  const pills = async () => {
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="models"]').click();
    await page.locator(".set-col h1", { hasText: "Models" }).waitFor();
    for (const name of ["Qwen here", "First key"]) await page.locator(".set-col .acct-r", { hasText: name }).waitFor(); // the model here, and the OpenAI list read from the engine
    return page.locator(".set-col .acct-r").evaluateAll((rows) => rows.map((row) => [row.querySelector("b")?.textContent ?? "", [...row.querySelectorAll(".pill")].map((pill) => pill.textContent.trim()).join(",")])
      .filter(([, said]) => said));
  };

  assert.equal((await accounts()).pools.find((p) => p.pool === POOL).answering, false, "the model on this computer answers");
  assert.deepEqual(await pills(), [["Qwen here", "Answers first"]], "the local model answers first; the OpenAI list says nothing");

  app.runtime.models.configure(owner, { activePreset: POOL });
  assert.equal((await accounts()).pools.find((p) => p.pool === POOL).answering, true);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  assert.deepEqual(await pills(), [["First key", "Answers first"]], "the OpenAI list's first account, not the local model");
  assert.deepEqual(errors, []);
});
