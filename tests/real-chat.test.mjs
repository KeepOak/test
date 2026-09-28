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
import { connect as tcp } from "node:net";
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
async function ownerWalk({ app, provider }, { say, heard, label }) {
  await say("hello there");
  const offer = await until(() => heard().find((text) => /\b\d{6}\b/.test(text)), `${label}: a pairing code over the real server`);
  assert.equal(provider.requests, 0, `${label}: a stranger never reaches the model`);
  app.channels.approve(app.runtime.owner, { code: /\b(\d{6})\b/.exec(offer)[1] });
  // Not only ASCII: an accent and an emoji must come through every transport, both ways.
  const question = "what is two plus two? ça va, naïve café 🌳🌳";
  await say(question);
  await until(() => heard().some((text) => text.includes("Echo:") && text.includes(question)), `${label}: the answer over the real server`);
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
