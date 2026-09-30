/**
 * CHAT-203: /insights, thirty days of usage. It adds the days up, names the top models, says when a
 * price is unknown, and a chat never gets the owner's all-conversation figures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { insightLines, insightsCommand } from "../dist/commands/insights.js";

const day = (date, model, runs, input, cost) => ({ date, runs, toolCalls: runs * 2, tokens: { input, output: 10 }, estimatedCost: cost ?? 0,
  pricedRuns: cost === null ? 0 : runs, unpricedRuns: cost === null ? runs : 0, failures: 0,
  presets: [{ id: model, model, runs, tokens: { input, output: 10 }, cost }], byChannel: [{ source: "window", runs, cost }] });

test("CHAT-203: thirty days are added up, with top models and unknown prices said plainly", () => {
  const text = insightLines([day("2026-09-29", "gpt-5.5", 2, 1000, 0.5), day("2026-09-28", "local", 1, 50, null)], "your conversations").join("\n");
  assert.match(text, /3 tasks · 6 tool calls · 2 active days/);
  assert.match(text, /1,050 tokens in · 20 out/);
  assert.match(text, /about \$0\.50 · 1 tasks have unknown prices/);
  assert.match(text, /gpt-5\.5: 2 tasks · 1,020 tokens · about \$0\.50\nlocal: 1 tasks · 60 tokens · price unknown/);
});

test("CHAT-203: in a chat, /insights all is refused and nothing is read", () => {
  let read = 0;
  const host = { requireOwner() { throw new Error("no"); }, runtime: { store: { ownsSession: () => true, usageStore() { read++; } } } };
  const reply = insightsCommand({ host, surface: "chat", access: "full", argument: "all", sessionId: "s1" });
  assert.match(reply.text, /owner key/);
  assert.equal(read, 0);
});
