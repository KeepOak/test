/* CHAT-041: /verbose sets how much of each step one direct chat is shown, without touching the app's setting or any
   other chat; "default" hands the chat back to the app's setting. */
import test from "node:test";
import assert from "node:assert/strict";
import { stepsInChat, verboseInChat } from "../dist/channels/steps-display.js";

function memoryStore() {
  const rows = new Map();
  return { get: (_t, _o, id) => rows.has(id) ? { data: rows.get(id) } : undefined,
    save: (_t, _o, id, data) => { rows.set(id, data); }, delete: (_t, _o, id) => rows.delete(id) };
}

test("/verbose cycles this chat's level, takes a named one, and default follows the app again", () => {
  const store = memoryStore(), app = { detail: "new", cleanup: false, noEdit: "summary" };
  const level = (chatId) => stepsInChat(store, "local", "telegram", chatId, app).detail;
  assert.match(verboseInChat(store, "local", "telegram", "1", "", app), /every step\./, "new → all");
  assert.equal(level("1"), "all");
  verboseInChat(store, "local", "telegram", "1", "", app);
  assert.equal(level("1"), "verbose");
  verboseInChat(store, "local", "telegram", "1", "", app);
  assert.equal(level("1"), "off", "and round again");
  verboseInChat(store, "local", "telegram", "1", "full", app);
  assert.equal(level("1"), "verbose");
  assert.equal(level("2"), "new", "another chat keeps the app's level");
  assert.match(verboseInChat(store, "local", "telegram", "1", "loud", app), /Use \/verbose off, new, all, full or default/);
  assert.match(verboseInChat(store, "local", "telegram", "1", "default", app), /follow this app's settings again/);
  assert.equal(level("1"), "new");
});

/* Through the real router, with the commands switch on so a paired friend and a group may use chat commands: only the
   owner's own direct chat changes its steps; a friend's DM and a group are told so and nothing is saved.
   Mutation: drop the ownerDmHere check in ChannelRouter.command and the friend's /verbose full is saved. */
async function routed(t) {
  const [{ mkdtemp }, { tmpdir }, { join }, { discardTemp }, { createBranch }, { saveCommandSettings }] = await Promise.all([
    import("node:fs/promises"), import("node:os"), import("node:path"), import("./temp-dir.mjs"), import("../dist/index.js"),
    import("../dist/commands/settings.js")]);
  const root = await mkdtemp(join(tmpdir(), "branch-chat-verbose-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } }, { activation: "always", pairing: true });
  for (const [sender, name] of [["owner-1", "Owner"], ["friend-2", "Friend"]])
    app.store.save("settings", app.runtime.owner, `channel-pair:tg:${sender}`,
      { status: "approved", code: "123456", name, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "tg", sender: "owner-1" }] });
  app.channels.setSwitches({ commands: "on" }); // chat commands for every paired sender, so a friend's /verbose is a command
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" }); // and the newer commands, /verbose among them
  let n = 0;
  const say = (senderId, text, extra = {}) => app.channels.handle({ channel: "tg", chatId: `dm-${senderId}`, chatKind: "direct", senderId,
    senderName: senderId, text, addressed: true, messageId: `m${++n}`, ...extra });
  const level = (chatId) => stepsInChat(app.store, app.runtime.owner, "tg", chatId, { detail: "new", cleanup: false, noEdit: "summary" }).detail;
  return { app, sent, say, level };
}

test("only the owner's own direct chat sets its steps; a friend's DM and a group save nothing", async (t) => {
  const { sent, say, level } = await routed(t);
  await say("owner-1", "/verbose full");
  assert.equal(level("dm-owner-1"), "verbose", "the owner's own DM is set");
  await say("friend-2", "/verbose full");
  assert.equal(level("dm-friend-2"), "new", "the friend's chat keeps the owner's level");
  await say("owner-1", "/verbose full", { chatId: "group-1", chatKind: "group" });
  assert.equal(level("group-1"), "new", "a group keeps the owner's level");
  assert.ok(sent.every((s) => s.chatId === "dm-owner-1" || !/steps/i.test(s.text) || /Only the owner's own direct chat/.test(s.text)), JSON.stringify(sent));
});
