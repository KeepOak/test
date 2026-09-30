/**
 * UP-CHAT-007..010: who may do what in a group, and how strangers are handled.
 * - In a group, only the owner's account (or a person the owner named with `groupCommands`) switches the model, starts
 *   the shared conversation afresh or stops somebody else's task.
 * - The owner's "chat commands off" holds for the owner-DM commands too.
 * - A stranger is answered once per code, never with a code in a group, at most three wait per app, and a block is silent.
 * - The owner's wrong-code count starts again after a right one.
 * A stand-in chat app of kind "telegram" is attached to the real router; the model is scripted. Nothing leaves this computer.
 *
 * Mutation notes (each turns this file red):
 * - router.ts command: drop groupCommandRefusal        -> "a member cannot switch the model" fails.
 * - router.ts ownerDmLine: drop the commands-off check -> "owner-DM commands obey the switch" fails.
 * - router.ts handle: reply to every stranger message  -> "answered once per code" fails.
 * - router.ts approveCode: keep wrongCodes             -> "starts again after a right code" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveOwnerAccounts } from "../dist/reach/platform.js";
import { saveChatLiveSwitches } from "../dist/channels/chat-live-settings.js";
import { saveSenderAllowlist } from "../dist/channels/allowlist.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

async function fixture(t, { hold = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-group-access-"));
  let release = () => undefined;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    if (hold) await Promise.race([gate, new Promise((resolve) => request.signal?.addEventListener?.("abort", resolve))]);
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { release(); await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "tg", kind: "telegram", botName: () => "bot", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } },
  { activation: "always", pairing: true, allowlist: ["owner-1", "friend-2", "friend-3"] });
  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "tg", sender: "owner-1" }]);
  let n = 0;
  const say = (senderId, text, extra = {}) => app.channels.handle({ channel: "tg", chatId: extra.chatId ?? "group-1", chatKind: "group",
    senderId, senderName: senderId, text, addressed: true, messageId: `m${++n}`, ...extra });
  return { app, provider, sent, say, release };
}
const last = (sent) => sent.at(-1)?.text ?? "";
const thread = (app, chatId = "group-1") => app.store.get("settings", app.runtime.owner, `channel-session:tg:${chatId}`)?.data?.sessionId;

test("in a group, a member cannot switch the model or start afresh; the owner and a person the owner named can", async (t) => {
  const { app, sent, say } = await fixture(t);
  saveChatLiveSwitches(app.store, app.runtime.owner, { commands: "on" });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" }); // /model is one of the shared commands
  await say("friend-2", "hello all");
  const before = thread(app);
  assert.ok(before);
  await say("friend-2", "/new");
  assert.match(last(sent), /only the owner or someone they choose can use \/new/);
  assert.equal(thread(app), before, "the shared conversation was not reset");
  await say("friend-2", "/model something");
  assert.match(last(sent), /only the owner or someone they choose can use \/model/);
  await say("friend-2", "/help");
  assert.doesNotMatch(last(sent), /only the owner or someone they choose/, "help is for everybody");

  await say("owner-1", "/new");
  assert.doesNotMatch(last(sent), /only the owner or someone they choose/);
  assert.notEqual(thread(app), before, "the owner's /new starts afresh");

  // A wide line never carries it; a line naming the person on the app does.
  app.channels.setPermissionSettings({ rules: [{ channel: "*", sender: "friend-3", groupCommands: true }] });
  await say("friend-3", "/new");
  assert.match(last(sent), /only the owner or someone they choose/);
  app.channels.setPermissionSettings({ rules: [{ channel: "tg", sender: "friend-3", groupCommands: true }] });
  await say("friend-3", "/new");
  assert.doesNotMatch(last(sent), /only the owner or someone they choose/);
  // A direct chat is that person's own: no group rule there.
  await say("friend-2", "/new", { chatKind: "direct", chatId: "dm-friend-2" });
  assert.doesNotMatch(last(sent), /only the owner or someone they choose/);
});

test("in a group, /stop stops only a task you started, unless you are the owner", async (t) => {
  const { app, sent, say, provider } = await fixture(t, { hold: true });
  saveChatLiveSwitches(app.store, app.runtime.owner, { commands: "on" });
  const working = say("friend-2", "write a long report");
  for (let i = 0; i < 100 && !provider.requests.length; i++) await delay(20);
  assert.equal(provider.requests.length, 1, "the task is working");
  await say("friend-3", "/stop");
  assert.match(last(sent), /only the person who started a task, or the owner, can stop it/);
  await say("friend-2", "/stop");
  assert.doesNotMatch(last(sent), /only the person who started/);
  await working;
});

test("owner-DM commands obey the owner's chat-commands switch once the owner moves it", async (t) => {
  const { app, provider, sent, say } = await fixture(t);
  app.store.save("memory", app.runtime.owner, "fact-1", { text: "The owner's sister is called Ada." });
  const dm = { chatKind: "direct", chatId: "dm-owner-1" };
  await say("owner-1", "/memory", dm);
  assert.match(last(sent), /sister is called Ada/, "as shipped, the owner's own chat reads them");
  saveChatLiveSwitches(app.store, app.runtime.owner, { commands: "off" });
  const asked = provider.requests.length;
  await say("owner-1", "/memory", dm);
  assert.ok(provider.requests.length > asked, "switched off, /memory is an ordinary message");
  assert.doesNotMatch(last(sent), /sister is called Ada/);
});

test("strangers: answered once per code, never in a group, three at most waiting, and a block is silent", async (t) => {
  const { app, sent, say } = await fixture(t);
  const dm = (who) => ({ chatKind: "direct", chatId: `dm-${who}` });
  assert.equal(await say("s1", "hi", dm("s1")), "pairing");
  assert.equal(await say("s1", "hello?", dm("s1")), "pairing");
  assert.equal(await say("s1", "anyone?", dm("s1")), "pairing");
  assert.equal(sent.filter((m) => m.chatId === "dm-s1").length, 1, "one code, one reply");
  assert.match(sent[0].text, /approve code \d{6}/);

  assert.equal(await say("s8", "just chatting", { addressed: false }), "ignored", "talk among others in a group asks for nothing");
  assert.equal(await say("s9", "hi everyone"), "pairing", "a stranger in a group waits for the owner");
  assert.equal(sent.filter((m) => m.chatId === "group-1").length, 0, "no code is posted where a group can read it");
  assert.ok(app.channels.summary().pending.some((p) => p.senderId === "s9"), "the owner sees the request in Settings");

  await say("s2", "hi", dm("s2"));
  await say("s3", "hi", dm("s3"));
  assert.equal(sent.filter((m) => m.chatId === "dm-s3").length, 0, "a fourth stranger is not offered a code");
  assert.equal(app.channels.summary().pending.length, 3);

  saveSenderAllowlist(app.store, app.runtime.owner, { rules: [{ channel: "tg", sender: "s5", decision: "block", note: "spam" }] });
  const count = sent.length;
  assert.equal(await say("s5", "let me in", dm("s5")), "rejected");
  assert.equal(sent.length, count, "a block says nothing");
});

test("the owner's wrong-code count starts again after a right code", async (t) => {
  const { app, sent, say } = await fixture(t);
  const codeOf = (who) => /code (\d{6})/.exec(sent.find((m) => m.chatId === `dm-${who}`).text)[1];
  const wrong = (code) => { const other = String((Number(code) + 1) % 1_000_000).padStart(6, "0"); assert.throws(() => app.channels.approve("local", { code: other }), /No pending request/); };
  await say("s1", "hi", { chatKind: "direct", chatId: "dm-s1" });
  for (let i = 0; i < 9; i++) wrong(codeOf("s1"));
  app.channels.approve("local", { code: codeOf("s1") });
  await say("s2", "hi", { chatKind: "direct", chatId: "dm-s2" });
  for (let i = 0; i < 9; i++) wrong(codeOf("s2"));
  assert.equal(app.channels.approve("local", { code: codeOf("s2") }).senderId, "s2", "nine earlier typos do not count against the next approval");
});
