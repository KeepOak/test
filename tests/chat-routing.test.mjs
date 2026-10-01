import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on, setupTrunk } from "./trunks-helpers.mjs";
import { parentScope, bindingFor, channelRoutes, ChannelRouteSchema } from "../dist/channels/routes.js";
import { chatThread } from "../dist/channels/threads.js";
import { startServer } from "../dist/server.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { MatrixAdapter } from "../dist/channels/matrix.js";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
let serial = 0;
const message = (text, extra = {}) => ({ channel: "chat", chatId: "dm", chatKind: "direct", senderId: "owner",
  senderName: "Owner", addressed: true, messageId: `m${++serial}`, text, ...extra });
async function setup(t, options = {}) {
  const f = await fixture(t); const { app } = f; on(app);
  // Ada is made in setup's own request, so she is the default Trunk (#625); a Trunk made later never is by age alone.
  const ada = setupTrunk(app, { name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  // #594: a Trunk answers in a chat app only where its reach allows it, the default Trunk included.
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { reach: { channels: ["chat", "slack", "matrix"], commands: false } });
  await app.trunks.introduced();
  app.channels.mergeWindowMs = 0;
  const sent = [];
  for (const [id, kind] of [["chat", options.kind ?? "telegram"], ["slack", "slack"], ["matrix", "matrix"]]) {
    await app.channels.attach({ id, kind, botName: () => "Branch", async start() {}, async stop() {},
      async send(chatId, text) { sent.push({ channel: id, chatId, text }); return String(sent.length); } },
    { activation: "always", pairing: true, allowlist: ["owner", "other"] });
  }
  if (options.paired !== false) app.store.save("settings", app.runtime.owner, "channel-pair:chat:owner",
    { status: "approved", code: "123456", name: "Owner", requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  app.channels.setOwnerCommandSettings({ on: false, accounts: [{ channel: "chat", sender: "owner" }] });
  const route = (scope, trunkId, channel = "chat") => app.channels.routeSettings({ channel, scope, trunkId });
  const say = async (text = "hello", extra = {}) => {
    await app.channels.handle(message(text, extra));
    return chatThread(app.store, app.runtime.owner, extra.channel ?? "chat", extra.chatId ?? "dm");
  };
  return { ...f, ada, bo, sent, route, say };
}
test("routing prefers exact chat, supported parent, whole app and then default", async t => {
  const { app, ada, bo, route } = await setup(t);
  route("*", bo.id); route("-10", ada.id); route("-10:7", bo.id);
  assert.equal(app.channels.chatTrunk("chat", "-10:7"), bo.id);
  assert.equal(app.channels.chatTrunk("chat", "-10:8"), ada.id);
  assert.equal(app.channels.chatTrunk("chat", "dm"), bo.id);
  route("-10:7", "default"); assert.equal(app.channels.chatTrunk("chat", "-10:7"), ada.id);
  route("-10:7", null); assert.equal(app.channels.chatTrunk("chat", "-10:7"), ada.id);
  route("*", null); assert.equal(app.channels.chatTrunk("chat", "dm"), ada.id);
  assert.equal(app.channels.chatTrunk("matrix", "!room:server.example"), ada.id);
});
test("only adapter-defined thread addresses have parents; another app stays separate", async t => {
  const { app, ada, bo, route } = await setup(t);
  assert.equal(parentScope("telegram", "-10:7"), "-10");
  assert.equal(parentScope("slack", "C1:123.456"), null);
  assert.equal(parentScope("matrix", "!room:server.example"), null);
  assert.equal(parentScope("discord", "123:456"), null);
  route("C1", bo.id, "slack");
  assert.equal(app.channels.chatTrunk("slack", "C1"), bo.id);
  assert.equal(app.channels.chatTrunk("matrix", "C1:123.456"), ada.id);
  route("!room", bo.id, "matrix");
  assert.equal(app.channels.chatTrunk("matrix", "!room:server.example"), ada.id);
});
// Review r4125983486: a Slack chat is its channel (or DM); a thread in it is the same chat, so a route names the channel.
test("Slack routes name the channel or DM: a thread reply is the same chat and a thread-shaped route is refused", async t => {
  const { app, bo, route } = await setup(t);
  const slack = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1" });
  const top = slack.inbound({ type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hi", ts: "1.1" });
  const reply = slack.inbound({ type: "message", channel: "D1", channel_type: "im", user: "U1", text: "more", ts: "1.2", thread_ts: "1.1" });
  assert.deepEqual([top.chatId, reply.chatId], ["D1", "D1"]);
  assert.throws(() => route("D1:1.1", bo.id, "slack"), /whole Slack channel/);
  assert.deepEqual(channelRoutes(app.store, app.runtime.owner), []);
  route("D1", bo.id, "slack"); assert.equal(app.channels.chatTrunk("slack", reply.chatId), bo.id);
});
// Review r4125983476: with Trunks off, a saved route starts nothing new as that Trunk and no Trunk can be chosen.
test("with Trunks switched off, saved routes start no Trunk and routing offers none", async t => {
  const { app, bo, route, say, sent } = await setup(t);
  route("*", bo.id);
  app.trunks.setMode("trunks", { mode: "off" });
  assert.equal(app.channels.chatTrunk("chat", "fresh"), null);
  assert.deepEqual(app.channels.routing().trunks, []);
  assert.throws(() => route("dm", bo.id), /existing Trunk/);
  await say("/trunk Bo"); assert.doesNotMatch(sent.at(-1).text, /Saved who answers/);
  await say("/trunk"); assert.doesNotMatch(sent.at(-1).text, /Bo \(@/);
  assert.notEqual((await say("hello", { chatId: "fresh" })).trunkId, bo.id);
});
// A chat app whose threads have chat ids of their own (base's Matrix threads) names each thread's room: a route on the room
// covers its threads, a thread's own route wins, and changing the room's route starts its threads afresh.
test("a route on a room reaches the threads the chat app says belong to it", async t => {
  const { app, ada, bo, route, say } = await setup(t);
  await app.channels.attach({ id: "rooms", kind: "matrix", botName: () => "Branch", async start() {}, async stop() {},
    routeParent: chatId => chatId.startsWith("thread:") ? "room-1" : null, async send() { return "1"; } },
  { activation: "always", pairing: false, allowlist: ["owner"] });
  app.trunks.edit(bo.id, { reach: { channels: ["chat", "slack", "matrix", "rooms"], commands: false } });
  app.trunks.edit(ada.id, { reach: { channels: ["chat", "slack", "matrix", "rooms"], commands: false } });
  const before = await say("hello", { channel: "rooms", chatId: "thread:a" });
  route("room-1", bo.id, "rooms");
  assert.equal(app.channels.chatTrunk("rooms", "thread:a"), bo.id);
  assert.equal(chatThread(app.store, app.runtime.owner, "rooms", "thread:a").sessionId, undefined, "the thread starts afresh with the room's Trunk");
  assert.notEqual(before.sessionId, undefined);
  route("thread:a", "default", "rooms");
  assert.equal(app.channels.chatTrunk("rooms", "thread:a"), ada.id);
  assert.equal(app.channels.chatTrunk("rooms", "thread:b"), bo.id);
  assert.equal(app.channels.chatTrunk("rooms", "other-room"), ada.id);
});
// Base gives each Matrix thread a chat id of its own; the adapter names the thread's room, so a room route covers it.
test("a Matrix thread falls back to its room's route", async t => {
  const { app, ada, bo, route } = await setup(t);
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "x" });
  const read = (content) => matrix.inbound("!room:m", { type: "m.room.message", event_id: `$${Math.random()}`, sender: "@alice:m", content: { msgtype: "m.text", ...content } });
  const room = read({ body: "hello" }).chatId;
  const thread = read({ body: "in a thread", "m.relates_to": { rel_type: "m.thread", event_id: "$root" } }).chatId;
  assert.match(thread, /^thread:/);
  assert.equal(matrix.routeParent(thread), room);
  assert.equal(matrix.routeParent(room), null);
  assert.equal(matrix.routeParent("thread:never-read"), null);
  const parent = matrix.routeParent(thread);
  route(room, bo.id, "matrix");
  assert.equal(bindingFor(app.store, app.runtime.owner, "matrix", thread, "matrix", parent), bo.id);
  assert.equal(bindingFor(app.store, app.runtime.owner, "matrix", thread, "matrix"), null, "without the room named, only the thread's own route counts");
  route(thread, "default", "matrix");
  assert.equal(bindingFor(app.store, app.runtime.owner, "matrix", thread, "matrix", parent), null, "a thread's own default wins");
  assert.ok(ada);
});
test("changing a route starts a fresh thread and retains its earlier conversation", async t => {
  const { app, bo, route, say } = await setup(t);
  const before = await say(); route("dm", bo.id);
  assert.equal(chatThread(app.store, app.runtime.owner, "chat", "dm").sessionId, undefined);
  const after = await say(); assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(after.trunkId, bo.id); assert.ok(after.earlier.includes(before.sessionId));
  assert.equal(app.trunks.trunkForConversation(after.sessionId).trunkId, bo.id);
  route("dm", bo.id); assert.equal(chatThread(app.store, app.runtime.owner, "chat", "dm").sessionId, after.sessionId);
});
test("whole-app route changes refresh inherited chats and preserve exact overrides", async t => {
  const { app, ada, bo, route, say } = await setup(t);
  const first = await say("one", { chatId: "one" });
  const fixed = await say("two", { chatId: "two" }); route("two", "default");
  route("*", bo.id);
  assert.equal(chatThread(app.store, app.runtime.owner, "chat", "one").sessionId, undefined);
  assert.equal(chatThread(app.store, app.runtime.owner, "chat", "two").sessionId, fixed.sessionId);
  assert.equal((await say("one", { chatId: "one" })).trunkId, bo.id);
  assert.equal((await say("two", { chatId: "two" })).trunkId, ada.id);
  assert.ok(app.store.ownsSession(app.runtime.owner, first.sessionId));
});
test("removed Trunk routes disappear and the next message starts with the fallback", async t => {
  const { app, ada, bo, route, say } = await setup(t);
  route("dm", bo.id); const old = await say(); app.trunks.remove(bo.id);
  assert.deepEqual(channelRoutes(app.store, app.runtime.owner), []);
  const next = await say(); assert.equal(next.trunkId, ada.id);
  assert.notEqual(next.sessionId, old.sessionId); assert.ok(next.earlier.includes(old.sessionId));
});
test("unknown, paused and unreachable Trunks cannot become a route", async t => {
  const { app, bo, route } = await setup(t);
  assert.throws(() => route("dm", "00000000-0000-4000-a000-000000000000"), /existing Trunk/);
  app.trunks.edit(bo.id, { reach: { channels: [], commands: false } });
  assert.throws(() => route("dm", bo.id), /does not answer/);
  app.trunks.edit(bo.id, { reach: { channels: ["chat"], commands: false } });
  app.trunks.pause.pause(bo.id, { now: false });
  assert.throws(() => route("dm", bo.id), /paused/i);
  assert.deepEqual(channelRoutes(app.store, app.runtime.owner), []);
});
test("changing a route during an active first turn rolls back without losing the task", async t => {
  const { app, provider, bo, route, say } = await setup(t);
  const original = provider.complete.bind(provider); let release, entered = false;
  provider.complete = async request => { entered = true; await new Promise(resolve => { release = resolve; }); return original(request); };
  const running = say("waiting");
  for (let i = 0; !entered && i < 300; i++) await delay(10);
  assert.ok(entered);
  try { assert.throws(() => route("*", bo.id), /Wait for that chat/); assert.deepEqual(channelRoutes(app.store, app.runtime.owner), []); }
  finally { release(); }
  const old = await running; provider.complete = original; route("*", bo.id);
  const next = await say(); assert.notEqual(next.sessionId, old.sessionId);
});
test("a Trunk removed during a turn cannot restore the old thread when that task finishes", async t => {
  const { app, provider, ada, bo, route, say } = await setup(t); route("dm", bo.id);
  const original = provider.complete.bind(provider); let release, entered = false;
  provider.complete = async request => { entered = true; await new Promise(resolve => { release = resolve; }); return original(request); };
  const running = say("waiting"); for (let i = 0; !entered && i < 300; i++) await delay(10);
  assert.ok(entered); app.trunks.remove(bo.id); release();
  const ended = await running; assert.equal(ended.sessionId, undefined);
  provider.complete = original;
  const next = await say(); assert.equal(next.trunkId, ada.id); assert.ok(next.earlier.length > 0);
});
test("the paired owner's /trunk works while command execution and command menus are off", async t => {
  const { app, ada, bo, say, sent } = await setup(t);
  app.channels.setSwitches({ commands: "off" }); const old = await say();
  await say("/trunk Bo"); assert.match(sent.at(-1).text, /Saved who answers/);
  assert.equal(app.channels.chatTrunk("chat", "dm"), bo.id);
  const next = await say(); assert.notEqual(next.sessionId, old.sessionId); assert.equal(next.trunkId, bo.id);
  await say("/trunk default"); assert.equal(app.channels.chatTrunk("chat", "dm"), ada.id);
  await say("/trunk inherit"); assert.deepEqual(channelRoutes(app.store, app.runtime.owner), []);
});
for (const [label, options, extra, change] of [
  ["unpaired", { paired: false }, {}], ["unvouched", { kind: "email" }, {}],
  ["group", {}, { chatKind: "group" }], ["other sender", {}, { senderId: "other" }],
  ["catch-up", {}, { caughtUp: true }], ["App lock", {}, {}, app => app.sessionLock.lock()],
  ["Lockdown", {}, {}, app => app.store.save("settings", app.runtime.owner, "lockdown", { on: true })],
]) test(`/trunk refuses route changes from ${label}`, async t => {
  const { app, say, sent } = await setup(t, options); change?.(app);
  await say("/trunk Bo", extra);
  assert.deepEqual(channelRoutes(app.store, app.runtime.owner), []);
  if (label === "Lockdown") { assert.deepEqual(sent, []); return; }
  assert.match(sent.at(-1).text, /paired direct chat/);
  await say("/trunk", extra); assert.doesNotMatch(sent.at(-1).text, /Bo \(@/);
});
// #1054's group floor comes first: /trunk is not on it, so someone else in a group is refused before /trunk can say which Trunk answers there.
test("a bare /trunk from someone else in a group is refused by the group floor and names no Trunk", async t => {
  const { sent, say } = await setup(t);
  await say("/trunk", { chatKind: "group", chatId: "-10", senderId: "other" });
  assert.match(sent.at(-1).text, /only the owner or someone they choose can use \/trunk/);
  assert.doesNotMatch(sent.at(-1).text, /answers here/);
});
test("route schema rejects channel key collisions and unreadable scopes", () => {
  assert.throws(() => ChannelRouteSchema.parse({ channel: "chat:other", scope: "*", trunkId: "default" }));
  assert.throws(() => ChannelRouteSchema.parse({ channel: "chat", scope: "a\u0000b", trunkId: "default" }));
});
test("owner window API saves routes and refuses invalid ids and locked changes", async t => {
  const { app, root, bo } = await setup(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 }); t.after(() => server.close());
  const post = body => fetch(server.url + "/api/channels/routes", { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ channel: "chat", scope: "*", trunkId: bo.id })).status, 200);
  const current = await (await fetch(server.url + "/api/channels/routes", { headers: { authorization: `Bearer ${server.token}` } })).json();
  assert.equal(current.routes[0].trunkId, bo.id);
  assert.equal((await post({ channel: "chat", scope: "*", trunkId: "00000000-0000-4000-a000-000000000000" })).status, 400);
  app.sessionLock.lock(); assert.equal((await post({ channel: "chat", scope: "*", trunkId: "default" })).status, 423);
});
