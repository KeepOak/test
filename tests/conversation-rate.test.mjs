/**
 * Settings › Permissions › Messages per conversation per hour (knobs limits.messagesPerConversationHour, 60 as shipped):
 * the most tasks one conversation may start in an hour, so a runaway loop stops. Work nobody typed (a trigger here) past
 * it is refused in words before anything starts; the owner's own message counts but is never refused; other
 * conversations are not touched; raising the figure lets it through.
 *
 * Mutation notes (each turns this file red):
 * - runtime.ts: drop the conversationRateRefusal check                  -> "refused in words" fails.
 * - runtime.ts: refuse the owner's own messages too (unattended = true) -> "the owner's own message is never refused" fails.
 * - store.ts sessionTasksSince: count every conversation, not this one  -> "another conversation is not touched" fails.
 * - store.ts sessionTasksSince: ignore the hour                         -> "an hour later it starts again" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs } from "../dist/index.js";
import { conversationRateRefusal } from "../dist/knobs/apply.js";
import { readKnobs } from "../dist/knobs/settings.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-conversation-rate-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("60 as shipped; past the figure a loop's next task is refused in words; the owner's own and other conversations are not", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  assert.equal(readKnobs(app.store, owner, "limits").messagesPerConversationHour, 60);
  saveKnobs(app.store, owner, "limits", { messagesPerConversationHour: 2 });
  const first = await app.runtime.run({ prompt: "one", source: "trigger" });
  await app.runtime.run({ prompt: "two", sessionId: first.sessionId, source: "trigger" });
  await assert.rejects(app.runtime.run({ prompt: "three", sessionId: first.sessionId, source: "trigger" }),
    /This conversation has had 2 messages in the last hour, the most Settings › Permissions allows, so this one did not start/);
  await assert.rejects(app.runtime.run({ prompt: "from a chat", sessionId: first.sessionId, source: "channel" }), /2 messages in the last hour/);
  await assert.rejects(app.runtime.run({ prompt: "from another Trunk", sessionId: first.sessionId, originFrom: first.id }), /2 messages in the last hour/);
  // The owner's own conversation: typed by hand, past the figure, still starts.
  const mine = await app.runtime.run({ prompt: "by hand 1" });
  for (const n of [2, 3]) assert.equal((await app.runtime.run({ prompt: `by hand ${n}`, sessionId: mine.sessionId })).status, "completed", "the owner's own message is never refused");
  const other = await app.runtime.run({ prompt: "elsewhere", source: "trigger" });
  assert.equal(other.status, "completed", "another conversation is not touched");
  saveKnobs(app.store, owner, "limits", { messagesPerConversationHour: 4 });
  assert.equal((await app.runtime.run({ prompt: "three", sessionId: first.sessionId, source: "trigger" })).status, "completed", "a higher figure lets it through");
});

test("the count is the last hour's: an hour later it starts again", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  saveKnobs(app.store, owner, "limits", { messagesPerConversationHour: 1 });
  const run = await app.runtime.run({ prompt: "one" });
  assert.match(conversationRateRefusal(app.store, owner, run.sessionId) ?? "", /1 messages in the last hour/);
  assert.equal(conversationRateRefusal(app.store, owner, run.sessionId, Date.now() + 3_600_000 + 1000), null);
});

test("over HTTP: the knobs route saves it, and a figure out of range is refused", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const ask = (body) => fetch(new URL("/api/knobs", server.url), { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await ask()).body.values.limits.messagesPerConversationHour, 60);
  assert.equal((await ask({ card: "limits", values: { messagesPerConversationHour: 120 } })).body.values.limits.messagesPerConversationHour, 120);
  assert.equal((await ask({ card: "limits", values: { messagesPerConversationHour: 0 } })).status, 400);
  assert.equal((await ask()).body.values.limits.maxSteps, null, "the card's other values are kept (the step limit ships as auto)");
});

test("a chat app's message past the figure is told why in these words, not a vague failure", async (t) => {
  const { app } = await fixture(t);
  saveKnobs(app.store, app.runtime.owner, "limits", { messagesPerConversationHour: 1 });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {}, async send(_c, text) { sent.push(text); return "1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  t.after(() => app.channels.detachAll());
  const msg = (id, text) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id });
  await app.channels.handle(msg("m1", "first"));
  await app.channels.handle(msg("m2", "second"));
  await app.channels.flush();
  assert.ok(sent.some((text) => /This conversation has had 1 messages in the last hour/.test(text)), sent.join(" | "));
  assert.ok(!sent.some((text) => /Something went wrong on my side/.test(text)));
});
