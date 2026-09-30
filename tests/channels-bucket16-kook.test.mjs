import test from "node:test";
import assert from "node:assert/strict";
import { saveReplyStyle } from "../dist/channels/reply-style.js";
import {
  fixture, until, delay, assertNoSecret, httpService, socketService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { KookChannel } from "../dist/channels/kook.js";
import { buildParityChannel, paritySummary } from "../dist/channels/parity-config.js";

/**
 * mac6/bucket-16: KOOK through its official bot API, against stand-ins that answer the way
 * developer.kookapp.cn describes. Nothing real is contacted.
 */
const KOOK_TOKEN = "SECRET-KOOK-BOT-TOKEN-61";
const GATEWAY_KEY = "SECRET-KOOK-GATEWAY-KEY-62";
const policy = { activation: "mention", pairing: true, allowlist: [] };

async function kookWorld(t, { token = KOOK_TOKEN, gatewayHost = "127.0.0.1", hello = { code: 0, session_id: "sess-1" } } = {}) {
  const events = await socketService(t, (connection) => {
    connection.onMessage = (value) => { if (value.s === 2 && world.pong) connection.send({ s: 3 }); };
    connection.send({ s: 1, d: hello });
  });
  const posts = [];
  const api = await httpService(t, (call) => {
    if (call.headers.authorization !== `Bot ${token}`) return { status: 401, body: { code: 401, message: "unauthorized" } };
    if (call.path === "/api/v3/user/me") return { body: { code: 0, data: { id: "BOT1", username: "Branch" } } };
    if (call.path === "/api/v3/gateway/index") {
      const port = new URL(events.url).port;
      return { body: { code: 0, data: { url: `ws://${gatewayHost}:${port}/gateway?compress=0&token=${GATEWAY_KEY}` } } };
    }
    if (call.method === "POST" && /^\/api\/v3\/(message|direct-message)\/create$/.test(call.path)) {
      posts.push(call);
      return { body: { code: 0, data: { msg_id: `out-${posts.length}` } } };
    }
    return undefined;
  });
  let sn = 0;
  const world = { events, api, posts, pong: true,
    say: (link, d) => link.send({ s: 0, sn: ++sn, d: { type: 1, msg_id: `m-${sn}`, author_id: "U7", extra: { author: { username: "carol" } }, ...d } }),
    replay: (link, number, d) => link.send({ s: 0, sn: number, d: { type: 1, msg_id: `m-${number}`, author_id: "U7", ...d } }),
    channel: (extra = {}) => new KookChannel({ id: "kook", token: KOOK_TOKEN, apiBase: `${api.base}/api/v3`, retryBaseMs: 20, ...extra }),
  };
  return world;
}
const dm = (content) => ({ channel_type: "PERSON", target_id: "BOT1", content });
const sentTexts = (world) => () => world.posts.map((c) => c.json.content);

test("KOOK: a Bot token, a gateway on its own host, a direct message pairs, and the answer goes back as plain text", async (t) => {
  const context = await fixture(t);
  const world = await kookWorld(t);
  const channel = world.channel();
  await context.app.channels.attach(channel, policy);
  saveReplyStyle(context.app.store, context.app.runtime.owner, { channel: "kook", quote: "first" }, ["kook"]); // A one-to-one answer quotes only when needed (reply-style.ts); "first" checks this app's quote on the wire.
  t.after(() => channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  assert.match(link.path, /compress=0/);
  assert.ok(!/resume=1/.test(link.path), "the first connection is a fresh session");
  await until(() => channel.health().state === "connected", "hello");
  await pairingWalk(context, { label: "KOOK", sent: sentTexts(world), say: async (text) => world.say(link, dm(text)) });
  const reply = world.posts.at(-1);
  assert.equal(reply.path, "/api/v3/direct-message/create");
  assert.equal(reply.json.type, 1, "plain text, never KMarkdown");
  assert.equal(reply.json.target_id, "U7");
  assert.match(reply.json.quote, /^m-\d+$/);
  await assertNoSecret(context, [KOOK_TOKEN, GATEWAY_KEY]);
});

test("KOOK: in a channel only a mention is answered, its own and bot messages never are, and repeats are dropped", async (t) => {
  const context = await fixture(t);
  const world = await kookWorld(t);
  const channel = world.channel();
  await context.app.channels.attach(channel, { ...policy, pairing: false, allowlist: ["kook:U7"] });
  t.after(() => channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  await until(() => channel.health().state === "connected", "hello");
  const group = (content, extra = {}) => ({ channel_type: "GROUP", target_id: "CH9", content, ...extra });
  world.say(link, group("just chatting"));
  world.say(link, group("(met)BOT1(met) my own words", { author_id: "BOT1", extra: { mention: ["BOT1"] } }));
  world.say(link, group("(met)BOT1(met) from another bot", { extra: { mention: ["BOT1"], author: { bot: true } } }));
  await delay(120);
  assert.equal(context.provider.requests.length, 0);
  world.say(link, group("(met)BOT1(met) summarise please", { extra: { mention: ["BOT1"] } }));
  await until(() => world.posts.some((c) => c.path === "/api/v3/message/create" && c.json.target_id === "CH9" && /summarise please/.test(c.json.content)), "answered in the channel");
  assert.ok(!/\(met\)/.test(context.provider.requests.at(-1).messages.at(-1).content), "the mention is taken out");
  world.replay(link, 4, group("(met)BOT1(met) summarise please", { extra: { mention: ["BOT1"] } }));
  await delay(120);
  assert.equal(context.provider.requests.length, 1, "a number already handled is not answered again");
});

test("KOOK: pings carry the last number, a missing pong reconnects with resume, and a restart resumes the saved session", async (t) => {
  const context = await fixture(t);
  const world = await kookWorld(t);
  const saved = { value: null, load: () => saved.value, save: (value) => { saved.value = value; } };
  // The pong budget must outlast a stall of the whole process. At 40ms, answering "first" (a task
  // written to the database) held the event loop long enough that the next beat found the pong still
  // unread and closed the socket before any ping carried number 1 (CI run 35446096639, and 9 of 75
  // runs here on a loaded machine). A second asks the same questions with room for that stall.
  const channel = world.channel({ heartbeatMs: 30, pongWaitMs: 1000 });
  channel.catchUp = saved;
  await context.app.channels.attach(channel, { ...policy, pairing: false, allowlist: ["kook:U7"] });
  const link = await until(() => world.events.connections[0], "a socket");
  await until(() => channel.health().state === "connected", "hello");
  world.say(link, dm("first"));
  await until(() => saved.value === "sess-1:1", "session and number saved once answered");
  await until(() => link.received.some((m) => m.s === 2 && m.sn === 1), "a ping with the last number");
  world.pong = false;
  const again = await until(() => world.events.connections[1], "reconnected after the missing pong");
  assert.match(again.path, /resume=1/);
  assert.match(again.path, /sn=1/);
  assert.match(again.path, /session_id=sess-1/);
  world.pong = true;
  await context.app.channels.detachAll();
  const before = world.events.connections.length;
  const restarted = world.channel();
  restarted.catchUp = saved;
  await context.app.channels.attach(restarted, { ...policy, pairing: false, allowlist: ["kook:U7"] });
  t.after(() => restarted.stop());
  const third = await until(() => world.events.connections[before], "a socket after the restart");
  assert.match(third.path, /resume=1/);
  assert.match(third.path, /sn=1&session_id=sess-1/);
  world.replay(third, 1, dm("first"));
  world.replay(third, 2, dm("sent while closed"));
  await until(() => world.posts.some((c) => /sent while closed/.test(c.json.content)), "the missed message is answered");
  await delay(80);
  assert.equal(world.posts.filter((c) => /Echo: .*first/.test(c.json.content)).length, 1, "the one already answered is not answered again");
});

test("KOOK: signal 5 starts a fresh session, a foreign gateway is not followed, and a bad token is said plainly", async (t) => {
  const context = await fixture(t);
  const world = await kookWorld(t);
  const channel = world.channel();
  await context.app.channels.attach(channel, { ...policy, pairing: false });
  t.after(() => channel.stop());
  const link = await until(() => world.events.connections[0], "a socket");
  await until(() => channel.health().state === "connected", "hello");
  await refusalWalk(context, { label: "KOOK", sent: sentTexts(world), say: async (text) => world.say(link, dm(text)) });
  link.send({ s: 5, d: { code: 41008, err: "missing params" } });
  const fresh = await until(() => world.events.connections[1], "a new connection");
  assert.ok(!/resume=1/.test(fresh.path), "signal 5 forgets the session");

  const foreign = await kookWorld(t, { gatewayHost: "localhost" });
  const lured = foreign.channel();
  await lured.start(async () => undefined);
  t.after(() => lured.stop());
  await until(() => /not KOOK's/.test(lured.health().reason ?? ""), "the foreign gateway is refused");
  assert.equal(foreign.events.connections.length, 0);

  const wrong = await kookWorld(t, { token: "a-different-token" });
  const refused = wrong.channel();
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /KOOK_BOT_TOKEN/);
  await assert.rejects(() => refused.send("u:7", "hi"), (error) => !error.message.includes(KOOK_TOKEN) && /KOOK refused/.test(error.message));

  const expired = await kookWorld(t, { hello: { code: 40103 } });
  const stale = expired.channel();
  await stale.start(async () => undefined);
  t.after(() => stale.stop());
  await until(() => stale.health().state === "needs attention", "an expired token in the hello is reported");
});

test("KOOK: built from the connections file with a secret name, checked against KOOK's host, and off until switched on", async (t) => {
  const context = await fixture(t);
  const base = { type: "kook", id: "kook", ...policy };
  const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  await assert.rejects(() => buildParityChannel(base, { credential: async () => "x", policy: blocked }), /Not allowed: www\.kookapp\.cn/);
  await assert.rejects(() => buildParityChannel({ ...base, tokenSecret: "1/raw-token.value" }, { credential: async () => "x" }));
  await assert.rejects(() => buildParityChannel({ ...base, token: "raw" }, { credential: async () => "x" }), /token|Unrecognized/i);
  const asked = [];
  const built = await buildParityChannel(base, { credential: async (name) => { asked.push(name); return "x"; },
    store: context.app.store, owner: context.app.runtime.owner });
  assert.deepEqual(asked, ["KOOK_BOT_TOKEN"]);
  assert.equal(built.kind, "kook");
  assert.equal(built.health().state, "needs attention");
  assert.ok(built.inner.catchUp, "KOOK is handed a saved place");
  const card = (await paritySummary(context.app.store, context.app.runtime.owner)).find((s) => s.kind === "kook");
  assert.equal(card.switch, "off");
  assert.equal(card.receives, "socket");
});

/**
 * A channel asked to stop while it is part-way through opening its next socket used to wait for
 * that socket to close for ever: `stop()` had already looked at `this.socket` and found nothing,
 * and the loop went on to `await socket.closed` with nobody left to close it. Shutting the app
 * down then never finished. The socket a stopping channel opens is closed as soon as it arrives.
 */
test("KOOK: stopping while the next socket is still being opened comes back", async (t) => {
  const context = await fixture(t);
  const world = await kookWorld(t);
  let arrive = () => undefined;
  const opening = new Promise((resolve) => { arrive = resolve; });
  let asked = 0, closes = 0;
  const connect = async () => {
    asked++;
    await opening;
    let shut = () => undefined;
    const closed = new Promise((resolve) => { shut = resolve; });
    return { send: () => undefined, close: () => { closes++; shut(); }, closed };
  };
  const channel = world.channel({ connect });
  await context.app.channels.attach(channel, { ...policy, pairing: false, allowlist: ["kook:U7"] });
  await until(() => asked === 1, "the socket is being opened");
  const stopped = channel.stop();
  arrive();
  await Promise.race([stopped, delay(3000).then(() => assert.fail("stop() never came back"))]);
  assert.equal(closes, 1, "the socket that arrived after the stop is closed, not left open");
});
