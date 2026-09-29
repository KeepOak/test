import test from "node:test";
import assert from "node:assert/strict";
import { saveReplyStyle } from "../dist/channels/reply-style.js";
import {
  fixture, until, delay, setSwitch, assertNoSecret, httpService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { parityServices } from "../dist/channels/parity-services.js";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { NextcloudTalkChannel } from "../dist/channels/nextcloud-talk.js";
import { TwilioSmsChannel } from "../dist/channels/twilio-sms.js";
import { NtfyChannel, NtfyListeningChannel, ntfyOwnTag } from "../dist/channels/ntfy.js";
import { PushoverChannel } from "../dist/channels/pushover.js";
import { ThreemaChannel, cutBytes, threemaRecipient } from "../dist/channels/threema.js";
import { HomeAssistantChannel } from "../dist/channels/homeassistant.js";

/**
 * Nextcloud Talk, text messages (Twilio), ntfy, Pushover, Threema Gateway and Home Assistant,
 * each against a stand-in server that answers the way the service's documentation says.
 * No real service is contacted.
 */
const NEXTCLOUD_PASSWORD = "SECRET-NEXTCLOUD-APP-PW-11";
const TWILIO_TOKEN = "SECRET-TWILIO-AUTH-TOKEN-12";
const NTFY_TOKEN = "tk_SECRETNTFYACCESSTOKEN13";
const PUSHOVER_TOKEN = "SECRET-PUSHOVER-APP-TOKEN-14";
const PUSHOVER_USER = "SECRET-PUSHOVER-USER-KEY-15";
const THREEMA_SECRET = "SECRET-THREEMA-GATEWAY-16";
const HASS_TOKEN = "SECRET-HOMEASSISTANT-TOKEN-17";
const ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;
const OUR_NUMBER = "+15557654321";
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const policy = { assertAllowed: async () => undefined, guard: (f) => f };

// ---------------------------------------------------------------- Nextcloud Talk

/**
 * A Talk server holding conversations: `lookIntoFuture=0` hands back the newest message, `=1` what
 * came after `lastKnownMessageId` (or 304), and a post is stored as the assistant's own message.
 */
async function talkServer(t, rooms, { refuse = () => false } = {}) {
  let next = 100;
  const add = (room, fields) => { const message = { id: next++, actorType: "users", actorDisplayName: "", message: "",
    systemMessage: "", messageType: "comment", messageParameters: [], timestamp: 0, ...fields }; rooms[room].messages.push(message); return message; };
  const service = await httpService(t, (call) => {
    if (refuse()) return { status: 401, body: { ocs: { meta: { status: "failure" }, data: [] } } };
    const room = /\/api\/v[14]\/(?:chat|room)\/([a-z0-9]+)$/i.exec(call.path)?.[1];
    if (!room || !rooms[room]) return { status: 404, body: {} };
    if (call.path.includes("/api/v4/room/")) return { body: { ocs: { data: { token: room, type: rooms[room].type, displayName: rooms[room].title ?? "" } } } };
    if (call.method === "POST") return { status: 201, body: { ocs: { data: add(room, { actorId: "branch", message: call.json.message }) } } };
    const all = rooms[room].messages;
    if (call.query.lookIntoFuture === "0") return { body: { ocs: { data: all.slice(-1) } } };
    const after = all.filter((m) => m.id > Number(call.query.lastKnownMessageId));
    return after.length ? { body: { ocs: { data: after } } } : { status: 304, body: "" };
  });
  return { ...service, add, posts: () => service.calls.filter((c) => c.method === "POST") };
}

function talkChannel(server, rooms, extra = {}) {
  return new NextcloudTalkChannel({ id: "talk", server: `${server.base}/`, username: "branch", password: NEXTCLOUD_PASSWORD,
    passwordSecret: "NEXTCLOUD_TALK_APP_PASSWORD", rooms, pollMs: 20, waitSeconds: 0, ...extra });
}

test("Nextcloud Talk: history is left alone, a stranger pairs, and the answer goes back to the conversation", async (t) => {
  const context = await fixture(t);
  const rooms = { abcd1234: { type: 1, messages: [] } };
  const server = await talkServer(t, rooms);
  server.add("abcd1234", { actorId: "carol", message: "an old message from before Branch started" });
  const channel = talkChannel(server, ["abcd1234"]);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  saveReplyStyle(context.app.store, context.app.runtime.owner, { channel: "nextcloud-talk", quote: "first" }, ["nextcloud-talk"]); // A one-to-one answer quotes only when needed (reply-style.ts); "first" checks this app's quote on the wire.
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "took stock");
  await until(() => server.calls.some((c) => c.query.lookIntoFuture === "1"), "asked for new messages");
  await delay(80);
  assert.equal(server.posts().length, 0, "the old message is not answered");
  assert.equal(context.provider.requests.length, 0);
  const first = server.calls[0];
  assert.equal(first.headers.authorization, basic("branch", NEXTCLOUD_PASSWORD));
  assert.equal(first.headers["ocs-apirequest"], "true");
  const future = server.calls.find((c) => c.query.lookIntoFuture === "1");
  assert.equal(future.query.setReadMarker, "0");
  assert.equal(future.query.lastKnownMessageId, String(rooms.abcd1234.messages[0].id));

  const said = () => server.posts().map((c) => c.json.message);
  await pairingWalk(context, { label: "Nextcloud Talk", say: async (text) => server.add("abcd1234", { actorId: "carol", actorDisplayName: "Carol", message: text }), sent: said });
  const reply = server.posts().at(-1);
  assert.equal(reply.path, "/ocs/v2.php/apps/spreed/api/v1/chat/abcd1234", "answered in the same conversation");
  const asked = rooms.abcd1234.messages.find((m) => m.message === "what is the time");
  assert.equal(reply.json.replyTo, asked.id, "as a reply to the question");
  assert.ok(context.app.channels.summary().approved.some((p) => p.senderId === "carol"), "the Nextcloud user id is who was approved");

  // The assistant's own posts come back from the server and are never answered; nor are system notes.
  const before = context.provider.requests.length;
  const postsBefore = server.posts().length;
  server.add("abcd1234", { actorId: "branch", message: "something I said myself" });
  server.add("abcd1234", { actorId: "carol", message: "", systemMessage: "call_started", messageType: "system" });
  await delay(150);
  assert.equal(context.provider.requests.length, before, "neither its own message nor a system note reaches the model");
  assert.equal(server.posts().length, postsBefore);
  await assertNoSecret(context, [NEXTCLOUD_PASSWORD]);
});

test("Nextcloud Talk: in a group conversation only a mention is answered, and the mention is taken out", async (t) => {
  const context = await fixture(t);
  const rooms = { grp98765: { type: 2, title: "Team", messages: [] } };
  const server = await talkServer(t, rooms);
  const channel = talkChannel(server, ["grp98765"]);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: ["carol"] });
  t.after(() => channel.stop());
  await until(() => server.calls.some((c) => c.query.lookIntoFuture === "1"), "polling");
  server.add("grp98765", { actorId: "carol", message: "lunch at noon?" });
  await delay(150);
  assert.equal(context.provider.requests.length, 0, "an unaddressed group message is left alone");
  server.add("grp98765", { actorId: "carol", actorDisplayName: "Carol", message: "{mention-user1} summarise the plan",
    messageParameters: { "mention-user1": { type: "user", id: "branch", name: "Branch" } } });
  await until(() => server.posts().length > 0, "answered in the group");
  assert.equal(context.provider.requests[0].messages.at(-1).content.includes("{mention-user1}"), false, "the placeholder is gone");
  assert.match(server.posts()[0].json.message, /Echo: .*summarise the plan/);
  assert.equal(server.posts()[0].path, "/ocs/v2.php/apps/spreed/api/v1/chat/grp98765");
  await assert.rejects(() => channel.send("../../evil", "x"), /not a Nextcloud Talk conversation/);
  await assertNoSecret(context, [NEXTCLOUD_PASSWORD]);
});

test("Nextcloud Talk: a stranger is refused when pairing is off, and a refused app password is named", async (t) => {
  const context = await fixture(t);
  const rooms = { abcd1234: { type: 1, messages: [] } };
  const server = await talkServer(t, rooms);
  const channel = talkChannel(server, ["abcd1234"]);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => server.calls.some((c) => c.query.lookIntoFuture === "1"), "polling");
  await refusalWalk(context, { label: "Nextcloud Talk", sent: () => server.posts().map((c) => c.json.message),
    say: async (text) => server.add("abcd1234", { actorId: "mallory", message: text }) });
  await assertNoSecret(context, [NEXTCLOUD_PASSWORD]);

  const locked = await talkServer(t, { abcd1234: { type: 1, messages: [] } }, { refuse: () => true });
  const refused = talkChannel(locked, ["abcd1234"], { retryBaseMs: 10 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /NEXTCLOUD_TALK_APP_PASSWORD/);
  assert.ok(!refused.health().reason.includes(NEXTCLOUD_PASSWORD));
  await assert.rejects(() => refused.send("abcd1234", "hi"), (error) => !error.message.includes(NEXTCLOUD_PASSWORD) && /refused/.test(error.message));
});

// ---------------------------------------------------------------- Text messages (Twilio)

/** Twilio's message list, newest first; a send is stored as an outbound message. */
async function twilioServer(t, { refuse = () => false } = {}) {
  const messages = [];
  let next = 1;
  const sid = (prefix) => `${prefix}${String(next++).padStart(32, "0")}`;
  const listPath = `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const service = await httpService(t, (call) => {
    if (refuse()) return { status: 401, body: { code: 20003, message: "Authenticate" } };
    if (call.path !== listPath) return undefined;
    if (call.method === "POST") {
      const row = { sid: sid("SM"), from: call.form.From, to: call.form.To, body: call.form.Body, direction: "outbound-api" };
      messages.unshift(row);
      return { status: 201, body: row };
    }
    return { body: { messages: messages.filter((m) => m.to === call.query.To).slice(0, Number(call.query.PageSize)), page: 0 } };
  });
  const text = (from, body, direction = "inbound") => messages.unshift({ sid: sid("SM"), from, to: OUR_NUMBER, body, direction });
  return { ...service, text, posts: () => service.calls.filter((c) => c.method === "POST") };
}
const smsChannel = (server, extra = {}) => new TwilioSmsChannel({ id: "sms", accountSid: ACCOUNT_SID, authToken: TWILIO_TOKEN,
  authTokenSecret: "TWILIO_AUTH_TOKEN", from: OUR_NUMBER, apiBase: server.base, pollMs: 20, ...extra });

test("Text messages: old texts are left alone, a stranger pairs, and the answer is texted back to that number", async (t) => {
  const context = await fixture(t);
  const server = await twilioServer(t);
  server.text("+15550001111", "an old text from before Branch started");
  const channel = smsChannel(server);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "took stock");
  await until(() => server.calls.length >= 3, "polled again");
  assert.equal(server.posts().length, 0, "the old text is not answered");
  assert.equal(server.calls[0].headers.authorization, basic(ACCOUNT_SID, TWILIO_TOKEN));
  assert.deepEqual(server.calls[0].query, { To: OUR_NUMBER, PageSize: "50" });

  const said = () => server.posts().map((c) => c.form.Body);
  await pairingWalk(context, { label: "SMS", say: async (text) => server.text("+15550001111", text), sent: said });
  const reply = server.posts().at(-1).form;
  assert.equal(reply.To, "+15550001111");
  assert.equal(reply.From, OUR_NUMBER);
  assert.ok(context.app.channels.summary().approved.some((p) => p.senderId === "+15550001111"), "the phone number is who was approved");

  // Texts the assistant sent come back in the list and are never answered.
  const before = context.provider.requests.length;
  const postsBefore = server.posts().length;
  server.text(OUR_NUMBER, "a text from our own number", "outbound-api");
  await delay(150);
  assert.equal(context.provider.requests.length, before);
  assert.equal(server.posts().length, postsBefore);

  const long = await channel.send("+15550001111", "x".repeat(2000));
  assert.match(long, /^SM/);
  assert.equal(server.posts().at(-1).form.Body.length, 1600, "cut to Twilio's limit");
  await assert.rejects(() => channel.send("not-a-number", "hi"), /phone number/);
  await assertNoSecret(context, [TWILIO_TOKEN]);
});

test("Text messages: a stranger is refused when pairing is off, and a refused token is named", async (t) => {
  const context = await fixture(t);
  const server = await twilioServer(t);
  const channel = smsChannel(server);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => server.calls.length >= 2, "polling");
  await refusalWalk(context, { label: "SMS", say: async (text) => server.text("+15559990000", text), sent: () => server.posts().map((c) => c.form.Body) });
  assert.equal(server.posts().at(-1).form.To, "+15559990000");
  await assertNoSecret(context, [TWILIO_TOKEN]);

  const locked = await twilioServer(t, { refuse: () => true });
  const refused = smsChannel(locked, { retryBaseMs: 10 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /TWILIO_AUTH_TOKEN/);
  assert.ok(!refused.health().reason.includes(TWILIO_TOKEN));
  await assert.rejects(() => refused.send("+15550001111", "hi"), (error) => !error.message.includes(TWILIO_TOKEN));
});

// ---------------------------------------------------------------- ntfy

/** An ntfy server: publishes are kept per topic, and `poll=1` replays them after `since`. */
async function ntfyServer(t, { token } = {}) {
  const topics = {};
  let next = 1;
  const publish = (topic, message, tags = []) => {
    const event = { id: `m${String(next++).padStart(11, "0")}`, time: Math.floor(Date.now() / 1000), event: "message", topic, message, tags };
    (topics[topic] ??= []).push(event);
    return event;
  };
  const service = await httpService(t, (call) => {
    if (token && call.headers.authorization !== `Bearer ${token}`) return { status: 403, body: { code: 40301, error: "forbidden" } };
    if (call.method === "POST" && call.path === "/") return { body: publish(call.json.topic, call.json.message, call.json.tags) };
    const topic = /^\/([-_A-Za-z0-9]+)\/json$/.exec(call.path)?.[1];
    if (!topic || call.query.poll !== "1") return undefined;
    const all = topics[topic] ?? [];
    const since = call.query.since;
    const at = all.findIndex((e) => e.id === since);
    const picked = since === "latest" ? all.slice(-1) : since === "all" ? all : at >= 0 ? all.slice(at + 1)
      : /^\d+$/.test(since) ? all.filter((e) => e.time >= Number(since)) : [];
    const lines = [{ id: "open1", event: "open", topic }, ...picked].map((e) => JSON.stringify(e)).join("\n");
    return { type: "application/x-ndjson", body: `${lines}\n` };
  });
  return { ...service, topics, publish, posts: () => service.calls.filter((c) => c.method === "POST") };
}
const listening = (server, extra = {}) => new NtfyListeningChannel({ id: "ntfy", server: server.base, topic: "branch-alerts",
  listenTopic: "ask-branch", title: "Branch", token: NTFY_TOKEN, tokenSecret: "NTFY_TOKEN", pollMs: 20, ...extra });

test("ntfy: the listen topic's history is left alone, a stranger pairs, and answers go back to that topic tagged", async (t) => {
  const context = await fixture(t);
  const server = await ntfyServer(t, { token: NTFY_TOKEN });
  server.publish("ask-branch", "an old message from before Branch started");
  const channel = listening(server);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "took stock");
  await until(() => server.calls.length >= 3, "polled again");
  assert.equal(server.calls[0].query.since, "latest", "the first poll only asks for the newest message");
  assert.equal(server.calls[1].query.since, server.topics["ask-branch"][0].id, "then asks for what came after it");
  assert.equal(server.posts().length, 0, "the old message is not answered");

  const said = () => server.posts().map((c) => c.json.message);
  await pairingWalk(context, { label: "ntfy", say: async (text) => server.publish("ask-branch", text), sent: said });
  const reply = server.posts().at(-1);
  assert.equal(reply.json.topic, "ask-branch", "answered on the topic the question came from");
  assert.deepEqual(reply.json.tags, [ntfyOwnTag]);
  assert.equal(reply.json.title, "Branch");
  assert.equal(reply.headers.authorization, `Bearer ${NTFY_TOKEN}`);
  assert.ok(!server.calls.some((c) => JSON.stringify(c.query).includes(NTFY_TOKEN)), "the token never travels in an address");

  // The assistant's own answers are published to the same topic and are never answered.
  const before = context.provider.requests.length;
  const postsBefore = server.posts().length;
  server.publish("ask-branch", "looks like one of mine", [ntfyOwnTag]);
  await delay(150);
  assert.equal(context.provider.requests.length, before);
  assert.equal(server.posts().length, postsBefore);
  await channel.send("somewhere-else", "a notification");
  assert.equal(server.posts().at(-1).json.topic, "branch-alerts", "anything not answering the listen topic goes to the main topic");
  await assertNoSecret(context, [NTFY_TOKEN]);
});

test("ntfy: a stranger is refused when pairing is off, and a refused token is named", async (t) => {
  const context = await fixture(t);
  const server = await ntfyServer(t, { token: NTFY_TOKEN });
  const channel = listening(server);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => server.calls.length >= 2, "polling");
  assert.match(server.calls[1].query.since, /^\d+$/, "an empty topic is followed from the moment Branch started");
  await refusalWalk(context, { label: "ntfy", say: async (text) => server.publish("ask-branch", text), sent: () => server.posts().map((c) => c.json.message) });
  await assertNoSecret(context, [NTFY_TOKEN]);

  const refused = listening(server, { token: "tk_wrong", retryBaseMs: 10 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /NTFY_TOKEN/);
  await assert.rejects(() => refused.send("x", "hi"), (error) => !error.message.includes("tk_wrong") && /ntfy refused/.test(error.message));
});

test("ntfy without a listen topic only publishes, with no token header unless one is saved", async (t) => {
  const context = await fixture(t);
  const server = await ntfyServer(t);
  const channel = new NtfyChannel({ id: "ntfy", server: `${server.base}/`, topic: "branch-alerts", title: "Branch" });
  assert.equal(await channel.send("ignored", "Backup finished"), server.topics["branch-alerts"][0].id);
  assert.equal(server.calls[0].path, "/");
  assert.equal(server.calls[0].headers.authorization, undefined);
  assert.deepEqual(server.calls[0].json, { topic: "branch-alerts", message: "Backup finished", title: "Branch", tags: [ntfyOwnTag] });
  assert.match(channel.health().reason, /cannot hand messages back/);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  await assertNoSecret(context, []);
});

// ---------------------------------------------------------------- send only

test("Pushover: a form with the token, user key, message and title, and the token never in an error", async (t) => {
  const context = await fixture(t);
  let refuse = false;
  const server = await httpService(t, (call) => refuse ? { status: 400, body: { status: 0, errors: ["application token is invalid"] } }
    : call.path === "/1/messages.json" ? { body: { status: 1, request: "5042853c-402d-4a18-abcb-168734a801de" } } : undefined);
  const channel = new PushoverChannel({ id: "pushover", appToken: PUSHOVER_TOKEN, userKey: PUSHOVER_USER, title: "Branch",
    appTokenSecret: "PUSHOVER_APP_TOKEN", userKeySecret: "PUSHOVER_USER_KEY", endpoint: `${server.base}/1/messages.json` });
  assert.equal(channel.maxTextLength, 1024);
  assert.equal(await channel.send("ignored", "y".repeat(1100)), "5042853c-402d-4a18-abcb-168734a801de");
  assert.deepEqual(server.calls[0].form, { token: PUSHOVER_TOKEN, user: PUSHOVER_USER, message: "y".repeat(1024), title: "Branch" });
  assert.match(server.calls[0].headers["content-type"], /x-www-form-urlencoded/);
  refuse = true;
  await assert.rejects(() => channel.send("x", "again"), (error) =>
    !error.message.includes(PUSHOVER_TOKEN) && !error.message.includes(PUSHOVER_USER) && /Pushover refused/.test(error.message));
  assert.equal(channel.health().state, "needs attention");
  assert.match(channel.health().reason, /PUSHOVER_APP_TOKEN/);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  await assertNoSecret(context, [PUSHOVER_TOKEN, PUSHOVER_USER]);
});

test("Threema: Basic mode form, the recipient field chosen by the chat id, and text cut to 3500 bytes", async (t) => {
  const context = await fixture(t);
  let status = 200;
  const server = await httpService(t, (call) => status !== 200 ? { status, type: "text/plain", body: "" }
    : call.path === "/send_simple" ? { type: "text/plain", body: "0a1b2c3d4e5f6071\n" } : undefined);
  const channel = new ThreemaChannel({ id: "threema", gatewayId: "*BRANCH1", secret: THREEMA_SECRET,
    secretName: "THREEMA_GATEWAY_SECRET", endpoint: `${server.base}/send_simple` });
  assert.equal(await channel.send("echoecho", "Hallo"), "0a1b2c3d4e5f6071");
  assert.deepEqual(server.calls[0].form, { from: "*BRANCH1", to: "ECHOECHO", secret: THREEMA_SECRET, text: "Hallo" });
  await channel.send("+41791234567", "hi");
  assert.equal(server.calls[1].form.phone, "41791234567");
  await channel.send("Owner@Example.com", "hi");
  assert.equal(server.calls[2].form.email, "owner@example.com");
  assert.throws(() => threemaRecipient("not a person"), /Threema ID/);

  const words = "é".repeat(2000);
  await channel.send("ECHOECHO", words);
  assert.equal(Buffer.byteLength(server.calls[3].form.text), 3500, "cut on a character boundary at 3500 bytes");
  assert.equal(cutBytes("aé", 2), "a", "a two-byte character is never split");
  assert.ok(!server.calls.some((c) => c.path.includes(THREEMA_SECRET) || JSON.stringify(c.query).includes(THREEMA_SECRET)), "the secret travels in the body");

  status = 401;
  await assert.rejects(() => channel.send("ECHOECHO", "again"), (error) => !error.message.includes(THREEMA_SECRET) && /Threema refused/.test(error.message));
  assert.match(channel.health().reason, /THREEMA_GATEWAY_SECRET/);
  status = 402;
  await assert.rejects(() => channel.send("ECHOECHO", "again"));
  assert.match(channel.health().reason, /no credits/);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  await assertNoSecret(context, [THREEMA_SECRET]);
});

test("Home Assistant: calls notify with the bearer token, and a plain chat id picks the notify service", async (t) => {
  const context = await fixture(t);
  let refuse = false;
  const server = await httpService(t, (call) => refuse ? { status: 401, body: { message: "Unauthorized" } }
    : call.path.startsWith("/api/services/notify/") ? { body: [] } : undefined);
  const channel = new HomeAssistantChannel({ id: "home", url: `${server.base}/`, token: HASS_TOKEN, tokenSecret: "HOMEASSISTANT_TOKEN",
    service: "mobile_app_phone", title: "Branch" });
  assert.equal(await channel.send("owner-chat!", "Door left open"), undefined);
  assert.equal(server.calls[0].path, "/api/services/notify/mobile_app_phone");
  assert.equal(server.calls[0].headers.authorization, `Bearer ${HASS_TOKEN}`);
  assert.deepEqual(server.calls[0].json, { message: "Door left open", title: "Branch" });
  await channel.send("living_room_speaker", "Dinner is ready");
  assert.equal(server.calls[1].path, "/api/services/notify/living_room_speaker");
  await channel.send("../../api/config", "x");
  assert.equal(server.calls[2].path, "/api/services/notify/mobile_app_phone", "a chat id with other characters never changes the address");
  refuse = true;
  await assert.rejects(() => channel.send("x", "again"), (error) => !error.message.includes(HASS_TOKEN) && /refused/.test(error.message));
  assert.match(channel.health().reason, /HOMEASSISTANT_TOKEN/);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  await assertNoSecret(context, [HASS_TOKEN]);
});

// ---------------------------------------------------------------- built from the connections file

/** A network policy that records every host it is asked about and sends the calls to the stand-in. */
function rewritingPolicy(base) {
  const hosts = [];
  const guard = () => async (url, init) => {
    const target = new URL(String(url));
    hosts.push(target.hostname);
    return fetch(`${base}${target.pathname}${target.search}`, init);
  };
  return { hosts, policy: { assertAllowed: async (url) => { hosts.push(url.hostname); }, guard } };
}

const sendOnly = [
  { kind: "pushover", host: "api.pushover.net", config: {}, secrets: { PUSHOVER_APP_TOKEN: PUSHOVER_TOKEN, PUSHOVER_USER_KEY: PUSHOVER_USER },
    path: "/1/messages.json", check: (call) => call.form.token === PUSHOVER_TOKEN && call.form.message === "Switched on" },
  { kind: "threema", host: "msgapi.threema.ch", config: { gatewayId: "*BRANCH1" }, secrets: { THREEMA_GATEWAY_SECRET: THREEMA_SECRET },
    chatId: "ECHOECHO", path: "/send_simple", check: (call) => call.form.secret === THREEMA_SECRET && call.form.to === "ECHOECHO" },
  { kind: "homeassistant", host: "home.example.org", config: { url: "https://home.example.org:8123", service: "mobile_app_phone" },
    secrets: { HOMEASSISTANT_TOKEN: HASS_TOKEN }, chatId: "phone-owner", path: "/api/services/notify/mobile_app_phone",
    check: (call) => call.headers.authorization === `Bearer ${HASS_TOKEN}` },
  { kind: "ntfy", host: "ntfy.example.org", config: { server: "https://ntfy.example.org", topic: "branch-alerts" }, secrets: {},
    path: "/", check: (call) => call.json.topic === "branch-alerts" && call.headers.authorization === undefined },
];

for (const service of sendOnly) {
  test(`${service.kind}: built from the connections file, off until switched on, then delivered through the ledger`, async (t) => {
    const context = await fixture(t);
    const { app } = context;
    const server = await httpService(t, (call) => call.path === service.path
      ? (service.kind === "threema" ? { type: "text/plain", body: "0a1b2c3d4e5f6071" } : { body: service.kind === "homeassistant" ? [] : { status: 1, id: "n1", request: "r1" } })
      : undefined);
    const { hosts, policy: rewriting } = rewritingPolicy(server.base);
    const channel = await buildParityChannel({ type: service.kind, id: service.kind, activation: "mention", pairing: true, allowlist: [], ...service.config },
      { credential: async (name) => service.secrets[name] ?? assert.fail(`unexpected secret ${name}`), policy: rewriting, store: app.store, owner: app.runtime.owner });
    await app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
    t.after(() => channel.stop());
    await assert.rejects(() => app.channels.adapter(service.kind).send(service.chatId ?? "owner", "too early"), /switched off/);
    assert.equal(server.calls.length, 0, "nothing left the computer while it was off");
    setSwitch(app, service.kind, "on");
    await app.channels.deliver(service.kind, service.chatId ?? "owner", "Switched on");
    await until(() => server.calls.length === 1, "delivered");
    assert.ok(service.check(server.calls[0]), "the request has the service's shape");
    assert.ok(hosts.length > 0 && hosts.every((host) => host === service.host), `every check named ${service.host}: ${hosts}`);
    await assertNoSecret(context, Object.values(service.secrets));
  });
}

test("every new service takes strict settings, names its secrets, and is checked against the right host", async () => {
  const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  const base = { activation: "mention", pairing: true, allowlist: [] };
  const cases = [
    [{ type: "nextcloud-talk", id: "talk", server: "https://cloud.example.org", username: "branch", rooms: ["abcd1234"] }, "cloud.example.org"],
    [{ type: "sms", id: "sms", accountSid: ACCOUNT_SID, from: OUR_NUMBER }, "api.twilio.com"],
    [{ type: "sms", id: "sms2", accountSid: ACCOUNT_SID, from: OUR_NUMBER, apiBase: "https://sms.example.net" }, "sms.example.net"],
    [{ type: "ntfy", id: "ntfy", topic: "alerts", listenTopic: "ask", tokenSecret: "NTFY_TOKEN" }, "ntfy.sh"],
    [{ type: "pushover", id: "po" }, "api.pushover.net"],
    [{ type: "threema", id: "th", gatewayId: "*BRANCH1" }, "msgapi.threema.ch"],
    [{ type: "homeassistant", id: "ha", url: "http://homeassistant.local:8123" }, "homeassistant.local"],
  ];
  for (const [config, host] of cases)
    await assert.rejects(() => buildParityChannel({ ...config, ...base }, { credential: async () => "x", policy: blocked }),
      new RegExp(`Not allowed: ${host.replace(/\./g, "\\.")}`), `${config.type} is checked against ${host}`);

  const defaults = {
    "nextcloud-talk": ["passwordSecret", "NEXTCLOUD_TALK_APP_PASSWORD"], sms: ["authTokenSecret", "TWILIO_AUTH_TOKEN"],
    pushover: ["appTokenSecret", "PUSHOVER_APP_TOKEN"], threema: ["gatewaySecret", "THREEMA_GATEWAY_SECRET"],
    homeassistant: ["tokenSecret", "HOMEASSISTANT_TOKEN"],
  };
  for (const [config] of cases) {
    const service = parityServices.find((s) => s.kind === config.type);
    const { type: _t, id: _i, ...own } = config;
    const parsed = service.settings.parse(own);
    for (const [key, value] of Object.entries(parsed))
      if (/Secret$/.test(key)) assert.match(value, /^[A-Z][A-Z0-9_]*$/, `${config.type}.${key} is a secret's name`);
    if (defaults[config.type]) assert.equal(parsed[defaults[config.type][0]], defaults[config.type][1]);
    assert.throws(() => service.settings.parse({ ...own, token: "abc" }), /token|Unrecognized/i, `${config.type} refuses a token written in the settings`);
  }
  assert.throws(() => parityServices.find((s) => s.kind === "sms").settings.parse({ accountSid: "nope", from: OUR_NUMBER }));
  assert.throws(() => parityServices.find((s) => s.kind === "nextcloud-talk").settings.parse({ server: "https://c.example", username: "b", rooms: ["../x"] }));
  assert.equal(parityServices.find((s) => s.kind === "ntfy").settings.parse({ topic: "alerts" }).tokenSecret, undefined, "no token unless one is named");
  // Building with the ordinary policy hands the saved password to the channel and nowhere else.
  const talk = await buildParityChannel({ type: "nextcloud-talk", id: "talk", server: "https://cloud.example.org", username: "branch", rooms: ["abcd1234"], ...base },
    { credential: async (name) => (name === "NEXTCLOUD_TALK_APP_PASSWORD" ? NEXTCLOUD_PASSWORD : assert.fail(name)), policy });
  assert.equal(talk.inner.kind, "nextcloud-talk");
  assert.equal(talk.health().state, "needs attention", "off until switched on");
});
