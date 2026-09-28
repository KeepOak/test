/**
 * CHAT-003: every chat app tested for real where a free local server exists, and every other one skipped with its
 * reason (tests/real-chat-apps.mjs). "Real" means Branch's own channel, built exactly as the owner's connections file
 * builds it (`buildChannelEntry`, network rules on, "private addresses" allowed as the owner would for a server of
 * their own), talking to a real server; and a person on the other side using that server with their own minimal
 * client, written here and sharing no code with Branch. The walk is the one an owner goes through: a stranger writes
 * and gets a pairing code, the owner approves it, the same person asks and gets the model's answer back.
 *
 * The servers are started by `node scripts/real-chat/servers.mjs up`, which writes where they listen to a state file.
 * Without it (CI, or a computer that never ran it) each local app is skipped, saying so. Nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { connect as tcp } from "node:net";
import { createInterface } from "node:readline";
import { connect as tlsConnect } from "node:tls";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { buildChannelEntry } from "../dist/integrations/bootstrap.js";
import { saveParitySwitches } from "../dist/channels/parity-switch.js";
import { LOCAL, SKIPPED } from "./real-chat-apps.mjs";

const stateFile = process.env.BRANCH_REAL_CHAT_STATE
  ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "BranchRealChat", "state.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { servers: {} };
const notRunning = (app) => `${app}: its local server is not running here. Start it with: node scripts/real-chat/servers.mjs up`;

async function until(check, label, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); } // poll tick only
  assert.fail(`Timed out: ${label}`);
}
/** An engine with the owner's own local server allowed, and a model that echoes, so an answer is recognisable. */
async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-real-chat-"));
  const provider = { name: "stand-in", requests: 0,
    async complete(request) { provider.requests++; return { content: `Echo: ${request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""}`, toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
    web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  return { app, provider };
}
/** Builds the channel from a connections-file entry, as Branch does at start, and attaches it. */
async function connect(app, entry, env) {
  const host = app.channelHost;
  const adapter = await buildChannelEntry(entry, env, host, host.web.policy);
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: [] });
  return adapter;
}
/** The owner's walk: a stranger gets a code, the owner approves it, the person asks and is answered. */
async function ownerWalk({ app, provider }, { say, heard, label, ms = 20_000 }) {
  await say("hello there");
  const offer = await until(() => heard().find((text) => /\b\d{6}\b/.test(text)), `${label}: a pairing code over the real server`, ms);
  assert.equal(provider.requests, 0, `${label}: a stranger never reaches the model`);
  app.channels.approve(app.runtime.owner, { code: /\b(\d{6})\b/.exec(offer)[1] });
  // Not only ASCII: an accent and an emoji must come through every transport, both ways.
  const question = "what is two plus two? ça va, naïve café 🌳🌳";
  await say(question);
  await until(() => heard().some((text) => text.includes("Echo:") && text.includes(question)), `${label}: the answer over the real server`, ms);
}

/** A line-based socket, for the person's own IRC, SMTP, IMAP and XMPP clients. */
function lines(socket) {
  const got = [];
  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { const all = (partial + chunk).split(/\r?\n/); partial = all.pop() ?? ""; got.push(...all); });
  return got;
}
const opened = (socket, event = "connect") => new Promise((resolve, reject) => { socket.once(event, resolve); socket.once("error", reject); });

// ---- IRC: the person is a plain IRC client on the same server ----
test("IRC, for real: a local Ergo server", { skip: state.servers.irc ? false : notRunning("IRC") }, async (t) => {
  const { host, port } = state.servers.irc;
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { irc: "on" }, ["irc"]);
  const nick = `branch${Date.now() % 100000}`;
  await connect(context.app, { type: "irc", id: "irc", server: host, port, tls: false, nick, channels: [], activation: "mention", pairing: true, allowlist: [] }, {});
  const person = tcp({ host, port });
  t.after(() => person.destroy());
  await opened(person);
  const seen = lines(person);
  const me = `sam${Date.now() % 100000}`;
  person.write(`NICK ${me}\r\nUSER sam 0 * :Sam\r\n`);
  await until(() => seen.some((line) => / 001 /.test(line)), "IRC: the person is welcomed");
  await until(async () => { person.write(`WHOIS ${nick}\r\n`); await delay(100); return seen.some((line) => / 311 /.test(line)); }, "IRC: the assistant is online");
  const heard = () => seen.filter((line) => line.includes(` PRIVMSG ${me} :`)).map((line) => line.split(` PRIVMSG ${me} :`)[1]);
  await ownerWalk(context, { label: "IRC", heard, say: async (text) => person.write(`PRIVMSG ${nick} :${text}\r\n`) });
});

// ---- Email: the person sends with SMTP and reads with IMAP, by hand ----
async function smtpSend({ host, port }, from, to, subject, body) {
  const socket = tcp({ host, port });
  await opened(socket);
  const got = lines(socket);
  const step = async (line, code) => { if (line) socket.write(`${line}\r\n`); await until(() => got.some((l) => l.startsWith(code)), `SMTP ${code}`); got.length = 0; };
  await step(null, "220");
  await step("EHLO person.localhost", "250 ");
  await step(`MAIL FROM:<${from}>`, "250");
  await step(`RCPT TO:<${to}>`, "250");
  await step("DATA", "354");
  await step(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}.${Math.random()}@person.localhost>\r\n`
    + `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n.`, "250");
  socket.end("QUIT\r\n");
}
async function imapBodies({ host, port }, user, password, first = []) {
  const socket = tcp({ host, port });
  await opened(socket);
  const got = lines(socket);
  const run = async (tag, command) => { socket.write(`${tag} ${command}\r\n`); await until(() => got.some((l) => l.startsWith(`${tag} `)), `IMAP ${tag}`); };
  await until(() => got.some((l) => l.startsWith("* OK")), "IMAP greeting");
  await run("a", `LOGIN ${user} ${password}`);
  await run("b", "SELECT INBOX");
  for (const [n, command] of first.entries()) await run(`p${n}`, command);
  await run("c", "FETCH 1:* (BODY[TEXT])");
  socket.end("d LOGOUT\r\n");
  return got.join("\n");
}
test("Email, for real: a local GreenMail SMTP and IMAP server", { skip: state.servers.email ? false : notRunning("email") }, async (t) => {
  const { smtp, imap, domain } = state.servers.email;
  const context = await engine(t);
  const bot = `branch@${domain}`, person = `sam@${domain}`;
  // Both mailboxes start empty, so no code or question left from an earlier, interrupted run is read again.
  const empty = ["STORE 1:* +FLAGS (\\Deleted)", "EXPUNGE"];
  await imapBodies(imap, bot, "branchpw", empty);
  await imapBodies(imap, person, "sampw", empty);
  await connect(context.app, { type: "email", id: "email", address: bot, pollSeconds: 5,
    imap: { host: imap.host, port: imap.port, user: bot, tls: false }, smtp: { host: smtp.host, port: smtp.port, user: bot, tls: false },
    activation: "mention", pairing: true, allowlist: [] }, { EMAIL_PASSWORD: "branchpw" });
  let mail = "";
  const heard = () => mail.split(/\n/);
  const refresh = setInterval(() => { imapBodies(imap, person, "sampw").then((text) => { mail = text; }, () => undefined); }, 1000);
  t.after(() => clearInterval(refresh));
  await ownerWalk(context, { label: "Email", heard, say: (text) => smtpSend(smtp, person, bot, "Hello", text) });
});

// ---- XMPP: the person signs in with STARTTLS (the throwaway local CA) and SASL PLAIN, by hand ----
async function xmppPerson({ host, port, domain, ca }, user, password) {
  const plain = tcp({ host, port });
  await opened(plain);
  const open = `<?xml version='1.0'?><stream:stream to='${domain}' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>`;
  let text = "";
  plain.setEncoding("utf8");
  plain.on("data", (chunk) => { text += chunk; });
  plain.write(open);
  await until(() => text.includes("starttls"), "XMPP: STARTTLS offered");
  plain.write("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>");
  await until(() => text.includes("<proceed"), "XMPP: STARTTLS proceed");
  plain.removeAllListeners("data");
  const secure = tlsConnect({ socket: plain, servername: domain, ca: readFileSync(ca) }); // verified against the local CA
  await opened(secure, "secureConnect");
  let buffer = "";
  secure.setEncoding("utf8");
  secure.on("data", (chunk) => { buffer += chunk; });
  secure.write(open);
  await until(() => buffer.includes("PLAIN"), "XMPP: PLAIN offered over TLS");
  secure.write(`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${Buffer.from(`\0${user}\0${password}`).toString("base64")}</auth>`);
  await until(() => buffer.includes("<success"), "XMPP: signed in");
  buffer = "";
  secure.write(open);
  await until(() => buffer.includes("bind"), "XMPP: bind offered");
  secure.write("<iq type='set' id='b1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>phone</resource></bind></iq>");
  await until(() => buffer.includes("id='b1'") || buffer.includes('id="b1"'), "XMPP: bound");
  secure.write("<presence/>");
  return { socket: secure, read: () => buffer };
}
const xmlText = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
// The assistant checks the server's certificate like any other; Node trusts the local CA only when started with it.
const xmppSkip = !state.servers.xmpp ? notRunning("XMPP")
  : process.env.NODE_EXTRA_CA_CERTS !== state.servers.xmpp.ca ? "XMPP: run it through node scripts/real-chat/servers.mjs test, which trusts the local CA" : false;
test("XMPP, for real: a local Prosody server", { skip: xmppSkip }, async (t) => {
  const server = state.servers.xmpp;
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { xmpp: "on" }, ["xmpp"]);
  await connect(context.app, { type: "xmpp", id: "xmpp", jid: `branch@${server.domain}`, server: server.host, port: server.port, security: "starttls",
    activation: "mention", pairing: true, allowlist: [] }, { XMPP_PASSWORD: "branchpw" });
  await until(() => context.app.channels.summary().channels.find((c) => c.id === "xmpp")?.health?.state === "connected", "XMPP: the assistant signed in");
  const person = await xmppPerson(server, "sam", "sampw");
  t.after(() => person.socket.destroy());
  const heard = () => [...person.read().matchAll(/<body>([\s\S]*?)<\/body>/g)].map((m) => xmlText(m[1]));
  let n = 0;
  await ownerWalk(context, { label: "XMPP", heard,
    say: async (text) => person.socket.write(`<message to='branch@${server.domain}' type='chat' id='m${n++}'><body>${text}</body></message>`) });
});

// ---- Matrix: the person is a second account on the same homeserver, using the client-server API by hand ----
async function matrixAccount(base, user, password, token) {
  const post = (path, body, access) => fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  const login = await post("/_matrix/client/v3/login", { type: "m.login.password", identifier: { type: "m.id.user", user }, password });
  if (login.access_token) return login;
  const first = await post("/_matrix/client/v3/register", { username: user, password });
  return post("/_matrix/client/v3/register", { username: user, password, auth: { type: "m.login.registration_token", token, session: first.session } });
}
test("Matrix, for real: a local tuwunel homeserver", { skip: state.servers.matrix ? false : notRunning("Matrix") }, async (t) => {
  const { base, registrationToken } = state.servers.matrix;
  const context = await engine(t);
  const bot = await matrixAccount(base, "branch", "branchpw-long-enough", registrationToken);
  const sam = await matrixAccount(base, "sam", "sampw-long-enough", registrationToken);
  assert.ok(bot.access_token && sam.access_token, "two accounts on the homeserver");
  const call = (access, method, path, body) => fetch(`${base}${path}`, { method,
    headers: { "content-type": "application/json", authorization: `Bearer ${access}` }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  // The person opens a room with the assistant; the assistant accepts (as its owner would, once, in any client).
  const room = await call(sam.access_token, "POST", "/_matrix/client/v3/createRoom", { invite: [bot.user_id], preset: "private_chat" });
  await call(bot.access_token, "POST", `/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, {});
  await connect(context.app, { type: "matrix", id: "matrix", homeserver: base, userId: bot.user_id, syncSeconds: 5,
    activation: "mention", pairing: true, allowlist: [] }, { MATRIX_ACCESS_TOKEN: bot.access_token });
  let txn = 0;
  const say = (text) => call(sam.access_token, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/send/m.room.message/t${Date.now()}${txn++}`,
    { msgtype: "m.text", body: `${bot.user_id} ${text}` });
  let said = [];
  const refresh = setInterval(async () => {
    const page = await call(sam.access_token, "GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/messages?dir=b&limit=50`).catch(() => null);
    if (page?.chunk) said = page.chunk.filter((e) => e.sender === bot.user_id && e.type === "m.room.message").map((e) => e.content?.body ?? "");
  }, 500);
  t.after(() => clearInterval(refresh));
  await ownerWalk(context, { label: "Matrix", heard: () => said, say });
});

// ---- MQTT: the person is a plain MQTT 3.1.1 client on the same broker, packets written by hand ----
const mqttString = (text) => { const bytes = Buffer.from(text, "utf8"); return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 255]), bytes]); };
function mqttPacket(type, body) {
  const length = [];
  let left = body.length;
  do { let byte = left % 128; left = Math.floor(left / 128); if (left > 0) byte |= 128; length.push(byte); } while (left > 0);
  return Buffer.concat([Buffer.from([type, ...length]), body]);
}
/** Connects, subscribes to one topic, and collects every PUBLISH that arrives on it (QoS 0). */
async function mqttPerson({ host, port }, clientId, subscribe) {
  const socket = tcp({ host, port });
  await opened(socket);
  const got = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      let length = 0, multiplier = 1, at = 1;
      while (at < buffer.length && at < 5) { const byte = buffer[at++]; length += (byte & 127) * multiplier; multiplier *= 128; if (!(byte & 128)) break; }
      if (buffer.length < at + length || at === 1) return;
      const type = buffer[0] >> 4, body = buffer.subarray(at, at + length);
      buffer = buffer.subarray(at + length);
      if (type === 3) { const topicLength = body.readUInt16BE(0); got.push(body.subarray(2 + topicLength).toString("utf8")); }
    }
  });
  socket.write(mqttPacket(0x10, Buffer.concat([mqttString("MQTT"), Buffer.from([4, 2, 0, 60]), mqttString(clientId)])));
  socket.write(mqttPacket(0x82, Buffer.concat([Buffer.from([0, 1]), mqttString(subscribe), Buffer.from([0])])));
  return { socket, got, publish: (topic, payload) => socket.write(mqttPacket(0x30, Buffer.concat([mqttString(topic), Buffer.from(payload, "utf8")]))) };
}
test("MQTT, for real: a local Mosquitto broker", { skip: state.servers.mqtt ? false : notRunning("MQTT") }, async (t) => {
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { mqtt: "on" }, ["mqtt"]);
  const run = `r${Date.now()}`; // topics of this run only, so nothing retained from an earlier one is read
  const person = await mqttPerson(state.servers.mqtt, `sam${run}`.slice(0, 23), `${run}/out/#`);
  t.after(() => person.socket.destroy());
  await connect(context.app, { type: "mqtt", id: "mqtt", host: state.servers.mqtt.host, port: state.servers.mqtt.port, tls: false,
    clientId: `branch${run}`.slice(0, 23), inboundTopic: `${run}/in`, replyTopic: `${run}/out/{chat}`, activation: "mention", pairing: true, allowlist: [] }, {});
  await until(() => context.app.channels.summary().channels.find((c) => c.id === "mqtt")?.health?.state === "connected", "MQTT: the assistant connected");
  const heard = () => person.got.map((payload) => { try { return JSON.parse(payload).text ?? ""; } catch { return ""; } });
  await ownerWalk(context, { label: "MQTT", heard, say: async (text) => person.publish(`${run}/in`, JSON.stringify({ from: "sam", chat: "sam", text })) });
});

// ---- ntfy: the person publishes to the listen topic and reads the answers there, over ntfy's own HTTP API ----
test("ntfy, for real: a local ntfy server", { skip: state.servers.ntfy ? false : notRunning("ntfy") }, async (t) => {
  const { base } = state.servers.ntfy;
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { ntfy: "on" }, ["ntfy"]);
  const run = `r${Date.now()}`;
  await connect(context.app, { type: "ntfy", id: "ntfy", server: base, topic: `${run}-out`, listenTopic: `${run}-in`, pollSeconds: 2,
    activation: "mention", pairing: true, allowlist: [] }, {});
  let said = [];
  const refresh = setInterval(async () => {
    // Branch answers on the topic it was written on; the person's own messages there carry no code and no "Echo:".
    const text = await fetch(`${base}/${run}-in/json?poll=1&since=all`).then((r) => r.text()).catch(() => "");
    said = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.event === "message").map((e) => e.message);
  }, 500);
  t.after(() => clearInterval(refresh));
  await delay(2500); // the first look only learns where the listen topic stands
  await ownerWalk(context, { label: "ntfy", heard: () => said,
    say: (text) => fetch(`${base}/${run}-in`, { method: "POST", body: Buffer.from(text, "utf8") }).then((r) => assert.equal(r.status, 200)) });
});

// ---- Gotify: send-only, so the walk is the owner's own delivery; the person reads it with a client token ----
test("Gotify, for real: a local Gotify server (it can only be sent to)", { skip: state.servers.gotify ? false : notRunning("Gotify") }, async (t) => {
  const { base, admin } = state.servers.gotify;
  const basic = { authorization: `Basic ${Buffer.from(`${admin.user}:${admin.pass}`).toString("base64")}`, "content-type": "application/json" };
  const made = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: basic, body: JSON.stringify(body) }).then((r) => r.json());
  const application = await made("/application", { name: `branch ${Date.now()}` });
  const reader = await made("/client", { name: `phone ${Date.now()}` });
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { gotify: "on" }, ["gotify"]);
  await connect(context.app, { type: "gotify", id: "gotify", server: base, activation: "mention", pairing: true, allowlist: [] },
    { GOTIFY_APP_TOKEN: application.token });
  const text = `Your report is ready: ça va, naïve café 🌳 ${Date.now()}`;
  const sent = await context.app.channels.deliver("gotify", "owner", text);
  assert.equal(sent.sent, true, "delivered through Branch's own delivery path");
  const inbox = await fetch(`${base}/application/${application.id}/message`, { headers: { "x-gotify-key": reader.token } }).then((r) => r.json());
  assert.ok(inbox.messages.some((m) => m.message === text), "the phone's client reads exactly what was sent");
});

// ---- Mumble: the person is a minimal Mumble client (TLS, protobuf written by hand) on the same server ----
const varint = (value) => { const out = []; let left = BigInt(value); do { let byte = Number(left & 127n); left >>= 7n; if (left) byte |= 128; out.push(byte); } while (left); return Buffer.from(out); };
const pbInt = (field, value) => Buffer.concat([varint(field << 3), varint(value)]);
const pbText = (field, text) => { const bytes = Buffer.from(text, "utf8"); return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]); };
/** Reads one protobuf message into field number → values (numbers, or Buffers for length-delimited fields). */
function pbRead(body) {
  const fields = new Map();
  const readVarint = (at) => { let value = 0n, shift = 0n; for (;;) { const byte = body[at++]; value |= BigInt(byte & 127) << shift; shift += 7n; if (!(byte & 128)) return [value, at]; } };
  for (let at = 0; at < body.length;) {
    const [key, next] = readVarint(at); at = next;
    const field = Number(key >> 3n), wire = Number(key & 7n);
    let value;
    if (wire === 0) { const [v, n] = readVarint(at); value = Number(v); at = n; }
    else if (wire === 2) { const [length, n] = readVarint(at); value = body.subarray(n, n + Number(length)); at = n + Number(length); }
    else if (wire === 5) { value = body.readUInt32LE(at); at += 4; }
    else if (wire === 1) { at += 8; continue; }
    else break;
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}
const mumbleFrame = (type, body) => { const head = Buffer.alloc(6); head.writeUInt16BE(type, 0); head.writeUInt32BE(body.length, 2); return Buffer.concat([head, body]); };
async function mumblePerson({ host, port }, name) {
  // Accepting the server's self-signed certificate is what a Mumble client does on first connecting.
  const socket = tlsConnect({ host, port, rejectUnauthorized: false });
  await opened(socket, "secureConnect");
  const users = new Map(), texts = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6 && buffer.length >= 6 + buffer.readUInt32BE(2)) {
      const type = buffer.readUInt16BE(0), body = buffer.subarray(6, 6 + buffer.readUInt32BE(2));
      buffer = buffer.subarray(6 + body.length);
      const fields = pbRead(body);
      if (type === 9 && fields.has(3)) users.set(fields.get(3)[0].toString("utf8"), fields.get(1)?.[0]);
      if (type === 11) texts.push(fields.get(5)?.[0]?.toString("utf8") ?? "");
    }
  });
  socket.write(mumbleFrame(0, Buffer.concat([pbInt(1, 0x010500), pbText(2, "real-chat person"), pbText(3, "test")])));
  socket.write(mumbleFrame(2, Buffer.concat([pbText(1, name), pbInt(5, 1)])));
  const ping = setInterval(() => socket.write(mumbleFrame(3, pbInt(1, Date.now()))), 5000);
  socket.on("close", () => clearInterval(ping));
  return { socket, users, texts, say: (session, text) => socket.write(mumbleFrame(11, Buffer.concat([pbInt(2, session), pbText(5, text)]))) };
}
const htmlText = (value) => value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
test("Mumble, for real: a local Mumble server", { skip: state.servers.mumble ? false : notRunning("Mumble") }, async (t) => {
  const server = state.servers.mumble;
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { mumble: "on" }, ["mumble"]);
  const run = Date.now() % 100000, bot = `branch${run}`;
  await connect(context.app, { type: "mumble", id: "mumble", server: server.host, port: server.port, username: bot, allowSelfSigned: true,
    activation: "mention", pairing: true, allowlist: [] }, {});
  const person = await mumblePerson(server, `sam${run}`);
  t.after(() => person.socket.destroy());
  const session = await until(() => person.users.get(bot), "Mumble: the assistant is on the server");
  await ownerWalk(context, { label: "Mumble", heard: () => person.texts.map(htmlText), say: async (text) => person.say(session, text) });
});

// ---- Delta Chat: the person is a second deltachat-rpc-server, driven over its own JSON-RPC, on the same mail server ----
function deltaProgram(path, accountsPath) {
  const child = spawn(path, [], { env: { ...process.env, DC_ACCOUNTS_PATH: accountsPath }, windowsHide: true });
  const waiting = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const answer = JSON.parse(line), waiter = waiting.get(answer.id);
    if (!waiter) return;
    waiting.delete(answer.id);
    if (answer.error) waiter.reject(new Error(answer.error.message)); else waiter.resolve(answer.result);
  });
  child.stderr.resume();
  const call = (method, ...params) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
  });
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  return { call, stop: () => { child.kill(); return stopped; } };
}
async function deltaAccount(program, { smtp, imap, domain }, user) {
  const account = await program.call("add_account");
  await program.call("add_or_update_transport", account, { addr: `${user}@${domain}`, password: `${user}pw`,
    imapServer: imap.host, imapPort: imap.port, imapSecurity: "plain", smtpServer: smtp.host, smtpPort: smtp.port, smtpSecurity: "plain" });
  return account;
}
test("Delta Chat, for real: deltachat-rpc-server on the local mail server", { skip: state.servers.deltachat ? false : notRunning("Delta Chat") }, async (t) => {
  const server = state.servers.deltachat;
  // Both mailboxes start empty, so nothing from an earlier, interrupted run is read again.
  const empty = ["STORE 1:* +FLAGS (\\Deleted)", "EXPUNGE"];
  for (const user of ["dcbot", "dcsam"]) await imapBodies(server.imap, `${user}@${server.domain}`, `${user}pw`, empty);
  const root = await mkdtemp(join(tmpdir(), "branch-real-deltachat-"));
  // The owner's setup, done once in the program as Branch's setup page asks: an account, and its invite link to share.
  const setup = deltaProgram(server.path, join(root, "assistant"));
  const assistant = await deltaAccount(setup, server, "dcbot");
  await setup.call("set_config", assistant, "displayname", "Branch");
  const invite = await setup.call("get_chat_securejoin_qr_code", assistant, null);
  await setup.stop();
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { deltachat: "on" }, ["deltachat"]);
  await connect(context.app, { type: "deltachat", id: "deltachat", path: server.path, accountsPath: join(root, "assistant"),
    activation: "mention", pairing: true, allowlist: [] }, {});
  await until(() => context.app.channels.summary().channels.find((c) => c.id === "deltachat")?.health?.state === "connected", "Delta Chat: the assistant's program is running");
  // The person scans the invite (Delta Chat's secure join) and writes in the chat it opens.
  const phone = deltaProgram(server.path, join(root, "person"));
  let reading = true;
  t.after(async () => { reading = false; await phone.stop(); await discardTemp(root); }); // after Branch lets go of its program
  const person = await deltaAccount(phone, server, "dcsam");
  const texts = [];
  void (async () => {
    while (reading) {
      const next = await phone.call("get_next_event").catch(() => null);
      if (!next) return;
      if (next.contextId === person && next.event.kind === "IncomingMsg") texts.push((await phone.call("get_message", person, next.event.msgId)).text ?? "");
    }
  })();
  await phone.call("start_io", person);
  const chat = await phone.call("secure_join", person, invite);
  // The join is a short exchange of mail with the assistant's own program; the chat can be written in once it is done.
  // Delta Chat's program looks at the inbox on its own schedule, so a round trip can take up to about a minute.
  await until(() => phone.call("can_send", person, chat), "Delta Chat: the person joined by the invite", 90_000);
  await ownerWalk(context, { label: "Delta Chat", heard: () => texts, ms: 90_000,
    say: (text) => phone.call("misc_send_text_message", person, chat, text) });
});

// ---- Nostr: the person uses nak, a separate Nostr client, for keys, NIP-04 encryption and the relay ----
function nak(path, ...args) {
  const done = spawnSync(path, args, { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (done.status !== 0) throw new Error(`nak ${args[0]} failed: ${done.stderr}`);
  return done.stdout.trim();
}
test("Nostr, for real: a local relay (nak serve)", { skip: state.servers.nostr ? false : notRunning("Nostr") }, async (t) => {
  const { relay, nak: path } = state.servers.nostr;
  const botSecret = nak(path, "key", "generate"), botPublic = nak(path, "key", "public", botSecret);
  const samSecret = nak(path, "key", "generate"), samPublic = nak(path, "key", "public", samSecret);
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { nostr: "on" }, ["nostr"]);
  await connect(context.app, { type: "nostr", id: "nostr", relays: [relay], activation: "mention", pairing: true, allowlist: [] },
    { NOSTR_PRIVATE_KEY: botSecret });
  await until(() => context.app.channels.summary().channels.find((c) => c.id === "nostr")?.health?.state === "connected", "Nostr: the assistant is on the relay");
  const heard = () => nak(path, "req", "-k", "4", "-a", botPublic, "-t", `p=${samPublic}`, relay).split("\n").filter(Boolean)
    .map((line) => nak(path, "decrypt", "--sec", samSecret, "-p", botPublic, "--nip04", JSON.parse(line).content));
  const say = async (text) => {
    const sealed = nak(path, "encrypt", "--sec", samSecret, "-p", botPublic, "--nip04", text);
    nak(path, "event", "--sec", samSecret, "-k", "4", "-p", botPublic, "-c", sealed, relay);
  };
  await ownerWalk(context, { label: "Nostr", heard, say });
});

// ---- SimpleX: the person is a second simplex-chat program, driven over its own WebSocket API, on a local relay ----
async function simplexProgram(url) {
  const socket = new WebSocket(url), waiting = new Map(), events = [];
  let n = 0;
  socket.onmessage = (message) => {
    const parsed = JSON.parse(message.data);
    if (parsed.corrId && waiting.has(parsed.corrId)) { waiting.get(parsed.corrId)(parsed.resp); waiting.delete(parsed.corrId); } else events.push(parsed.resp ?? parsed);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`${url} did not open`)); });
  const command = (cmd) => new Promise((resolve) => { const corrId = `person-${++n}`; waiting.set(corrId, resolve); socket.send(JSON.stringify({ corrId, cmd })); });
  return { socket, events, command };
}
const simplexReady = async (url) => until(async () => { try { const program = await simplexProgram(url); await program.command("/user"); return program; } catch { return null; } },
  `SimpleX: ${url} answers`, 30_000);
test("SimpleX, for real: two simplex-chat programs on a local relay", { skip: state.servers.simplex ? false : notRunning("SimpleX") }, async (t) => {
  const { assistant, person: personUrl } = state.servers.simplex;
  // The owner's setup, done in their own simplex-chat as the docs ask: a one-time invitation to share.
  const owner = await simplexReady(assistant);
  const invitation = await owner.command("/c");
  owner.socket.close();
  const link = JSON.stringify(invitation).match(/simplex:\/invitation#[^"\s]+/)?.[0];
  assert.ok(link, "the assistant's program made an invitation");
  const context = await engine(t);
  saveParitySwitches(context.app.store, context.app.runtime.owner, { simplex: "on" }, ["simplex"]);
  await connect(context.app, { type: "simplex", id: "simplex", address: assistant, activation: "mention", pairing: true, allowlist: [] }, {});
  await until(() => context.app.channels.summary().channels.find((c) => c.id === "simplex")?.health?.state === "connected", "SimpleX: the assistant is on its program");
  const person = await simplexReady(personUrl);
  t.after(() => person.socket.close());
  await person.command(`/c ${link}`);
  const contact = await until(() => person.events.find((e) => e.type === "contactConnected")?.contact?.contactId, "SimpleX: the person is connected");
  const heard = () => person.events.filter((e) => e.type === "newChatItems").flatMap((e) => e.chatItems)
    .filter((item) => item.chatInfo?.contact?.contactId === contact && item.chatItem?.chatDir?.type === "directRcv")
    .map((item) => item.chatItem.content?.msgContent?.text ?? "");
  await ownerWalk(context, { label: "SimpleX", heard,
    say: (text) => person.command(`/_send @${contact} json ${JSON.stringify([{ msgContent: { type: "text", text } }])}`) });
});

// ---- Every other app: why it is not tested for real ----
for (const [app, reason] of Object.entries(SKIPPED)) test(`${app}, for real`, { skip: reason }, () => undefined);
test("every app in the setup catalog is either tested for real or says why not", async () => {
  const { readFile } = await import("node:fs/promises");
  const catalog = JSON.parse(await readFile(new URL("../data/channel-setup.json", import.meta.url), "utf8")).recipes.map((r) => r.id);
  const covered = new Set([...Object.keys(LOCAL), ...Object.keys(SKIPPED)]);
  assert.deepEqual(catalog.filter((id) => !covered.has(id)), [], "an app with neither a real test nor a reason");
  assert.deepEqual([...covered].filter((id) => !catalog.includes(id)), [], "a reason for an app the catalog does not have");
  for (const [app, reason] of Object.entries(SKIPPED)) assert.ok(reason.length > 20, `${app} gives a real reason`);
});
test("the table in docs/chat-parity.md is the one the harness writes", async () => {
  const { docPath, withTable } = await import("../scripts/real-chat/table.mjs");
  const doc = readFileSync(docPath, "utf8");
  assert.equal(doc, withTable(doc), "run node scripts/real-chat/table.mjs");
});
