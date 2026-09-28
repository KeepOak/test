import test from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter, createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { chatCommandsFor } from "../dist/channels/chat-commands.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discardTemp } from "./temp-dir.mjs";
import { setTimeout as delay } from "node:timers/promises";
const base = { id: "stand-in", token: "1234:TEST-fake-token", apiBase: "https://stand-in.invalid" };
function adapterFixture(options = {}) {
  const calls = [];
  const adapter = new TelegramAdapter({ ...base, fetch: async (url, init) => {
    calls.push({ method: String(url).split("/").at(-1), body: init.body });
    return Response.json(options.refused ? { ok: false, description: "refused" } : { ok: true, result: { message_id: 17 } });
  } });
  return { adapter, calls };
}
test("Telegram: the owner's own chats get a chat-scoped menu, and null clears it", async () => {
  const { adapter, calls } = adapterFixture();
  const rows = [{ command: "stop", description: "Stop" }];
  await adapter.setCommands([], [], { chatIds: ["4242", "not-a-chat"], commands: rows });
  await adapter.setCommands([], [], { chatIds: ["4242"], commands: null });
  assert.deepEqual(calls.slice(2, 3).map(one => [one.method, JSON.parse(one.body)]), [["setMyCommands", { commands: rows, scope: { type: "chat", chat_id: 4242 } }]]);
  assert.deepEqual(calls.at(-1).method, "deleteMyCommands");
  assert.equal(calls.length, 6, "only a real chat id gets its own menu");
});
test("Telegram menus use separate private/group scopes, each with its own rows", async () => {
  const split = adapterFixture();
  const direct = [{ command: "new", description: "Fresh thread" }, { command: "stop", description: "Stop" }], group = direct.slice(0, 1);
  await split.adapter.setCommands(direct, group);
  assert.deepEqual(split.calls.map(one => JSON.parse(one.body)), [
    { commands: direct, scope: { type: "all_private_chats" } }, { commands: group, scope: { type: "all_group_chats" } },
  ]);
  const { adapter, calls } = adapterFixture();
  const commands = [{ command: "new", description: "Fresh thread" }, { command: "trunk", description: "Who answers" }];
  await adapter.setCommands(commands);
  assert.deepEqual(calls.map(one => one.method), ["setMyCommands", "setMyCommands"]);
  assert.deepEqual(calls.map(one => JSON.parse(one.body)), [
    { commands, scope: { type: "all_private_chats" } }, { commands, scope: { type: "all_group_chats" } },
  ]);
});
for (const [mediaType, extension] of [["audio/ogg", "ogg"], ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"]])
  test(`Telegram ${mediaType} replies are actual voice uploads with topic/reply provenance`, async () => {
    const { adapter, calls } = adapterFixture();
    assert.equal(await adapter.sendVoice("-99:7", new Uint8Array([65,66]), mediaType, "12"), "17");
    const [{ method, body }] = calls; assert.equal(method, "sendVoice");
    assert.equal(body.get("chat_id"), "-99"); assert.equal(body.get("message_thread_id"), "7");
    assert.equal(body.get("audio"), null); assert.equal(body.get("voice").name, `reply.${extension}`);
    assert.deepEqual([...new Uint8Array(await body.get("voice").arrayBuffer())], [65,66]);
    assert.deepEqual(JSON.parse(body.get("reply_parameters")), { message_id: 12, allow_sending_without_reply: true });
  });
test("WAV speech is delivered as a file, preserving its format and topic", async () => {
  const { adapter, calls } = adapterFixture();
  await adapter.sendVoice("-99:7", new Uint8Array([65]), "audio/wav", "12");
  assert.equal(calls[0].method, "sendDocument");
  assert.equal(calls[0].body.get("document").name, "reply.wav");
  assert.equal(calls[0].body.get("message_thread_id"), "7");
});
test("refused voice uploads throw and oversized speech never starts an upload", async () => {
  const refused = adapterFixture({ refused: true });
  await assert.rejects(() => refused.adapter.sendVoice("42", new Uint8Array([65]), "audio/mpeg"), /sendVoice failed/);
  const normal = adapterFixture();
  await assert.rejects(() => normal.adapter.sendVoice("42", new Uint8Array(50*1024*1024+1), "audio/mpeg"), /50 MB/);
  assert.deepEqual(normal.calls, []);
});
test("router menus follow both saved command switches and their catalog; rejected menus do not break connection", async t => {
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-menu-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "stand-in", complete: async () => ({ content: "Done.", toolCalls: [] }) } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const menus = [], groups = [], owns = []; let refuse = false;
  const adapter = { id: "chat", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {}, async send() { return "1"; },
    async setCommands(commands, group, own) { if (refuse) throw new Error("refused"); menus.push(commands); groups.push(group); owns.push(own); } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  app.store.save("settings", app.runtime.owner, "channel-pair:chat:4242",
    { status: "approved", code: "123456", name: "Owner", requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "chat", sender: "4242" }] });
  await app.channels.refreshCommandMenus();
  // As shipped, only the owner's own paired direct chat reads commands (#706): only its menu lists them.
  assert.deepEqual(menus.at(-1).map(one => one.command), ["new", "trunk"], "everyone else's menu: /new and /trunk");
  assert.deepEqual(groups.at(-1).map(one => one.command), ["new", "trunk"]);
  assert.deepEqual(owns.at(-1).chatIds, ["4242"]);
  assert.ok(owns.at(-1).commands.some(one => one.command === "stop"), "the owner's own chat lists the commands as shipped");
  app.channels.setSwitches({ commands: "on" }); await app.channels.refreshCommandMenus();
  assert.ok(menus.at(-1).some(one => one.command === "stop"));
  assert.ok(!menus.at(-1).some(one => one.command === "goal"), "shared catalog still off");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 }); t.after(() => server.close());
  const response = await fetch(server.url + "/api/commands/settings", { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "on" }) });
  assert.equal(response.status, 200); await delay(30);
  const expected = new Set(["new", "trunk", ...chatCommandsFor("on").map(one => one.name)]);
  assert.deepEqual(new Set(menus.at(-1).map(one => one.command)), expected);
  assert.ok(!menus.at(-1).some(one => ["account", "loop", "remove"].includes(one.command)), "window-only owner commands excluded");
  refuse = true; app.channels.setSwitches({ commands: "off" }); await app.channels.refreshCommandMenus();
  assert.equal(app.channels.adapter("chat"), adapter);
  assert.equal(await app.channels.handle({ channel: "chat", chatId: "dm", chatKind: "direct", senderId: "owner", senderName: "Owner",
    addressed: true, text: "hello", messageId: "1" }), "replied");
  refuse = false; await app.channels.refreshCommandMenus(); assert.deepEqual(menus.at(-1).map(one => one.command), ["new", "trunk"],
    "the owner turned commands off: no menu lists them");
  assert.equal(owns.at(-1).commands, null, "and the owner's own chat menu is cleared back to everyone's");
  assert.deepEqual(groups.at(-1).map(one => one.command), ["new", "trunk"]);
});
for (const [label, lock] of [["scrubs secrets before speech", false], ["rechecks App lock after speech", true]])
  test(`router voice reply ${label}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "branch-telegram-voice-"));
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
      provider: { name: "stand-in", complete: async () => ({ content: "Here is SAVED-TEST-SECRET", toolCalls: [] }) } });
    t.after(async () => { await app.close(); await discardTemp(root); });
    const speech = [], uploads = [];
    app.channels.hideLeaks = text => text.replaceAll("SAVED-TEST-SECRET", "[hidden]");
    app.channels.transcribeVoice = async () => "hello";
    app.channels.speakReply = async text => { speech.push(text); if (lock) app.sessionLock.lock(); return { bytes: new Uint8Array([65]), mediaType: "audio/mpeg" }; };
    await app.channels.attach({ id: "chat", kind: "telegram", botName: () => "Branch", async start() {}, async stop() {}, async send() { return "1"; },
      async sendVoice(chat, bytes, type) { uploads.push({ chat, bytes, type }); return "2"; } },
    { activation: "always", pairing: false, allowlist: ["owner"] });
    app.channels.mergeWindowMs = 0;
    await app.channels.handle({ channel: "chat", chatId: "dm", chatKind: "direct", senderId: "owner", senderName: "Owner", addressed: true,
      text: "", messageId: "1", voice: { mediaType: "audio/ogg", bytes: async () => new Uint8Array([65]) } });
    assert.deepEqual(speech, ["Here is [hidden]"]);
    assert.equal(uploads.length, lock ? 0 : 1);
  });
