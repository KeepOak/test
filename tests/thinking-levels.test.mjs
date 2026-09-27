/**
 * Redesign phase 2 (accounts, critique #22): the Thinking lists offer only the levels the chosen
 * model really takes. The map is checked against the providers that actually send a level, and the
 * lists are checked in a headless window with three stand-in connections (nothing reaches a service).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { thinkingLevels } from "../dist/thinking-levels.js";
import { openSettingFor } from "./places.mjs";

const all = ["low", "medium", "high"];

test("K1 only the providers that send a level are offered one, and only for models that think", () => {
  const effort = (levels = all) => ({ how: "effort", levels, sent: true });
  const budget = { how: "budget", levels: all, sent: true };
  const unknown = { how: "none", levels: [], sent: true };
  assert.deepEqual(thinkingLevels("openai-compatible", "gpt-5.5"), effort());
  assert.deepEqual(thinkingLevels("openai-compatible", "openai/o4-mini"), effort(), "a router's prefix is read through");
  assert.deepEqual(thinkingLevels("openai-compatible", "gpt-4o-mini"), unknown, "a model that does not think; a saved level is still sent");
  assert.deepEqual(thinkingLevels("openai-compatible", "grok-3-mini"), effort(["low", "high"]), "xAI takes two levels");
  assert.deepEqual(thinkingLevels("chatgpt", "gpt-5.6-terra"), effort());
  // GPT-6 review (Mac mini): the ChatGPT default is GPT-6 Sol at medium, so its Thinking list must offer levels,
  // not say the model "does not take a thinking setting".
  for (const model of ["gpt-6-sol", "gpt-6-luna"]) assert.deepEqual(thinkingLevels("chatgpt", model), effort(), `${model} takes a thinking level`);
  assert.deepEqual(thinkingLevels("openai-responses", "gpt-5.5"), effort());
  // Integration review: Azure OpenAI builds the same body as the OpenAI-shaped connection.
  assert.deepEqual(thinkingLevels("azure-openai", "o4-mini"), effort());
  assert.deepEqual(thinkingLevels("azure-openai", "my-deployment"), unknown);
  // Integration review: models that refuse reasoning_effort although their family takes it.
  for (const model of ["o1-mini", "o1-preview-2024-09-12", "gpt-5-chat-latest", "openai/gpt-5.1-chat"])
    assert.deepEqual(thinkingLevels("openai-compatible", model), unknown, `${model} refuses a reasoning effort`);
  assert.deepEqual(thinkingLevels("openai-compatible", "o1"), effort(), "o1 itself takes one");
  assert.deepEqual(thinkingLevels("anthropic", "claude-sonnet-4-5"), budget);
  assert.deepEqual(thinkingLevels("anthropic-vertex", "claude-opus-4-1@20250805"), budget);
  assert.deepEqual(thinkingLevels("anthropic", "claude-3-7-sonnet-latest"), budget);
  assert.deepEqual(thinkingLevels("anthropic", "claude-3-5-haiku-latest"), unknown);
  for (const provider of ["gemini", "ollama", "cohere", "bedrock", "claude-code", "scripted"])
    assert.deepEqual(thinkingLevels(provider, "gpt-5.5"), { how: "none", levels: [], sent: false }, `${provider} sends no level, so none is offered`);
});

test("K2 the providers that send a level are exactly the ones the map knows", async () => {
  const src = join(import.meta.dirname, "..", "src");
  const files = [...(await readdir(src)).map((name) => join(src, name)), ...(await readdir(join(src, "providers"))).map((name) => join(src, "providers", name))];
  const senders = [];
  for (const file of files.filter((name) => name.endsWith(".ts"))) {
    const text = await readFile(file, "utf8");
    // Integration review: a provider that reuses a shared body builder sends the level too (Azure did, unseen).
    if (/request\.reasoning\s*\?/.test(text) || /thinkingBudgets\[request\.reasoning\]/.test(text)
      || /\b(openaiBody|anthropicBody)\(request/.test(text)) senders.push(file);
  }
  assert.deepEqual(senders.map((file) => file.split(/[\\/]/).slice(-2).join("/")).sort(),
    ["providers/azure-openai.ts", "providers/openai-responses.ts", "src/chatgpt-provider.ts", "src/providers.ts"],
    "a provider started or stopped sending a thinking level: update src/thinking-levels.ts");
  // Every provider those files define is one the map says sends a level.
  for (const file of senders)
    for (const [, name] of (await readFile(file, "utf8")).matchAll(/readonly name(?:: string)? = "([^"]+)"/g))
      assert.equal(thinkingLevels(name, "unknown-model").sent, true, `${name} sends a level, but the map says it does not`);
});

async function fixture(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-thinking-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const answer = async () => ({ content: "ok", toolCalls: [] });
  for (const [id, name, provider, model] of [["think-gpt", "OpenAI", "openai-compatible", "gpt-5.5"],
    ["think-claude", "Anthropic", "anthropic", "claude-sonnet-4-5"], ["think-local", "Ollama", "ollama", "llama3.1:8b"],
    ["think-plain", "OpenAI plain", "openai-compatible", "gpt-4o-mini"]])
    app.runtime.models.register({ id, name, model, provider: { name: provider, complete: answer } });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "think-local", reasoning: "high" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app, server };
}
const values = (page, id) => page.locator(`#${id} option`).evaluateAll((nodes) => nodes.map((node) => node.value));

/* Redesign: the engine's half of K3 and K4, which no window control is needed for; the window's halves are the
   originals below, skipped until Settings › Models › Defaults and the model chip's menu are live. */
test("K3 the /api/state models carry their levels (the engine, for the new window)", async (t) => {
  const { errors, server } = await fixture(t);
  const state = await (await fetch(new URL("/api/state", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const byId = Object.fromEntries(state.models.presets.map((preset) => [preset.id, preset.thinking]));
  assert.deepEqual(byId["think-claude"], { how: "budget", levels: all, sent: true });
  assert.deepEqual(byId["think-local"], { how: "none", levels: [], sent: false });
  const knobs = await (await fetch(new URL("/api/knobs", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const local = knobs.connections.find((one) => one.id === "think-local");
  assert.deepEqual(local.thinking, { how: "none", levels: [], sent: false }, "the per-model levels carry the same map");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (mtab=defaults, Settings › Models › Defaults, and its thinking level), checked at ef021c57.
test.skip("K3 the /api/state models carry their levels, and the default list follows the chosen model", async (t) => {
  const { page, errors, server } = await fixture(t);
  const state = await (await fetch(new URL("/api/state", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const byId = Object.fromEntries(state.models.presets.map((preset) => [preset.id, preset.thinking]));
  assert.deepEqual(byId["think-claude"], { how: "budget", levels: all, sent: true });
  assert.deepEqual(byId["think-local"], { how: "none", levels: [], sent: false });
  await page.locator("#models-reasoning-thinking-note").waitFor({ state: "attached", timeout: 30000 });
  await openSettingFor(page, "#models-reasoning");
  // Ollama takes no level: the saved "high" is kept and marked, and the note says so.
  assert.deepEqual(await values(page, "models-reasoning"), ["", "high"]);
  assert.equal(await page.locator("#models-reasoning").inputValue(), "high", "the saved level is kept, not cleared");
  assert.match(await page.locator("#models-reasoning option[value=high]").innerText(), /does not use it/);
  assert.match(await page.locator("#models-reasoning-thinking-note").innerText(), /llama3\.1:8b does not take a thinking setting/);
  await page.locator("#models-active").selectOption("think-claude");
  assert.deepEqual(await values(page, "models-reasoning"), ["", ...all]);
  assert.match(await page.locator("#models-reasoning option[value=low]").innerText(), /short think/);
  assert.match(await page.locator("#models-reasoning option[value='']").innerText(), /^Off/);
  await page.locator("#models-active").selectOption("think-gpt");
  // The window redraws these lists every 3 seconds: a model picked here and not saved yet stays.
  await page.waitForTimeout(3500);
  assert.equal(await page.locator("#models-active").inputValue(), "think-gpt", "the pick is still theirs");
  assert.deepEqual(await values(page, "models-reasoning"), ["", ...all]);
  assert.equal(await page.locator("#models-reasoning option[value=medium]").innerText(), "Balanced");
  assert.equal(await page.locator("#models-reasoning-thinking-note").isHidden(), true, "nothing to explain for an effort model");
  // Integration review: a model of a provider that still sends the saved level is never called "unused".
  await page.locator("#models-active").selectOption("think-plain");
  assert.deepEqual(await values(page, "models-reasoning"), ["", "high"]);
  assert.match(await page.locator("#models-reasoning option[value=high]").innerText(), /may refuse it/);
  assert.match(await page.locator("#models-reasoning-thinking-note").innerText(), /still sends the level saved here, but gpt-4o-mini/);
  assert.deepEqual(errors, []);
});

/* Redesign: the model chip's menu (public/app/chat/chips.js, prototype POPS.modelmenu2) has a Thinking row with the
   levels the conversation's own model takes (data-act="pick-think"), and none for a model that takes none. The old
   window's #session-reasoning list is replaced by it; the per-model levels in /api/knobs are checked in K3 above. */
const modelChip = (page) => page.locator('#composer [data-act="modelmenu2"]');
async function thinkingRow(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(5200); // the chips read the conversation's model again at most every five seconds
  await page.locator('#tbActions [data-act="theme-flip"]').click(); // a redraw, which reads the chips again
  await page.waitForTimeout(800);
  await modelChip(page).click();
  const menu = page.locator("#app > .pop");
  await menu.waitFor({ state: "visible" });
  return menu.locator('[data-act="pick-think"]').evaluateAll((nodes) => nodes.map((n) => n.dataset.v));
}
test("K4 a conversation's list follows its own model, and a per-model level offers only what that model takes", async (t) => {
  const { page, errors, server } = await fixture(t);
  const call = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  await page.locator("#prompt").fill("Hello there");
  await page.locator("#send").click();
  await page.locator("#conversation .b .txt").first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById("send").disabled);
  assert.deepEqual(await thinkingRow(page), [], "the workspace default here is Ollama, which takes none");
  const sessionId = await page.locator('#side [data-act="chat"][aria-current="true"]').getAttribute("data-id");
  await call(`/api/sessions/${sessionId}/model`, { preset: "think-claude", reasoning: "medium" });
  assert.deepEqual(await thinkingRow(page), all, "the conversation's own model's levels");
  assert.equal(await page.locator('#app > .pop [data-act="pick-think"][aria-pressed="true"]').getAttribute("data-v"), "medium");
  assert.deepEqual(errors, []);
});

/* Redesign: the chip reads "<model> · <level>" (prototype modelChipHTML: the model's name, then the level in lower case);
   the old window's long row and "Balanced" wording are replaced by the new window. */
test("K5 dogfood B9: the model chip carries the thinking level, chosen from its menu, and the long row is not drawn", async (t) => {
  const { page, errors, server } = await fixture(t);
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await page.locator("#prompt").fill("Hello there");
  await page.locator("#send").click();
  await page.locator("#conversation .b .txt").first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById("send").disabled);
  const sessionId = await page.locator('#side [data-act="chat"][aria-current="true"]').getAttribute("data-id");
  await call(`/api/sessions/${sessionId}/model`, { preset: "think-claude", reasoning: null });
  assert.deepEqual(await thinkingRow(page), all);
  assert.equal(await page.locator("#model-controls").count(), 0, "the row of labelled selects is not drawn");
  const menu = page.locator("#app > .pop");
  assert.ok(await menu.getByText("Thinking", { exact: true }).isVisible(), "the menu has a Thinking part");
  await menu.locator('[data-act="pick-think"][data-v="medium"]').click();
  await page.waitForFunction(async (id) => (await (await fetch(`/api/sessions/${id}/model`, {
    headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } })).json()).reasoning === "medium", sessionId, { timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /· medium$/.test(document.querySelector('#composer [data-act="modelmenu2"] .lbl')?.textContent.trim() ?? ""), null, { timeout: 10000 });
  assert.equal((await modelChip(page).locator(".lbl").innerText()).trim(), "claude-sonnet-4-5 · medium",
    "the chip says the model and how hard it thinks (NAS 62efb38)");
  assert.deepEqual(errors, []);
});
