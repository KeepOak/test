import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "./chat-fixture.mjs";

/* CHAT-156: the owner may choose to leave strangers' direct messages unanswered, with no pairing code made for them. */
test("unknown: ignore leaves a stranger's direct chat unanswered and makes no pairing request; groups keep their reply", async (t) => {
  const { app, sent, say } = await chatFixture(t);
  await say("stranger-9", "hi there");
  assert.match(sent.at(-1).text, /Ask my owner to approve code \d{6}/, "as shipped, a stranger is offered a code");
  app.store.delete("settings", app.runtime.owner, "channel-pair:tg:stranger-9");

  app.channels.setSenderAllowlist({ rules: [{ channel: "tg", sender: "blocked-3", decision: "block" }] });
  const saved = app.channels.setSenderAllowlist({ unknown: "ignore" });
  assert.equal(saved.unknown, "ignore");
  assert.equal(saved.rules.length, 1, "rules not given are kept");

  const before = sent.length;
  await say("stranger-9", "hello?");
  assert.equal(sent.length, before, "no reply at all");
  assert.equal(app.store.get("settings", app.runtime.owner, "channel-pair:tg:stranger-9"), undefined, "no pairing request");
  assert.equal(app.store.runs(app.runtime.owner).some((run) => run.prompt === "hello?"), false);

  await say("stranger-9", "anyone?", { chatId: "group-1", chatKind: "group" });
  assert.equal(sent.at(-1).text, "This assistant is private.", "a group keeps the refusal reply");

  await say("friend-2", "still me");
  assert.ok(app.store.runs(app.runtime.owner).some((run) => run.prompt === "still me"), "an approved pairing still works");
});
