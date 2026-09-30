import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createBranch, WebhookChatAdapter, MetaMessagingAdapter, MatrixAdapter, SignalAdapter,
  channelEntry, channelEntries, channelCatalog, sign, metaSignature, signalCliInstalled,
  renderChannelTable, currentChannelTable, replaceChannelTable, broadcast, digest,
  ChannelConnectors, fillFrom, readPath, Budget,
} from "../dist/index.js";
import { readFile } from "node:fs/promises";
import { discardTemp } from "./temp-dir.mjs";
import { startServer } from "../dist/server.js";

/** Values that must never turn up anywhere a person or another service can see them. */
const SECRET = "SHARED-SECRET-VALUE-0123";
const TOKEN = "SERVICE-ACCESS-TOKEN-4567";
const TEAMS_KEY = Buffer.from("teams-signing-key-value").toString("base64");
const BOT = "branch";

async function until(check, label) {
  for (let i = 0; i < 400; i++) { const value = check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}
function scripted() {
  const provider = { name: "scripted", requests: [], reply: (last) => `Echo: ${last}`, async complete(request) {
    provider.requests.push(request);
    return { content: provider.reply(request.messages.at(-1).content), toolCalls: [] };
  } };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-channels-2-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
/** A server that records every request and answers everything with one harmless JSON body. */
async function chatService(t) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    const type = String(request.headers["content-type"] ?? "");
    const call = { path: request.url, headers: request.headers, raw };
    if (type.includes("json")) call.body = raw ? JSON.parse(raw) : {};
    else call.form = Object.fromEntries(new URLSearchParams(raw));
    calls.push(call);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, id: "sent-1", name: "spaces/S/messages/M", message_token: 991 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, base: `http://127.0.0.1:${server.address().port}` };
}
const body = (value) => Buffer.from(JSON.stringify(value), "utf8");

/**
 * One row per service in `data/channels.json`: how to set the connection up against a fake, what a
 * post from that service looks like, and how it proves it is genuine. Nothing here is service
 * knowledge the adapter has — the adapter reads all of that out of the catalog.
 */
const table = [
  {
    id: "mattermost", group: true,
    options: (base) => ({ webhookUrl: `${base}/hooks/abc`, secret: SECRET, botName: BOT }),
    post: ({ text, sender, chat }) => ({ token: SECRET, post_id: "p1", channel_id: chat, channel_name: "town-square", user_id: sender, user_name: "alice", text }),
    headers: () => ({}),
    breaks: (post) => ({ ...post, token: "WRONG-TOKEN-VALUE-0000" }),
    sentText: (call) => call.body.text,
  },
  {
    id: "rocketchat", group: true,
    options: (base) => ({ webhookUrl: `${base}/hooks/abc`, secret: SECRET, botName: BOT }),
    post: ({ text, sender, chat }) => ({ token: SECRET, message_id: "m1", channel_id: chat, channel_name: "general", user_id: sender, user_name: "alice", text }),
    headers: () => ({}),
    breaks: (post) => ({ ...post, token: "WRONG-TOKEN-VALUE-0000" }),
    sentText: (call) => call.body.text,
  },
  {
    id: "googlechat", group: true,
    options: (base) => ({ webhookUrl: `${base}/v1/spaces/S/messages`, secret: SECRET, botName: BOT }),
    post: ({ text, sender, chat, group }) => ({
      type: "MESSAGE", token: SECRET,
      space: { name: chat, type: group ? "ROOM" : "DM", displayName: "Team" },
      message: { name: `${chat}/messages/abc`, text, sender: { name: sender, displayName: "Alice" } },
    }),
    headers: () => ({}),
    breaks: (post) => ({ ...post, token: "WRONG-TOKEN-VALUE-0000" }),
    sentText: (call) => call.body.text,
  },
  {
    id: "msteams", group: true,
    options: (base) => ({ webhookUrl: `${base}/webhookb2/xyz`, secret: TEAMS_KEY, botName: BOT }),
    post: ({ text, sender, chat }) => ({ id: "m1", text, from: { id: sender, name: "Alice" }, conversation: { id: chat } }),
    headers: (raw) => ({ authorization: "HMAC " + sign({ algorithm: "sha256", encoding: "base64", signs: "body", keyEncoding: "base64" }, TEAMS_KEY, raw, "") }),
    breaks: null,
    badHeaders: () => ({ authorization: "HMAC 0000000000000000000000000000000000000000000=" }),
    sentText: (call) => call.body.text,
  },
  {
    id: "zulip", group: false,
    options: (base) => ({ apiBase: base, token: "Ym90OmtleQ==", secret: SECRET, botName: BOT }),
    post: ({ text, sender }) => ({ token: SECRET, bot_email: "bot@example.com",
      message: { id: 7, sender_email: sender, sender_full_name: "Alice", content: text, type: "private", display_recipient: "Alice" } }),
    headers: () => ({}),
    breaks: (post) => ({ ...post, token: "WRONG-TOKEN-VALUE-0000" }),
    sentText: (call) => call.form.content,
    chat: "alice@example.com", sender: "alice@example.com",
  },
  {
    id: "feishu", group: true,
    options: (base) => ({ webhookUrl: `${base}/open-apis/bot/v2/hook/abc`, secret: SECRET, botName: BOT }),
    post: ({ text, sender, chat, group }) => ({
      schema: "2.0", header: { event_id: "e1", token: SECRET, event_type: "im.message.receive_v1" },
      event: { message: { message_id: "om_1", chat_id: chat, chat_type: group ? "group" : "p2p", content: JSON.stringify({ text }) },
        sender: { sender_id: { open_id: sender } } },
    }),
    headers: () => ({}),
    breaks: (post) => ({ ...post, header: { ...post.header, token: "WRONG-TOKEN-VALUE-0000" } }),
    sentText: (call) => call.body.content.text,
  },
  {
    id: "dingtalk", group: true,
    options: (base) => ({ webhookUrl: `${base}/robot/send?access_token=abc`, secret: SECRET, botName: BOT }),
    post: ({ text, sender, chat, group }) => ({ msgtype: "text", msgId: "m1", conversationId: chat,
      conversationType: group ? "2" : "1", conversationTitle: "Team", senderId: sender, senderNick: "Alice", text: { content: text } }),
    headers: (raw) => {
      const timestamp = String(Date.now());
      return { timestamp, sign: sign({ algorithm: "sha256", encoding: "base64", signs: "timestamp-secret", keyEncoding: "utf8" }, SECRET, raw, timestamp) };
    },
    breaks: null,
    badHeaders: () => ({ timestamp: String(Date.now()), sign: "not-the-right-signature-at-all==" }),
    sentText: (call) => call.body.text.content,
  },
  {
    id: "line", group: true,
    options: (base) => ({ apiBase: base, token: TOKEN, secret: SECRET, botName: BOT }),
    post: ({ text, sender, chat, group }) => ({ destination: "U0", events: [{
      type: "message", timestamp: 1, message: { id: "m1", type: "text", text },
      source: group ? { type: "group", groupId: chat, userId: sender } : { type: "user", userId: sender },
    }] }),
    headers: (raw) => ({ "x-line-signature": sign({ algorithm: "sha256", encoding: "base64", signs: "body", keyEncoding: "utf8" }, SECRET, raw, "") }),
    breaks: null,
    badHeaders: () => ({ "x-line-signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }),
    sentText: (call) => call.body.messages[0].text,
  },
  {
    id: "viber", group: false,
    options: (base) => ({ apiBase: base, token: TOKEN, botName: BOT }),
    post: ({ text, sender }) => ({ event: "message", message_token: 12345, sender: { id: sender, name: "Alice" }, message: { type: "text", text } }),
    headers: (raw) => ({ "x-viber-content-signature": sign({ algorithm: "sha256", encoding: "hex", signs: "body", keyEncoding: "utf8" }, TOKEN, raw, "") }),
    breaks: null,
    badHeaders: () => ({ "x-viber-content-signature": "00".repeat(32) }),
    sentText: (call) => call.body.text,
  },
];

test("every service in the list is covered by this file, and the send-only one is declared as such", () => {
  const listed = channelEntries().map((entry) => entry.id).sort();
  const covered = [...table.map((row) => row.id), "wecom"].sort();
  assert.deepEqual(listed, covered, "data/channels.json and this test table describe the same services");
  assert.equal(channelEntry("wecom").receive, null, "a WeCom group robot cannot hand messages back");
});

for (const row of table) {
  const entry = channelEntry(row.id);
  test(`${entry.name}: a stranger pairs, an approved person is answered, a bad signature is refused, and a long reply is split`, async (t) => {
    const { app, provider } = await fixture(t);
    const service = await chatService(t);
    const adapter = new WebhookChatAdapter({ id: row.id, entry, ...row.options(service.base) });
    await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: [] });

    const chat = row.chat ?? "chat-1";
    const sender = row.sender ?? "user-9";
    const mention = entry.mention.replace("{{botName}}", BOT);
    const said = (words) => (row.group ? `${mention} ${words}` : words);
    const send = async (text, options = {}) => {
      const post = row.post({ text, sender, chat, group: row.group, ...options });
      const shaped = options.breaks && row.breaks ? row.breaks(post) : post;
      const raw = body(shaped);
      const headers = { ...row.headers(raw), ...(options.breaks && row.badHeaders ? row.badHeaders(raw) : {}) };
      return adapter.receive(raw, headers);
    };

    // An unknown sender is given a pairing code rather than being answered.
    await send(said("hello there"));
    const first = await until(() => service.calls[0], "pairing reply");
    const code = /\b(\d{6})\b/.exec(row.sentText(first));
    assert.ok(code, `a six-digit code was offered: ${row.sentText(first)}`);
    assert.equal(provider.requests.length, 0, "a stranger never reaches the model");

    // Once the owner approves the code, the same person is answered.
    app.channels.approve(app.runtime.owner, { code: code[1] });
    await send(said("what is the time"));
    const answered = await until(() => service.calls.find((call, index) => index > 0 && /Echo:/.test(row.sentText(call) ?? "")), "an answer");
    assert.match(row.sentText(answered), /what is the time/);

    // A post that does not prove it came from the service is refused and nothing inside it is read.
    const before = service.calls.length, asked = provider.requests.length;
    await assert.rejects(() => send(said("let me in"), { breaks: true }), (error) => {
      assert.ok(!error.message.includes(SECRET) && !error.message.includes(TOKEN) && !error.message.includes(TEAMS_KEY),
        "the refusal never repeats the secret back");
      return true;
    });
    await delay(80);
    assert.equal(service.calls.length, before, "nothing was sent in answer to a post that was not genuine");
    assert.equal(provider.requests.length, asked, "a post that was not genuine never reaches the model");

    // A long reply is split into pieces this service will accept.
    await app.channels.deliver(row.id, chat, "y".repeat(entry.maxTextLength * 2 + 50), `long:${row.id}`);
    const pieces = service.calls.slice(before).map((call) => row.sentText(call) ?? "").filter((text) => text.startsWith("y"));
    assert.ok(pieces.length >= 3, `a reply twice the limit becomes at least three pieces, got ${pieces.length}`);
    assert.ok(pieces.every((piece) => piece.length <= entry.maxTextLength), "no piece is over the service's limit");
    await adapter.stop();
  });
}

test("a group message that does not mention the assistant is left alone", async (t) => {
  const { app, provider } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "mattermost");
  const adapter = new WebhookChatAdapter({ id: "mattermost", entry: channelEntry("mattermost"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "mention", pairing: false, allowlist: ["user-9"] });
  await adapter.receive(body(row.post({ text: "just chatting among ourselves", sender: "user-9", chat: "c1", group: true })), {});
  await delay(150);
  assert.equal(service.calls.length, 0, "an unaddressed group message is not answered");
  assert.equal(provider.requests.length, 0);
  await adapter.receive(body(row.post({ text: `@${BOT} and now to you`, sender: "user-9", chat: "c1", group: true })), {});
  const reply = await until(() => service.calls[0], "reply once mentioned");
  assert.match(reply.body.text, /and now to you/);
  await adapter.stop();
});

test("Feishu echoes the word it is asked for once, and only when the shared word matches", async (t) => {
  const { app } = await fixture(t);
  const service = await chatService(t);
  const adapter = new WebhookChatAdapter({ id: "feishu", entry: channelEntry("feishu"), webhookUrl: `${service.base}/hook`, secret: SECRET });
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: [] });
  const good = await adapter.receive(body({ type: "url_verification", token: SECRET, challenge: "abc123" }), {});
  assert.equal(good.challenge, "abc123");
  await assert.rejects(() => adapter.receive(body({ type: "url_verification", token: "nope", challenge: "abc123" }), {}));
  await adapter.stop();
});

test("a WeCom group robot is posted to but cannot hand anything back", async (t) => {
  const { app } = await fixture(t);
  const service = await chatService(t);
  const adapter = new WebhookChatAdapter({ id: "wecom", entry: channelEntry("wecom"), webhookUrl: `${service.base}/cgi-bin/webhook/send?key=abc` });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: [] });
  await app.channels.deliver("wecom", "group-1", "the brief for today", "wecom:1");
  const sent = await until(() => service.calls[0], "sent");
  assert.equal(sent.body.text.content, "the brief for today");
  await assert.rejects(() => adapter.receive(body({ anything: true }), {}), /cannot hand messages back/);
  await adapter.stop();
});

test("DingTalk signs the address it posts to, and refuses a post whose timestamp is long past", async (t) => {
  const { app } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "dingtalk");
  const adapter = new WebhookChatAdapter({ id: "dingtalk", entry: channelEntry("dingtalk"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["user-9"] });
  await app.channels.deliver("dingtalk", "c1", "hello", "ding:1");
  const sent = await until(() => service.calls[0], "sent");
  const query = new URL(sent.path, "http://x").searchParams;
  assert.ok(query.get("sign"), "the address carries a signature");
  assert.ok(Number(query.get("timestamp")) > 0, "the address carries a timestamp");
  assert.ok(!sent.path.includes(SECRET), "the signing secret is never put in the address");

  const stale = String(Date.now() - 3600_000);
  const post = body(row.post({ text: "old news", sender: "user-9", chat: "c1", group: true }));
  const signature = sign({ algorithm: "sha256", encoding: "base64", signs: "timestamp-secret", keyEncoding: "utf8" }, SECRET, post, stale);
  await assert.rejects(() => adapter.receive(post, { timestamp: stale, sign: signature }), /too old/);
  await adapter.stop();
});

test("the chat address refuses a post that is not genuine, writes the refusal down, and never shows a secret", async (t) => {
  const { app, root } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "line");
  const adapter = new WebhookChatAdapter({ id: "line", entry: channelEntry("line"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["user-9"] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());

  const post = JSON.stringify(row.post({ text: "hello from outside", sender: "user-9", chat: "user-9", group: false }));
  // mac7/channel-leaks: the service's own words, and the row in the record, are for a caller who
  // showed the word on the end of the address. That is the whole address the owner pastes in.
  const { webhookSecret } = await import("../dist/channels/webhook-address.js");
  const word = webhookSecret(app.store, app.runtime.owner, "line");
  const refused = await fetch(`${server.url}/webhooks/chat/line/${word}`, {
    method: "POST", headers: { "content-type": "application/json", "x-line-signature": "AAAA" }, body: post,
  });
  assert.equal(refused.status, 401);
  const written = app.store.auditEntries
    ? app.store.auditEntries(app.runtime.owner)
    : await fetch(`${server.url}/api/audit`, { headers: { authorization: "Bearer " + server.token, origin: server.url } }).then((r) => r.json());
  const text = JSON.stringify(written);
  assert.match(text, /webhooks\/chat\/line/, "the refusal is in the record of what was allowed");
  assert.match(text, /auth\.refused/);

  const good = await fetch(`${server.url}/webhooks/chat/line/${word}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": sign({ algorithm: "sha256", encoding: "base64", signs: "body", keyEncoding: "utf8" }, SECRET, Buffer.from(post, "utf8"), "") },
    body: post,
  });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { accepted: 1 });


  const shown = await fetch(`${server.url}/api/channels`, { headers: { authorization: "Bearer " + server.token, origin: server.url } }).then((r) => r.text());
  assert.ok(!shown.includes(SECRET) && !shown.includes(TOKEN), "no secret is in what the app shows");
  assert.match(shown, /"kind":"line"/);

  // The Connections card lists the services from this same data rather than from hand-written text.
  const listed = await fetch(`${server.url}/api/channels/catalog`, { headers: { authorization: "Bearer " + server.token, origin: server.url } }).then((r) => r.json());
  assert.deepEqual(listed.services.map((service) => service.id), channelEntries().map((service) => service.id));
  assert.equal(listed.services.find((service) => service.id === "wecom").canReceive, false);
  assert.ok(listed.services.every((service) => service.needs.length > 0 && service.docs.startsWith("https://")));
  assert.ok(!JSON.stringify(listed).includes("{{"), "no template is shown to the owner");

  // Nothing here carries the session key, so somewhere posting rubbish over and over is made to
  // wait rather than being allowed to fill the record of refusals.
  const tryBadly = () => fetch(`${server.url}/webhooks/chat/line/${word}`, {
    method: "POST", headers: { "content-type": "application/json", "x-line-signature": "AAAA" }, body: post,
  });
  const codes = [];
  for (let attempt = 0; attempt < 6; attempt++) codes.push((await tryBadly()).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429, "a place that keeps posting rubbish is made to wait");

  // mac7/channel-leaks: the old shape of address, which anybody can guess, gets one sentence and
  // leaves nothing behind in the owner's record. Counted on its own limiter, which is now waiting,
  // so this is checked on a second launch.
  const second = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => second.close());
  const rows = JSON.stringify(app.store.auditEntries?.(app.runtime.owner) ?? []).length;
  const guessed = await fetch(`${second.url}/webhooks/chat/line`, {
    method: "POST", headers: { "content-type": "application/json", "x-line-signature": "AAAA" }, body: post,
  });
  assert.equal(guessed.status, 404);
  assert.match((await guessed.json()).error, /No chat service is connected at that address/);
  assert.equal(JSON.stringify(app.store.auditEntries?.(app.runtime.owner) ?? []).length, rows,
    "a caller who never showed the word cannot fill the owner's record");
  await adapter.stop();
});

/** Messenger and Instagram are the same code with different words, so both are put through the same steps. */
for (const service of ["messenger", "instagram"]) {
  test(`${service}: shares WhatsApp's signature and address check, pairs a stranger, and says it needs Meta's review`, async (t) => {
    const { app, provider } = await fixture(t);
    const api = await chatService(t);
    const adapter = new MetaMessagingAdapter({ id: service, service, pageId: "page-1",
      token: TOKEN, verifyToken: "VERIFY-WORD", appSecret: SECRET, apiBase: api.base });
    await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: [] });
    assert.equal(adapter.needsAppReview, true);
    assert.match(adapter.health().reason, /review/);

    // Meta checks the address once, and will not take a word that does not match.
    assert.equal(adapter.verify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "VERIFY-WORD", "hub.challenge": "99" })), "99");
    assert.throws(() => adapter.verify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "no", "hub.challenge": "99" })));

    const post = (text) => body({ object: service === "instagram" ? "instagram" : "page",
      entry: [{ id: "page-1", messaging: [{ sender: { id: "u-1" }, recipient: { id: "page-1" }, message: { mid: `mid-${text.length}`, text } }] }] });

    // A post that is not signed is refused and never reaches the model.
    const unsigned = post("let me in");
    await assert.rejects(() => adapter.receive(unsigned, "sha256=deadbeef"), /not signed by/);
    assert.equal(provider.requests.length, 0);
    assert.equal(api.calls.length, 0);

    // An unknown sender is given a pairing code; once approved, the same person is answered.
    const first = post("are you there");
    await adapter.receive(first, metaSignature(first, SECRET));
    const offered = await until(() => api.calls[0], "pairing reply");
    assert.equal(offered.path, "/page-1/messages");
    assert.equal(offered.body.recipient.id, "u-1");
    const code = /\b(\d{6})\b/.exec(offered.body.message.text);
    assert.ok(code, `a six-digit code was offered: ${offered.body.message.text}`);
    assert.equal(provider.requests.length, 0, "a stranger never reaches the model");

    app.channels.approve(app.runtime.owner, { code: code[1] });
    const second = post("what is the time");
    await adapter.receive(second, metaSignature(second, SECRET));
    const answered = await until(() => api.calls.find((call, index) => index > 0 && /Echo:/.test(call.body.message.text ?? "")), "an answer");
    assert.match(answered.body.message.text, /what is the time/);
    assert.equal(answered.headers.authorization, `Bearer ${TOKEN}`);

    // The page's own posts come back down the same address and must not be answered.
    const echo = body({ object: service, entry: [{ id: "page-1", messaging: [{ sender: { id: "page-1" }, message: { mid: "m2", text: "our own post", is_echo: true } }] }] });
    assert.deepEqual(await adapter.receive(echo, metaSignature(echo, SECRET)), { accepted: 0 });

    // A long reply is split to what Meta accepts.
    const before = api.calls.length;
    await app.channels.deliver(service, "u-1", "z".repeat(adapter.maxTextLength * 2 + 50), `long:${service}`);
    const pieces = api.calls.slice(before).map((call) => call.body.message.text).filter((text) => text.startsWith("z"));
    assert.ok(pieces.length >= 3 && pieces.every((piece) => piece.length <= adapter.maxTextLength));
    await adapter.stop();
  });
}

test("Matrix holds a request open, retries with a widening wait, and stops when the channel closes", async (t) => {
  const { app, provider } = await fixture(t);
  const syncs = [];
  const sends = [];
  const typing = [];
  let failNext = true;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    if (request.url.startsWith("/_matrix/client/v3/sync")) {
      syncs.push(request.url);
      if (failNext) { failNext = false; response.writeHead(502); response.end("{}"); return; }
      response.writeHead(200, { "content-type": "application/json" });
      const events = syncs.length === 2 ? [] : [{ type: "m.room.message", event_id: "$1", sender: "@alice:example.org", content: { msgtype: "m.text", body: "@branch:example.org are you awake" } },
        { type: "m.room.encrypted", event_id: "$2", sender: "@alice:example.org", content: {} }];
      response.end(JSON.stringify({ next_batch: `s${syncs.length}`, rooms: { join: { "!room:example.org": { timeline: { events } } } } }));
      return;
    }
    // "typing…" goes to its own address; everything else here is a message sent to the room.
    (request.url.includes("/typing/") ? typing : sends).push({ path: request.url, body: JSON.parse(raw), headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url.includes("/typing/") ? {} : { event_id: "$sent" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: `http://127.0.0.1:${server.address().port}`,
    userId: "@branch:example.org", accessToken: TOKEN, syncTimeoutMs: 50, reconnectBaseMs: 5 });
  app.channels.setSwitches({ liveStatus: "on" });
  await app.channels.attach(adapter, { activation: "mention", pairing: false, allowlist: ["@alice:example.org"] });

  await until(() => adapter.health().state === "reconnecting" || syncs.length > 1, "the first failure is retried");
  const sent = await until(() => sends.find(({ path }) => path.includes('/send/m.room.message/')), "an answer in the room");
  assert.match(sent.path, /^\/_matrix\/client\/v3\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\//);
  assert.match(sent.body.body, /are you awake/);
  assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.body.msgtype, "m.text");
  assert.ok(provider.requests.length >= 1);
  // While it worked, the room was shown "typing…" as the bot itself, with the same token.
  assert.ok(typing.length >= 1, "typing was shown while the answer was written");
  assert.equal(typing[0].path, "/_matrix/client/v3/rooms/!room%3Aexample.org/typing/%40branch%3Aexample.org");
  assert.deepEqual(typing[0].body, { typing: true, timeout: 6000 });
  assert.equal(typing[0].headers.authorization, `Bearer ${TOKEN}`);
  await until(() => /encrypted room/.test(adapter.health().reason ?? ""), "encrypted messages are reported, not read");

  const before = syncs.length;
  await adapter.stop();
  await delay(200);
  assert.ok(syncs.length <= before + 1, "closing the channel stops the loop");
});

test("Signal refuses to start when signal-cli is not installed, and drives it over stdio when it is", async (t) => {
  const { app } = await fixture(t);
  const missing = new SignalAdapter({ id: "signal", path: "C:/nowhere/signal-cli", account: "+15550000000" });
  await assert.rejects(() => app.channels.attach(missing, { activation: "always", pairing: false, allowlist: [] }),
    /signal-cli/);
  assert.equal(missing.health().state, "needs attention");
  assert.equal(await signalCliInstalled("C:/nowhere/signal-cli"), false);

  // With the program present, messages come in on its output and go out on its input.
  const written = [];
  const stdout = new (await import("node:stream")).PassThrough();
  const fake = { stdout, stdin: { writable: true, write: (line) => written.push(JSON.parse(line)) }, on: () => undefined, kill: () => undefined };
  const adapter = new SignalAdapter({ id: "signal2", path: "anything", account: "+15550000000",
    exists: async () => true, spawnProcess: () => fake });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["+15551111111"] });
  stdout.write(JSON.stringify({ method: "receive", params: { envelope: { source: "+15551111111", sourceName: "Alice", timestamp: 17, dataMessage: { message: "hello signal" } } } }) + "\n");
  const reply = await until(() => written[0], "a reply written to signal-cli");
  assert.equal(reply.method, "send");
  assert.deepEqual(reply.params.recipient, ["+15551111111"]);
  assert.match(reply.params.message, /hello signal/);
  await adapter.stop();
});

test("a plugin may bring a chat service, which is registered, connected and delivers", async (t) => {
  const { app, root } = await fixture(t);
  const service = await chatService(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  // RES-251: a chat service lives inside Branch, so a plugin bringing one runs there only by the owner's own choice.
  app.addOns.save({ wallEveryPlugin: false, confirmLoosening: true });
  const folder = join(root, "data", "plugins");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "toy-chat.mjs"), `
    const sent = [];
    export default {
      id: "toy-chat", name: "Toy chat", permissions: [],
      channels: [{
        id: "plugin.channel.toy", name: "Toy chat service",
        create(setup) {
          return {
            id: setup.id, kind: "toy", maxTextLength: 100,
            botName: () => "toy",
            health: () => ({ state: "connected" }),
            async start(onMessage) { this.deliverTo = onMessage; },
            async stop() { this.deliverTo = null; },
            async send(chatId, text) {
              await setup.fetch(setup.settings.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, text }) });
              return "toy-1";
            },
          };
        },
      }],
    };
  `.trim());
  const summary = await app.plugins.enable("toy-chat");
  assert.equal(summary.id, "toy-chat");
  const brought = app.channelConnectors.list();
  assert.deepEqual(brought.map((entry) => entry.id), ["plugin.channel.toy"]);
  assert.equal(brought[0].plugin, "toy-chat");

  await app.channelConnectors.connect({ connector: "plugin.channel.toy", id: "toy", settings: { endpoint: `${service.base}/toy` }, pairing: false, allowlist: [] });
  await app.channels.deliver("toy", "room-1", "a message through a plugin", "toy:1");
  const sent = await until(() => service.calls[0], "the plugin sent it");
  assert.equal(sent.body.text, "a message through a plugin");
  assert.ok(app.channels.summary().channels.some((channel) => channel.id === "toy" && channel.kind === "toy"));

  // Switching the plugin off takes its service away again.
  app.plugins.disable("toy-chat");
  assert.deepEqual(app.channelConnectors.list(), []);
  await assert.rejects(() => app.channelConnectors.connect({ connector: "plugin.channel.toy", id: "toy2", settings: {} }), /No plugin has brought/);
});

test("one message reaches several chats at once, and quiet hours hold it until morning", async (t) => {
  const { app } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "mattermost");
  const adapter = new WebhookChatAdapter({ id: "mattermost", entry: channelEntry("mattermost"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["user-9"] });
  const result = await broadcast(app.channels, app.runtime.owner, {
    text: "the office is closed tomorrow",
    to: [{ channel: "mattermost", chatId: "c1" }, { channel: "mattermost", chatId: "c2" }],
  });
  assert.equal(result.chats, 2);
  assert.equal(result.failed.length, 0);
  await until(() => service.calls.length >= 2, "both chats were sent to");
  assert.deepEqual(service.calls.slice(0, 2).map((call) => call.body.channel_id).sort(), ["c1", "c2"]);

  // With quiet hours on, nothing goes out; the message waits with a time to try again.
  const morning = new Date(Date.now() + 3600_000).toISOString();
  app.channels.deliveries.holdUntil = () => morning;
  const before = service.calls.length;
  await broadcast(app.channels, app.runtime.owner, { text: "not until morning", to: [{ channel: "mattermost", chatId: "c1" }] });
  await delay(150);
  assert.equal(service.calls.length, before, "quiet hours hold the message");
  const waiting = app.channels.outstanding().find((delivery) => delivery.preview.startsWith("not until morning"));
  assert.ok(waiting && waiting.nextAt === morning, "it is waiting until quiet hours end");
  app.channels.deliveries.holdUntil = () => null;
  await adapter.stop();
});

test("the morning brief can be sent over any connected chat service", async (t) => {
  const { app } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "rocketchat");
  const adapter = new WebhookChatAdapter({ id: "rocketchat", entry: channelEntry("rocketchat"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: [] });
  const result = await digest(app.channels, app.brief, app.runtime.owner, { channel: "rocketchat", chatId: "c9" });
  assert.equal(result.channel, "rocketchat");
  const sent = await until(() => service.calls[0], "the brief went out");
  assert.match(sent.body.text, /Good morning/);
  assert.ok(result.characters > 20);
  await adapter.stop();
});

test("an outbound webhook is shaped by the owner, signed with a key from the locker, and can be tried out", async (t) => {
  const { app, root } = await fixture(t);
  const received = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    received.push({ headers: request.headers, raw });
    response.writeHead(200); response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}/hook`;
  await app.store.secrets.put(app.runtime.owner, "default", "HOOK_SIGNING_KEY", "locker-signing-key");
  app.web.policy.configure({ allowPrivateAddresses: true });

  const hook = app.webhooks.create(app.runtime.context(), {
    name: "shaped", url: address, secretName: "HOOK_SIGNING_KEY", events: ["run.completed", "webhook.test"],
    templates: { "run.completed": { kind: "{{event}}", who: "branch", task: "{{runId}}" } },
  });
  assert.equal(hook.secretName, "HOOK_SIGNING_KEY");

  // The shape editor shows what would be sent without sending anything.
  const preview = app.webhooks.preview(app.runtime.owner, hook.id, "run.completed", { runId: "r-1" });
  assert.deepEqual(preview.body, { kind: "run.completed", who: "branch", task: "r-1" });
  assert.deepEqual(preview.unfilled, []);
  assert.deepEqual(app.webhooks.preview(app.runtime.owner, hook.id, "run.completed", {}).unfilled, ["runId"]);

  app.webhooks.retryDelays = [];
  await app.webhooks.deliver(app.runtime.owner, hook.id, "run.completed", { runId: "r-9" });
  const delivered = await until(() => received[0], "the shaped event arrived");
  assert.deepEqual(JSON.parse(delivered.raw), { kind: "run.completed", who: "branch", task: "r-9" });
  const expected = "sha256=" + (await import("node:crypto")).createHmac("sha256", "locker-signing-key").update(delivered.raw).digest("hex");
  assert.equal(delivered.headers["x-branch-signature"], expected, "signed with the key named in the locker");

  // The "try this out" button sends one straight away and writes it into the log.
  const tried = await app.webhooks.test(app.runtime.owner, hook.id);
  assert.equal(tried.ok, true);
  const log = app.webhooks.getLog(hook.id, app.runtime.owner);
  assert.ok(log.some((line) => line.eventType === "webhook.test" && line.status === "success"), JSON.stringify(log));

  // A shape for an event the hook does not listen for is refused when it is saved.
  assert.throws(() => app.webhooks.create(app.runtime.context(), {
    name: "wrong", url: address, events: ["run.completed"], templates: { "run.failed": { a: "1" } },
  }), /does not listen for it/);
  void root;
});

test("a trigger with replay protection refuses a stale or repeated request", async (t) => {
  const { app, root } = await fixture(t);
  const trigger = app.triggers.create(app.runtime.context(), {
    name: "guarded", prompt: "Say {{payload}}", replayProtection: true, replayWindowSeconds: 60,
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const fire = (headers) => fetch(`${server.url}/api/triggers/${trigger.id}/fire`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${trigger.secret}`, ...headers },
    body: JSON.stringify({ hello: "world" }),
  });
  const stamp = String(Math.floor(Date.now() / 1000));
  assert.equal((await fire({})).status, 401, "no timestamp at all is refused");
  assert.equal((await fire({ "x-branch-timestamp": String(Math.floor(Date.now() / 1000) - 5000), "x-branch-nonce": "n0" })).status, 401, "a stale timestamp is refused");
  assert.equal((await fire({ "x-branch-timestamp": stamp, "x-branch-nonce": "n1" })).status, 200);
  assert.equal((await fire({ "x-branch-timestamp": stamp, "x-branch-nonce": "n1" })).status, 401, "the same nonce twice is refused");
  assert.equal((await fire({ "x-branch-timestamp": stamp, "x-branch-nonce": "n2" })).status, 200);

  // A trigger without it switched on keeps working exactly as before.
  const plain = app.triggers.create(app.runtime.context(), { name: "plain", prompt: "Say {{payload}}" });
  const answer = await fetch(`${server.url}/api/triggers/${plain.id}/fire`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${plain.secret}` },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(answer.status, 200);
});

test("the Connections table in the documentation is regenerated byte for byte", async () => {
  const docs = await readFile("docs/configuration.md", "utf8");
  assert.equal(currentChannelTable(docs), renderChannelTable(), "docs/configuration.md is out of date with data/channels.json");
  assert.equal(replaceChannelTable(docs), docs, "regenerating the table changes nothing else in the file");
  for (const entry of channelCatalog().services) {
    assert.match(currentChannelTable(docs), new RegExp(`\\(\`${entry.id}\`\\)`), `${entry.id} is in the table`);
    assert.ok(currentChannelTable(docs).includes(entry.docs), `${entry.id} links to its own documentation`);
  }
});

test("a shape kept as data is filled in and read back by dotted name", () => {
  assert.deepEqual(fillFrom({ a: "{{run.id}}", b: ["{{missing}}", "plain"] }, { run: { id: "r1" } }),
    { b: ["", "plain"], a: "r1" });
  assert.equal(readPath({ source: { groupId: "", userId: "u" } }, "source.groupId|source.userId"), "u");
  assert.equal(readPath({ events: [{ id: 3 }] }, "events.0.id"), 3);
});

test("a plugin chat service may not reach an address the network settings refuse", async (t) => {
  const { app } = await fixture(t);
  const connectors = new ChannelConnectors(app.channels, app.web.policy, async () => "", globalThis.fetch);
  connectors.register("toy", {
    id: "plugin.channel.blocked", name: "Blocked",
    create: (setup) => ({
      id: setup.id, kind: "blocked", botName: () => null, async start() {}, async stop() {},
      send: async () => { await setup.fetch("http://127.0.0.1:1/anything", { method: "POST" }); return undefined; },
    }),
  });
  await connectors.connect({ connector: "plugin.channel.blocked", id: "blocked", settings: {}, pairing: false });
  await app.channels.deliver("blocked", "c1", "hello", "blocked:1");
  const waiting = app.channels.outstanding().find((delivery) => delivery.channel === "blocked");
  assert.ok(waiting, "the message is held rather than sent");
  assert.match(waiting.lastError ?? "", /private|local address|not on the allowed list/,
    "the plugin could not reach an address the network settings refuse");
});

/**
 * A service that does not hear back quickly sends the same message again. These prove the second
 * copy is recognised and dropped, so nobody is answered twice, and that the check happens only
 * after the post has been proved genuine.
 */
test("a service that sends the same message twice is answered only once", async (t) => {
  const { app, provider } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "line");
  const adapter = new WebhookChatAdapter({ id: "line", entry: channelEntry("line"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["user-9"] });
  const raw = body(row.post({ text: "did you get that", sender: "user-9", chat: "c1", group: false }));
  const headers = row.headers(raw);
  assert.equal((await adapter.receive(raw, headers)).accepted, 1);
  await until(() => service.calls.length >= 1, "the first copy is answered");
  // The very same post again, exactly as the service would resend it.
  await adapter.receive(raw, headers);
  await delay(200);
  assert.equal(service.calls.length, 1, "the second copy is dropped rather than answered again");
  assert.equal(provider.requests.length, 1, "and it never reaches the model a second time");
  await adapter.stop();
});

test("Messenger drops a repeated post too", async (t) => {
  const { app, provider } = await fixture(t);
  const service = await chatService(t);
  const adapter = new MetaMessagingAdapter({ id: "messenger", service: "messenger", pageId: "page-1",
    token: TOKEN, verifyToken: SECRET, appSecret: SECRET, apiBase: service.base });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["psid-1"] });
  const raw = body({ object: "page", entry: [{ id: "page-1", messaging: [
    { sender: { id: "psid-1" }, recipient: { id: "page-1" }, message: { mid: "mid-1", text: "are you there" } }] }] });
  const signature = metaSignature(raw, SECRET);
  assert.equal((await adapter.receive(raw, signature)).accepted, 1);
  await until(() => service.calls.length >= 1, "the first copy is answered");
  await adapter.receive(raw, signature);
  await delay(200);
  assert.equal(service.calls.length, 1, "Meta's retry is not answered a second time");
  assert.equal(provider.requests.length, 1);
  await adapter.stop();
});

test("a first message on Matrix or Signal gets a pairing code and never reaches the model", async (t) => {
  const { app, provider } = await fixture(t);
  const sends = [];
  let served = 0;
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    if (request.url.startsWith("/_matrix/client/v3/sync")) {
      served++;
      response.writeHead(200, { "content-type": "application/json" });
      // The first answer is whatever was already in the room, which is never replied to, so the
      // stranger's first message comes on the one after it.
      const events = served === 2 ? [{ type: "m.room.message", event_id: "$1", sender: "@stranger:example.org",
        content: { msgtype: "m.text", body: "@branch:example.org hello" } }] : [];
      response.end(JSON.stringify({ next_batch: `s${served}`, rooms: { join: { "!room:example.org": { timeline: { events } } } } }));
      return;
    }
    sends.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ event_id: "$sent" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: `http://127.0.0.1:${server.address().port}`,
    userId: "@branch:example.org", accessToken: TOKEN, syncTimeoutMs: 30, reconnectBaseMs: 5 });
  await app.channels.attach(matrix, { activation: "always", pairing: true, allowlist: [] });
  const offered = await until(() => sends[0], "a pairing code on Matrix");
  assert.match(offered.body, /\b\d{6}\b/, "a stranger on Matrix is offered a code, not an answer");
  assert.equal(provider.requests.length, 0, "and never reaches the model");
  await matrix.stop();

  const written = [];
  const stdout = new (await import("node:stream")).PassThrough();
  const fake = { stdout, stdin: { writable: true, write: (line) => written.push(JSON.parse(line)) }, on: () => undefined, kill: () => undefined };
  const signal = new SignalAdapter({ id: "signal-pairing", path: "anything", account: "+15550000000",
    exists: async () => true, spawnProcess: () => fake });
  await app.channels.attach(signal, { activation: "always", pairing: true, allowlist: [] });
  stdout.write(JSON.stringify({ method: "receive", params: { envelope: { source: "+15552222222", sourceName: "Stranger",
    timestamp: 21, dataMessage: { message: "hello" } } } }) + "\n");
  const reply = await until(() => written[0], "a pairing code on Signal");
  assert.match(reply.params.message, /\b\d{6}\b/, "a stranger on Signal is offered a code, not an answer");
  assert.equal(provider.requests.length, 0);
  await signal.stop();
});

test("only the owner may send to their own chats", async (t) => {
  const { app } = await fixture(t);
  const service = await chatService(t);
  const row = table.find((candidate) => candidate.id === "mattermost");
  const adapter = new WebhookChatAdapter({ id: "mattermost", entry: channelEntry("mattermost"), ...row.options(service.base) });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: [] });
  const context = { owner: app.runtime.owner, workspace: ".", runId: "r1", signal: new AbortController().signal,
    budget: new Budget(), permissions: new Set(["channels.send"]), depth: 0 };
  // Somebody else sharing this computer, under their own profile with their own PIN.
  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  await assert.rejects(() => app.registry.execute("channels.broadcast", { text: "hello everyone" }, context), /owner/);
  await assert.rejects(() => app.registry.execute("channels.digest", { channel: "mattermost", chatId: "c1" }, context), /owner/);
  await delay(120);
  assert.equal(service.calls.length, 0, "nothing was sent to the owner's chats");
  // Back as the owner, the same call goes through.
  app.store.profiles.switch({ profileId: null });
  await app.registry.execute("channels.digest", { channel: "mattermost", chatId: "c1" }, context);
  await until(() => service.calls.length >= 1, "the owner's own brief goes out");
  await adapter.stop();
});
