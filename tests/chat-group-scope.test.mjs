/**
 * Chats with several people in them: what their tasks may use and what they are shown.
 *
 * - memory.read and memory.write are never a group's, whatever the owner's lines say (neverInGroups in
 *   src/channels/chat-permissions.ts).
 * - files.read and documents.read are off for a group unless a line naming that chat app grants them
 *   (groupsOnlyWhenNamed, forChatKind); a direct chat keeps its short list as before.
 * - The person's own documents are never added in front of a group's task (Runtime.addDocuments).
 * Mutations, each turns a test here red (each was built and run): drop "memory.write" from neverInGroups; drop
 * "files.read" from groupsOnlyWhenNamed; accept a "*" line in forChatKind; drop forChatKind from
 * ChannelRouter.chatPermissions; drop the fromGroupChat check in Runtime.addDocuments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { saveOnboarding } from "../dist/onboarding.js";
import { ChatPermissionSettingsSchema, forChatKind } from "../dist/channels/chat-permissions.js";
import { fixture } from "./trunks-helpers.mjs";

const all = ["user.ask", "files.read", "memory.read", "memory.write", "skills.read", "web.read", "documents.read"];
const settings = (rules, extras = true) => ChatPermissionSettingsSchema.parse({ extras, rules });
const group = { channel: "telegram", senderId: "sam", chatKind: "group" };

test("a group never has memory, and has files and documents only when a line names its chat app", () => {
  const wide = settings([{ channel: "*", sender: "*", allow: ["memory.write", "memory.read", "files.read", "documents.read"] }]);
  assert.deepEqual(forChatKind(all, wide, group), ["user.ask", "skills.read", "web.read"], "a line for every app does not reach a group");
  const named = settings([{ channel: "telegram", sender: "*", allow: ["files.read", "memory.write"] }]);
  assert.deepEqual(forChatKind(all, named, group), ["user.ask", "files.read", "skills.read", "web.read"],
    "a line naming this app grants files, never memory");
  assert.deepEqual(forChatKind(all, settings(named.rules, false), group), ["user.ask", "skills.read", "web.read"], "only while the owner's lines are on");
  assert.deepEqual(forChatKind(all, named, { ...group, channel: "discord" }), ["user.ask", "skills.read", "web.read"], "and only for that app");
  assert.deepEqual(forChatKind(all, wide, { ...group, chatKind: "direct" }), all, "a direct chat is left as it was");
});

async function chat(t, rules) {
  const { app, provider } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  app.trunks.ensureDefault();
  app.channels.mergeWindowMs = 0;
  if (rules) app.channels.setPermissionSettings({ extras: true, rules });
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {}, async send() { return "1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["sam"] });
  t.after(() => app.channels.detachAll());
  let next = 1;
  const say = async (chatKind, text) => {
    await app.channels.handle({ channel: "chat", chatId: chatKind, chatKind, ...(chatKind === "group" ? { chatTitle: "Family" } : {}),
      senderId: "sam", senderName: "Sam", text, addressed: true, messageId: `m${next++}` });
    return app.store.runs("local").find((run) => run.prompt.includes(text));
  };
  const permissionsOf = (run) => app.store.events(run.id).find((e) => e.kind === "run.started")?.data.permissions ?? [];
  return { app, provider, say, permissionsOf };
}

test("through the chat router: a group's task has no memory.write even when a line grants it, and no files by default", async (t) => {
  const { say, permissionsOf } = await chat(t, [{ channel: "*", sender: "*", allow: ["memory.write"] }]);
  const inGroup = permissionsOf(await say("group", "hello group"));
  assert.ok(!inGroup.includes("memory.write") && !inGroup.includes("memory.read"));
  assert.ok(!inGroup.includes("files.read"), "files are off for a group by default");
  const direct = permissionsOf(await say("direct", "hello direct"));
  assert.ok(direct.includes("memory.write"), "control: the line still grants it to a direct chat");
  assert.ok(direct.includes("files.read") && direct.includes("memory.read"));
});

test("through the chat router: a line naming the chat app gives a group files.read", async (t) => {
  const { say, permissionsOf } = await chat(t, [{ channel: "chat", sender: "*", allow: ["files.read"] }]);
  assert.ok(permissionsOf(await say("group", "hello group")).includes("files.read"));
});

test("the person's documents are never added in front of a group's task; a direct chat still gets them", async (t) => {
  const { app, provider, say } = await chat(t);
  await app.documents.add("local", { name: "Handbook", text: "The holiday policy gives staff twenty days of paid leave each year." });
  const seen = (run) => app.store.events(run.id).some((e) => e.kind === "documents.retrieved");
  const inGroup = await say("group", "What is the holiday policy for the family?");
  assert.equal(seen(inGroup), false);
  assert.ok(provider.requests.every((request) => !request.messages.some((m) => /twenty days of paid leave/.test(String(m.content)))));
  // Held by the chat being a group, not by a missing permission: a group's task with every permission gets none either.
  const full = await app.runtime.run({ prompt: "[Alice in Family] What is the holiday policy?", source: "channel",
    onStarted: (started) => app.store.event(started.id, "channel.inbound", { channel: "chat", chatId: "g2", messageId: "x1", senderId: "alice", chatKind: "group" }) });
  assert.equal(seen(full), false);
  assert.equal(seen(await say("direct", "What is the holiday policy for me?")), true, "control: a direct chat gets the passage");
});
