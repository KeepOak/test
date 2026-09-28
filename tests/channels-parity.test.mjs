import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect as tcpConnect } from "node:net";
import {
  fixture, until, delay, setSwitch, assertNoSecret, httpService, lineServer, socketService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { parityServices } from "../dist/channels/parity-services.js";
import { buildParityChannel, paritySummary, ParityChannelSchema } from "../dist/channels/parity-config.js";
import { SwitchedChannel, paritySwitch, isPostedChannel } from "../dist/channels/parity-switch.js";
import { lineChunks } from "../dist/channels/parity-common.js";
import { parseIrcLine, IrcChannel, socketDial } from "../dist/channels/irc.js";
import { GotifyChannel } from "../dist/channels/gotify.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { startServer } from "../dist/server.js";
import { connectWebSocket } from "../dist/channels/ws-client.js";

const GOTIFY_TOKEN = "SECRET-GOTIFY-APP-TOKEN-1";
const IRC_PASSWORD = "SECRET-IRC-NICKSERV-PW-2";
const TWITCH_TOKEN = "SECRET-TWITCH-OAUTH-3";

/** A plain socket opener pointed at the stand-in, whatever host the settings name. */
const localSocket = (port) => async (target) => new Promise((resolve, reject) => {
  const socket = tcpConnect({ host: "127.0.0.1", port }, () => resolve(socket));
  socket.once("error", reject);
});

function fakeInner(kind = "fake") {
  const inner = { id: "fake", kind, starts: 0, stops: 0, sent: [], deliver: null,
    botName: () => "bot",
    async start(onMessage) { inner.starts++; inner.deliver = onMessage; },
    async stop() { inner.stops++; },
    async send(chatId, text) { inner.sent.push([chatId, text]); return "m1"; } };
  return inner;
}

test("every service ships switched off, and the list names each one once", async (t) => {
  const context = await fixture(t);
  const kinds = parityServices.map((service) => service.kind);
  assert.equal(new Set(kinds).size, kinds.length, "no service is listed twice");
  for (const service of await paritySummary(context.app.store, context.app.runtime.owner)) {
    assert.equal(service.switch, "off", `${service.kind} starts off`);
    assert.ok(service.needs.length > 0 && /^https:\/\//.test(service.docs), `${service.kind} says what it needs and where the docs are`);
  }
  assert.throws(() => setSwitch(context.app, "not-a-service", "on"), /no chat service called not-a-service/);
});

test("off never connects, on connects at once, when needed connects to send and lets go when quiet", async () => {
  let position = "off";
  const inner = fakeInner();
  const channel = new SwitchedChannel(inner, { read: () => position, idleMs: 60 });
  await channel.start(async () => undefined);
  assert.equal(inner.starts, 0, "off opens nothing");
  assert.equal(channel.health().state, "needs attention");
  assert.match(channel.health().reason, /Switched off/);
  await assert.rejects(() => channel.send("c", "hi"), /switched off/);
  assert.equal(inner.sent.length, 0);

  position = "when-needed";
  await channel.refresh();
  assert.equal(inner.starts, 0, "when needed opens nothing until there is something to send");
  assert.match(channel.health().reason, /when there is something to send/);
  await channel.send("c", "hello");
  assert.equal(inner.starts, 1, "sending opened the connection");
  assert.deepEqual(inner.sent, [["c", "hello"]]);
  await until(() => inner.stops === 1, "closed again after the quiet spell");

  position = "on";
  await channel.refresh();
  assert.equal(inner.starts, 2, "on opens it straight away");
  position = "off";
  await channel.refresh();
  assert.equal(inner.stops, 2, "switching off closes it");
  await channel.stop();
  assert.equal(isPostedChannel(channel), false, "a polled service is not offered a web address");
});

test("the switch only offers the extras the real channel has, and typing never opens a connection", async () => {
  const plain = new SwitchedChannel(fakeInner(), { read: () => "on" });
  for (const name of ["sendTyping", "edit", "react", "sendButtons", "sendVoice"])
    assert.equal(typeof plain[name], "undefined", `${name} is not offered by a channel that lacks it`);
  const inner = fakeInner();
  const typed = [];
  inner.sendTyping = async (chatId) => { typed.push(chatId); };
  inner.edit = async (chatId, messageId, text) => { inner.sent.push([chatId, `edit ${messageId} ${text}`]); };
  let position = "when-needed";
  const rich = new SwitchedChannel(inner, { read: () => position, idleMs: 1000 });
  await rich.start(async () => undefined);
  await rich.sendTyping("c");
  assert.deepEqual(typed, [], "typing is not worth opening a connection for");
  await rich.edit("c", "m1", "better");
  assert.equal(inner.starts, 1, "an edit opens the connection like a send");
  await rich.sendTyping("c");
  assert.deepEqual(typed, ["c"]);
  position = "off";
  await assert.rejects(() => rich.edit("c", "m1", "again"), /switched off/);
  await rich.stop();
});

test("the card's switches are saved, listed, and applied to a connected channel at once", async (t) => {
  const context = await fixture(t);
  const { app } = context;
  const inner = fakeInner("gotify");
  const channel = new SwitchedChannel(inner, { read: () => paritySwitch(app.store, app.runtime.owner, "gotify") });
  await app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  const server = await startServer(app, { dataDir: join(context.root, "data"), port: 0 });
  t.after(() => server.close());
  const call = (body) => fetch(`${server.url}/api/channels/parity`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const listed = await call();
  assert.equal(listed.status, 200);
  assert.equal(listed.body.services.find((s) => s.kind === "gotify").switch, "off");
  const saved = await call({ gotify: "on" });
  assert.equal(saved.body.services.find((s) => s.kind === "gotify").switch, "on");
  assert.equal(inner.starts, 1, "switching on opened the connected channel without a restart");
  const refused = await call({ gotify: "sideways" });
  assert.equal(refused.status, 400);
  // The old window's card script is checked on its own below (the new window has no More chat apps card).
});

test("a short-lived key can read the chat app switches but never change them", async (t) => {
  const context = await fixture(t);
  const { app } = context;
  const server = await startServer(app, { dataDir: join(context.root, "data"), port: 0 });
  t.after(() => server.close());
  // A "run" key may do things in general, so it is the one this refusal really matters for.
  for (const scope of ["run", "read"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { scope, minutes: 5 });
    const headers = { authorization: `Bearer ${key.token}`, "content-type": "application/json" };
    const listed = await fetch(`${server.url}/api/channels/parity`, { headers });
    assert.equal(listed.status, 200, `a ${scope} key may look`);
    const changed = await fetch(`${server.url}/api/channels/parity`, { method: "POST", headers, body: JSON.stringify({ imessage: "on" }) });
    assert.equal(changed.status, 401, `a ${scope} key may not switch a chat app on`);
    assert.match((await changed.json()).error, /short-lived key cannot switch chat apps/);
  }
  assert.equal(paritySwitch(app.store, app.runtime.owner, "imessage"), "off", "the switch did not move");
});

test("the connections file takes a new service by type, checks its settings, and keeps it off", async (t) => {
  const context = await fixture(t);
  const { app, root } = context;
  const service = await httpService(t, () => ({ body: { id: 7 } }));
  const path = join(root, "connections.json");
  await writeFile(path, JSON.stringify({ web: { allowPrivateAddresses: true }, channels: [{ type: "gotify", id: "phone", server: service.base, pairing: false }] }));
  const loaded = await loadIntegrations(app.registry, path, { GOTIFY_APP_TOKEN: GOTIFY_TOKEN }, app.secretsFor, app.channelHost);
  t.after(() => loaded.close());
  const summary = app.channels.summary().channels.find((c) => c.id === "phone");
  assert.equal(summary.kind, "gotify");
  assert.equal(summary.health.state, "needs attention", "a fresh service is off");
  await assert.rejects(() => app.channels.adapter("phone").send("x", "hi"), /switched off/);
  assert.equal(service.calls.length, 0, "nothing left the computer while it was off");

  const bad = join(root, "bad.json");
  await writeFile(bad, JSON.stringify({ web: { allowPrivateAddresses: true }, channels: [{ type: "gotify", id: "phone2", server: service.base, colour: "red" }] }));
  await assert.rejects(() => loadIntegrations(app.registry, bad, { GOTIFY_APP_TOKEN: GOTIFY_TOKEN }, app.secretsFor, app.channelHost),
    /colour|Unrecognized/i, "an unknown setting is refused by name");
  assert.equal(ParityChannelSchema.safeParse({ type: "telegram", id: "x" }).success, false);
  await assertNoSecret(context, [GOTIFY_TOKEN]);
});

test("a service the network settings do not allow is refused before anything is opened", async () => {
  const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  await assert.rejects(() => buildParityChannel({ type: "irc", id: "irc", server: "irc.example.org", nick: "branch", activation: "mention", pairing: true, allowlist: [] },
    { credential: async () => "x", policy: blocked }), /Not allowed: irc.example.org/);
  await assert.rejects(() => buildParityChannel({ type: "gotify", id: "g", server: "https://push.example.org", activation: "mention", pairing: true, allowlist: [] },
    { credential: async () => "x", policy: blocked }), /Not allowed: push.example.org/);
});

test("Gotify: sends a notification with the app token in a header, and never repeats the token", async (t) => {
  const context = await fixture(t);
  let refuse = false;
  const service = await httpService(t, (call) => (refuse ? { status: 401, body: { error: "unauthorized" } }
    : call.path === "/message" ? { body: { id: 42 } } : undefined));
  const channel = new GotifyChannel({ id: "gotify", server: `${service.base}/`, token: GOTIFY_TOKEN, title: "Branch", priority: 5 });
  assert.equal(await channel.send("ignored", "Your report is ready"), "42");
  assert.equal(service.calls[0].headers["x-gotify-key"], GOTIFY_TOKEN);
  assert.deepEqual(service.calls[0].json, { title: "Branch", message: "Your report is ready", priority: 5 });
  assert.match(channel.health().reason, /cannot hand messages back/);
  refuse = true;
  await assert.rejects(() => channel.send("x", "again"), (error) => !error.message.includes(GOTIFY_TOKEN) && /Gotify refused/.test(error.message));
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  await assertNoSecret(context, [GOTIFY_TOKEN]);
});

test("IRC lines are read the way RFC 2812 and IRCv3 tags write them", () => {
  assert.deepEqual(parseIrcLine(":alice!a@host PRIVMSG #room :hello: there"),
    { tags: {}, prefix: "alice!a@host", command: "PRIVMSG", params: ["#room", "hello: there"] });
  assert.deepEqual(parseIrcLine("@id=abc;display-name=Al\\sB :al!al@tmi PRIVMSG #chan :hi").tags, { id: "abc", "display-name": "Al B" });
  assert.equal(parseIrcLine("PING :tolsun.oulu.fi").params[0], "tolsun.oulu.fi");
  assert.equal(parseIrcLine("   "), null);
  assert.deepEqual(lineChunks("one\n\ntwo words here", 5), ["one", "two", "words", "here"]);
});

/**
 * A small IRC server that records everything. It runs SASL PLAIN and, as IRCv3 capability negotiation
 * requires, holds registration until CAP END: the welcome (001) never arrives mid-negotiation. It used
 * to welcome on USER, so the client joined before SASL was over and the order check below raced
 * (CI run 35453102759). Like a real server it still welcomes after a refused sign-in.
 */
function ircServer(connection, { password } = {}) {
  connection.onLine = (line) => {
    if (line === "CAP REQ :sasl") connection.write(":srv CAP * ACK :sasl");
    else if (line === "CAP REQ :account-tag") connection.write(":srv CAP * ACK :account-tag");
    else if (line === "AUTHENTICATE PLAIN") connection.write("AUTHENTICATE +");
    else if (line.startsWith("AUTHENTICATE ") && line !== "AUTHENTICATE +") {
      const [, , pass] = Buffer.from(line.slice(13), "base64").toString().split("\0");
      connection.write(pass === password ? ":srv 903 branch :SASL authentication successful" : ":srv 904 branch :SASL authentication failed");
    } else if (line === "CAP END") connection.write(":srv 001 branch :Welcome");
  };
}

test("IRC: signs in with SASL, joins, pairs a stranger, answers once approved, and keeps lines apart", async (t) => {
  const context = await fixture(t);
  const server = await lineServer(t, (connection) => ircServer(connection, { password: IRC_PASSWORD }));
  const channel = new IrcChannel({ id: "irc", nick: "branch", channels: ["#room"], password: IRC_PASSWORD,
    dial: socketDial(localSocket(server.port), "irc.example.org", 6697, false), lineGapMs: 5 });
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  t.after(() => channel.stop());
  const link = await until(() => server.connections[0], "a connection");
  await until(() => link.lines.includes("JOIN #room"), "joined after the welcome");
  const signedIn = link.lines.findIndex((l) => l.startsWith("AUTHENTICATE ") && l !== "AUTHENTICATE PLAIN");
  assert.ok(signedIn >= 0 && link.lines.indexOf("CAP END") > signedIn, "SASL finished before the capability talk ended");
  assert.ok(link.lines.indexOf("JOIN #room") > link.lines.indexOf("CAP END"), "no channel is joined before signing in");
  assert.equal(channel.health().state, "connected");
  link.write("PING :keepalive");
  await until(() => link.lines.includes("PONG :keepalive"), "answers a ping");

  const said = () => link.lines.filter((l) => l.startsWith("PRIVMSG ")).map((l) => l.slice(l.indexOf(" :") + 2));
  await pairingWalk(context, { label: "IRC", say: async (text) => link.write(`:carol!c@host PRIVMSG branch :${text}`), sent: said });
  assert.ok(link.lines.some((l) => l.startsWith("PRIVMSG carol :")), "a private message is answered privately");

  // In a channel, only a line addressed to the nick is answered.
  const asked = context.provider.requests.length;
  link.write(":carol!c@host PRIVMSG #room :just chatting");
  await delay(100);
  assert.equal(context.provider.requests.length, asked, "an unaddressed channel line is left alone");
  link.write(":carol!c@host PRIVMSG #room :branch: summarise please");
  await until(() => link.lines.some((l) => /^PRIVMSG #room :Echo: .*summarise please/.test(l)), "answered in the channel");

  // A reply with newlines, or a newline smuggled into a target, never becomes a second command.
  await channel.send("#room\r\nQUIT", "first line\nsecond line");
  await until(() => link.lines.includes("PRIVMSG #room  QUIT :second line"), "each line sent on its own");
  assert.ok(!link.lines.includes("QUIT"), "no injected command");
  await assertNoSecret(context, [IRC_PASSWORD]);
});

test("IRC: a stranger is refused when pairing is off, and a wrong password is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await lineServer(t, (connection) => ircServer(connection, { password: "something-else" }));
  const channel = new IrcChannel({ id: "irc", nick: "branch", channels: ["#room"], password: IRC_PASSWORD,
    dial: socketDial(localSocket(server.port), "irc.example.org", 6697, false), lineGapMs: 5 });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  const link = await until(() => server.connections[0], "a connection");
  await until(() => channel.health().state === "needs attention", "the refused password is reported");
  assert.match(channel.health().reason, /did not accept the saved password/);
  assert.ok(!channel.health().reason.includes(IRC_PASSWORD));
  // The server welcomes after CAP END anyway; the stranger's line below arrives after that welcome.
  await until(() => link.lines.includes("CAP END"), "the capability talk ended");
  const said = () => link.lines.filter((l) => l.startsWith("PRIVMSG ")).map((l) => l.slice(l.indexOf(" :") + 2));
  await refusalWalk(context, { label: "IRC", say: async (text) => link.write(`:mallory!m@host PRIVMSG branch :${text}`), sent: said });
  assert.match(channel.health().reason, /did not accept the saved password/, "the welcome does not hide the refused password");
  assert.ok(!link.lines.includes("JOIN #room"), "no channel is joined without the account");
  await assertNoSecret(context, [IRC_PASSWORD]);
});

test("IRC: a dropped connection is opened again", async (t) => {
  const server = await lineServer(t, (connection) => ircServer(connection));
  const channel = new IrcChannel({ id: "irc", nick: "branch", channels: ["#a"], retryBaseMs: 10,
    dial: socketDial(localSocket(server.port), "irc.example.org", 6667, false) });
  await channel.start(async () => undefined);
  t.after(() => channel.stop());
  const first = await until(() => server.connections[0], "first connection");
  await until(() => first.lines.includes("JOIN #a"), "joined");
  first.socket.destroy();
  const second = await until(() => server.connections[1], "second connection");
  await until(() => second.lines.includes("JOIN #a"), "joined again");
});

test("Twitch chat: IRC inside a WebSocket, with the token sent as PASS and user ids from the tags", async (t) => {
  const context = await fixture(t);
  const service = await socketService(t, (connection) => {
    connection.onMessage = (line) => {
      if (line.startsWith("NICK ")) connection.send(":tmi.twitch.tv 001 branchbot :Welcome, GLHF!");
    };
  }, { json: false });
  const channel = await buildParityChannel({ type: "twitch", id: "twitch", login: "branchbot", channels: ["somestreamer"], address: service.url,
    activation: "mention", pairing: true, allowlist: [] },
  { credential: async () => TWITCH_TOKEN, store: context.app.store, owner: context.app.runtime.owner, connectWs: connectWebSocket });
  setSwitch(context.app, "twitch", "on");
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  t.after(() => channel.stop());
  const link = await until(() => service.connections[0], "a connection");
  await until(() => link.received.includes("JOIN #somestreamer"), "joined the streamer's chat");
  assert.ok(link.received.includes(`PASS oauth:${TWITCH_TOKEN}`));
  assert.ok(link.received.includes("CAP REQ :twitch.tv/tags twitch.tv/commands"));
  const said = () => link.received.filter((l) => l.startsWith("PRIVMSG ")).map((l) => l.slice(l.indexOf(" :") + 2));
  await pairingWalk(context, { label: "Twitch", sent: said, say: async (text) =>
    link.send(`@badge-info=;display-name=Viewer;id=m-${Date.now()};user-id=12345 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #somestreamer :@branchbot ${text}`) });
  const pending = context.app.channels.summary().approved;
  assert.ok(pending.some((person) => person.senderId === "twitch:12345"), "the Twitch user id, not the changeable name, is who was approved");
  await assertNoSecret(context, [TWITCH_TOKEN]);
});

/* Redesign: the More chat apps card is replaced by the "More" tiles of Customize › Channels (public/app/places/
   customize.js channelsTab, family "parity"), each opening the chat-app wizard. */
test("Customize › Channels › More lists every service and fits a 400-pixel-wide window", async (t) => {
  const { chromium } = await import("playwright");
  const context = await fixture(t);
  const server = await startServer(context.app, { dataDir: join(context.root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "attached", timeout: 120000 });
  await page.locator('[data-act="side"]').first().click();
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-place="customize"][data-v="channels"]').click();
  await page.locator('[data-act="ch-fam"][data-v="parity"]').click();
  await page.locator('[data-act="ch-open"]').first().waitFor();
  const tiles = await page.locator('[data-act="ch-open"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v));
  for (const service of parityServices) assert.ok(tiles.includes(service.kind), `${service.kind} has a tile: ${tiles.join(", ")}`);
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    grid: document.querySelector(".ch-grid12").getBoundingClientRect().right,
  }));
  assert.ok(widths.page <= 400, `the page does not scroll sideways (${widths.page})`);
  assert.ok(widths.grid <= 400, `the tiles stay inside the window (${widths.grid})`);
  assert.deepEqual(errors, []);
});

