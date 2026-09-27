import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ProviderStreamError } from "../dist/index.js";
import { billedRoomDefault, hostedWindowDefault, learnWindow, modelWindow, overflowOf, rememberPublished, windowKey } from "../dist/model-context.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { statedIn } from "../dist/context-words.js";
import { ProviderHttpError, rejectedHttpResponse } from "../dist/provider-retry.js";
import { publishedWindow, readModelWindow } from "../dist/model-info.js";

/* Dogfood follow-up: the real context limit comes from the model's service. Anthropic's "prompt is too long", an
   overflow that arrives mid-stream, and what a service's model list publishes all count; the room is known before the
   first request wherever the service publishes it. */

const anthropicTooLong = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } });
const openaiTooLong = JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 131000 tokens.", type: "invalid_request_error", code: null } });

test("the services' own words: Anthropic, OpenAI and mid-stream overflows, with the maximum they state", async () => {
  assert.equal(statedIn("prompt is too long: 210000 tokens > 200000 maximum"), 200000);
  assert.equal(statedIn("This model's maximum context length is 128000 tokens."), 128000);
  assert.equal(statedIn("Your input exceeds the context window of 32,768 tokens"), 32768);
  const anthropic = await rejectedHttpResponse(new Response(anthropicTooLong, { status: 400 }));
  assert.equal(anthropic.code, "context_length_exceeded", "Anthropic's general invalid_request_error is read as the overflow");
  assert.equal(anthropic.contextLimit, 200000);
  assert.doesNotMatch(anthropic.message, /prompt is too long/, "the service's words are never put in the error's own message");
  const openai = await rejectedHttpResponse(new Response(openaiTooLong, { status: 400 }));
  assert.deepEqual(overflowOf(openai), { overflow: true, stated: 128000 });
  const limited = await rejectedHttpResponse(new Response(JSON.stringify({ error: { message: "Too many tokens per minute", type: "rate_limit_error" } }), { status: 429 }));
  assert.equal(overflowOf(limited).overflow, false, "a rate limit that mentions tokens is not an overflow");
  const midStream = new ProviderStreamError(new Error("ChatGPT reported a failed response: Your input exceeds the context window of this model."), 0);
  assert.deepEqual(overflowOf(midStream), { overflow: true, stated: null });
  assert.equal(overflowOf(new ProviderStreamError(new Error("ChatGPT stopped early (max_output_tokens)"), 0)).overflow, false);
  assert.equal(overflowOf(new ProviderHttpError(500)).overflow, false);
});

test("a stated maximum lowers the learned room further; published windows come before the defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-limits-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  assert.equal(learnWindow(app.store, owner, "small", 40000, hostedWindowDefault, 32768), 29491, "the service said 32,768: a tenth under it");
  assert.equal(learnWindow(app.store, owner, "big", 90000, hostedWindowDefault, 200000), 72000, "a stated maximum above what was refused changes nothing");
  const listed = { id: "listed", model: "big-model" };
  rememberPublished(app.store, owner, windowKey(listed), 1_000_000);
  assert.equal(modelWindow(app.store, owner, listed, false), 1_000_000, "what the model list publishes beats the hosted default");
  learnWindow(app.store, owner, windowKey(listed), 500000, 1_000_000);
  assert.equal(modelWindow(app.store, owner, listed, false), 400000, "a refusal still wins when it is lower");
  assert.equal(modelWindow(app.store, owner, { id: "listed", model: "other-model" }, false), hostedWindowDefault,
    "the same connection id on another model inherits nothing");
  // A connection removed and added again under the same id and model name, but at another address, starts fresh.
  const here = { id: "again", model: "same-model", endpoint: "https://one.example/v1" };
  rememberPublished(app.store, owner, windowKey(here), 64000);
  learnWindow(app.store, owner, windowKey(here), 50000, 64000);
  assert.equal(modelWindow(app.store, owner, here, false), 40000);
  assert.equal(modelWindow(app.store, owner, { ...here, endpoint: "https://two.example/v1" }, false), hostedWindowDefault,
    "another address inherits neither the published nor the learned figure");
  // Without an address written down, the one the connection's own routes hand out counts.
  const routed = (endpoint) => ({ id: "routed", model: "m", provider: { name: "x", embeddings: () => ({ endpoint, apiKey: "k" }) } });
  rememberPublished(app.store, owner, windowKey(routed("https://one.example/v1")), 64000);
  assert.equal(modelWindow(app.store, owner, routed("https://one.example/v1"), false), 64000);
  assert.equal(modelWindow(app.store, owner, routed("https://two.example/v1"), false), hostedWindowDefault);
  assert.doesNotMatch(windowKey(here), /one\.example/, "the address is kept only as a digest");
});

test("a connection billed per token is held to 256k unless the owner raises it; a sign-in or a local model keeps its window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-limits-billed-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const plain = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const keyed = { id: "keyed", name: "Keyed", model: "wide", provider: plain };
  const signedIn = { id: "chatgpt-plan", name: "Plan", model: "wide", provider: plain };
  const gemini = { id: "google-gemini", name: "Gemini", model: "wide", provider: plain };
  const local = { id: "local", name: "Local", model: "wide", provider: { ...plain, embeddings: () => ({ endpoint: "http://127.0.0.1:1234/v1", apiKey: "local" }) } };
  for (const preset of [keyed, signedIn, gemini, local]) rememberPublished(app.store, owner, windowKey(preset), 1_000_000);
  assert.equal(billedRoomDefault, 256_000);
  assert.equal(app.runtime.contextWindowFor(keyed), billedRoomDefault, "an API key's published million is held to 256k");
  assert.equal(app.runtime.contextWindowFor(signedIn), 1_000_000, "a subscription sign-in keeps the model's window");
  assert.equal(app.runtime.contextWindowFor(gemini), 1_000_000);
  assert.equal(app.runtime.contextWindowFor(local), 1_000_000, "a model on this computer keeps its window");
  const small = { id: "small", name: "Small", model: "narrow", provider: plain };
  rememberPublished(app.store, owner, windowKey(small), 64000);
  assert.equal(app.runtime.contextWindowFor(small), 64000, "a window under the cap is used as it is");
  saveKnobs(app.store, owner, "compaction", { contextWindowTokens: 900_000 });
  assert.equal(app.runtime.contextWindowFor(keyed), 900_000, "the owner's own figure in Settings raises it");
  // The fold point follows the room: a long task on the billed connection folds within 256k, not the million.
  saveKnobs(app.store, owner, "compaction", { contextWindowTokens: null });
  app.runtime.modelInfo = async () => 1_000_000;
  const run = await app.runtime.run({ prompt: "hello" });
  const [budget] = app.store.events(run.id).filter((event) => event.kind === "context.budget");
  assert.equal(budget.data.limit, billedRoomDefault);
  assert.ok(budget.data.threshold <= billedRoomDefault, "the fold point is inside the capped room");
});

test("the model list's figure is read in each service's own shape", async () => {
  assert.equal(publishedWindow({ data: [{ id: "anthropic/claude-x", context_length: 200000 }] }, "anthropic/claude-x"), 200000);
  assert.equal(publishedWindow({ data: [{ id: "m", top_provider: { context_length: 65536 } }] }, "m"), 65536);
  assert.equal(publishedWindow({ models: [{ name: "models/gemini-x", inputTokenLimit: 1048576 }] }, "gemini-x"), 1048576);
  assert.equal(publishedWindow({ data: [{ id: "local-q", max_context_length: 32768 }] }, "local-q"), 32768);
  assert.equal(publishedWindow({ data: [{ id: "gpt-x", created: 1 }] }, "gpt-x"), null, "OpenAI's list publishes none");
  assert.equal(publishedWindow({ data: [{ id: "other", context_length: 9000 }] }, "wanted"), null);
  assert.equal(publishedWindow({ data: [{ id: "m", context_length: 12 }] }, "m"), null, "a figure that is not a window is ignored");
  const provider = { name: "listing", modelsList: () => ({ url: "https://models.example/v1/models", headers: { authorization: "Bearer k" } }), async complete() { return { content: "", toolCalls: [] }; } };
  const asked = [];
  const policy = { async assertAllowed(url) { asked.push(String(url)); }, guard: (base) => async (url, init) => { asked.push("guarded"); return base(url, init); } };
  const fetchImpl = async (url, init) => { asked.push(init.headers.authorization); return new Response(JSON.stringify({ data: [{ id: "claude-x", context_length: 200000 }] })); };
  assert.equal(await readModelWindow({ id: "p", name: "P", model: "claude-x", provider }, policy, fetchImpl), 200000);
  assert.deepEqual(asked, ["https://models.example/v1/models", "guarded", "Bearer k"], "the network rules were asked first, and the request went through the guarded transport");
  const refusing = { async assertAllowed() { throw new Error("blocked"); }, guard: (base) => base };
  assert.equal(await readModelWindow({ id: "p", name: "P", model: "claude-x", provider }, refusing, fetchImpl), null, "refused by the rules: nothing is fetched");
});

async function scripted(t, reply) {
  const root = await mkdtemp(join(tmpdir(), "branch-limits-run-"));
  await mkdir(join(root, "w"), { recursive: true });
  for (let i = 0; i < 6; i++) await writeFile(join(root, "w", `page${i}.txt`), `page ${i} `.repeat(1500));
  let n = 0;
  const provider = { name: "scripted", async complete(request) { n++; return reply(request, n); } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const folder = (request) => String(request.messages[0]?.content ?? "");
const reads = (limit) => (request, n) => {
  if (folder(request).startsWith("Summarise the work below")) return { content: "Pages read so far.", toolCalls: [] };
  if (folder(request).startsWith("This task has run out of room")) return { content: "Best answer.", toolCalls: [] };
  if (n <= limit) return { content: "", toolCalls: [{ id: `r${n}`, name: "files.read", arguments: JSON.stringify({ path: `page${n - 1}.txt` }) }] };
  return { content: "All pages read.", toolCalls: [] };
};

test("the room is known before the first request when the service publishes it, and asked once per connection", async (t) => {
  const app = await scripted(t, reads(0));
  let asked = 0;
  app.runtime.modelInfo = async () => { asked++; return 32000; };
  const first = await app.runtime.run({ prompt: "hello" });
  const [budget] = app.store.events(first.id).filter((event) => event.kind === "context.budget");
  assert.equal(budget.data.limit, 32000, "the first request already used the published room");
  assert.ok(app.store.events(first.id).some((event) => event.kind === "context.window_published"));
  await app.runtime.run({ prompt: "again", sessionId: first.sessionId });
  assert.equal(asked, 1, "the list is read once per connection while Branch runs");
  // The connection switched to another model under the same id: its list is read again, and the old figure is not used.
  const preset = app.runtime.models.presets.get(app.runtime.models.summary(app.runtime.owner).defaultPreset);
  const before = preset.model;
  preset.model = `${before}-next`;
  app.runtime.modelInfo = async () => { asked++; return null; };
  const third = await app.runtime.run({ prompt: "and again" });
  assert.equal(asked, 2, "asked again for the other model");
  const [again] = app.store.events(third.id).filter((event) => event.kind === "context.budget");
  assert.equal(again.data.limit, hostedWindowDefault, "the old model's published room did not carry over");
  preset.model = before;
});

test("a local server from the catalog is asked; one that says what it was loaded with is not", async (t) => {
  const app = await scripted(t, reads(0));
  const preset = app.runtime.models.presets.get(app.runtime.models.summary(app.runtime.owner).defaultPreset);
  let asked = 0;
  app.runtime.modelInfo = async () => { asked++; return 40000; };
  preset.contextWindow = 16384;
  await app.runtime.run({ prompt: "hello" });
  assert.equal(asked, 0, "the loaded context it reported is used as it is");
  delete preset.contextWindow;
  await app.runtime.run({ prompt: "hello again" });
  assert.equal(asked, 1);
});

test("an overflow mid-stream, and Anthropic's refusal with its maximum, teach the room and the task carries on", async (t) => {
  let thrown = false;
  const inner = reads(4);
  const app = await scripted(t, (request, n) => {
    if (!thrown && n === 3) { thrown = true; throw new ProviderStreamError(new Error("Your input exceeds the context window of this model."), 0); }
    return inner(request, n);
  });
  const run = await app.runtime.run({ prompt: "read four pages" });
  assert.equal(run.status, "completed", run.output);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "context.window_learned"), "the mid-stream overflow taught the room");

  let refused = false;
  const inner2 = reads(4);
  const other = await scripted(t, async (request, n) => {
    if (!refused && n === 3) { refused = true; throw await rejectedHttpResponse(new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 9000 tokens > 8192 maximum" } }), { status: 400 })); }
    return inner2(request, n);
  });
  const second = await other.runtime.run({ prompt: "read four pages" });
  assert.equal(second.status, "completed", second.output);
  const learned = other.store.events(second.id).find((event) => event.kind === "context.window_learned");
  assert.equal(learned.data.stated, 8192);
  assert.equal(learned.data.room, Math.floor(Math.min(learned.data.sent * 0.8, 8192 * 0.9)), "never above a tenth under the maximum Anthropic stated");
  assert.ok(learned.data.room <= 7372);
});
