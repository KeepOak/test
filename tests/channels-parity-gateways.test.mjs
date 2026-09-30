import test from "node:test";
import assert from "node:assert/strict";
import { saveReplyStyle } from "../dist/channels/reply-style.js";
import { createServer, connect as tcpConnect } from "node:net";
import {
  fixture, until, delay, assertNoSecret, httpService, socketService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { RevoltChannel } from "../dist/channels/revolt.js";
import { GuildedChannel } from "../dist/channels/guilded.js";
import { VkChannel } from "../dist/channels/vk.js";
import { QqBotChannel } from "../dist/channels/qq-bot.js";
import { MumbleChannel, refusePeer, htmlToText, textToHtml } from "../dist/channels/mumble.js";
import { encodeFields, decodeFields, frame, frameReader, numberField, numberList, textField, MumbleType } from "../dist/channels/mumble-proto.js";
import { connectWebSocket } from "../dist/channels/ws-client.js";

/**
 * The gateway batch: VK, QQ (official bot), Guilded, Revolt and Mumble, each against a stand-in
 * that answers the way the service's documentation says. No real service is contacted.
 */
const REVOLT_TOKEN = "SECRET-REVOLT-BOT-TOKEN-1";
const GUILDED_TOKEN = "SECRET-GUILDED-BOT-TOKEN-2";
const VK_TOKEN = "SECRET-VK-GROUP-TOKEN-3";
const VK_KEY = "SECRET-VK-LONGPOLL-KEY-4";
const QQ_SECRET = "SECRET-QQ-CLIENT-SECRET-5";
const QQ_ACCESS = "SECRET-QQ-ACCESS-TOKEN-6";
const MUMBLE_PASSWORD = "SECRET-MUMBLE-SERVER-PW-7";
const policy = { activation: "mention", allowlist: [] };

// ---------------------------------------------------------------- Revolt

async function revoltWorld(t, { refuse = false } = {}) {
  let count = 0;
  const api = await httpService(t, (call) => {
    if (call.headers["x-bot-token"] !== REVOLT_TOKEN || refuse) return { status: 401, body: { type: "Unauthenticated" } };
    if (call.path === "/users/@me") return { body: { _id: "RBOT", username: "branchbot" } };
    if (call.path === "/channels/DM1") return { body: { channel_type: "DirectMessage" } };
    if (call.path === "/channels/TXT1") return { body: { channel_type: "TextChannel" } };
    if (call.method === "POST" && /^\/channels\/\w+\/messages$/.test(call.path)) return { body: { _id: `out-${++count}` } };
    return undefined;
  });
  const events = await socketService(t, (connection) => {
    connection.onMessage = (value) => {
      if (value.type === "Authenticate" && value.token === REVOLT_TOKEN) {
        connection.send({ type: "Authenticated" });
        connection.send({ type: "Ready", users: [], servers: [], channels: [{ _id: "TXT1", channel_type: "TextChannel" }] });
      }
    };
  });
  const channel = new RevoltChannel({ id: "revolt", token: REVOLT_TOKEN, apiBase: api.base, wsBase: events.url, pingMs: 30, retryBaseMs: 20 });
  const sent = () => api.calls.filter((c) => c.method === "POST").map((c) => c.json.content);
  const say = (link, fields) => link.send({ type: "Message", _id: `in-${Date.now()}-${Math.random()}`, ...fields });
  return { api, events, channel, sent, say };
}

test("Revolt: signs in on the socket, pings, pairs a stranger in a DM, and answers the right channel", async (t) => {
  const context = await fixture(t);
  const world = await revoltWorld(t);
  await context.app.channels.attach(world.channel, { ...policy, pairing: true });
  saveReplyStyle(context.app.store, context.app.runtime.owner, { channel: "revolt", quote: "first" }, ["revolt"]); // A one-to-one answer quotes only when needed (reply-style.ts); "first" checks this app's quote on the wire.
  t.after(() => world.channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  assert.match(link.path, /version=1&format=json/);
  assert.ok(!link.path.includes(REVOLT_TOKEN), "the token is not in the address");
  await until(() => world.channel.health().state === "connected", "ready");
  await until(() => link.received.some((m) => m.type === "Ping"), "a ping");

  await pairingWalk(context, { label: "Revolt", sent: world.sent,
    say: async (text) => world.say(link, { channel: "DM1", author: "USER1", content: text }) });
  const reply = world.api.calls.filter((c) => c.method === "POST").at(-1);
  assert.equal(reply.path, "/channels/DM1/messages");
  assert.deepEqual(reply.json.replies?.[0]?.mention, false);

  // The bot's own message and an unaddressed channel message are left alone.
  const asked = context.provider.requests.length;
  world.say(link, { channel: "DM1", author: "RBOT", content: "Echo: something I said" });
  world.say(link, { channel: "TXT1", author: "USER1", content: "just chatting" });
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "own and unaddressed messages are not answered");
  world.say(link, { channel: "TXT1", author: "USER1", content: "<@RBOT> summarise please", mentions: ["RBOT"] });
  await until(() => world.api.calls.some((c) => c.path === "/channels/TXT1/messages" && /summarise please/.test(c.json.content)), "answered in the channel");
  assert.ok(!context.provider.requests.at(-1).messages.at(-1).content.includes("<@RBOT>"), "the mention is stripped");
  await assertNoSecret(context, [REVOLT_TOKEN]);
});

test("Revolt: a stranger is refused when pairing is off, and a refused token is said plainly", async (t) => {
  const context = await fixture(t);
  const world = await revoltWorld(t);
  await context.app.channels.attach(world.channel, { ...policy, pairing: false });
  t.after(() => world.channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  await until(() => world.channel.health().state === "connected", "ready");
  await refusalWalk(context, { label: "Revolt", sent: world.sent,
    say: async (text) => world.say(link, { channel: "DM1", author: "USER2", content: text }) });

  const refused = await revoltWorld(t, { refuse: true });
  await refused.channel.start(async () => undefined);
  t.after(() => refused.channel.stop());
  await until(() => refused.channel.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.channel.health().reason, /REVOLT_BOT_TOKEN/);
  assert.equal(refused.events.connections.length, 0, "no socket is opened with a refused token");
  await assertNoSecret(context, [REVOLT_TOKEN]);
});

// ---------------------------------------------------------------- Guilded

async function guildedWorld(t) {
  let count = 0;
  const api = await httpService(t, (call) => {
    if (call.headers.authorization !== `Bearer ${GUILDED_TOKEN}`) return { status: 401, body: {} };
    if (call.method === "POST" && /^\/channels\/[\w-]+\/messages$/.test(call.path)) return { body: { message: { id: `g-out-${++count}` } } };
    return undefined;
  });
  const events = await socketService(t, (connection) => {
    connection.send({ op: 1, d: { heartbeatIntervalMs: 22500, lastMessageId: "before-start", user: { id: "GBOT", name: "Branch" } } });
  });
  const channel = new GuildedChannel({ id: "guilded", token: GUILDED_TOKEN, apiBase: api.base, socketUrl: events.url, retryBaseMs: 20 });
  let n = 0;
  const say = (link, message) => link.send({ op: 0, t: "ChatMessageCreated", s: `gm-${++n}`,
    d: { serverId: "S1", message: { id: `gm-${n}`, channelId: "CH1", type: "default", createdBy: "USER1", ...message } } });
  const sent = () => api.calls.map((c) => c.json.content);
  return { api, events, channel, say, sent };
}

test("Guilded: a Bearer socket, answers when mentioned, never answers itself, and replays after a drop", async (t) => {
  const context = await fixture(t);
  const world = await guildedWorld(t);
  await context.app.channels.attach(world.channel, { ...policy, pairing: true });
  t.after(() => world.channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  assert.equal(link.headers.authorization, `Bearer ${GUILDED_TOKEN}`);
  assert.equal(link.headers["guilded-last-message-id"], undefined, "the first connection never asks for history");
  await until(() => world.channel.health().state === "connected", "welcomed");

  await pairingWalk(context, { label: "Guilded", sent: world.sent,
    say: async (text) => world.say(link, { content: `@Branch ${text}`, mentions: { users: [{ id: "GBOT" }] } }) });
  const reply = world.api.calls.at(-1);
  assert.equal(reply.path, "/channels/CH1/messages");
  assert.match(reply.json.replyMessageIds[0], /^gm-\d+$/, "the reply names the message it answers");
  assert.ok(!/@Branch/.test(context.provider.requests.at(-1).messages.at(-1).content), "the mention is stripped");

  const asked = context.provider.requests.length;
  world.say(link, { content: "@Branch Echo: my own words", createdBy: "GBOT", mentions: { users: [{ id: "GBOT" }] } });
  world.say(link, { content: "nobody asked the bot" });
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "own and unaddressed messages are not answered");

  link.socket.destroy();
  const again = await until(() => world.events.connections[1], "reconnected");
  assert.match(again.headers["guilded-last-message-id"], /^gm-\d+$/, "the reconnect asks for what was missed");
  await assertNoSecret(context, [GUILDED_TOKEN]);
});

test("Guilded: a stranger is refused when pairing is off", async (t) => {
  const context = await fixture(t);
  const world = await guildedWorld(t);
  await context.app.channels.attach(world.channel, { ...policy, pairing: false });
  t.after(() => world.channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  await until(() => world.channel.health().state === "connected", "welcomed");
  await refusalWalk(context, { label: "Guilded", sent: world.sent,
    say: async (text) => world.say(link, { createdBy: "USER9", content: `@Branch ${text}`, mentions: { users: [{ id: "GBOT" }] } }) });
  await assertNoSecret(context, [GUILDED_TOKEN]);
});

// ---------------------------------------------------------------- VK

async function vkWorld(t, { history = [], refuse = false } = {}) {
  const queue = [];
  let ts = 100;
  let sentCount = 0;
  const api = await httpService(t, (call) => {
    if (call.path === "/method/groups.getLongPollServer") {
      if (refuse) return { body: { error: { error_code: 5, error_msg: "User authorization failed" } } };
      return { body: { response: { key: VK_KEY, server: `${api.base}/lp`, ts: String(ts) } } };
    }
    if (call.path === "/method/messages.send") return { body: { response: 500 + ++sentCount } };
    if (call.path === "/lp") {
      if (call.query.key !== VK_KEY) return { body: { failed: 2 } };
      if (call.query.wait === "0") return { body: { ts: String(ts), updates: history } };
      const next = queue.shift();
      if (next?.failed) return { body: next };
      ts++;
      return { body: { ts: String(ts), updates: next ? [next] : [] } };
    }
    return undefined;
  });
  const channel = new VkChannel({ id: "vk", groupId: 77, token: VK_TOKEN, apiBase: `${api.base}/method`, waitSeconds: 1, pollGapMs: 10, retryBaseMs: 20 });
  let n = 0;
  const say = (message) => queue.push({ type: "message_new", group_id: 77,
    object: { message: { id: ++n, conversation_message_id: 0, from_id: 1001, peer_id: 1001, out: 0, ...message } } });
  const sends = () => api.calls.filter((c) => c.path === "/method/messages.send");
  return { api, channel, say, queue, sends, sent: () => sends().map((c) => c.form.message) };
}

test("VK: takes stock first, pairs a stranger, answers groups on a mention, and keeps the token in the body", async (t) => {
  const context = await fixture(t);
  const old = { type: "message_new", object: { message: { id: 1, from_id: 1001, peer_id: 1001, out: 0, text: "an old message" } } };
  const world = await vkWorld(t, { history: [old] });
  await context.app.channels.attach(world.channel, { ...policy, pairing: true });
  saveReplyStyle(context.app.store, context.app.runtime.owner, { channel: "vk", quote: "first" }, ["vk"]); // A one-to-one answer quotes only when needed (reply-style.ts); "first" checks this app's quote on the wire.
  t.after(() => world.channel.stop());
  await until(() => world.channel.health().state === "connected", "polling");
  const firstCheck = world.api.calls.find((c) => c.path === "/lp");
  assert.equal(firstCheck.query.ts, "100", "the first check starts at the place VK gave");
  assert.equal(firstCheck.query.act, "a_check");
  await delay(80);
  assert.equal(world.sends().length, 0, "the message from before Branch started is not answered");
  const keyCall = world.api.calls[0];
  assert.equal(keyCall.method, "POST");
  assert.equal(keyCall.form.access_token, VK_TOKEN);
  assert.equal(keyCall.form.group_id, "77");
  assert.equal(keyCall.form.v, "5.199");
  assert.ok(world.api.calls.every((c) => !JSON.stringify(c.query).includes(VK_TOKEN)), "the token never travels in an address");

  await pairingWalk(context, { label: "VK", sent: world.sent, say: async (text) => world.say({ text }) });
  const reply = world.sends().at(-1).form;
  assert.equal(reply.peer_id, "1001");
  assert.match(reply.random_id, /^\d+$/);
  assert.match(reply.reply_to, /^\d+$/);

  const asked = context.provider.requests.length;
  world.say({ text: "sent by the community", out: 1 });
  world.say({ text: "another community", from_id: -77 });
  world.say({ text: "chatting in the group", peer_id: 2000000005 });
  await delay(150);
  assert.equal(context.provider.requests.length, asked, "outgoing, community and unaddressed messages are left alone");
  world.say({ text: "[club77|@branch] summarise please", peer_id: 2000000005, id: 0, conversation_message_id: 12 });
  await until(() => world.sends().some((c) => c.form.peer_id === "2000000005"), "answered in the group chat");
  const groupReply = world.sends().find((c) => c.form.peer_id === "2000000005").form;
  assert.deepEqual(JSON.parse(groupReply.forward), { peer_id: 2000000005, conversation_message_ids: [12], is_reply: true });
  assert.equal(context.provider.requests.at(-1).messages.at(-1).content.includes("club77"), false, "the mention is stripped");

  // An expired key is replaced and the place kept, as the docs say for failed: 2.
  const before = world.api.calls.filter((c) => c.path === "/method/groups.getLongPollServer").length;
  world.queue.push({ failed: 2 });
  await until(() => world.api.calls.filter((c) => c.path === "/method/groups.getLongPollServer").length > before, "a new key");
  await assertNoSecret(context, [VK_TOKEN, VK_KEY]);
});

test("VK: a stranger is refused when pairing is off, a refused token is said plainly, and a foreign long-poll server is not followed", async (t) => {
  const context = await fixture(t);
  const world = await vkWorld(t);
  await context.app.channels.attach(world.channel, { ...policy, pairing: false });
  t.after(() => world.channel.stop());
  await until(() => world.channel.health().state === "connected", "polling");
  await refusalWalk(context, { label: "VK", sent: world.sent, say: async (text) => world.say({ text, from_id: 2002, peer_id: 2002 }) });

  const refused = await vkWorld(t, { refuse: true });
  await refused.channel.start(async () => undefined);
  t.after(() => refused.channel.stop());
  await until(() => refused.channel.health().state === "needs attention", "the refusal");
  assert.match(refused.channel.health().reason, /VK_GROUP_TOKEN/);
  assert.ok(!refused.channel.health().reason.includes(VK_TOKEN));

  // Against the real API, a long-poll server that is not VK's is refused before it is called.
  const asked = [];
  const forged = new VkChannel({ id: "vk2", groupId: 77, token: VK_TOKEN, retryBaseMs: 20,
    fetch: async (url, init) => { asked.push(String(url));
      return new Response(JSON.stringify({ response: { key: VK_KEY, server: "https://evil.example.com/lp", ts: "1" } }), { status: 200 }); } });
  await forged.start(async () => undefined);
  t.after(() => forged.stop());
  await until(() => /not VK's/.test(forged.health().reason ?? ""), "the forged server is refused");
  assert.ok(asked.every((url) => url.startsWith("https://api.vk.com/method/")), "nothing else was called");
  await assertNoSecret(context, [VK_TOKEN, VK_KEY]);
});

// ---------------------------------------------------------------- QQ

async function qqWorld(t, { gatewayUrl } = {}) {
  let count = 0;
  const events = await socketService(t, (connection) => {
    connection.send({ op: 10, d: { heartbeat_interval: 41250 } });
    connection.onMessage = (value) => {
      if (value.op === 2) connection.send({ op: 0, s: 1, t: "READY", d: { version: 1, session_id: "SESSION-1", user: { id: "QBOT", username: "branch", bot: true }, shard: [0, 1] } });
      if (value.op === 6) connection.send({ op: 0, s: value.d.seq + 1, t: "RESUMED", d: "" });
    };
  });
  const api = await httpService(t, (call) => {
    if (call.path === "/app/getAppAccessToken")
      return call.json?.clientSecret === QQ_SECRET ? { body: { access_token: QQ_ACCESS, expires_in: "7200" } } : { status: 401, body: { code: 100016 } };
    if (call.headers.authorization !== `QQBot ${QQ_ACCESS}`) return { status: 401, body: {} };
    if (call.path === "/gateway") return { body: { url: gatewayUrl ?? events.url } };
    if (call.method === "POST") return { body: { id: `qq-out-${++count}`, timestamp: "2026-09-17T00:00:00+08:00" } };
    return undefined;
  });
  const make = (secret = QQ_SECRET) => new QqBotChannel({ id: "qq", appId: "1024", clientSecret: secret, apiBase: api.base,
    tokenUrl: `${api.base}/app/getAppAccessToken`, heartbeatMs: 30, retryBaseMs: 20 });
  let seq = 1;
  const push = (link, type, d) => link.send({ op: 0, s: ++seq, t: type, id: `ev-${seq}`, d: { id: `qm-${seq}`, timestamp: "", ...d } });
  const posts = () => api.calls.filter((c) => c.method === "POST" && c.path !== "/app/getAppAccessToken");
  return { api, events, make, push, posts, sent: () => posts().map((c) => c.json.content) };
}

test("QQ bot: token, gateway, identify, heartbeats, passive replies to each kind of chat, and resume", async (t) => {
  const context = await fixture(t);
  const world = await qqWorld(t);
  const channel = world.make();
  await context.app.channels.attach(channel, { ...policy, pairing: true });
  t.after(() => channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  const identify = await until(() => link.received.find((m) => m.op === 2), "identify");
  assert.equal(identify.d.token, `QQBot ${QQ_ACCESS}`);
  assert.deepEqual(identify.d.shard, [0, 1]);
  assert.equal(identify.d.intents & (1 << 25), 1 << 25, "group and private messages are asked for");
  await until(() => channel.health().state === "connected", "ready");
  await until(() => link.received.some((m) => m.op === 1 && m.d === 1), "a heartbeat carrying the last sequence");

  await pairingWalk(context, { label: "QQ", sent: world.sent,
    say: async (text) => world.push(link, "C2C_MESSAGE_CREATE", { author: { user_openid: "OPENID-A" }, content: text }) });
  const reply = world.posts().at(-1);
  assert.equal(reply.path, "/v2/users/OPENID-A/messages");
  assert.equal(reply.headers.authorization, `QQBot ${QQ_ACCESS}`);
  assert.equal(reply.json.msg_type, 0);
  assert.match(reply.json.msg_id, /^qm-\d+$/, "a passive reply names the message");
  assert.equal(typeof reply.json.msg_seq, "number");

  world.push(link, "GROUP_AT_MESSAGE_CREATE", { group_openid: "GROUP-1", author: { member_openid: "OPENID-A" }, content: " hello group" });
  world.push(link, "AT_MESSAGE_CREATE", { channel_id: "CHAN-1", guild_id: "GUILD-1", author: { id: "QBOT", bot: true }, content: "<@!QBOT> my own words" });
  world.push(link, "DIRECT_MESSAGE_CREATE", { guild_id: "DMG-1", channel_id: "DMC-1", author: { id: "U-77", username: "friend" }, content: "hi in a dm" });
  await until(() => world.posts().some((c) => c.path === "/dms/DMG-1/messages"), "the guild DM gets a pairing offer at its own address");
  await until(() => world.posts().some((c) => c.path === "/v2/groups/GROUP-1/messages"), "the group gets a pairing offer at its own address");
  assert.ok(!world.posts().some((c) => c.path.startsWith("/channels/")), "the bot's own channel message is not answered");

  link.socket.destroy();
  const again = await until(() => world.events.connections[1], "reconnected");
  const resume = await until(() => again.received.find((m) => m.op === 6), "resumed");
  assert.equal(resume.d.session_id, "SESSION-1");
  assert.equal(resume.d.token, `QQBot ${QQ_ACCESS}`);
  assert.equal(world.api.calls.filter((c) => c.path === "/app/getAppAccessToken").length, 1, "the token is reused until it runs out");
  await assertNoSecret(context, [QQ_SECRET, QQ_ACCESS]);
});

test("QQ bot: a stranger is refused when pairing is off, a wrong secret is said plainly, and a foreign gateway is not followed", async (t) => {
  const context = await fixture(t);
  const world = await qqWorld(t);
  const channel = world.make();
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  await until(() => channel.health().state === "connected", "ready");
  await refusalWalk(context, { label: "QQ", sent: world.sent,
    say: async (text) => world.push(link, "C2C_MESSAGE_CREATE", { author: { user_openid: "OPENID-Z" }, content: text }) });

  const wrong = world.make("not-the-secret");
  await wrong.start(async () => undefined);
  t.after(() => wrong.stop());
  await until(() => wrong.health().state === "needs attention", "the refusal");
  assert.match(wrong.health().reason, /QQ_BOT_CLIENT_SECRET/);

  const forged = await qqWorld(t, { gatewayUrl: "wss://evil.example.com/websocket" });
  const lured = forged.make();
  await lured.start(async () => undefined);
  t.after(() => lured.stop());
  await until(() => /not QQ's/.test(lured.health().reason ?? ""), "the foreign gateway is refused");
  assert.equal(forged.events.connections.length, 0);
  await assertNoSecret(context, [QQ_SECRET, QQ_ACCESS]);
});

// ---------------------------------------------------------------- Mumble

/** A Mumble control-channel stand-in over plain TCP; the TLS layer is the opener's business. */
async function mumbleServer(t, { reject } = {}) {
  const connections = [];
  const server = createServer((socket) => {
    const connection = { socket, frames: [], send: (type, fields) => socket.write(frame(type, encodeFields(fields))) };
    connections.push(connection);
    socket.on("error", () => undefined);
    socket.on("data", frameReader((type, body) => {
      const fields = decodeFields(body);
      connection.frames.push({ type, fields });
      if (type !== MumbleType.Authenticate) return;
      if (reject) { connection.send(MumbleType.Reject, [[1, reject]]); socket.end(); return; }
      connection.send(MumbleType.ChannelState, [[1, 0], [3, "Root"]]);
      connection.send(MumbleType.ChannelState, [[1, 3], [2, 0], [3, "Lobby"]]);
      connection.send(MumbleType.UserState, [[1, 5], [3, "branch"]]);
      connection.send(MumbleType.UserState, [[1, 9], [3, "carol"], [4, 42], [5, 3]]);
      connection.send(MumbleType.UserState, [[1, 11], [3, "guest"]]);
      connection.send(MumbleType.ServerSync, [[1, 5], [3, "Welcome"]]);
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const c of connections) c.socket.destroy(); server.close(resolve); }));
  const port = server.address().port;
  const open = () => new Promise((resolve, reject) => { const s = tcpConnect({ host: "127.0.0.1", port }, () => resolve(s)); s.once("error", reject); });
  return { connections, open };
}
const textsFrom = (connection) => connection.frames.filter((f) => f.type === MumbleType.TextMessage);

test("Mumble: hand-written protobuf and HTML read and write as the protocol says", () => {
  const body = encodeFields([[1, 300], [2, "héllo"], [5, true], [6, 1n << 40n]]);
  const fields = decodeFields(body);
  assert.equal(numberField(fields, 1), 300);
  assert.equal(textField(fields, 2), "héllo");
  assert.equal(numberField(fields, 5), 1);
  assert.equal(numberField(fields, 6), 2 ** 40);
  assert.deepEqual(numberList(decodeFields(Buffer.from([0x1a, 0x03, 0x01, 0x96, 0x01])), 3), [1, 150], "a packed list is read too");
  const framed = frame(11, Buffer.from([0xaa, 0xbb]));
  assert.deepEqual([...framed], [0, 11, 0, 0, 0, 2, 0xaa, 0xbb]);
  assert.equal(htmlToText("<p>a &amp; b<br/>c &lt;x&gt;</p>"), "a & b\nc <x>");
  assert.equal(textToHtml("<b>&\"\nnext"), "&lt;b&gt;&amp;&quot;<br>next");
  const pin = "AB:".repeat(31) + "AB";
  assert.equal(refusePeer({ authorized: false, error: "DEPTH_ZERO_SELF_SIGNED_CERT", fingerprint256: pin }, { allowSelfSigned: false, fingerprint: pin.toLowerCase() }), null);
  assert.match(refusePeer({ authorized: true, fingerprint256: "CD:".repeat(31) + "CD" }, { allowSelfSigned: false, fingerprint: pin }), /does not match/);
  assert.match(refusePeer({ authorized: false, error: "DEPTH_ZERO_SELF_SIGNED_CERT" }, { allowSelfSigned: false }), /not trusted/, "self-signed is refused by default");
  assert.equal(refusePeer({ authorized: false, error: "DEPTH_ZERO_SELF_SIGNED_CERT" }, { allowSelfSigned: true }), null);
  assert.match(refusePeer({ authorized: false, error: "CERT_HAS_EXPIRED" }, { allowSelfSigned: true }), /not trusted/);
  assert.equal(refusePeer({ authorized: true }, { allowSelfSigned: false }), null);
});

test("Mumble: signs in, pings, joins its channel, pairs a direct message, and answers a named channel message", async (t) => {
  const context = await fixture(t);
  const server = await mumbleServer(t);
  const channel = new MumbleChannel({ id: "mumble", open: server.open, username: "branch", password: MUMBLE_PASSWORD, channel: "Lobby", pingMs: 30, retryBaseMs: 20 });
  await context.app.channels.attach(channel, { ...policy, pairing: true });
  t.after(() => channel.stop());
  const link = await until(() => server.connections[0], "a connection");
  await until(() => channel.health().state === "connected", "synced");
  const [version, auth] = link.frames;
  assert.equal(version.type, MumbleType.Version);
  assert.equal(numberField(version.fields, 1), 0x010500);
  assert.equal(textField(auth.fields, 1), "branch");
  assert.equal(textField(auth.fields, 2), MUMBLE_PASSWORD);
  assert.equal(numberField(auth.fields, 5), 1, "opus is offered");
  await until(() => link.frames.some((f) => f.type === MumbleType.Ping), "a ping");
  const move = await until(() => link.frames.find((f) => f.type === MumbleType.UserState), "moved to the Lobby");
  assert.deepEqual([numberField(move.fields, 1), numberField(move.fields, 5)], [5, 3]);

  const said = () => textsFrom(link).map((f) => htmlToText(textField(f.fields, 5)));
  await pairingWalk(context, { label: "Mumble", sent: said,
    say: async (text) => link.send(MumbleType.TextMessage, [[1, 9], [2, 5], [5, `<p>${textToHtml(text)}</p>`]]) });
  const reply = textsFrom(link).at(-1);
  assert.deepEqual(numberList(reply.fields, 2), [9], "a direct message is answered to that person");
  assert.equal(context.app.channels.summary().approved.some((p) => p.senderId === "mumble-id:42"), true, "the registered account is who was approved");

  const asked = context.provider.requests.length;
  link.send(MumbleType.TextMessage, [[1, 5], [3, 3], [5, "branch: my own words"]]);
  link.send(MumbleType.TextMessage, [[1, 9], [3, 3], [5, "just chatting"]]);
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "own and unaddressed messages are not answered");
  link.send(MumbleType.TextMessage, [[1, 9], [3, 3], [5, "branch: <b>summarise</b> please"]]);
  await until(() => textsFrom(link).some((f) => numberList(f.fields, 3)[0] === 3 && /summarise please/.test(textField(f.fields, 5))), "answered in the channel");
  assert.equal(context.provider.requests.at(-1).messages.at(-1).content.includes("<b>"), false, "HTML is stripped on the way in");

  await channel.send("user:mumble-id:42", "<b>bold</b> & more");
  const escaped = await until(() => textsFrom(link).find((f) => /bold/.test(textField(f.fields, 5)) && numberList(f.fields, 2)[0] === 9), "sent to carol");
  assert.equal(textField(escaped.fields, 5), "&lt;b&gt;bold&lt;/b&gt; &amp; more", "HTML is escaped on the way out");
  await assert.rejects(() => channel.send("user:mumble-id:999", "hi"), /not connected/);
  await assert.rejects(() => channel.send("channel:abc", "hi"), /not a Mumble channel/);
  await assertNoSecret(context, [MUMBLE_PASSWORD]);
});

test("Mumble: a stranger is refused when pairing is off, and a refused password is said plainly", async (t) => {
  const context = await fixture(t);
  const server = await mumbleServer(t);
  const channel = new MumbleChannel({ id: "mumble", open: server.open, username: "branch", pingMs: 1000, retryBaseMs: 20 });
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  const link = await until(() => server.connections[0], "a connection");
  await until(() => channel.health().state === "connected", "synced");
  const said = () => textsFrom(link).map((f) => htmlToText(textField(f.fields, 5)));
  await refusalWalk(context, { label: "Mumble", sent: said,
    say: async (text) => link.send(MumbleType.TextMessage, [[1, 11], [2, 5], [5, text]]) });
  assert.deepEqual(numberList(textsFrom(link).at(-1).fields, 2), [11]);

  const locked = await mumbleServer(t, { reject: 4 });
  const refused = new MumbleChannel({ id: "m2", open: locked.open, username: "branch", password: MUMBLE_PASSWORD, passwordName: "MUMBLE_PASSWORD", retryBaseMs: 200 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal");
  assert.match(refused.health().reason, /refused the password.*MUMBLE_PASSWORD/);
  await assertNoSecret(context, [MUMBLE_PASSWORD]);
});

// ---------------------------------------------------------------- the connections file

test("each gateway service is built from its settings, checks the right hosts, and ships switched off", async (t) => {
  const context = await fixture(t);
  const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  const base = { activation: "mention", pairing: true, allowlist: [] };
  const configs = [
    [{ type: "vk", id: "vk", groupId: 77 }, "api.vk.com"],
    [{ type: "qq-bot", id: "qq", appId: "1024" }, "bots.qq.com"],
    [{ type: "guilded", id: "guilded" }, "www.guilded.gg"],
    [{ type: "revolt", id: "revolt" }, "api.revolt.chat"],
    [{ type: "mumble", id: "mumble", server: "voice.example.org", username: "branch" }, "voice.example.org"],
  ];
  for (const [config, host] of configs) {
    await assert.rejects(() => buildParityChannel({ ...config, ...base }, { credential: async () => "x", policy: blocked }),
      new RegExp(`Not allowed: ${host.replace(/\./g, "\\.")}`), `${config.type} checks ${host} first`);
  }
  const seen = [];
  const watching = { assertAllowed: async (url) => { seen.push(url.hostname); }, guard: (f) => f };
  const asked = [];
  const credential = async (name) => { asked.push(name); return "x"; };
  const host = { credential, policy: watching, store: context.app.store, owner: context.app.runtime.owner, connectWs: connectWebSocket };
  for (const [config] of configs) {
    const built = await buildParityChannel({ ...config, ...base }, host);
    assert.equal(built.kind, config.type);
    assert.equal(built.health().state, "needs attention", `${config.type} is off until the owner turns it on`);
  }
  assert.deepEqual(asked, ["VK_GROUP_TOKEN", "QQ_BOT_CLIENT_SECRET", "GUILDED_BOT_TOKEN", "REVOLT_BOT_TOKEN"], "each secret is read by its default name");
  assert.ok(seen.includes("api.sgroup.qq.com") && seen.includes("ws.revolt.chat") && seen.includes("www.guilded.gg"));
  await buildParityChannel({ type: "qq-bot", id: "qq2", appId: "1024", sandbox: true, ...base }, host);
  assert.ok(seen.includes("sandbox.api.sgroup.qq.com"));
  await buildParityChannel({ type: "mumble", id: "m3", server: "voice.example.org", username: "branch", passwordSecret: "MUMBLE_PASSWORD",
    certificateFingerprint: "AB:".repeat(31) + "AB", ...base }, host);
  assert.equal(asked.at(-1), "MUMBLE_PASSWORD");

  // A setting that holds a value instead of a secret's name, or an unknown setting, is refused.
  await assert.rejects(() => buildParityChannel({ type: "vk", id: "v2", groupId: 77, tokenSecret: "vk1.a.real-token-value", ...base }, host));
  await assert.rejects(() => buildParityChannel({ type: "revolt", id: "r2", token: "abc", ...base }, host), /token|Unrecognized/i);
  await assert.rejects(() => buildParityChannel({ type: "mumble", id: "m4", server: "voice.example.org", username: "branch", certificateFingerprint: "nope", ...base }, host));
  await assert.rejects(() => buildParityChannel({ type: "qq-bot", id: "q3", appId: "1024", clientSecret: "raw", ...base }, host), /clientSecret|Unrecognized/i);
  await assert.rejects(() => buildParityChannel({ type: "revolt", id: "r3", tokenSecret: "abc-real-token", ...base }, host));
  await assert.rejects(() => buildParityChannel({ type: "guilded", id: "g3", tokenSecret: "gapi_real-token", ...base }, host));
  await assert.rejects(() => buildParityChannel({ type: "qq-bot", id: "q4", appId: "1024", clientSecretSecret: "raw-secret-value", ...base }, host));
  await assert.rejects(() => buildParityChannel({ type: "mumble", id: "m5", server: "voice.example.org", username: "branch", passwordSecret: "hunter2", ...base }, host));
});
