import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "./chat-fixture.mjs";
import { saveOwnerAccounts } from "../dist/reach/platform.js";

/* CHAT-261: Share › Hand off offers only the owner's own live Telegram direct chats, and links one only if it is still
   exactly what the chooser showed; a friend's chat is never offered. */
test("hand-off targets are the owner's own Telegram DMs, checked again before linking", async (t) => {
  const { app, say, sent } = await chatFixture(t);
  const owner = app.runtime.owner;
  for (const sender of ["1001", "2002"]) app.store.save("settings", owner, `channel-pair:tg:${sender}`,
    { status: "approved", code: "123456", name: sender, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  saveOwnerAccounts(app.store, owner, [{ channel: "tg", sender: "owner-1" }, { channel: "tg", sender: "1001" }]);
  await say("1001", "hello from my phone", { chatId: "1001" });
  await say("2002", "hello from a friend", { chatId: "2002" });
  const targets = app.channels.handoffTargets(owner);
  assert.deepEqual(targets.map((target) => target.chatId), ["1001"], "only the owner's own direct chat");

  const source = (await app.runtime.run({ prompt: "draft the letter" })).sessionId;
  const [mine] = targets;
  await assert.rejects(() => app.channels.handoff(owner, { channel: "tg", chatId: "1001", sourceSessionId: source,
    expectedSessionId: mine.sessionId, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }), /changed or is no longer available/);
  await assert.rejects(() => app.channels.handoff(owner, { channel: "tg", chatId: "2002", sourceSessionId: source,
    expectedSessionId: mine.sessionId, expectedUpdatedAt: mine.updatedAt }), /changed or is no longer available/);
  const done = await app.channels.handoff(owner, { channel: "tg", chatId: "1001", sourceSessionId: source,
    expectedSessionId: mine.sessionId, expectedUpdatedAt: mine.updatedAt });
  assert.equal(done.sent, true);
  assert.equal(app.channels.chats(owner).find((chat) => chat.chatId === "1001").sessionId, source, "the chat now carries on this conversation");
  assert.equal(sent.at(-1).text, "This conversation carries on here.");
  assert.equal(sent.at(-1).chatId, "1001");
});
