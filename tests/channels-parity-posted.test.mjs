import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign as rsaSign } from "node:crypto";
import { join } from "node:path";
import {
  fixture, until, delay, setSwitch, assertNoSecret, httpService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { parityServices } from "../dist/channels/parity-services.js";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { secretName } from "../dist/channels/parity-common.js";
import { FlockChannel } from "../dist/channels/flock.js";
import { PumbleChannel } from "../dist/channels/pumble.js";
import { SynologyChatChannel } from "../dist/channels/synology-chat.js";
import { WebexChannel } from "../dist/channels/webex.js";
import { ZaloChannel } from "../dist/channels/zalo.js";
import { TeamsBotChannel, allowedServiceUrl } from "../dist/channels/teams-bot.js";
import { startServer } from "../dist/server.js";

/**
 * The chat services that post to this computer: Teams (Bot Framework), Webex, Synology Chat, Zalo
 * OA, Flock and Pumble. Each is driven by posting exactly what the service would post, signed the
 * way its documentation says, and answered through a stand-in for its API. Nothing here reaches a
 * real service.
 */
const FLOCK_SECRET = "SECRET-FLOCK-APP-SECRET-11";
const FLOCK_TOKEN = "SECRET-FLOCK-BOT-TOKEN-12";
const PUMBLE_SIGNING = "SECRET-PUMBLE-SIGNING-21";
const PUMBLE_TOKEN = "SECRET-PUMBLE-BOT-TOKEN-22";
const PUMBLE_KEY = "SECRET-PUMBLE-APP-KEY-23";
const SYNO_TOKEN = "SECRET-SYNOLOGY-OUT-TOKEN-31";
const SYNO_URL_TOKEN = "SECRET-SYNOLOGY-IN-TOKEN-32";
const WEBEX_TOKEN = "SECRET-WEBEX-BOT-TOKEN-41";
const WEBEX_HOOK = "SECRET-WEBEX-HOOK-SECRET-42";
const ZALO_KEY = "SECRET-ZALO-OA-KEY-51";
const ZALO_APP_SECRET = "SECRET-ZALO-APP-SECRET-52";
const ZALO_ACCESS = "SECRET-ZALO-ACCESS-OLD-53";
const ZALO_REFRESH = "SECRET-ZALO-REFRESH-54";
const ZALO_NEW_ACCESS = "SECRET-ZALO-ACCESS-NEW-55";
const ZALO_NEW_REFRESH = "SECRET-ZALO-REFRESH-NEW-56";
const TEAMS_PASSWORD = "SECRET-TEAMS-APP-PASSWORD-61";
const TEAMS_CONNECTOR = "SECRET-TEAMS-CONNECTOR-62";
const policy = { activation: "mention", pairing: true, allowlist: [] };
let counter = 0;
const nextId = (prefix) => `${prefix}-${++counter}`;
const lower = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
const post = (channel, body, headers = {}) => channel.receivePost(Buffer.from(body), lower(headers));

/** Posts that must be refused: nothing may reach the model and nothing may be sent. */
async function refusedPosts(context, service, attempts) {
  const before = service.calls.length;
  for (const [label, attempt] of attempts) await assert.rejects(attempt, undefined, `${label} is refused`);
  await delay(50);
  assert.equal(context.provider.requests.length, 0, "a refused post never reaches the model");
  assert.equal(service.calls.length, before, "a refused post makes Branch call nobody");
}

// ---------------------------------------------------------------- Flock

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function hs256(claims, secret = FLOCK_SECRET, alg = "HS256") {
  const head = `${b64({ alg, typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}
const flockToken = (extra = {}) => hs256({ appId: "app1", userId: "u:owner", exp: Math.floor(Date.now() / 1000) + 60, ...extra });
const flockEvent = (text, { from = "u:alice", to = "u:bot" } = {}) =>
  JSON.stringify({ name: "chat.receiveMessage", userId: "u:owner", message: { from, to, text, uid: nextId("f") } });
async function flockSetup(t) {
  return httpService(t, (call) => (call.path === "/v1/chat.sendMessage" ? { body: { uid: nextId("sent") } } : undefined));
}
const flockChannel = (base) => new FlockChannel({ id: "flock", appSecret: FLOCK_SECRET, botToken: FLOCK_TOKEN, appId: "app1",
  botUserId: "u:bot", botName: "branch", apiBase: `${base}/v1` });
const flockSent = (service) => () => service.calls.filter((c) => c.path === "/v1/chat.sendMessage").map((c) => c.json.text);

test("Flock: a signed event is answered, a stranger pairs first, and the bot's own words are left alone", async (t) => {
  const context = await fixture(t);
  const service = await flockSetup(t);
  const channel = flockChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const say = (text) => post(channel, flockEvent(text), { "X-Flock-Event-Token": flockToken() });
  await pairingWalk(context, { label: "Flock", say, sent: flockSent(service) });
  const reply = service.calls.find((c) => c.path === "/v1/chat.sendMessage");
  assert.equal(reply.json.to, "u:alice", "a direct message is answered to the person");
  assert.equal(reply.json.token, FLOCK_TOKEN, "the bot token travels in the body");
  assert.ok(!reply.path.includes(FLOCK_TOKEN));

  const asked = context.provider.requests.length;
  assert.deepEqual(await post(channel, flockEvent("echo", { from: "u:bot" }), { "x-flock-event-token": flockToken() }), { accepted: 0 });
  assert.deepEqual(await post(channel, JSON.stringify({ name: "app.install", userId: "u:owner" }), { "x-flock-event-token": flockToken() }), { accepted: 0 });
  await post(channel, flockEvent("just chatting", { to: "g:team" }), { "x-flock-event-token": flockToken() });
  await delay(80);
  assert.equal(context.provider.requests.length, asked, "the bot's own message and an unaddressed group line are left alone");
  await post(channel, flockEvent("@branch summarise please", { to: "g:team" }), { "x-flock-event-token": flockToken() });
  await until(() => service.calls.some((c) => c.json?.to === "g:team" && /^Echo: .*\] summarise please$/.test(c.json.text)), "answered in the group");
  await assertNoSecret(context, [FLOCK_SECRET, FLOCK_TOKEN]);
});

test("Flock: forged, expired, foreign and missing event tokens are refused", async (t) => {
  const context = await fixture(t);
  const service = await flockSetup(t);
  const channel = flockChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const body = flockEvent("let me in");
  await refusedPosts(context, service, [
    ["a wrong signature", () => post(channel, body, { "x-flock-event-token": hs256({ appId: "app1", exp: 9e9 }, "not-the-secret") })],
    ["no token", () => post(channel, body)],
    ["an expired token", () => post(channel, body, { "x-flock-event-token": flockToken({ exp: Math.floor(Date.now() / 1000) - 3600 }) })],
    ["another app's token", () => post(channel, body, { "x-flock-event-token": flockToken({ appId: "other" }) })],
    ["an unsigned token", () => post(channel, body, { "x-flock-event-token": `${b64({ alg: "none" })}.${b64({ exp: 9e9 })}.` })],
  ]);
  await assertNoSecret(context, [FLOCK_SECRET, FLOCK_TOKEN]);
});

test("Flock: a stranger is refused when pairing is off", async (t) => {
  const context = await fixture(t);
  const service = await flockSetup(t);
  const channel = flockChannel(service.base);
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  await refusalWalk(context, { label: "Flock", sent: flockSent(service),
    say: (text) => post(channel, flockEvent(text, { from: "u:mallory" }), { "x-flock-event-token": flockToken() }) });
  await assertNoSecret(context, [FLOCK_SECRET, FLOCK_TOKEN]);
});

test("Flock through the real web address: 200 when signed, 401 when not, 503 while switched off", async (t) => {
  const context = await fixture(t);
  const { app } = context;
  const service = await flockSetup(t);
  const secrets = { FLOCK_APP_SECRET: FLOCK_SECRET, FLOCK_BOT_TOKEN: FLOCK_TOKEN };
  const channel = await buildParityChannel({ type: "flock", id: "flock", appId: "app1", apiBase: `${service.base}/v1`, ...policy },
    { credential: async (name) => secrets[name], store: app.store, owner: app.runtime.owner });
  setSwitch(app, "flock", "on");
  await app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const server = await startServer(app, { dataDir: join(context.root, "data"), port: 0 });
  t.after(() => server.close());
  const listed = await fetch(`${server.url}/api/channels/addresses`, { headers: { authorization: `Bearer ${server.token}`, origin: server.url } })
    .then((response) => response.json());
  const address = listed.addresses.find((entry) => entry.channel === "flock")?.address;
  assert.match(address ?? "", /^\/webhooks\/chat\/flock\/[a-f0-9]{32}$/, "the posted service is given an address");
  const send = (token) => fetch(`${server.url}${address}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-flock-event-token": token } : {}) }, body: flockEvent("hello there"),
  });
  const bad = await send(hs256({ appId: "app1", exp: 9e9 }, "forged"));
  assert.equal(bad.status, 401);
  const good = await send(flockToken());
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { accepted: 1 });
  await until(() => flockSent(service)().some((text) => /\b\d{6}\b/.test(text)), "the stranger was offered a code");
  const missing = await send(undefined);
  assert.equal(missing.status, 401);
  setSwitch(app, "flock", "off");
  const off = await send(flockToken());
  assert.equal(off.status, 503, "a switched-off service turns posts away");
  assert.equal(context.provider.requests.length, 0);
  await assertNoSecret(context, Object.values(secrets));
});

// ---------------------------------------------------------------- Pumble

function pumbleHeaders(raw, secret = PUMBLE_SIGNING, timestamp = String(Date.now())) {
  return { "x-pumble-request-timestamp": timestamp, "x-pumble-request-signature": createHmac("sha256", secret).update(`${timestamp}:${raw}`).digest("hex") };
}
const pumbleEvent = (text, { channel = "D1", author = "U1", thread } = {}) => JSON.stringify({
  messageType: "PUMBLE_EVENT", eventType: "NEW_MESSAGE", workspaceId: "W1", workspaceUserIds: ["BOT1"],
  body: JSON.stringify({ mId: nextId("pm"), cId: channel, aId: author, tx: text, ...(thread ? { trId: thread } : {}) }),
});
async function pumbleSetup(t) {
  return httpService(t, (call) => {
    if (call.method === "GET" && call.path === "/v1/channels/D1") return { body: { channel: { id: "D1", channelType: "DIRECT" } } };
    if (call.method === "GET" && call.path === "/v1/channels/C1") return { body: { channel: { id: "C1", channelType: "PUBLIC" } } };
    if (call.method === "POST" && call.path.startsWith("/v1/channels/")) return { body: { id: nextId("sent") } };
    return undefined;
  });
}
const pumbleChannel = (base) => new PumbleChannel({ id: "pumble", signingSecret: PUMBLE_SIGNING, botToken: PUMBLE_TOKEN,
  appKey: PUMBLE_KEY, botUserId: "BOT1", apiBase: base });
const pumbleSent = (service) => () => service.calls.filter((c) => c.method === "POST").map((c) => c.json.text);
const pumbleSay = (channel, options) => (text) => { const raw = pumbleEvent(text, options); return post(channel, raw, pumbleHeaders(raw)); };

test("Pumble: a signed direct message pairs and is answered; in a channel only a mention is, in its thread", async (t) => {
  const context = await fixture(t);
  const service = await pumbleSetup(t);
  const channel = pumbleChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await pairingWalk(context, { label: "Pumble", say: pumbleSay(channel), sent: pumbleSent(service) });
  const reply = service.calls.find((c) => c.method === "POST");
  assert.equal(reply.path, "/v1/channels/D1/messages");
  assert.equal(reply.headers.token, PUMBLE_TOKEN);
  assert.equal(reply.headers["x-app-token"], PUMBLE_KEY);

  const asked = context.provider.requests.length;
  await pumbleSay(channel, { author: "BOT1" })("my own reply");
  await pumbleSay(channel, { channel: "C1" })("just chatting");
  await delay(80);
  assert.equal(context.provider.requests.length, asked, "the bot's own message and an unaddressed channel line are left alone");
  await pumbleSay(channel, { channel: "C1", thread: "ROOT9" })("<<@BOT1>> summarise please");
  await until(() => service.calls.some((c) => c.path === "/v1/channels/C1/messages/ROOT9" && /Echo: .*summarise please/.test(c.json.text)), "answered in the thread");
  const raw = JSON.stringify({ messageType: "SLASH_COMMAND", slashCommand: "/x" });
  assert.deepEqual(await post(channel, raw, pumbleHeaders(raw)), { accepted: 0 });
  await assertNoSecret(context, [PUMBLE_SIGNING, PUMBLE_TOKEN, PUMBLE_KEY]);
});

test("Pumble: wrong and missing signatures are refused, and pairing off refuses a stranger", async (t) => {
  const context = await fixture(t);
  const service = await pumbleSetup(t);
  const channel = pumbleChannel(service.base);
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  const raw = pumbleEvent("let me in");
  await refusedPosts(context, service, [
    ["a wrong signature", () => post(channel, raw, pumbleHeaders(raw, "not-the-secret"))],
    ["no signature", () => post(channel, raw)],
    ["a signature over other words", () => post(channel, raw, pumbleHeaders(pumbleEvent("something else")))],
  ]);
  await refusalWalk(context, { label: "Pumble", say: pumbleSay(channel, { author: "U666" }), sent: pumbleSent(service) });
  await assertNoSecret(context, [PUMBLE_SIGNING, PUMBLE_TOKEN, PUMBLE_KEY]);
});

// ---------------------------------------------------------------- Synology Chat

const synologyForm = (text, { token = SYNO_TOKEN, user = "42" } = {}) => new URLSearchParams({
  token, user_id: user, username: "alice", post_id: nextId("sp"), channel_id: "7", text, timestamp: String(Date.now()),
}).toString();
async function synologySetup(t, { refuse = () => false } = {}) {
  const service = await httpService(t, (call) => (call.path === "/webapi/entry.cgi"
    ? (refuse() ? { status: 500, body: { success: false } } : { body: { success: true } }) : undefined));
  const incomingUrl = `${service.base}/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22${SYNO_URL_TOKEN}%22`;
  return { service, incomingUrl };
}
const synologySent = (service) => () => service.calls.filter((c) => c.form?.payload).map((c) => JSON.parse(c.form.payload).text);

test("Synology Chat: the Chatbot's token is checked, a stranger pairs, and replies go to that person only", async (t) => {
  const context = await fixture(t);
  let refuse = false;
  const { service, incomingUrl } = await synologySetup(t, { refuse: () => refuse });
  const channel = new SynologyChatChannel({ id: "synology", token: SYNO_TOKEN, incomingUrl });
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await pairingWalk(context, { label: "Synology", say: (text) => post(channel, synologyForm(text)), sent: synologySent(service) });
  const reply = service.calls.find((c) => c.form?.payload);
  assert.deepEqual(JSON.parse(reply.form.payload).user_ids, [42], "the reply names the person who wrote");
  assert.equal(reply.query.token, `"${SYNO_URL_TOKEN}"`);
  assert.deepEqual(await post(channel, synologyForm("   ")), { accepted: 0 }, "an empty post is not answered");

  refuse = true;
  await assert.rejects(() => channel.send("42", "again"),
    (error) => !error.message.includes(SYNO_URL_TOKEN) && !error.message.includes("entry.cgi") && /Synology Chat refused/.test(error.message));
  await assertNoSecret(context, [SYNO_TOKEN, SYNO_URL_TOKEN]);
});

test("Synology Chat: a wrong or missing token is refused, and pairing off refuses a stranger", async (t) => {
  const context = await fixture(t);
  const { service, incomingUrl } = await synologySetup(t);
  const channel = new SynologyChatChannel({ id: "synology", token: SYNO_TOKEN, incomingUrl });
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  await refusedPosts(context, service, [
    ["a wrong token", () => post(channel, synologyForm("let me in", { token: "guess" }))],
    ["no token", () => post(channel, synologyForm("let me in", { token: "" }))],
  ]);
  await refusalWalk(context, { label: "Synology", say: (text) => post(channel, synologyForm(text, { user: "66" })), sent: synologySent(service) });
  await assertNoSecret(context, [SYNO_TOKEN, SYNO_URL_TOKEN]);
});

// ---------------------------------------------------------------- Webex

const ROOM_DIRECT = `Y2lzY29zcGFyazovL3VzL1JPT00v${"d".repeat(50)}`;
const ROOM_GROUP = `Y2lzY29zcGFyazovL3VzL1JPT00v${"g".repeat(50)}`;
async function webexSetup(t) {
  const messages = new Map();
  const service = await httpService(t, (call) => {
    if (call.headers.authorization !== `Bearer ${WEBEX_TOKEN}`) return { status: 401, body: {} };
    if (call.path === "/v1/people/me") return { body: { id: "BOTID", displayName: "Branch Bot" } };
    if (call.method === "GET" && call.path.startsWith("/v1/messages/")) {
      const found = messages.get(decodeURIComponent(call.path.slice(13)));
      return found ? { body: found } : { status: 404, body: {} };
    }
    if (call.method === "POST" && call.path === "/v1/messages") return { body: { id: nextId("sent") } };
    return undefined;
  });
  /** Makes Webex hold a message and post its id, signed with `secret`. */
  const say = (channel, { room = ROOM_DIRECT, roomType = "direct", person = "PERSON1", secret = WEBEX_HOOK, age = 0 } = {}) => (text) => {
    const id = `${nextId("wm")}-${"x".repeat(60)}`;
    messages.set(id, { id, roomId: room, roomType, personId: person, personEmail: `${person}@example.com`, text, created: new Date(Date.now() - age).toISOString() });
    const raw = JSON.stringify({ id: "hook", resource: "messages", event: "created", data: { id, personId: person, roomId: room } });
    return post(channel, raw, { "x-spark-signature": createHmac("sha1", secret).update(raw).digest("hex") });
  };
  const sent = () => service.calls.filter((c) => c.method === "POST").map((c) => c.json.text);
  /** Posts the same signed body again, as somebody who copied it would. */
  const again = (channel, raw) => post(channel, raw, { "x-spark-signature": createHmac("sha1", WEBEX_HOOK).update(raw).digest("hex") });
  return { service, say, sent, again };
}
const webexChannel = (base) => new WebexChannel({ id: "webex", botToken: WEBEX_TOKEN, webhookSecret: WEBEX_HOOK, apiBase: base });

test("Webex: a signed post is looked up, a stranger pairs, and a group mention is answered in its thread", async (t) => {
  const context = await fixture(t);
  const { service, say, sent } = await webexSetup(t);
  const channel = webexChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  assert.equal(channel.botName(), "Branch Bot");
  await pairingWalk(context, { label: "Webex", say: say(channel), sent });
  const reply = service.calls.find((c) => c.method === "POST");
  assert.equal(reply.json.roomId, ROOM_DIRECT, "the reply goes to the room the message came from");
  assert.ok(reply.json.parentId, "and hangs off the message it answers");

  const looked = service.calls.length;
  assert.deepEqual(await say(channel, { person: "BOTID" })("my own words"), { accepted: 0 });
  assert.equal(service.calls.length, looked, "the bot's own message is not even fetched");
  await say(channel, { room: ROOM_GROUP, roomType: "group" })("Branch Bot summarise please");
  await until(() => service.calls.some((c) => c.json?.roomId === ROOM_GROUP && /^Echo: .*\] summarise please/.test(c.json.text)), "answered in the group without the bot's name");
  await assertNoSecret(context, [WEBEX_TOKEN, WEBEX_HOOK]);
});

test("Webex: wrong and missing signatures are refused, pairing off refuses, and a refused token is reported", async (t) => {
  const context = await fixture(t);
  const { service, say, sent } = await webexSetup(t);
  const channel = webexChannel(service.base);
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  const raw = JSON.stringify({ resource: "messages", event: "created", data: { id: "X" } });
  await refusedPosts(context, service, [
    ["a wrong signature", () => say(channel, { secret: "not-the-secret" })("let me in")],
    ["no signature", () => post(channel, raw)],
  ]);
  await refusalWalk(context, { label: "Webex", say: say(channel, { person: "STRANGER" }), sent });
  const broken = new WebexChannel({ id: "webex2", botToken: "wrong", webhookSecret: WEBEX_HOOK, apiBase: service.base });
  await broken.start(async () => undefined);
  assert.equal(broken.health().state, "needs attention");
  assert.match(broken.health().reason, /WEBEX_BOT_TOKEN/);
  await assertNoSecret(context, [WEBEX_TOKEN, WEBEX_HOOK]);
});

// ---------------------------------------------------------------- Zalo OA

const ZALO_APP = "123456789";
function zaloSigned(event, { key = ZALO_KEY, app = ZALO_APP } = {}) {
  const raw = JSON.stringify(event);
  const mac = createHash("sha256").update(`${app}${raw}${event.timestamp}${key}`).digest("hex");
  return [raw, { "X-ZEvent-Signature": `mac=${mac}` }];
}
const zaloEvent = (text, { user = "ZUSER1", name = "user_send_text", age = 0 } = {}) => ({
  app_id: ZALO_APP, user_id_by_app: "x", event_name: name, timestamp: String(Date.now() - age),
  sender: { id: name === "oa_send_text" ? "OA1" : user }, recipient: { id: name === "oa_send_text" ? user : "OA1" },
  message: { text, msg_id: nextId("zm") },
});
async function zaloSetup(t, { renew = true } = {}) {
  return httpService(t, (call) => {
    if (call.path === "/v3.0/oa/message/cs")
      return { body: call.headers.access_token === ZALO_NEW_ACCESS || call.headers.access_token === "GOOD" ? { error: 0, message: "Success", data: { message_id: nextId("zs") } }
        : { error: -216, message: "Access token is invalid" } };
    if (call.path === "/v4/oa/access_token")
      return renew && call.headers.secret_key === ZALO_APP_SECRET && call.form?.refresh_token === ZALO_REFRESH
        ? { body: { access_token: ZALO_NEW_ACCESS, refresh_token: ZALO_NEW_REFRESH, expires_in: "90000" } }
        : { body: { error: -14014, error_name: "Invalid refresh token" } };
    return undefined;
  });
}
const zaloChannel = (base, accessToken = ZALO_ACCESS) => new ZaloChannel({ id: "zalo", appId: ZALO_APP, oaSecretKey: ZALO_KEY,
  appSecret: ZALO_APP_SECRET, accessToken, refreshToken: ZALO_REFRESH, apiBase: base, oauthBase: base });
/** What reached Zalo with a token it accepted. */
const zaloSent = (service, token = "GOOD") => () => service.calls
  .filter((c) => c.path === "/v3.0/oa/message/cs" && c.headers.access_token === token).map((c) => c.json.message.text);
const zaloSay = (channel, options) => (text) => { const [raw, headers] = zaloSigned(zaloEvent(text, options)); return post(channel, raw, headers); };
const zaloSecrets = [ZALO_KEY, ZALO_APP_SECRET, ZALO_ACCESS, ZALO_REFRESH, ZALO_NEW_ACCESS, ZALO_NEW_REFRESH];

test("Zalo OA: a signed message pairs and is answered, an expired token is renewed, and the owner is told to save the new pair", async (t) => {
  const context = await fixture(t);
  const service = await zaloSetup(t);
  const channel = zaloChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await pairingWalk(context, { label: "Zalo", say: zaloSay(channel), sent: zaloSent(service, ZALO_NEW_ACCESS) });
  const reply = service.calls.find((c) => c.path === "/v3.0/oa/message/cs" && c.headers.access_token === ZALO_NEW_ACCESS);
  assert.deepEqual(reply.json.recipient, { user_id: "ZUSER1" }, "the reply goes to the person who wrote");
  assert.equal(service.calls.filter((c) => c.path === "/v4/oa/access_token").length, 1, "renewed once, then the new token is kept");
  assert.equal(channel.health().state, "needs attention");
  assert.match(channel.health().reason, /ZALO_OA_ACCESS_TOKEN and ZALO_OA_REFRESH_TOKEN/);

  const asked = context.provider.requests.length;
  assert.deepEqual(await zaloSay(channel, { name: "oa_send_text" })("the OA's own words"), { accepted: 0 });
  await delay(50);
  assert.equal(context.provider.requests.length, asked, "the OA's own message is not answered");
  await assertNoSecret(context, zaloSecrets);
});

test("Zalo OA: wrong and missing signatures are refused, pairing off refuses, and a failed renewal is reported", async (t) => {
  const context = await fixture(t);
  const service = await zaloSetup(t, { renew: false });
  const good = zaloChannel(service.base, "GOOD");
  await context.app.channels.attach(good, { ...policy, pairing: false });
  t.after(() => good.stop());
  const [raw, headers] = zaloSigned(zaloEvent("let me in"));
  const [, foreign] = zaloSigned(zaloEvent("let me in"), { app: "999" });
  await refusedPosts(context, service, [
    ["a wrong signature", () => post(good, raw, zaloSigned(JSON.parse(raw), { key: "not-the-key" })[1])],
    ["no signature", () => post(good, raw)],
    ["a signature for another app", () => post(good, raw, foreign)],
    ["a signature over other words", () => post(good, raw.replace("let me in", "let me out"), headers)],
  ]);
  await refusalWalk(context, { label: "Zalo", say: zaloSay(good, { user: "ZSTRANGER" }), sent: zaloSent(service) });
  const stale = zaloChannel(service.base);
  await assert.rejects(() => stale.send("ZUSER1", "hello"), (error) => zaloSecrets.every((s) => !error.message.includes(s)));
  assert.equal(stale.health().state, "needs attention");
  assert.match(stale.health().reason, /expired and could not be renewed/);
  await assertNoSecret(context, zaloSecrets);
});

// ---------------------------------------------------------------- Replayed posts (integration review)

const HOUR = 60 * 60 * 1000;
test("a copied Zalo, Pumble or Webex post is refused when posted again or when it is old", async (t) => {
  const context = await fixture(t);
  const zaloService = await zaloSetup(t);
  const zalo = zaloChannel(zaloService.base, "GOOD");
  const pumbleService = await pumbleSetup(t);
  const pumble = pumbleChannel(pumbleService.base);
  const webex = await webexSetup(t);
  const webexCh = webexChannel(webex.service.base);
  for (const channel of [zalo, pumble, webexCh]) {
    // The senders are allowed, so a copy that got through would reach the model and be counted.
    await context.app.channels.attach(channel, { ...policy, pairing: false, allowlist: ["ZUSER1", "U1", "PERSON1"] });
    t.after(() => channel.stop());
  }
  const [zraw, zheaders] = zaloSigned(zaloEvent("first"));
  assert.deepEqual(await post(zalo, zraw, zheaders), { accepted: 1 });
  await assert.rejects(() => post(zalo, zraw, zheaders), /already taken in/, "the same Zalo post twice");
  const [oldRaw, oldHeaders] = zaloSigned(zaloEvent("stale", { age: HOUR }));
  await assert.rejects(() => post(zalo, oldRaw, oldHeaders), /too old/, "an hour-old Zalo post");

  const praw = pumbleEvent("first");
  const pheaders = pumbleHeaders(praw);
  assert.deepEqual(await post(pumble, praw, pheaders), { accepted: 1 });
  await assert.rejects(() => post(pumble, praw, pheaders), /already taken in/, "the same Pumble post twice");
  const inSeconds = pumbleHeaders(praw, PUMBLE_SIGNING, String(Math.floor((Date.now() - HOUR) / 1000)));
  await assert.rejects(() => post(pumble, praw, inSeconds), /too old/, "an hour-old Pumble post, timed in seconds");
  await assert.rejects(() => post(pumble, praw, pumbleHeaders(praw, PUMBLE_SIGNING, "soon")), /too old|no time/);
  const fresh = pumbleEvent("timed in seconds");
  assert.deepEqual(await post(pumble, fresh, pumbleHeaders(fresh, PUMBLE_SIGNING, String(Math.floor(Date.now() / 1000)))), { accepted: 1 });

  assert.deepEqual(await webex.say(webexCh)("first"), { accepted: 1 });
  const captured = [...webex.service.calls].reverse().find((c) => c.method === "GET" && c.path.startsWith("/v1/messages/"));
  const id = decodeURIComponent(captured.path.slice(13));
  const replay = JSON.stringify({ id: "hook", resource: "messages", event: "created", data: { id, personId: "PERSON1" } });
  await until(() => context.provider.requests.length === 4, "each genuine post reached the model once");
  const asked = context.provider.requests.length;
  assert.deepEqual(await webex.again(webexCh, replay), { accepted: 0 }, "the same Webex message twice is not taken in");
  assert.deepEqual(await webex.say(webexCh, { age: HOUR })("stale"), { accepted: 0 }, "an hour-old Webex message is not taken in");
  await delay(50);
  assert.equal(context.provider.requests.length, asked, "no copy reached the model");
});

// ---------------------------------------------------------------- Microsoft Teams (Bot Framework)

const APP_ID = "00000000-aaaa-bbbb-cccc-000000000001";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function rs256(claims, key = privateKey, kid = "k1") {
  const head = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(claims)}`;
  return `${head}.${rsaSign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}
async function teamsSetup(t) {
  const service = await httpService(t, (call) => {
    if (call.path === "/openid") return { body: { issuer: "https://api.botframework.com", jwks_uri: `${service.base}/keys` } };
    if (call.path === "/keys") return { body: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", endorsements: ["msteams"] }] } };
    if (call.path === "/botframework.com/oauth2/v2.0/token")
      return call.form?.client_secret === TEAMS_PASSWORD && call.form.scope === "https://api.botframework.com/.default"
        ? { body: { token_type: "Bearer", expires_in: 3600, access_token: TEAMS_CONNECTOR } } : { status: 401, body: { error: "invalid_client" } };
    if (call.method === "POST" && call.path.startsWith("/v3/conversations/"))
      return call.headers.authorization === `Bearer ${TEAMS_CONNECTOR}` ? { body: { id: nextId("ta") } } : { status: 401, body: {} };
    return undefined;
  });
  const claims = (extra = {}) => ({ iss: "https://api.botframework.com", aud: APP_ID, serviceUrl: `${service.base}/`,
    nbf: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 600, ...extra });
  const activity = (text, { conversation = "a:personal-chat-1", type = "personal", from = "29:alice", entities = [], serviceUrl = `${service.base}/`, kind = "message" } = {}) =>
    JSON.stringify({ type: kind, id: nextId("act"), serviceUrl, channelId: "msteams", text, entities,
      from: { id: from, name: "Alice", aadObjectId: from === "28:bot" ? undefined : `aad-${from}` },
      recipient: { id: "28:bot", name: "Branch" }, conversation: { id: conversation, conversationType: type } });
  const sent = () => service.calls.filter((c) => c.path.startsWith("/v3/conversations/")).map((c) => c.json.text);
  return { service, claims, activity, sent };
}
const teamsChannel = (base, password = TEAMS_PASSWORD) => new TeamsBotChannel({ id: "teams", appId: APP_ID, appPassword: password,
  tenant: "botframework.com", openIdUrl: `${base}/openid`, loginBase: base, allowServiceHosts: ["127.0.0.1"] });

test("Teams bot: a verified activity pairs and is answered; a channel mention is answered in its thread", async (t) => {
  const context = await fixture(t);
  const { service, claims, activity, sent } = await teamsSetup(t);
  const channel = teamsChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const say = (text) => post(channel, activity(text), { authorization: `Bearer ${rs256(claims())}` });
  await pairingWalk(context, { label: "Teams", say, sent });
  const reply = service.calls.find((c) => c.path.startsWith("/v3/conversations/"));
  assert.match(reply.path, /^\/v3\/conversations\/a%3Apersonal-chat-1\/activities\/act-\d+$/, "the reply answers that activity in that chat");
  assert.equal(reply.json.type, "message");
  assert.equal(service.calls.filter((c) => c.path.endsWith("/token")).length, 1, "the sign-in token is kept, not asked for each time");
  assert.equal(service.calls.filter((c) => c.path === "/keys").length, 1, "Microsoft's keys are fetched once");

  const asked = context.provider.requests.length;
  const token = () => ({ authorization: `Bearer ${rs256(claims())}` });
  assert.deepEqual(await post(channel, activity("my own", { from: "28:bot" }), token()), { accepted: 0 });
  assert.deepEqual(await post(channel, activity("", { kind: "conversationUpdate" }), token()), { accepted: 0 });
  const conversation = "19:general@thread.tacv2;messageid=1700000000000";
  await post(channel, activity("just chatting", { conversation, type: "channel" }), token());
  await delay(80);
  assert.equal(context.provider.requests.length, asked, "its own message, an event and an unaddressed channel line are left alone");
  const mention = [{ type: "mention", text: "<at>Branch</at>", mentioned: { id: "28:bot", name: "Branch" } }];
  await post(channel, activity("<at>Branch</at> summarise please", { conversation, type: "channel", entities: mention }), token());
  await until(() => service.calls.some((c) => c.path.startsWith(`/v3/conversations/${encodeURIComponent(conversation)}/activities/`)
    && /\] summarise please$/.test(c.json.text)), "answered in the channel thread without the mention");
  await assertNoSecret(context, [TEAMS_PASSWORD, TEAMS_CONNECTOR]);
});

test("Teams bot: expired, foreign, forged, missing and misdirected tokens are all refused", async (t) => {
  const context = await fixture(t);
  const { service, claims, activity } = await teamsSetup(t);
  const channel = teamsChannel(service.base);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const body = activity("let me in");
  const withToken = (token) => post(channel, body, { authorization: `Bearer ${token}` });
  const now = Math.floor(Date.now() / 1000);
  // The keys are fetched by the first attempt; the calls made after that must be none.
  await assert.rejects(() => withToken(rs256(claims({ exp: now - 3600 }))), /expired/);
  await refusedPosts(context, service, [
    ["an expired token", () => withToken(rs256(claims({ exp: now - 3600, nbf: now - 7200 })))],
    ["a token not valid yet", () => withToken(rs256(claims({ nbf: now + 3600 })))],
    ["another bot's token", () => withToken(rs256(claims({ aud: "someone-else" })))],
    ["a token from another issuer", () => withToken(rs256(claims({ iss: "https://sts.windows.net/evil/" })))],
    ["a forged signature", () => withToken(rs256(claims(), otherKey))],
    ["a token for another service address", () => withToken(rs256(claims({ serviceUrl: "https://smba.trafficmanager.net/emea/" })))],
    ["an unsigned token", () => withToken(`${b64({ alg: "none", kid: "k1" })}.${b64(claims())}.x`)],
    ["no token", () => post(channel, body)],
    ["a service address that is not Microsoft's", () => post(channel, activity("hi", { serviceUrl: "https://evil.example.org/" }),
      { authorization: `Bearer ${rs256(claims({ serviceUrl: "https://evil.example.org/" }))}` })],
  ]);
  assert.ok(!service.calls.some((c) => c.path.endsWith("/token")), "no sign-in was attempted for a refused post");
  await assertNoSecret(context, [TEAMS_PASSWORD]);
});

test("Teams bot: pairing off refuses a stranger, and a refused app password is reported plainly", async (t) => {
  const context = await fixture(t);
  const { service, claims, activity, sent } = await teamsSetup(t);
  const channel = teamsChannel(service.base);
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  await refusalWalk(context, { label: "Teams", sent,
    say: (text) => post(channel, activity(text, { from: "29:mallory" }), { authorization: `Bearer ${rs256(claims())}` }) });
  const wrong = teamsChannel(service.base, "wrong-password");
  await wrong.start(async () => undefined);
  await post(wrong, activity("hello"), { authorization: `Bearer ${rs256(claims())}` });
  await assert.rejects(() => wrong.send("a:personal-chat-1", "hi"), (error) => !error.message.includes("wrong-password"));
  assert.equal(wrong.health().state, "needs attention");
  assert.match(wrong.health().reason, /MSTEAMS_APP_PASSWORD/);
  await assertNoSecret(context, [TEAMS_PASSWORD, TEAMS_CONNECTOR]);
});

test("Teams bot: only Microsoft's service hosts are written to, unless the owner names another", () => {
  for (const good of ["https://smba.trafficmanager.net/amer/", "https://europe.smba.trafficmanager.net/", "https://token.botframework.com/",
    "https://smba.infra.gov.teams.microsoft.us.botframework.us/", "https://canary.teams.microsoft.com/"])
    assert.equal(allowedServiceUrl(good, []), true, good);
  for (const bad of ["http://smba.trafficmanager.net/", "https://botframework.com.evil.org/", "https://evil.org/?x=.botframework.com", "not a url"])
    assert.equal(allowedServiceUrl(bad, []), false, bad);
  assert.equal(allowedServiceUrl("http://127.0.0.1:8080/", ["127.0.0.1"]), true);
});

// ---------------------------------------------------------------- Settings and the network check

test("each posted service takes secret names only, refuses unknown settings, and checks its hosts before anything is opened", async () => {
  const kinds = ["msteams-bot", "webex", "synology-chat", "zalo", "flock", "pumble"];
  for (const kind of kinds) {
    const service = parityServices.find((s) => s.kind === kind);
    assert.ok(service, `${kind} is listed`);
    assert.equal(service.receives, "posted");
    for (const [key, field] of Object.entries(service.settings.shape)) {
      if (!key.endsWith("Secret")) continue;
      const fallback = field.parse(undefined);
      assert.match(fallback, secretName, `${kind}.${key} defaults to a secret name`);
      assert.equal(field.safeParse("sk-live-abc123").success, false, `${kind}.${key} refuses a raw token`);
    }
  }
  const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  const cases = [
    [{ type: "msteams-bot", appId: APP_ID }, "login.botframework.com"],
    [{ type: "webex" }, "webexapis.com"],
    [{ type: "synology-chat" }, "nas.example.org"],
    [{ type: "zalo", appId: ZALO_APP }, "openapi.zalo.me"],
    [{ type: "flock" }, "api.flock.co"],
    [{ type: "pumble", botUserId: "BOT1" }, "api-ga.pumble.com"],
  ];
  const credential = async (name) => (name === "SYNOLOGY_CHAT_INCOMING_URL" ? `https://nas.example.org:5001/webapi/entry.cgi?token=${SYNO_URL_TOKEN}` : "x");
  for (const [config, host] of cases) {
    await assert.rejects(() => buildParityChannel({ id: "c", ...config, ...policy }, { credential, policy: blocked }),
      (error) => error.message === `Not allowed: ${host}` && !error.message.includes(SYNO_URL_TOKEN), `${config.type} checks ${host}`);
    await assert.rejects(() => buildParityChannel({ id: "c", ...config, colour: "red", ...policy }, { credential }), /colour|Unrecognized/i);
  }
  await assert.rejects(() => buildParityChannel({ id: "c", type: "pumble", ...policy }, { credential }), /botUserId/, "Pumble needs the bot's id");
  const built = await buildParityChannel({ id: "teams", type: "msteams-bot", appId: APP_ID, ...policy }, { credential: async () => TEAMS_PASSWORD });
  assert.equal(built.kind, "msteams-bot");
  assert.equal(built.health().state, "needs attention", "a new service starts switched off");
});
