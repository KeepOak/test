/**
 * CHAT-096 / CHAT-200: /voice in a chat says when that chat's replies are spoken: to voice notes (as shipped), to every
 * reply (the owner's own account only), or never. Settings › Voice still decides whether anything is spoken at all.
 * Stand-in chat app, model and speech; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { chatVoiceMode, speaksHere } from "../dist/channels/chat-voice.js";
import { lookup } from "../dist/commands/catalog.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

let serial = 0;
async function world(t, voice = { replyWithVoiceOnChannels: true }) {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-command-"));
  const provider = { name: "scripted", async complete(request) { return { content: `Echo: ${request.messages.at(-1).content}`, toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.store.save("settings", app.runtime.owner, "voice", voice);
  const sent = [], spoken = [];
  app.channels.speakReply = async (text) => ({ bytes: new TextEncoder().encode(text), mediaType: "audio/ogg" });
  const adapter = { id: "tg", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); },
    async sendVoice(chatId, audio) { spoken.push({ chatId, words: new TextDecoder().decode(audio) }); return "v"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: [] });
  for (const sender of ["owner", "friend"])
    app.store.save("settings", app.runtime.owner, `channel-pair:tg:${sender}`,
      { status: "approved", code: "123456", name: sender, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "tg", sender: "owner" }] });
  // The shared commands switch (Settings › Commands) on, so commands beyond the ones chats always had are read.
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  app.channels.setSwitches({ commands: "on" });
  const say = (text, extra = {}) => app.channels.handle({ channel: "tg", chatId: "dm", chatKind: "direct", senderId: "owner",
    senderName: "Owner", addressed: true, messageId: `m${++serial}`, text, ...extra });
  const voiceNote = (extra = {}) => say("", { voice: { mediaType: "audio/ogg", bytes: async () => new Uint8Array([1]) }, ...extra });
  app.channels.transcribeVoice = async () => "hello by voice";
  return { app, sent, spoken, say, voiceNote };
}

test("the rule: voice notes by default, every reply, or never", () => {
  assert.deepEqual([speaksHere("voice", true), speaksHere("voice", false), speaksHere("always", false), speaksHere("off", true)], [true, false, true, false]);
  assert.equal(chatVoiceMode({ get: () => undefined }, "o", "tg", "c"), "voice");
  assert.deepEqual(lookup("tts")?.name, "voice");
  assert.deepEqual(lookup("voice").surfaces, ["chat"]);
  assert.equal(lookup("voice").level, "run", "a chat's own reply format, never an owner setting");
});

test("/voice always from the owner's account speaks every reply; /voice off speaks none; a voice note is answered in voice as shipped", async (t) => {
  const { sent, spoken, say, voiceNote } = await world(t);
  await say("/voice");
  assert.match(sent.at(-1).text, /Voice notes here are answered with a voice note/);
  await say("plain words");
  await until(() => sent.some((s) => s.text.startsWith("Echo: plain words")));
  assert.equal(spoken.length, 0, "a typed message gets words only, as shipped");
  await voiceNote();
  await until(() => spoken.length === 1);

  await say("/voice always");
  assert.match(sent.at(-1).text, /Every reply here is spoken/);
  await say("typed now");
  await until(() => spoken.length === 2);
  assert.match(spoken[1].words, /Echo: typed now/);

  await say("/tts off");
  assert.match(sent.at(-1).text, /words only/);
  await voiceNote();
  await until(() => sent.filter((s) => s.text.includes("Echo: hello by voice")).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(spoken.length, 2, "off: not even a voice note is answered in voice");
  await say("/voice sometimes");
  assert.match(sent.at(-1).text, /Send \/voice on/);
});

test("a paired friend cannot turn on spoken replies for every message, and the owner's Voice settings still win", async (t) => {
  const { app, sent, spoken, say } = await world(t, { replyWithVoiceOnChannels: false });
  await say("/voice always", { senderId: "friend", chatId: "dm-friend" });
  assert.match(sent.at(-1).text, /Only the owner/);
  assert.equal(chatVoiceMode(app.store, app.runtime.owner, "tg", "dm-friend"), "voice", "nothing saved");
  await say("/voice always");
  assert.match(sent.at(-1).text, /Spoken replies are off in Settings › Voice/, "it says why nothing will be spoken yet");
  // On an app that cannot vouch for its senders (email here), even an account named as the owner's is not trusted with it.
  const mail = { id: "mail", kind: "email", botName: () => "me@x", async start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); return "e"; } };
  await app.channels.attach(mail, { activation: "always", pairing: false, allowlist: ["owner@x"] });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "tg", sender: "owner" }, { channel: "mail", sender: "owner@x" }] });
  await app.channels.handle({ channel: "mail", chatId: "owner@x", chatKind: "direct", senderId: "owner@x", senderName: "Owner", addressed: true, messageId: "e1", text: "/voice always" });
  assert.match(sent.at(-1).text, /Only the owner/);
  app.store.save("settings", app.runtime.owner, "voice", { replyWithVoiceOnChannels: true, keepAudioOnThisComputer: true });
  await say("/voice");
  assert.match(sent.at(-1).text, /Keep audio on this computer is on/);
  assert.equal(spoken.length, 0);
});

async function until(check, tries = 300) {
  for (let i = 0; i < tries; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail(`timed out: ${check}`);
}
