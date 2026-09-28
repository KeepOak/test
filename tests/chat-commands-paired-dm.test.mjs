/**
 * Commands ship on in the owner's own paired direct chat (src/channels/chat-live-settings.ts commandsInPairedDm): with
 * the commands switch as shipped, an account the owner named as their own and approved by pairing code gets /status,
 * /help and the rest in its direct chat. A paired friend, a group, a sender let in only by the allowlist, and every
 * chat once the owner has set the switch keep the switch as it is. Stand-in chat app and model; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

let serial = 0;
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-paired-dm-commands-"));
  const asked = [];
  const provider = { name: "scripted", async complete(request) { asked.push(request); return { content: `Echo: ${request.messages.at(-1).content}`, toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["allowed"] });
  for (const [sender, name] of [["owner", "Owner"], ["friend", "Friend"]])
    app.store.save("settings", app.runtime.owner, `channel-pair:tg:${sender}`,
      { status: "approved", code: "123456", name, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  // The owner names this account as their own (Settings › Commands from your own chat, left off).
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "tg", sender: "owner" }] });
  const say = (text, extra = {}) => app.channels.handle({ channel: "tg", chatId: "dm", chatKind: "direct", senderId: "owner",
    senderName: "Owner", addressed: true, messageId: `m${++serial}`, text, ...extra });
  return { app, sent, asked, say };
}

test("as shipped, /help in the owner's paired direct chat is a command, not a message to the model", async (t) => {
  const { app, sent, asked, say } = await world(t);
  assert.equal(app.channels.summary().live.commands, "off", "the switch itself still ships off");
  await say("/help");
  assert.equal(asked.length, 0, "the model was not asked");
  assert.match(sent.at(-1).text, /\/stop/);
});

test("a group, and a sender let in only by the allowlist, keep commands off", async (t) => {
  const { sent, asked, say } = await world(t);
  await say("/help", { chatKind: "group", chatId: "team", chatTitle: "Team" });
  assert.equal(asked.length, 1, "in a group /help is an ordinary message");
  await say("/help", { senderId: "allowed", chatId: "dm2" });
  assert.equal(asked.length, 2, "an allowlisted, unpaired sender's /help is an ordinary message");
  assert.match(sent.at(-1).text, /^Echo: \/help/);
});

test("once the owner sets the switch, their choice holds in the paired direct chat too", async (t) => {
  const { app, asked, say } = await world(t);
  app.channels.setSwitches({ commands: "off" });
  await say("/help");
  assert.equal(asked.length, 1, "the owner turned commands off: /help goes to the model");
  app.channels.setSwitches({ commands: "on" });
  await say("/help");
  assert.equal(asked.length, 1, "and on is on");
});

test("a paired account the owner never named as their own keeps commands off", async (t) => {
  const { sent, asked, say } = await world(t);
  await say("/help", { senderId: "friend", chatId: "dm3" });
  assert.equal(asked.length, 1, "a paired friend's /help goes to the model");
  assert.match(sent.at(-1).text, /^Echo: \/help/);
});
