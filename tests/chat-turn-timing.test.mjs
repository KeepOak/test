/**
 * A slow chat reply explains itself (the owner's Telegram "Hi" took 10–39 s and nothing said where the time went). A chat
 * task's record says how long it waited before starting, and when its first words and its reply went out; "Look inside"
 * (GET /api/runs/:id/inspect, src/inspect.ts `timing`) turns that into parts: waiting, memory and instructions, tools and
 * model, first words, the whole answer, and sending it. Stand-in chat app and model only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { timing } from "../dist/inspect.js";

test("a chat task's record says where its time went, part by part", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-turn-timing-"));
  const provider = { name: "stand-in", async complete(request) { request.onTextDelta?.("Hi! "); return { content: "Hi! How can I help?", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const chat = { id: "tg", kind: "telegram", botName: () => "TK", async start() {}, async stop() {}, async send() { return "1"; } };
  await app.channels.attach(chat, { activation: "always", pairing: true, allowlist: ["owner"] });
  assert.equal(await app.channels.handle({ channel: "tg", chatId: "c", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: "Hi", addressed: true, messageId: "1" }), "replied");
  const [run] = app.store.runs(app.runtime.owner);
  const kinds = app.store.events(run.id).map((event) => event.kind);
  for (const kind of ["channel.inbound", "channel.first_words", "channel.sent"]) assert.ok(kinds.includes(kind), `${kind} is on the record`);
  const { parts, totalMs } = timing(app.store, run.id);
  assert.deepEqual(parts.map((p) => p.part), ["waited", "memory", "tools", "firstWords", "answer", "sent"]);
  assert.ok(parts.every((p) => Number.isFinite(p.ms) && p.ms >= 0));
  assert.ok(totalMs >= parts.find((p) => p.part === "answer").ms, "the total runs from taking the message in to the reply going out");
  // A task started in the window has no chat parts: nothing is guessed for them.
  const own = await app.runtime.run({ prompt: "hello" });
  assert.deepEqual(timing(app.store, own.id).parts.map((p) => p.part), ["memory", "tools", "answer"]);
});
