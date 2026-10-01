import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, chunkText, backoffMs, clipToolResult, shrinkToolResults, evaluateChecks } from "../dist/index.js";

/** A provider driven by a script of answers; each entry is a function of the request. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const step = steps[Math.min(provider.requests.length - 1, steps.length - 1)];
    return step(request);
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
async function fixture(t, steps, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-reliability-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
const kinds = (app, runId) => app.store.events(runId).map((e) => e.kind);

test("declared completion checks are enforced with bounded retries", async (t) => {
  const { app, root, provider } = await fixture(t, [say("Done."), say("Done. Total: 42"), say("still wrong")]);
  const run = await app.runtime.run({ prompt: "add it up", checks: { mustMention: ["total"], mustMatch: "\\d+", maxRetries: 1 } });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Done. Total: 42");
  assert.equal(provider.requests.length, 2, "one retry was used");
  assert.ok(provider.requests[1].messages.some((m) => m.role === "user" && /did not pass its check: The answer does not mention "total"/.test(m.content)), "the model was told what was missing");
  assert.deepEqual(kinds(app, run.id).filter((k) => k.startsWith("run.check")), ["run.check_failed", "run.check_passed"]);

  const strict = await app.runtime.run({ prompt: "again", checks: { mustMention: ["never present"], maxRetries: 0 } });
  assert.equal(strict.status, "failed");
  assert.match(strict.output, /did not pass its check/);
  assert.doesNotMatch(strict.output, /still wrong/, "the failing answer text is not the run's output");

  await writeFile(join(root, "workspace", "report.md"), "x");
  assert.equal(await evaluateChecks("ok", { files: ["report.md"], maxRetries: 0 }, join(root, "workspace")), null);
  assert.match(await evaluateChecks("ok", { files: ["missing.md"], maxRetries: 0 }, join(root, "workspace")), /does not exist yet/);
  assert.match(await evaluateChecks("ok", { files: ["../escape"], maxRetries: 0 }, join(root, "workspace")), /outside the workspace/);
  assert.match(await evaluateChecks("{\"a\":1}", { resultSchema: { type: "object", required: ["b"] }, maxRetries: 0 }, root), /result\.b is required/);
});

test("a silent model call is detected as stalled and recovered by retrying, then by falling back", async (t) => {
  let calls = 0;
  const hang = (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  const provider = { name: "sleepy", async complete(request) { calls++; return calls === 1 ? hang(request) : { content: "awake now", toolCalls: [] }; } };
  const root = await mkdtemp(join(tmpdir(), "branch-stall-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, reliability: { modelStallMs: 5000 } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.reliability.modelStallMs = 150;
  const run = await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "awake now");
  const events = app.store.events(run.id);
  assert.ok(events.some((e) => e.kind === "model.stalled"));
  assert.deepEqual(events.find((e) => e.kind === "model.stall_recovery").data.action, "retry");

  // Three stalls in a row exhaust the retry allowance; with nowhere to fall back the run fails plainly.
  const stuck = { name: "stuck", async complete(request) { return hang(request); } };
  app.runtime.models.register({ id: "stuck", name: "Stuck", provider: stuck, model: "x" });
  const failed = await app.runtime.run({ prompt: "hello", model: "stuck", onTextDelta: () => undefined });
  assert.equal(failed.status, "failed");
  assert.match(failed.output, /^No response for 0 seconds$/);
  assert.equal(app.store.events(failed.id).filter((e) => e.kind === "model.stalled").length, 3);
  assert.deepEqual(app.store.events(failed.id).filter((e) => e.kind === "model.stall_recovery").map((e) => e.data.action), ["retry", "retry", "fail"]);
  // With a fallback configured, the third stall moves to the next preset instead.
  app.runtime.models.configure("local", { fallbackOrder: [app.runtime.models.default.id] });
  app.runtime.models.now = () => Date.now() + 3600000;
  const rescued = await app.runtime.run({ prompt: "hello", model: "stuck", onTextDelta: () => undefined });
  assert.equal(rescued.status, "completed");
  assert.equal(rescued.output, "awake now");
  assert.deepEqual(app.store.events(rescued.id).filter((e) => e.kind === "model.stall_recovery").map((e) => e.data.action), ["retry", "retry", "fallback"]);
  assert.ok(app.store.events(rescued.id).some((e) => e.kind === "model.fallback"));
});

test("a tool that never finishes is stopped after the tool time limit and the run continues", async (t) => {
  const { app } = await fixture(t, [call("slow.tool", {}), say("moved on")], { reliability: { toolTimeoutMs: 5000 } });
  app.runtime.reliability.toolTimeoutMs = 200;
  const { z } = await import("zod");
  app.registry.register({ name: "slow.tool", permission: "files.read", description: "never returns", parameters: z.object({}).strict(),
    execute: (_a, context) => new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
  const run = await app.runtime.run({ prompt: "go" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "moved on");
  const stalled = app.store.events(run.id).find((e) => e.kind === "tool.stalled");
  assert.match(stalled.data.error, /stopped after 0.2 seconds/);
  const toolMessage = app.store.messages(run.sessionId).find((m) => m.role === "tool");
  assert.match(toolMessage.content, /stopped after/);
});

test("oversized tool results are clipped for the model and older results shrink instead of overflowing", async (t) => {
  const { app, provider } = await fixture(t, [call("files.read", { path: "big.txt" }), call("files.read", { path: "big.txt" }), call("files.read", { path: "big.txt" }), say("read it all")]);
  await writeFile(join(app.runtime.workspace, "big.txt"), "lorem ipsum ".repeat(2500));
  const run = await app.runtime.run({ prompt: "read the big file three times", budget: { maxSteps: 30, maxTokens: 80000 } });
  assert.equal(run.status, "completed", run.output);
  const events = kinds(app, run.id);
  assert.ok(events.includes("tool.result_clipped"), "each result was clipped");
  const seen = provider.requests.at(-1).messages.filter((m) => m.role === "tool");
  assert.equal(seen.length, 3);
  assert.ok(seen.every((m) => m.content.length <= 12500), "the model never saw a full 30 KB result");
  // The oldest result may already have been shrunk to make room (the tool catalog is large); at least one clipped result is still visible.
  assert.ok(seen.some((m) => m.content.includes("characters omitted")));
  const clipped = clipToolResult("a".repeat(20000), 1000);
  assert.equal(clipped.omitted, 20000 - 700 - 200);
  const messages = [{ role: "system", content: "s" }, { role: "tool", toolCallId: "1", content: "x".repeat(5000) }, { role: "tool", toolCallId: "2", content: "y".repeat(5000) }, { role: "assistant", content: "z" }];
  assert.equal(shrinkToolResults(messages, 2), 1);
  assert.match(messages[1].content, /Earlier result of 5000 characters removed/);
  assert.equal(messages[2].content.length, 5000);
});

test("an interrupted task continues from its transcript without repeating tool actions", async (t) => {
  const { app, provider } = await fixture(t, [say("finished after the restart")]);
  let executed = 0;
  const { z } = await import("zod");
  app.registry.register({ name: "notes.send", permission: "files.read", description: "pretend side effect", parameters: z.object({}).strict(), execute: async () => { executed++; return { sent: true }; } });
  const first = app.store.createRun("local", "send my notes");
  app.store.event(first.id, "run.started", { source: "owner", permissions: [app.registry.permissionOf("notes.send")],
    deadlineMs: 30_000, depth: 0, delegates: false, dryRun: false, ownCopy: false });
  app.store.message(first.sessionId, { role: "user", content: "send my notes" });
  app.store.message(first.sessionId, { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "notes.send", arguments: "{}" }] });
  app.store.finish(first.id, "interrupted", "Process stopped before completion; side effects were not replayed");
  await assert.rejects(app.runtime.resume("00000000-0000-4000-8000-000000000000"), /Run not found/);
  const resumed = await app.runtime.resume(first.id);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "finished after the restart");
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(executed, 0, "the interrupted tool call was not replayed");
  const request = provider.requests[0];
  assert.match(request.messages[0].content, /continuing from its saved transcript/);
  const toolResult = request.messages.find((m) => m.role === "tool" && m.toolCallId === "t1");
  assert.match(toolResult.content, /"outcome":"unknown"/);
  assert.equal(request.messages.filter((m) => m.role === "user").length, 1, "no second prompt was added");
  const resumedEvent = app.store.events(resumed.id).find((e) => e.kind === "run.resumed");
  assert.deepEqual(resumedEvent.data, { from: first.id, unknownToolOutcomes: 1 });
  await assert.rejects(app.runtime.resume(resumed.id), /Only interrupted tasks/);
});

test("delivery ledger keeps order, never duplicates, parks dead letters and sends after reconnect", async (t) => {
  const { app } = await fixture(t, [say("ok")]);
  const sent = [];
  let failures = 0;
  const flaky = { id: "tg", kind: "telegram", botName: () => "Bot", async start() {}, async stop() {},
    async send(chatId, text, replyTo) { if (failures > 0) { failures--; throw new Error("network down"); } sent.push({ chatId, text, replyTo }); return String(sent.length); } };
  const router = app.channels;
  router.pumpMs = 60000;
  await assert.rejects(router.deliver("tg", "chat1", "too early", "run:0"), /not connected/);
  assert.equal(router.deliveries.list().length, 0, "a channel that is not set up queues nothing");
  await router.attach(flaky, { activation: "mention", pairing: true, allowlist: [] });
  // The channel is up but the network is down: nothing is sent, everything waits in order.
  failures = 1000;
  const long = Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1}. ` + "word ".repeat(300)).join("\n");
  const first = await router.deliver("tg", "chat1", long, "run:1");
  assert.equal(sent.length, 0);
  assert.ok(first.queued >= 2, "long text was split into ordered chunks");
  await router.deliver("tg", "chat1", "second message", "run:2");
  await router.deliver("tg", "chat1", "second message", "run:2");
  assert.equal(router.deliveries.list().filter((d) => d.key === "run:2").length, 1, "same key is stored once");
  // The network is back: everything goes out in order once the retry time arrives.
  failures = 0;
  router.deliveries.now = () => new Date(Date.now() + backoffMs(3) + 1000);
  await router.flush();
  router.deliveries.now = () => new Date();
  const chunks = chunkText(long);
  assert.deepEqual(sent.map((s) => s.text), [...chunks, "second message"]);
  assert.ok(router.deliveries.list().every((d) => d.status === "sent"));
  // A chat whose first chunk fails keeps later chunks behind it.
  failures = 1;
  await router.deliver("tg", "chat2", "hello", "run:3");
  await router.deliver("tg", "chat2", "world", "run:4");
  assert.equal(sent.filter((s) => s.chatId === "chat2").length, 0, "nothing on chat2 overtook the failed chunk");
  const waiting = router.outstanding();
  assert.equal(waiting.length, 2);
  assert.equal(waiting[0].attempts, 1);
  assert.equal(waiting[0].lastError, "network down");
  router.deliveries.now = () => new Date(Date.now() + backoffMs(1) + 1000);
  await router.flush();
  assert.deepEqual(sent.filter((s) => s.chatId === "chat2").map((s) => s.text), ["hello", "world"]);
  // Five failures make a dead letter that an explicit retry revives.
  failures = 99;
  router.deliveries.now = () => new Date();
  await router.deliver("tg", "chat3", "doomed", "run:5");
  for (let i = 0; i < 6; i++) { router.deliveries.now = () => new Date(Date.now() + backoffMs(5) * (i + 1)); await router.flush(); }
  const dead = router.outstanding().find((d) => d.chatId === "chat3");
  assert.equal(dead.status, "dead");
  assert.equal(dead.attempts, 5);
  failures = 0;
  const revived = await router.retryDelivery(dead.id);
  assert.equal(revived.status, "sent");
  assert.equal(sent.at(-1).text, "doomed");
  await router.detachAll();
  assert.equal(backoffMs(4), 40000);
  assert.equal(backoffMs(20), 600000);
  await delay(5);
});
