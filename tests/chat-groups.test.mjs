/**
 * Group chats on every app (a GrokBot user added their bot to a group and it never answered): the assistant answers when
 * it is @mentioned, replied to or called by name; each group can be set to answer every message, from Settings or with
 * /activation from the owner's own account; and the app's own limits (Telegram's privacy mode) are asked and said.
 * Every chat service here is a stand-in on this computer or a fake; no real account is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, TelegramAdapter, SignalAdapter } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { calledByName } from "../dist/channels/addressing.js";
import { groupActivation } from "../dist/channels/group-activation.js";
import { saveOwnerAccounts } from "../dist/reach/platform.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { MatrixAdapter } from "../dist/channels/matrix.js";
import { DiscordAdapter } from "../dist/channels/discord.js";
import { recipeFor } from "../dist/channel-setup/recipes.js";

async function until(check, label) {
  for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-groups-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return { content: `Echo: ${request.messages.at(-1).content}`, toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, provider, root };
}

test("called by name: whole words in any case, never part of a word, and never a generic word", () => {
  assert.equal(calledByName("Juniper, what's the time?", ["juniper_bot", "Juniper"]), true);
  assert.equal(calledByName("thanks JUNIPER!", ["Juniper"]), true);
  assert.equal(calledByName("ask @juniper_bot", ["@juniper_bot"]), true);
  assert.equal(calledByName("junipers grow here", ["Juniper"]), false, "part of a word is not a name");
  assert.equal(calledByName("the bot is broken", ["Bot"]), false, "a generic word never counts");
  assert.equal(calledByName("ask the assistant", ["Assistant"]), false);
  assert.equal(calledByName("al is here", ["Al"]), false, "names under three letters are left out");
  assert.equal(calledByName("Émile, bonjour", ["Émile"]), true, "letters beyond English count as a word");
  assert.equal(calledByName("anything", [null, undefined, ""]), false);
});

/** A stand-in for api.telegram.org, with the bot's privacy mode and admin status as a test sets them. */
async function fakeTelegram(t, { readsAll = false, admin = false } = {}) {
  const state = { queue: [], sent: [], calls: [] };
  let next = 1;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const method = req.url.split("/").pop();
    state.calls.push({ method, body });
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "Juniper", username: "juniper_test_bot", can_read_all_group_messages: readsAll });
    if (method === "getChatMember") return reply({ status: admin ? "administrator" : "member", user: { id: 999 } });
    if (method === "getUpdates") {
      const pending = state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!pending.length) await delay(40);
      return reply(pending);
    }
    if (method === "sendMessage") { state.sent.push(body); return reply({ message_id: 1000 + state.sent.length }); }
    return reply(true);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const say = (from, text, chat = { id: -700, type: "supergroup", title: "Family" }, extra = {}) => state.queue.push({ update_id: next++,
    message: { message_id: next * 10, text, from: { id: from, first_name: `person ${from}` }, chat, ...extra } });
  return { state, say, apiBase: `http://127.0.0.1:${server.address().port}` };
}

test("Telegram groups: called by name is answered, Every message answers the rest, and a stranger is let in quietly from Settings", async (t) => {
  const { app, provider } = await fixture(t);
  const telegram = await fakeTelegram(t, { readsAll: true });
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase: telegram.apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: ["42"] });
  telegram.say(42, "juniper what is two plus two");
  await until(() => telegram.state.sent.length === 1, "called by name");
  assert.match(telegram.state.sent[0].text, /two plus two/);
  telegram.say(42, "just chatting among ourselves");
  await delay(300);
  assert.equal(telegram.state.sent.length, 1, "unaddressed, and the group has no choice of its own");

  // The owner chooses Every message for this group in Settings (POST /api/channels/groups).
  const answer = await app.channels.setGroup({ channel: "telegram", chatId: "-700", activation: "always", title: "Family" });
  assert.deepEqual(answer, { activation: "always", reading: { everyMessage: true } });
  telegram.say(42, "what should we cook tonight");
  await until(() => telegram.state.sent.length === 2, "answered without a mention");
  telegram.say(77, "and who are you?");
  await delay(300);
  assert.equal(telegram.state.sent.length, 2, "a stranger who did not speak to it gets no pairing code in a busy group");
  assert.equal(app.channels.summary().pending.length, 0, "and talk among others there asks for nothing");
  // #1054: a code is never sent where a group can read it; a stranger who mentions the bot is written down for the owner.
  telegram.say(77, "@juniper_test_bot hello", undefined, { entities: [{ type: "mention", offset: 0, length: 17 }] });
  await until(() => app.channels.summary().pending.some((p) => p.senderId === "77"), "a stranger who mentions it waits in Settings");
  await delay(300);
  assert.equal(telegram.state.sent.length, 2, "and gets no code in the group");
  const listed = app.channels.summary().groups.find((g) => g.chatId === "-700");
  assert.deepEqual({ ...listed }, { channel: "telegram", chatId: "-700", title: "Family", activation: "always", own: true });
  assert.ok(provider.requests.length >= 2);
  await adapter.stop();
});

test("Telegram privacy mode: Every message says what to change, unless the bot is an admin of that group", async (t) => {
  const { app } = await fixture(t);
  const telegram = await fakeTelegram(t, { readsAll: false });
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase: telegram.apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, {});
  const { reading } = await app.channels.setGroup({ channel: "telegram", chatId: "-700", activation: "always" });
  assert.equal(reading.everyMessage, false);
  assert.match(reading.fix, /privacy mode is on for @juniper_test_bot/);
  assert.match(reading.fix, /\/setprivacy to @BotFather/);
  assert.ok(telegram.state.calls.some((call) => call.method === "getChatMember" && call.body.chat_id === -700 && call.body.user_id === 999));
  await adapter.stop();

  const adminBot = await fakeTelegram(t, { readsAll: false, admin: true });
  const asAdmin = new TelegramAdapter({ id: "telegram2", token: "123:abc", apiBase: adminBot.apiBase, pollTimeoutSeconds: 1 });
  assert.deepEqual(await asAdmin.groupReading("-700"), { everyMessage: true }, "an admin bot reads every message");
});

test("/activation in a group from the owner's own account sets it; from anybody else it is an ordinary message", async (t) => {
  const { app } = await fixture(t);
  const telegram = await fakeTelegram(t, { readsAll: false });
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase: telegram.apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { pairing: true, allowlist: ["42", "5"] });
  telegram.say(42, "/activation always");
  await delay(300);
  assert.equal(groupActivation(app.store, app.runtime.owner, "telegram", "-700"), null, "a paired friend cannot change it");
  assert.equal(telegram.state.sent.length, 0, "and the line is an unaddressed group message");

  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "telegram", sender: "5" }]);
  telegram.say(5, "/activation always");
  await until(() => telegram.state.sent.length === 1, "the owner's command is answered");
  assert.match(telegram.state.sent[0].text, /answer every message here\. Telegram's privacy mode is on/);
  assert.equal(groupActivation(app.store, app.runtime.owner, "telegram", "-700"), "always");
  telegram.say(5, "/activation mention");
  await until(() => telegram.state.sent.length === 2, "back to mentions");
  assert.equal(groupActivation(app.store, app.runtime.owner, "telegram", "-700"), "mention");
  telegram.say(5, "/activation always", { id: 5, type: "private" });
  await until(() => telegram.state.sent.length === 3, "a direct chat is answered as a message");
  assert.equal(groupActivation(app.store, app.runtime.owner, "telegram", "5"), null, "only in a group");
  await adapter.stop();
});

test("Slack: a reply in a thread it started, a name, and group messages (mpim) count as speaking to it", async () => {
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1" });
  adapter.user = { id: "UBOT", name: "juniper" };
  const read = (event) => adapter.inbound({ type: "message", channel: "C1", user: "U1", ts: "2.0", channel_type: "channel", ...event });
  assert.equal(read({ text: "just talking" }).addressed, false);
  assert.equal(read({ text: "follow-up", thread_ts: "1.0", parent_user_id: "UBOT" }).addressed, true, "its own thread");
  assert.equal(read({ text: "follow-up", thread_ts: "1.0", parent_user_id: "U9" }).addressed, false, "someone else's thread");
  assert.equal(read({ text: "Juniper, summarise this" }).addressed, true);
  const mpim = read({ text: "hi all", channel: "G1", channel_type: "mpim" });
  assert.equal(mpim.chatKind, "group");
  assert.match(mpim.chatTitle, /group message/);
  assert.ok(recipeFor("slack").manifest.settings.event_subscriptions.bot_events.includes("message.mpim"), "the wizard's app hears group messages");
  assert.ok(recipeFor("slack").manifest.oauth_config.scopes.bot.includes("mpim:history"));
});

test("Matrix: a room of two is direct, and a mention, an intentional mention or a reply to it is addressed", async () => {
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "x" });
  adapter.members.set("!dm:m", 2);
  adapter.members.set("!room:m", 5);
  adapter.sent.set("h1", "$mine");
  const read = (room, content) => adapter.inbound(room, { type: "m.room.message", event_id: `$${Math.random()}`, sender: "@alice:m", content: { msgtype: "m.text", ...content } });
  const dm = read("!dm:m", { body: "hello" });
  assert.deepEqual([dm.chatKind, dm.addressed], ["direct", true]);
  assert.equal(read("!room:m", { body: "chatting" }).addressed, false);
  assert.equal(read("!room:m", { body: "Juniper: ping", formatted_body: '<a href="https://matrix.to/#/@juniper:m.example.org">Juniper</a>: ping' }).addressed, true);
  assert.equal(read("!room:m", { body: "ping", "m.mentions": { user_ids: ["@juniper:m.example.org"] } }).addressed, true);
  assert.equal(read("!room:m", { body: "yes", "m.relates_to": { "m.in_reply_to": { event_id: "$mine" } } }).addressed, true);
  assert.equal(read("!room:m", { body: "yes", "m.relates_to": { "m.in_reply_to": { event_id: "$theirs" } } }).addressed, false);
});

// Review r4117782280: a reply to one of its own messages counts after a restart or once the message left the recent list.
test("Matrix: a reply to its own older message is addressed by asking the server who sent it", async () => {
  const asked = [];
  const fetch = async (url, init) => {
    const address = String(url);
    if (address.includes("/sync")) return Response.json({ next_batch: "s2", rooms: { join: { "!room:m": { summary: { "m.joined_member_count": 5 }, timeline: { events: [
      { type: "m.room.message", event_id: "$a", sender: "@alice:m", content: { msgtype: "m.text", body: "yes", "m.relates_to": { "m.in_reply_to": { event_id: "$old" } } } },
      { type: "m.room.message", event_id: "$b", sender: "@alice:m", content: { msgtype: "m.text", body: "agreed", "m.relates_to": { "m.in_reply_to": { event_id: "$bobs" } } } },
      { type: "m.room.message", event_id: "$c", sender: "@alice:m", content: { msgtype: "m.text", body: "hm", "m.relates_to": { "m.in_reply_to": { event_id: "$gone" } } } },
      { type: "m.room.message", event_id: "$d", sender: "@alice:m", content: { msgtype: "m.text", body: "chatting" } },
      { type: "m.room.message", event_id: "$e", sender: "@alice:m", content: { msgtype: "m.text", body: "offline?", "m.relates_to": { "m.in_reply_to": { event_id: "$boom" } } } },
    ] } } } } });
    asked.push({ address, redirect: init?.redirect, auth: init?.headers?.authorization });
    if (address.endsWith(`/rooms/${encodeURIComponent("!room:m")}/event/${encodeURIComponent("$old")}`)) return Response.json({ event_id: "$old", sender: "@juniper:m.example.org" });
    if (address.includes(encodeURIComponent("$bobs"))) return Response.json({ event_id: "$bobs", sender: "@bob:m" });
    if (address.includes(encodeURIComponent("$boom"))) throw new Error("the server went away");
    return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
  };
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "x", fetch });
  adapter.since = "s1";
  const got = await adapter.sync();
  assert.deepEqual(got.map((message) => [message.text, message.addressed]), [["yes", true], ["agreed", false], ["hm", false], ["chatting", false], ["offline?", false]]);
  assert.equal(asked.length, 4, "only unaddressed replies to unknown events are looked up");
  assert.ok(asked.every((call) => call.redirect === "error" && call.auth === "Bearer x"));
});

test("Discord: its name in a server channel is addressed", () => {
  const adapter = new DiscordAdapter({ id: "discord", token: "t" });
  adapter.user = { id: "B1", name: "juniper_bot", shown: "Juniper" };
  const read = (content) => adapter.inbound({ id: "m1", channel_id: "C1", guild_id: "G1", content, author: { id: "U1", username: "alice" }, mentions: [], attachments: [] });
  assert.equal(read("juniper can you help").addressed, true);
  assert.equal(read("junipers everywhere").addressed, false);
});

test("Signal: an @mention of its number or a reply to it is addressed in a group (groups were never answered)", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), kill() {} });
  const got = [];
  const adapter = new SignalAdapter({ id: "signal", path: "/x/signal-cli", account: "+15550001111", exists: async () => true, spawnProcess: () => child });
  await adapter.start(async (message) => { got.push(message); });
  const line = (dataMessage) => child.stdout.write(JSON.stringify({ method: "receive", params: { envelope: { source: "+15552223333", timestamp: Date.now(), dataMessage } } }) + "\n");
  const group = { groupInfo: { groupId: "grp-1" } };
  line({ message: "chatting", ...group });
  line({ message: "￼ can you help", mentions: [{ number: "+15550001111", start: 0, length: 1 }], ...group });
  line({ message: "yes please", quote: { authorNumber: "+15550001111" }, ...group });
  await until(() => got.length === 3, "three messages");
  assert.deepEqual(got.map((message) => message.addressed), [false, true, true]);
  await adapter.stop();
});

test("the setup wizard says what each app does in groups, and the owner's group choice is saved through the route", async (t) => {
  for (const id of ["telegram", "discord", "slack", "matrix", "signal", "whatsapp", "imessage"]) assert.ok(recipeFor(id).groups?.length > 40, id);
  assert.match(recipeFor("telegram").groups, /\/setprivacy/);
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = (path, body) => fetch(server.url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const saved = await call("/api/channels/groups", { channel: "discord", chatId: "C1", activation: "always", title: "general" });
  assert.deepEqual(saved, { status: 200, body: { activation: "always", reading: null } });
  assert.deepEqual((await call("/api/channels")).body.groups, [{ channel: "discord", chatId: "C1", title: "general", activation: "always", own: true }]);
  assert.equal((await call("/api/channels/groups", { channel: "discord", chatId: "C1", activation: "loud" })).status, 400);
  await call("/api/channels/groups", { channel: "discord", chatId: "C1", activation: null });
  assert.deepEqual((await call("/api/channels")).body.groups, []);
});

/* #658's reaction approvals follow the same room rule: a tap in a room of two is a direct answer (so the owner's
   per-person yes applies), a tap in a bigger room is a group one. */
test("Matrix: a reaction answer in a room of two is direct, in a bigger room it is a group one", async () => {
  const puts = [];
  const fetch = async (url, init) => { puts.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ event_id: `$q${puts.length}` }); };
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "x", fetch });
  adapter.members.set("!dm:m", 2);
  adapter.members.set("!room:m", 5);
  for (const room of ["!dm:m", "!room:m"]) await adapter.sendButtons(room, "May I?", [{ label: "Yes", value: "y:abc" }, { label: "No", value: "n:abc" }]);
  const question = (room) => puts.find((put) => put.url.includes(encodeURIComponent(room)) && put.url.includes("/m.room.message/")).url && puts.filter((put) => put.url.includes(encodeURIComponent(room)) && put.body["m.relates_to"])[0].body["m.relates_to"].event_id;
  const react = (room) => adapter.inbound(room, { type: "m.reaction", event_id: "$r1", sender: "@alice:m", content: { "m.relates_to": { rel_type: "m.annotation", event_id: question(room), key: "👍" } } });
  assert.deepEqual([react("!dm:m").chatKind, react("!dm:m").text], ["direct", "y:abc"]);
  assert.equal(react("!room:m").chatKind, "group");
});

/* #664's files follow the same room rule: a picture or voice note sent in a room of two is for the assistant (direct and
   addressed); in a bigger room it waits to be asked about, like any other message there. */
test("Matrix: a file in a room of two is direct and addressed, in a bigger room it is a group one", () => {
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "x" });
  adapter.members.set("!dm:m", 2);
  adapter.members.set("!room:m", 5);
  const read = (room, msgtype) => adapter.inbound(room, { type: "m.room.message", event_id: "$f1", sender: "@alice:m",
    content: { msgtype, body: "cat.jpg", url: "mxc://m.example.org/abc", info: { mimetype: msgtype === "m.audio" ? "audio/ogg" : "image/jpeg" } } });
  const dm = read("!dm:m", "m.image");
  assert.deepEqual([dm.chatKind, dm.addressed, dm.chatTitle], ["direct", true, undefined]);
  assert.deepEqual([read("!dm:m", "m.audio").chatKind, read("!dm:m", "m.audio").addressed], ["direct", true]);
  const room = read("!room:m", "m.image");
  assert.deepEqual([room.chatKind, room.addressed, room.chatTitle], ["group", false, "!room:m"]);
});
