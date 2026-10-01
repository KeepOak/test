import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, DiscordAdapter, SlackAdapter, WhatsAppAdapter, EmailAdapter,
  toMrkdwn, taggedEnd, parseFetched, sendMail, ImapClient, handle,
} from "../dist/index.js";
import { acceptKey, frame, readFrame } from "../dist/ws.js";
import { startServer } from "../dist/server.js";

const discordToken = "MTIz.SECRET-DISCORD-TOKEN";
const slackBotToken = "xoxb-SECRET-SLACK-BOT";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
const slackAppToken = "xapp-SECRET-SLACK-APP";
const whatsAppToken = "SECRET-WHATSAPP-GRAPH-TOKEN";
const whatsAppSecret = "SECRET-WHATSAPP-APP-SECRET";

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
  const root = await mkdtemp(join(tmpdir(), "branch-channels-more-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}

/**
 * A WebSocket server for the fakes: it completes the handshake with the pieces the real server
 * uses, then hands each connection to the caller as send/received/close.
 */
async function socketService(t, onConnect) {
  const connections = [];
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket) => {
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    let pending = Buffer.alloc(0);
    const connection = { received: [], send: (value) => socket.write(frame(JSON.stringify(value))),
      drop: () => socket.destroy(), socket };
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
        pending = pending.subarray(decoded.consumed);
        if (decoded.opcode === 0x1) {
          const message = JSON.parse(decoded.payload.toString("utf8"));
          connection.received.push(message);
          // As Discord does: every heartbeat is acknowledged, or the client takes the connection for dead.
          if (message.op === 1) connection.send({ op: 11 });
        }
        if (decoded.opcode === 0x8) socket.end();
      }
    });
    socket.on("error", () => undefined);
    connections.push(connection);
    onConnect?.(connection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { connections, url: `ws://127.0.0.1:${server.address().port}` };
}
/** A JSON HTTP server that records every request; `route` answers by path. */
async function jsonService(t, route) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    const call = { path: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : {} };
    calls.push(call);
    const answer = route(call) ?? { status: 404, body: { ok: false, error: "unknown_method" } };
    response.writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers });
    response.end(JSON.stringify(answer.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, base: `http://127.0.0.1:${server.address().port}` };
}

test("Discord: a mention is answered in 2000-character pieces, the token never leaks, and a dropped socket reconnects", async (t) => {
  const { app } = await fixture(t);
  const gateway = await socketService(t, (connection) => connection.send({ op: 10, d: { heartbeat_interval: 45000 } }));
  const rest = await jsonService(t, (call) => call.path.endsWith("/messages") ? { body: { id: "msg-" + Date.now() } } : null);
  const adapter = new DiscordAdapter({ id: "discord", token: discordToken, apiBase: rest.base,
    gatewayUrl: gateway.url, heartbeatMs: 30, reconnectBaseMs: 10 });
  app.channels.setSwitches({ liveStatus: "on" });
  await app.channels.attach(adapter, { activation: "mention", pairing: false, allowlist: ["9001"] });
  const first = await until(() => gateway.connections[0], "gateway connection");
  const identify = await until(() => first.received.find((message) => message.op === 2), "identify");
  assert.equal(identify.d.token, discordToken, "the bot token is sent to Discord itself");
  // GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT.
  assert.equal(identify.d.intents, (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15));
  first.send({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-1", username: "BranchBot" }, session_id: "sess-1", resume_gateway_url: gateway.url } });
  await until(() => adapter.botName() === "BranchBot", "ready");
  assert.deepEqual(adapter.health(), { state: "connected" });
  await until(() => first.received.some((message) => message.op === 1), "heartbeat");

  // An unaddressed message in a server channel is left alone; a mention is answered in the channel.
  first.send({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1", channel_id: "c1", guild_id: "g1",
    content: "just chatting", author: { id: "9001", username: "alice" }, mentions: [] } });
  await delay(200);
  assert.equal(rest.calls.length, 0, "no reply to an unaddressed channel message");
  first.send({ op: 0, s: 3, t: "MESSAGE_CREATE", d: { id: "m2", channel_id: "c1", guild_id: "g1",
    content: "<@bot-1> how are you", author: { id: "9001", username: "alice" }, mentions: [{ id: "bot-1" }] } });
  const posts = () => rest.calls.filter((call) => call.path.endsWith("/messages"));
  const reply = await until(() => posts()[0], "mentioned reply");
  assert.equal(reply.path, "/channels/c1/messages");
  // While it worked, the channel showed "typing…" and the question got a "seen" reaction, both as the bot.
  const typing = rest.calls.find((call) => call.path === "/channels/c1/typing");
  assert.equal(typing?.headers.authorization, `Bot ${discordToken}`);
  assert.ok(rest.calls.some((call) => call.path === `/channels/c1/messages/m2/reactions/${encodeURIComponent("👀")}/@me`),
    "the question was marked as seen");
  assert.match(reply.body.content, /^Echo: \[alice in channel c1\] how are you$/);
  assert.equal(reply.body.message_reference.message_id, "m2");
  assert.equal(reply.headers.authorization, `Bot ${discordToken}`);

  // A long answer is split into pieces Discord will accept.
  const { provider } = await (async () => ({ provider: app.runtime.models }))();
  void provider;
  await app.channels.deliver("discord", "c1", "x".repeat(4500), "long:1");
  const pieces = posts().slice(1).map((call) => call.body.content);
  assert.equal(pieces.length, 3, "4500 characters become three messages");
  assert.ok(pieces.every((piece) => piece.length <= 2000), "no piece is over Discord's limit");

  // A direct message is always addressed, and a drop reconnects and resumes.
  first.drop();
  const second = await until(() => gateway.connections[1], "reconnected");
  assert.equal(adapter.health().state, "reconnecting");
  second.send({ op: 10, d: { heartbeat_interval: 45000 } });
  const resume = await until(() => second.received.find((message) => message.op === 6), "resume");
  assert.equal(resume.d.session_id, "sess-1");
  second.send({ op: 0, s: 4, t: "READY", d: { user: { id: "bot-1", username: "BranchBot" }, session_id: "sess-1", resume_gateway_url: gateway.url } });
  const before = posts().length;
  second.send({ op: 0, s: 5, t: "MESSAGE_CREATE", d: { id: "m3", channel_id: "dm1",
    content: "are you back", author: { id: "9001", username: "alice" }, mentions: [] } });
  await until(() => posts().length > before, "reply after reconnect");
  assert.equal(posts().at(-1).body.content, "Echo: are you back");
  await adapter.stop();
});

test("Discord: a stranger is turned away and the token stays out of what the app shows", async (t) => {
  const { app, root, provider } = await fixture(t);
  const gateway = await socketService(t, (connection) => connection.send({ op: 10, d: { heartbeat_interval: 45000 } }));
  const rest = await jsonService(t, () => ({ body: { id: "m" } }));
  const adapter = new DiscordAdapter({ id: "discord", token: discordToken, apiBase: rest.base, gatewayUrl: gateway.url, heartbeatMs: 1000 });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["9001"] });
  const connection = await until(() => gateway.connections[0], "connection");
  connection.send({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-1", username: "BranchBot" }, session_id: "s", resume_gateway_url: gateway.url } });
  await until(() => adapter.botName(), "ready");
  connection.send({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1", channel_id: "dm9",
    content: "let me in", author: { id: "6666", username: "mallory" }, mentions: [] } });
  const refusal = await until(() => rest.calls[0], "refusal");
  assert.equal(refusal.body.content, "This assistant is private.");
  assert.equal(provider.requests.length, 0, "a stranger never reaches the model");

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const response = await fetch(server.url + "/api/channels", { headers: { authorization: "Bearer " + server.token, origin: server.url } });
  const text = await response.text();
  assert.ok(!text.includes(discordToken), "the bot token is not in what the app shows");
  assert.match(text, /"kind":"discord"/);
  assert.match(text, /"state":"connected"/);
  await adapter.stop();
});

test("Slack: envelopes are acknowledged, replies stay in the thread as Slack's own formatting, and channels outside the list are ignored", async (t) => {
  const { app, provider } = await fixture(t);
  const socket = await socketService(t, (connection) => connection.send({ type: "hello" }));
  const api = await jsonService(t, (call) => {
    if (call.path.endsWith("auth.test")) return { body: { ok: true, user_id: "U-BOT", user: "branch" } };
    if (call.path.endsWith("chat.postMessage")) return { body: { ok: true, ts: "1700.5" } };
    return null;
  });
  const adapter = new SlackAdapter({ id: "slack", token: slackBotToken, appToken: slackAppToken,
    apiBase: api.base, socketUrl: socket.url, channels: ["C-ALLOWED"], reconnectBaseMs: 10 });
  await app.channels.attach(adapter, { activation: "mention", pairing: false, allowlist: ["U-ALICE"] });
  assert.equal(api.calls[0].headers.authorization, `Bearer ${slackBotToken}`);
  const connection = await until(() => socket.connections[0], "socket");
  await until(() => adapter.health().state === "connected", "connected");

  // A channel that is not on the list never reaches the assistant.
  connection.send({ type: "events_api", envelope_id: "e0", payload: { event_id: "ev0",
    event: { type: "message", channel: "C-OTHER", user: "U-ALICE", text: "<@U-BOT> hello", ts: "1.0" } } });
  await until(() => connection.received.some((message) => message.envelope_id === "e0"), "ack for the ignored channel");
  await delay(150);
  assert.equal(provider.requests.length, 0);

  provider.reply = () => "**bold** and [the docs](https://example.com/docs)";
  connection.send({ type: "events_api", envelope_id: "e1", payload: { event_id: "ev1",
    event: { type: "app_mention", channel: "C-ALLOWED", user: "U-ALICE", text: "<@U-BOT> summarise", ts: "1700.1", thread_ts: "1700.0" } } });
  await until(() => connection.received.some((message) => message.envelope_id === "e1"), "envelope acknowledged");
  const post = await until(() => api.calls.find((call) => call.path.endsWith("chat.postMessage")), "reply posted");
  assert.equal(post.body.channel, "C-ALLOWED");
  assert.equal(post.body.thread_ts, "1700.0", "the answer stays in the thread it was asked in");
  assert.equal(post.body.text, "*bold* and <https://example.com/docs|the docs>");

  // Slack resends an envelope it did not think was acknowledged; the question is answered once.
  const posts = api.calls.filter((call) => call.path.endsWith("chat.postMessage")).length;
  connection.send({ type: "events_api", envelope_id: "e2", payload: { event_id: "ev1",
    event: { type: "app_mention", channel: "C-ALLOWED", user: "U-ALICE", text: "<@U-BOT> summarise", ts: "1700.1", thread_ts: "1700.0" } } });
  await until(() => connection.received.some((message) => message.envelope_id === "e2"), "second ack");
  await delay(150);
  assert.equal(api.calls.filter((call) => call.path.endsWith("chat.postMessage")).length, posts, "a repeated event is answered once");

  // Slack's own messages and edits are never answered.
  connection.send({ type: "events_api", envelope_id: "e3", payload: { event_id: "ev3",
    event: { type: "message", channel: "C-ALLOWED", user: "U-ALICE", text: "changed", ts: "1700.9", subtype: "message_changed" } } });
  connection.send({ type: "events_api", envelope_id: "e4", payload: { event_id: "ev4",
    event: { type: "message", channel: "C-ALLOWED", user: "U-BOT", bot_id: "B1", text: "mine", ts: "1701.0" } } });
  await until(() => connection.received.some((message) => message.envelope_id === "e4"), "acks");
  await delay(150);
  assert.equal(api.calls.filter((call) => call.path.endsWith("chat.postMessage")).length, posts);

  // A dropped socket comes back by itself.
  connection.drop();
  const reconnected = await until(() => socket.connections[1], "reconnected socket");
  reconnected.send({ type: "hello" });
  await until(() => adapter.health().state === "connected", "connected again");
  await adapter.stop();
});

test("WhatsApp: the address is verified, an unsigned message is refused, and a late reply waits in the queue", async (t) => {
  const { app, root, provider } = await fixture(t);
  const graph = await jsonService(t, () => ({ body: { messages: [{ id: "wamid.1" }] } }));
  let clock = Date.parse("2026-01-01T12:00:00Z");
  const adapter = new WhatsAppAdapter({ id: "whatsapp", token: whatsAppToken, phoneNumberId: "PN-1",
    verifyToken: "let-me-in", appSecret: whatsAppSecret, apiBase: graph.base, now: () => clock });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["27123456789"] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());

  // The whole address the owner pastes into Meta carries an unguessable word on the end.
  const { webhookSecret } = await import("../dist/channels/webhook-address.js");
  const word = webhookSecret(app.store, app.runtime.owner, "whatsapp");
  const at = `/webhooks/whatsapp/whatsapp/${word}`;
  // Meta checks the address once, and expects the challenge back as plain text.
  const good = await fetch(`${server.url}${at}?hub.mode=subscribe&hub.verify_token=let-me-in&hub.challenge=54321`, { headers: { origin: server.url } });
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "54321");
  const bad = await fetch(`${server.url}${at}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=54321`, { headers: { origin: server.url } });
  assert.equal(bad.status, 403);
  // mac7/channel-leaks: without the word, the same wrong check says only that nothing is there,
  // which is what an address nobody has ever connected says too.
  const guessed = await fetch(`${server.url}/webhooks/whatsapp/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=54321`, { headers: { origin: server.url } });
  assert.equal(guessed.status, 404);
  assert.match((await guessed.json()).error, /No chat service is connected at that address/);

  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: {
    contacts: [{ wa_id: "27123456789", profile: { name: "Thandi" } }],
    messages: [{ id: "wamid.in1", from: "27123456789", type: "text", text: { body: "what is the weather" } }] } }] }] });
  const sign = (secret) => "sha256=" + createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
  const post = (headers) => fetch(`${server.url}${at}`, { method: "POST", body,
    headers: { "content-type": "application/json", origin: server.url, ...headers } });

  assert.equal((await post({})).status, 401, "a message with no signature is refused");
  assert.equal((await post({ "x-hub-signature-256": sign("not-the-secret") })).status, 401, "a wrong signature is refused");
  assert.equal(provider.requests.length, 0);
  const accepted = await post({ "x-hub-signature-256": sign(whatsAppSecret) });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: 1 });
  const sent = await until(() => graph.calls[0], "reply sent");
  assert.equal(sent.path, "/PN-1/messages");
  assert.equal(sent.body.to, "27123456789");
  assert.equal(sent.body.text.body, "Echo: what is the weather");
  assert.equal(sent.body.context, undefined, "a one-to-one answer to the only message waiting does not quote it (reply-style.ts)");
  assert.equal(sent.headers.authorization, `Bearer ${whatsAppToken}`);

  // More than a day later WhatsApp no longer allows a free reply, so the message waits and is shown.
  clock += 25 * 60 * 60 * 1000;
  await app.channels.deliver("whatsapp", "27123456789", "are you still there", "late:1").catch(() => undefined);
  const waiting = app.channels.outstanding().find((item) => item.preview.startsWith("are you still there"));
  assert.ok(waiting, "the late message is written down rather than lost");
  assert.match(waiting.lastError, /24-hour reply window/);

  const summary = await (await fetch(server.url + "/api/channels", { headers: { authorization: "Bearer " + server.token, origin: server.url } })).text();
  assert.ok(!summary.includes(whatsAppToken) && !summary.includes(whatsAppSecret), "no WhatsApp secret is shown");
  await adapter.stop();
});

test("Email: unread mail is fetched and marked read, and the answer is threaded onto it", async (t) => {
  const { app } = await fixture(t);
  const mailbox = await fakeImap(t);
  const outbox = await fakeSmtp(t);
  const adapter = new EmailAdapter({ id: "email", address: "assistant@example.com", pollMs: 50,
    imap: { host: "127.0.0.1", port: mailbox.port, user: "assistant@example.com", password: "mailbox-password", tls: false, timeoutMs: 4000 },
    smtp: { host: "127.0.0.1", port: outbox.port, user: "assistant@example.com", password: "mailbox-password", tls: false, timeoutMs: 4000 } });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["alice@example.com"] });
  const mail = await until(() => outbox.messages[0], "reply sent");
  assert.deepEqual(adapter.health(), { state: "connected" });
  assert.match(mail.headers["in-reply-to"], /^<first@example.com>$/);
  assert.match(mail.headers.references, /<first@example.com>/);
  assert.equal(mail.headers.subject, "Re: A question");
  assert.equal(mail.headers.to, "alice@example.com");
  assert.equal(mail.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(mail.headers["content-transfer-encoding"], "8bit");
  assert.equal(mail.body.trim(), "Echo: How much is the fee?");
  assert.ok(mailbox.stored.some((command) => /STORE 1 \+FLAGS \(\\Seen\)/.test(command)), "the message is marked read");
  assert.ok(!outbox.transcript.includes("mailbox-password"), "the password is sent only in the encoded login");
  await adapter.stop();
});

test("Email: a stranger is turned away, and the mail helpers read what a server actually sends", async (t) => {
  const { app, provider } = await fixture(t);
  const mailbox = await fakeImap(t, { from: "Mallory <mallory@example.com>" });
  const outbox = await fakeSmtp(t);
  const adapter = new EmailAdapter({ id: "email", address: "assistant@example.com", pollMs: 50,
    imap: { host: "127.0.0.1", port: mailbox.port, user: "a@example.com", password: "p", tls: false, timeoutMs: 4000 },
    smtp: { host: "127.0.0.1", port: outbox.port, user: "a@example.com", password: "p", tls: false, timeoutMs: 4000 } });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["alice@example.com"] });
  const refusal = await until(() => outbox.messages[0], "refusal sent");
  assert.equal(refusal.body.trim(), "This assistant is private.");
  assert.equal(provider.requests.length, 0);
  await adapter.stop();

  // The IMAP reader steps over literal blocks, so a message body cannot fake the end of an answer.
  const answer = "* 1 FETCH (BODY[HEADER] {14}\r\nb1 OK faked\r\n\r\n)\r\nb1 OK done\r\n";
  assert.equal(taggedEnd(answer, "b1"), answer.length);
  const parsed = parseFetched(1, "* 1 FETCH (BODY[HEADER] {55}\r\nFrom: A B <a@b.com>\r\nSubject: Hi\r\nMessage-ID: <x@y>\r\n\r\n BODY[TEXT] {6}\r\nhello!)\r\nb1 OK\r\n");
  assert.equal(parsed.from, "a@b.com");
  assert.equal(parsed.fromName, "A B");
  assert.equal(parsed.subject, "Hi");
  assert.equal(parsed.text, "hello!");
  // CHAT-003: a server may send the text before the headers (GreenMail does, about half the time), and a subject
  // that spells a part name is only text.
  const turned = parseFetched(1, "* 1 FETCH (BODY[TEXT] {6}\r\nhello! BODY[HEADER] {47}\r\nFrom: a@b.com\r\nSubject: BODY[TEXT] {3}\r\nabc\r\n\r\n)\r\nb1 OK\r\n");
  assert.equal(turned.from, "a@b.com");
  assert.equal(turned.subject, "BODY[TEXT] {3}");
  assert.equal(turned.text, "hello!");
  assert.equal(handle("short@example.com", "who"), "short@example.com");
  assert.match(handle("a".repeat(70) + "@example.com", "who"), /^who:[0-9a-f]{32}$/);
  assert.equal(toMrkdwn("keep ```**this**``` as is"), "keep ```**this**``` as is");
});

test("a mail with accents and emoji is read whole, since IMAP counts bytes (CHAT-003)", async (t) => {
  // Counted as characters, this body overran its literal, and the reader waited for an end that never came.
  const body = "Ça coûte combien ? Déjà payé, naïve café 🌳🌳🌳";
  const mailbox = await fakeImap(t, { body });
  const client = new ImapClient({ host: "127.0.0.1", port: mailbox.port, user: "a@example.com", password: "pw", tls: false, timeoutMs: 3000 });
  await client.connect();
  let mail;
  try { [mail] = await client.unread(); } finally { await client.close(); }
  assert.equal(mail.text, body);
  assert.equal(mail.from, "alice@example.com");
});

test("a mail server that refuses the password is reported in words the owner can act on", async (t) => {
  const mailbox = await fakeImap(t, { refuseLogin: true });
  const client = new ImapClient({ host: "127.0.0.1", port: mailbox.port, user: "a@example.com", password: "wrong", tls: false, timeoutMs: 3000 });
  await assert.rejects(client.connect(), (error) => {
    assert.match(error.message, /refused LOGIN/);
    assert.ok(!error.message.includes("wrong"), "the password is not repeated in the error");
    return true;
  });
  await client.close();
  const outbox = await fakeSmtp(t, { refuseAuth: true });
  await assert.rejects(sendMail({ host: "127.0.0.1", port: outbox.port, user: "a@example.com", password: "wrong", tls: false, timeoutMs: 3000 },
    { from: "a@example.com", to: "b@example.com", subject: "x", text: "y", messageId: "<1@b>" }), /answered 535/);
});

test("a mail server that never answers does not hold up starting, and the channel says it is trying", async (t) => {
  const { app } = await fixture(t);
  // 192.0.2.1 is reserved for documentation: nothing answers, and nothing refuses either.
  const unreachable = { host: "192.0.2.1", port: 993, user: "a@example.com", password: "p", tls: false, timeoutMs: 400 };
  const adapter = new EmailAdapter({ id: "email", address: "a@example.com", pollMs: 60000, imap: unreachable, smtp: unreachable });
  const started = Date.now();
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: [] });
  assert.ok(Date.now() - started < 1000, "attaching does not wait for the mail server");
  await until(() => adapter.health().state !== "connected" && adapter.health().reason?.includes("inbox"), "a plain reason");
  assert.notEqual(adapter.health().state, "connected");
  await adapter.stop();
});

test("a channel that is refused says so in words, and never repeats the secret it was refused for", async (t) => {
  const { app, root } = await fixture(t);
  const gateway = await socketService(t, (connection) => connection.send({ op: 10, d: { heartbeat_interval: 45000 } }));
  const rest = await jsonService(t, () => ({ status: 401, body: { message: "401: Unauthorized", code: 0 } }));
  const adapter = new DiscordAdapter({ id: "discord", token: discordToken, apiBase: rest.base, gatewayUrl: gateway.url, heartbeatMs: 1000 });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["9001"] });
  const connection = await until(() => gateway.connections[0], "connection");
  connection.send({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-1", username: "BranchBot" }, session_id: "s", resume_gateway_url: gateway.url } });
  await until(() => adapter.botName(), "ready");
  await app.channels.deliver("discord", "c1", "this will be refused", "refused:1").catch(() => undefined);
  const waiting = await until(() => app.channels.outstanding().find((item) => item.preview === "this will be refused"), "the refused message is kept");
  assert.match(waiting.lastError, /Discord refused the message \(401\)/);
  assert.ok(!waiting.lastError.includes(discordToken), "the token is not in the delivery error");
  assert.ok(!JSON.stringify(adapter.health()).includes(discordToken), "the token is not in the health reason");

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const shown = await (await fetch(server.url + "/api/channels", { headers: { authorization: "Bearer " + server.token, origin: server.url } })).text();
  assert.ok(!shown.includes(discordToken), "the token is not in what the app shows, errors included");
  // A web address naming a channel that is not connected tells the caller so rather than guessing.
  const missing = await fetch(`${server.url}/webhooks/whatsapp/nothere`, { headers: { origin: server.url } });
  assert.equal(missing.status, 404);
  await adapter.stop();
});

/** A stand-in IMAP server holding one unread message. */
async function fakeImap(t, options = {}) {
  const stored = [];
  const from = options.from ?? "Alice <alice@example.com>", fromDomain = /@([^>\s]+)/.exec(from)[1];
  // The receiving server's verdict, as a real mailbox stamps it (#979: unauthenticated senders are not routed).
  const headers = `Authentication-Results: mx.example.com; dmarc=pass header.from=${fromDomain}\r\n`
    + `From: ${from}\r\nSubject: A question\r\nMessage-ID: <first@example.com>\r\n`;
  const body = options.body ?? "How much is the fee?";
  let fetched = false;
  const server = createSocketServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("* OK fake IMAP ready\r\n");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\r\n").filter(Boolean)) {
        stored.push(line);
        const [tag, command] = line.split(" ");
        if (command === "LOGIN" && options.refuseLogin) { socket.write(`${tag} NO invalid credentials\r\n`); continue; }
        if (command === "SEARCH") { socket.write(fetched ? "* SEARCH\r\n" : "* SEARCH 1\r\n"); }
        if (command === "FETCH") {
          fetched = true;
          // IMAP counts a literal in bytes, as a real server does.
          socket.write(`* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers} BODY[TEXT] {${Buffer.byteLength(body)}}\r\n${body})\r\n`);
        }
        socket.write(`${tag} OK done\r\n`);
        if (command === "LOGOUT") socket.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, stored };
}
/** A stand-in SMTP server that records the messages it is handed. */
async function fakeSmtp(t, options = {}) {
  const messages = [];
  let transcript = "";
  const server = createSocketServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake SMTP ready\r\n");
    let data = false, pending = "", buffer = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      transcript += chunk;
      buffer += chunk;
      for (let eol = buffer.indexOf("\r\n"); eol !== -1; eol = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, eol); buffer = buffer.slice(eol + 2);
        if (data) {
          if (line === ".") { data = false; messages.push(parseMail(pending)); pending = ""; socket.write("250 queued\r\n"); }
          else pending += line.replace(/^\.\./, ".") + "\r\n";
          continue;
        }
        if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250 8BITMIME\r\n");
        else if (/^AUTH/i.test(line)) socket.write(options.refuseAuth ? "535 bad password\r\n" : "235 welcome\r\n");
        else if (/^(MAIL|RCPT)/i.test(line)) socket.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) { data = true; socket.write("354 go ahead\r\n"); }
        else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, messages, get transcript() { return transcript; } };
}
function parseMail(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const headers = Object.fromEntries(raw.slice(0, split).split("\r\n").map((line) => {
    const at = line.indexOf(":");
    return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
  }));
  return { headers, body: raw.slice(split + 4) };
}
