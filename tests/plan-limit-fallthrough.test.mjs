/**
 * The owner's ChatGPT plan showed "2% left". When a sign-in's plan runs out (ChatGPT answers 429 usage_limit_reached), the
 * work goes on with the owner's other sign-in on a different plan (the Claude subscription) instead of stopping, even when
 * that sign-in is not in the fallback order (a ChatGPT sign-in puts only ChatGPT's own models there, which share the spent
 * plan). A key billed per token is never chosen for it. Local only: fakes for every connection, no program is started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTProvider, createBranch } from "../dist/index.js";
import { ClaudeSubscriptionProvider } from "../dist/providers/claude-subscription.js";
import { discardTemp } from "./temp-dir.mjs";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })}.sig`;

/** A ChatGPT plan at its limit: every request is refused the way chatgpt.com/backend-api/codex refuses it. */
function spentChatGPT(model, calls) {
  const fetch = async () => {
    calls.push(model);
    return new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 300000 } }),
      { status: 429, headers: { "content-type": "application/json" } });
  };
  return new ChatGPTProvider({ accessToken: async () => token }, { model, fetch });
}
/** The Claude subscription, as a fake of its provider under its own id (not the accounts pool): nothing is started. */
function claude(calls) {
  const provider = Object.create(ClaudeSubscriptionProvider.prototype);
  Object.defineProperty(provider, "name", { value: "claude-subscription" });
  provider.complete = async () => { calls.push("claude"); return { content: "Carried on with Claude.", toolCalls: [] }; };
  return provider;
}

async function branch(t, { withClaude, claudeId = "claude-plan" }) {
  const calls = [];
  const presets = [
    { id: "chatgpt-gpt-6-sol", name: "ChatGPT · GPT-6 Sol", model: "gpt-6-sol", provider: spentChatGPT("gpt-6-sol", calls) },
    { id: "chatgpt-gpt-6-luna", name: "ChatGPT · GPT-6 Luna", model: "gpt-6-luna", provider: spentChatGPT("gpt-6-luna", calls) },
    { id: "openai-key", name: "OpenAI key", model: "gpt-5", provider: { name: "openai-compatible", async complete() { calls.push("key"); return { content: "paid", toolCalls: [] }; } } },
    ...(withClaude ? [{ id: claudeId, name: "Claude · Opus 5.5", model: "claude-opus-5-5", provider: claude(calls) }] : []),
  ];
  const root = await mkdtemp(join(tmpdir(), "branch-plan-limit-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // As a ChatGPT sign-in leaves it: Sol first, ChatGPT's other models next; here a paid key after them.
  app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-6-sol", fallbackOrder: ["chatgpt-gpt-6-luna", "openai-key"] });
  return { app, calls };
}

test("a ChatGPT plan at its limit moves the task to the Claude subscription, never to a paid key", async (t) => {
  const { app, calls } = await branch(t, { withClaude: true });
  const run = await app.runtime.run({ prompt: "carry on with the work" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(run.output, "Carried on with Claude.");
  assert.deepEqual(calls, ["gpt-6-sol", "claude"], "the spent plan's other model and the paid key are skipped");
  const moved = app.store.events(run.id).filter((event) => event.kind === "model.fallback").map((event) => event.data.to);
  assert.deepEqual(moved, ["claude-plan"]);
});

test("with no other sign-in the task stops rather than spending on a key", async (t) => {
  const { app, calls } = await branch(t, { withClaude: false });
  const run = await app.runtime.run({ prompt: "carry on with the work" });
  assert.notEqual(run.status, "completed");
  assert.ok(!calls.includes("key"), "a key billed per token is never chosen for a spent plan");
});

test("the owner's real Claude connection id is the one moved to; nothing of it is started here", async (t) => {
  // cli-claude-code is answered through the accounts pool, which would start the real program; the test's guard refuses
  // that after the move is written down, so only the move is checked.
  const { app, calls } = await branch(t, { withClaude: true, claudeId: "cli-claude-code" });
  const run = await app.runtime.run({ prompt: "carry on with the work" });
  const moved = app.store.events(run.id).filter((event) => event.kind === "model.fallback").map((event) => event.data.to);
  assert.equal(moved[0], "cli-claude-code");
  assert.ok(!calls.includes("key") && !calls.includes("gpt-6-luna"), "neither the key nor the spent plan's other model");
});
