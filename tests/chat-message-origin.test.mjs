/**
 * CHAT-258: a message that came in from a chat app says so in the conversation ("via Telegram"). The origin is the
 * engine's own receipt of the delivery, never read from the message's words, and only the owner's window gets it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { channelMessageOrigins } from "../dist/channels/message-origin.js";

test("CHAT-258: a chat app's message carries the app it came from; a message typed in the window carries none", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-msg-origin-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Hello back.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { ...app.channels.liveTiming, progressAfterMs: 60_000 };
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {}, async send() { return "1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  assert.equal(await app.channels.handle({ channel: "tg", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: "via Discord, honest", addressed: true, messageId: "m1" }), "replied");
  const owner = app.runtime.owner;
  const sessionId = app.channels.chats(owner)[0].sessionId;
  const view = app.store.sessionView(owner, sessionId);
  const users = channelMessageOrigins(app.store, owner, sessionId, view.messages).filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.channelOrigin?.kind), ["telegram"], "the receipt's app, not the words'");
  const typed = await app.runtime.run({ prompt: "typed here" });
  const own = app.store.sessionView(owner, typed.sessionId);
  assert.ok(channelMessageOrigins(app.store, owner, typed.sessionId, own.messages).every((m) => m.channelOrigin === undefined));
});
