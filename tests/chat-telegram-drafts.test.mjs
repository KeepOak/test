import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReplyStream } from "../dist/channels/reply-stream.js";
import { TelegramAdapter } from "../dist/channels/telegram.js";
import { chatFixture } from "./chat-fixture.mjs";

/* CHAT-052: a Telegram private chat sees the reply grow as a native draft, which has no message id, so the finished reply
   still goes out once as an ordinary message; a chat that refuses drafts falls back to the edited message. */
function stand(options = {}) {
  const calls = [];
  const adapter = { id: "tg", kind: "telegram",
    async send(chat, text) { calls.push({ op: "send", text }); return "r1"; },
    async edit(chat, id, text) { calls.push({ op: "edit", text }); },
    async sendDraft(chat, draftId, text) { calls.push({ op: "draft", draftId, text }); if (options.refuse) throw new Error("Bad Request: drafts are not allowed here"); },
  };
  const guard = options.guard ?? (async (text) => ({ text, blocked: false }));
  return { calls, stream: new ReplyStream({ adapter, chatId: "5", messageId: "in1" }, guard, 5) };
}

test("the reply grows as one draft, scrubbed first, and finish leaves the real send to the caller", async () => {
  const { calls, stream } = stand({ guard: async (text) => ({ text: text.replace(/sk-\w+/g, "[hidden]"), blocked: false }) });
  stream.text("The key is sk-abc123 and "); await delay(20);
  stream.text("more words "); await delay(20);
  const drafts = calls.filter((call) => call.op === "draft");
  assert.ok(drafts.length >= 1);
  assert.ok(drafts.every((call) => call.draftId === drafts[0].draftId && call.draftId > 0), "one draft, animated in place");
  assert.ok(drafts.every((call) => !call.text.includes("sk-")), "scrubbed before it is shown");
  assert.deepEqual(calls.filter((call) => call.op !== "draft"), [], "no message is sent or edited while drafting");
  assert.equal(await stream.finish("The key is sk-abc123 and more words."), null, "the caller sends the finished reply");
});

test("a chat that refuses drafts gets the edited message instead", async () => {
  const { calls, stream } = stand({ refuse: true });
  stream.text("First words "); await delay(20);
  stream.text("then more "); await delay(20);
  assert.equal(calls.filter((call) => call.op === "draft").length, 1, "drafts are tried once, then left alone");
  assert.equal(calls.filter((call) => call.op === "send").length, 1);
  assert.deepEqual(await stream.finish("First words then more."), { messageId: "r1", text: "First words then more." });
});

test("the Telegram adapter sends sendMessageDraft only to a private chat", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push([url.split("/").at(-1), JSON.parse(init.body)]); return Response.json({ ok: true, result: true }); };
  const adapter = new TelegramAdapter({ id: "tg", token: "fake", fetch });
  await adapter.sendDraft("555", 7, "Hello");
  assert.deepEqual(seen, [["sendMessageDraft", { chat_id: 555, draft_id: 7, text: "Hello" }]]);
  await assert.rejects(() => adapter.sendDraft("-100200", 7, "Hello"), /private chat/);
});

test("through the router the finished reply is sent exactly once after drafting", async (t) => {
  const drafts = [];
  const { app, sent, say } = await chatFixture(t, {
    reply: () => ({ content: "Here is a long answer about the garden plan.", toolCalls: [] }),
    adapter: { async edit() {}, async sendDraft(chatId, id, text) { drafts.push(text); } } });
  app.channels.setSwitches({ liveStatus: "on" });
  await say("owner-1", "tell me about the garden");
  assert.equal(sent.filter((message) => message.text === "Here is a long answer about the garden plan.").length, 1);
});
