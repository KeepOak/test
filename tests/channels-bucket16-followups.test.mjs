import test from "node:test";
import assert from "node:assert/strict";
import { connect as tcpConnect } from "node:net";
import { fixture, until, delay, httpService, lineServer, socketService } from "./channels-parity-kit.mjs";
import { channelMark, MarkKeeper } from "../dist/channels/catch-up.js";
import { MastodonChannel } from "../dist/channels/mastodon.js";
import { MatrixAdapter } from "../dist/channels/matrix.js";
import { GuildedChannel } from "../dist/channels/guilded.js";
import { IrcChannel, socketDial, ircAccount } from "../dist/channels/irc.js";
import { buildParityChannel } from "../dist/channels/parity-config.js";

/**
 * mac6/bucket-16 follow-ups: chat apps other than Telegram catch up on what arrived while Branch was
 * closed; Guilded gets its own heartbeat; IRC knows people by their signed-in account.
 */
const open = (lines) => ({ activation: "mention", pairing: false, allowlist: lines });

function memoryMark(initial = null) {
  const mark = { value: initial, saves: [], load: () => mark.value, save: (value) => { mark.saves.push(value); mark.value = value; } };
  return mark;
}

test("a saved place is read back, and one that is too old or too long is ignored", async (t) => {
  const { app } = await fixture(t);
  let now = Date.parse("2026-09-17T10:00:00Z");
  const mark = channelMark(app.store, "masto", app.runtime.owner, { now: () => now });
  assert.equal(mark.load(), null, "nothing saved yet");
  mark.save("12345");
  assert.equal(channelMark(app.store, "masto", app.runtime.owner, { now: () => now }).load(), "12345", "survives a new reader");
  assert.equal(channelMark(app.store, "other", app.runtime.owner).load(), null, "each channel has its own place");
  now += 25 * 60 * 60_000;
  assert.equal(mark.load(), null, "a place more than a day old is not trusted");
  mark.save("x".repeat(3000));
  assert.equal(mark.load(), null, "an oversized place is never written");
  assert.equal(channelMark(null, "masto"), undefined, "no store, no place");
});

test("a place is saved only when every message before it has been answered, and never goes back", async () => {
  const mark = memoryMark();
  const keeper = new MarkKeeper(mark);
  let finishFirst;
  const slow = new Promise((resolve) => { finishFirst = resolve; });
  const first = keeper.after("p1", [slow]);
  const second = keeper.after("p2", [Promise.resolve()]);
  await second;
  assert.deepEqual(mark.saves, [], "p2 waits for the slower batch before it");
  finishFirst();
  await first;
  assert.deepEqual(mark.saves, ["p2"], "both done: the newest place is saved once");
  await keeper.after("p3", [Promise.reject(new Error("the answer failed"))]);
  assert.deepEqual(mark.saves, ["p2", "p3"], "a failed answer still settles, as the ledger keeps the reply");
  await keeper.after(null, []);
  assert.deepEqual(mark.saves, ["p2", "p3"]);
});

function mastodonWorld(t) {
  const notes = [];
  let next = 100;
  const account = { id: "7", acct: "carol@other.example", username: "carol", display_name: "Carol" };
  const mention = (text) => {
    const id = String(next++);
    notes.push({ id, type: "mention", account, status: { id: `9${id}`, visibility: "direct", account, content: `<p>@branch ${text}</p>` } });
  };
  const posts = [];
  return httpService(t, (call) => {
    if (call.path === "/api/v1/accounts/verify_credentials") return { body: { id: "1", acct: "branch", username: "branch", display_name: "Branch" } };
    if (call.path === "/api/v1/notifications") {
      const since = call.query.since_id ? BigInt(call.query.since_id) : -1n;
      return { body: notes.filter((n) => BigInt(n.id) > since).reverse() };
    }
    if (call.path === "/api/v1/statuses" && call.method === "POST") { posts.push(call.json.status); return { body: { id: `5${posts.length}` } }; }
    return undefined;
  }).then((server) => ({ ...server, mention, posts }));
}

test("Mastodon: after a restart the mentions that arrived meanwhile are answered once, and older ones are not", async (t) => {
  const context = await fixture(t);
  const world = await mastodonWorld(t);
  world.mention("left from before Branch ever ran");
  const place = () => channelMark(context.app.store, "mastodon", context.app.runtime.owner);
  const first = new MastodonChannel({ id: "mastodon", instance: world.base, token: "t", pollMs: 20 });
  first.catchUp = place();
  await context.app.channels.attach(first, open(["7"]));
  await until(() => first.health().state === "connected", "first look");
  world.mention("first question");
  await until(() => world.posts.some((p) => /first question/.test(p)), "answered while running");
  await until(() => place().load() === "101", "the place is saved after the answer");
  await context.app.channels.detachAll();

  world.mention("sent while Branch was closed");
  const second = new MastodonChannel({ id: "mastodon", instance: world.base, token: "t", pollMs: 20 });
  second.catchUp = place();
  await context.app.channels.attach(second, open(["7"]));
  t.after(() => second.stop());
  await until(() => world.posts.some((p) => /sent while Branch was closed/.test(p)), "the missed mention is answered");
  await delay(120);
  assert.equal(world.posts.filter((p) => /first question/.test(p)).length, 1, "nothing is answered twice");
  assert.ok(!world.posts.some((p) => /left from before/.test(p)), "history from before the first run is still left alone");
});

test("Mastodon without a saved place still takes stock first, exactly as before", async (t) => {
  const context = await fixture(t);
  const world = await mastodonWorld(t);
  world.mention("old news");
  const channel = new MastodonChannel({ id: "mastodon", instance: world.base, token: "t", pollMs: 20 });
  channel.catchUp = memoryMark(null);
  await context.app.channels.attach(channel, open(["7"]));
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "first look");
  await delay(120);
  assert.deepEqual(world.posts, []);
});

test("a service built from the connections file is handed its saved place", async (t) => {
  const context = await fixture(t);
  const host = { credential: async () => "x", store: context.app.store, owner: context.app.runtime.owner };
  const built = await buildParityChannel({ type: "mastodon", id: "masto", instance: "https://social.example.org", ...open([]) }, host);
  assert.ok(built.inner.catchUp, "a polled service gets a place");
  built.inner.catchUp.save("42");
  assert.equal(channelMark(context.app.store, "masto", context.app.runtime.owner).load(), "42");
  const irc = await buildParityChannel({ type: "irc", id: "irc", server: "irc.example.org", nick: "b", ...open([]) }, host);
  assert.equal("catchUp" in irc.inner, false, "a service with no history to fetch is left as it was");
});

test("Matrix: the sync carries on from the saved token after a restart and saves the next one", async (t) => {
  const context = await fixture(t);
  const asked = [];
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const address = new URL(url);
    if (init.method === "PUT") { sent.push(JSON.parse(init.body).body); return Response.json({ event_id: "$out" }); }
    asked.push(address.searchParams.get("since"));
    if (asked.length === 1) return Response.json({ next_batch: "s2", rooms: { join: { "!room:ex.org": { timeline: { events: [
      { type: "m.room.message", event_id: "$e1", sender: "@carol:ex.org", content: { msgtype: "m.text", body: "branch while you were away" } },
    ] } } } } });
    await delay(30);
    return Response.json({ next_batch: `s${asked.length + 1}` });
  };
  const mark = memoryMark("s1");
  let answeredBeforeSave = null;
  const save = mark.save;
  mark.save = (value) => { answeredBeforeSave ??= sent.some((text) => /while you were away/.test(text)); save(value); };
  const channel = new MatrixAdapter({ id: "matrix", homeserver: "https://ex.org", userId: "@branch:ex.org", accessToken: "t",
    fetch: fetchImpl, mark, syncTimeoutMs: 10 });
  await context.app.channels.attach(channel, { activation: "always", pairing: false, allowlist: ["@carol:ex.org"] });
  t.after(() => channel.stop());
  await until(() => sent.some((text) => /while you were away/.test(text)), "the missed message is answered");
  assert.equal(asked[0], "s1", "the first sync starts from the saved token");
  await until(() => mark.saves.length > 0, "a token is saved once the message is answered");
  // Later empty syncs may finish first under load; the newest settled token is the one saved.
  assert.ok(Number(mark.saves[0].slice(1)) >= 2, `the saved token moved on from s1 (${mark.saves[0]})`);
  assert.ok(answeredBeforeSave, "nothing was saved before the missed message had been answered");
});

test("Guilded: a restart asks for what was missed, and a ping that goes unanswered reopens the socket", async (t) => {
  const context = await fixture(t);
  let pongs = true;
  const api = await httpService(t, () => ({ body: { message: { id: "out" } } }));
  const events = await socketService(t, (connection) => {
    connection.pings = 0;
    connection.socket.on("data", (chunk) => {
      if ((chunk[0] & 0x0f) !== 0x9) return;
      connection.pings++;
      if (pongs) connection.socket.write(Buffer.from([0x8a, 0x00]));
    });
    // mac7/linux-fixes: the welcome's interval is also the whole budget for a ping to come back,
    // because a ping still unanswered when the next one is due closes the socket. At 40ms that
    // was a race with the event loop, and on a busy two-processor machine the pong lost it: the
    // first socket was dropped before it had sent two pings. 400ms asks the same questions with
    // room for a stall.
    connection.send({ op: 1, d: { heartbeatIntervalMs: 400, lastMessageId: "server-latest", user: { id: "GBOT", name: "Branch" } } });
  });
  const mark = memoryMark("gm-saved");
  const channel = new GuildedChannel({ id: "guilded", token: "t", apiBase: api.base, socketUrl: events.url, retryBaseMs: 20, minHeartbeatMs: 30 });
  channel.catchUp = mark;
  await context.app.channels.attach(channel, open(["USER1"]));
  t.after(() => channel.stop());
  const link = await until(() => events.connections[0], "a socket");
  assert.equal(link.headers["guilded-last-message-id"], "gm-saved", "the first connection asks for what was missed");
  link.send({ op: 0, t: "ChatMessageCreated", s: "gm-9", d: { message: { id: "gm-9", channelId: "CH1", createdBy: "USER1",
    content: "@Branch hello", mentions: { users: [{ id: "GBOT" }] } } } });
  await until(() => mark.saves.includes("gm-9"), "the message id is saved once answered");
  await until(() => link.pings >= 2, "pings are sent at the welcome's interval");
  pongs = false;
  await until(() => events.connections[1], "an unanswered ping closes the socket and it is opened again");
  assert.equal(events.connections[1].headers["guilded-last-message-id"], "gm-9");
});

/** An IRC stand-in that supports account-tag, and SASL when given a password. */
function accountServer(connection) {
  connection.onLine = (line) => {
    if (line === "CAP REQ :account-tag") connection.write(":srv CAP * ACK :account-tag");
    else if (line === "CAP END") connection.write(":srv 001 branch :Welcome");
  };
}

test("IRC: people signed in to the network are known by account, not by a nick anyone can take", async (t) => {
  assert.equal(ircAccount("alice", "al"), "account:alice");
  assert.equal(ircAccount("*", "al"), "al", "`*` means not signed in");
  assert.equal(ircAccount(undefined, "al"), "al");
  assert.equal(ircAccount("bad name", "al"), "al");

  const context = await fixture(t);
  const server = await lineServer(t, accountServer);
  const local = async () => new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: "127.0.0.1", port: server.port }, () => resolve(socket));
    socket.once("error", reject);
  });
  const channel = new IrcChannel({ id: "irc", nick: "branch", channels: [], dial: socketDial(local, "irc.example.org", 6667, false), lineGapMs: 5 });
  await context.app.channels.attach(channel, open(["account:alice"]));
  t.after(() => channel.stop());
  const link = await until(() => server.connections[0], "a connection");
  await until(() => channel.health().state === "connected", "welcomed after CAP END");
  assert.ok(link.lines.indexOf("CAP REQ :account-tag") < link.lines.indexOf("CAP END"));
  const answered = () => link.lines.filter((l) => l.startsWith("PRIVMSG "));

  link.write("@account=mallory :alice!m@evil PRIVMSG branch :i am alice, honest");
  link.write(":alice!m@evil PRIVMSG branch :no account at all");
  await delay(400);
  // UP-CHAT-008: both impostors are strangers, turned away in silence.
  assert.equal(answered().length, 0, "a nick alone is not the account");
  assert.equal(context.provider.requests.length, 0);

  link.write("@account=alice :al2!a@home PRIVMSG branch :hello from my other nick");
  await until(() => answered().some((l) => /^PRIVMSG al2 :Echo: .*hello from my other nick/.test(l)), "the account is answered under any nick");
});

test("IRC: a server that answers both capability requests on one line still signs in with SASL", async (t) => {
  const server = await lineServer(t, (connection) => {
    connection.onLine = (line) => {
      if (line === "CAP REQ :sasl") connection.write(":srv CAP * ACK :account-tag sasl");
      else if (line === "AUTHENTICATE PLAIN") connection.write("AUTHENTICATE +");
      else if (line.startsWith("AUTHENTICATE ") && line !== "AUTHENTICATE +") connection.write(":srv 903 branch :SASL authentication successful");
      else if (line === "CAP END") connection.write(":srv 001 branch :Welcome");
    };
  });
  const local = async () => new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: "127.0.0.1", port: server.port }, () => resolve(socket));
    socket.once("error", reject);
  });
  const channel = new IrcChannel({ id: "irc", nick: "branch", channels: [], password: "pw", dial: socketDial(local, "irc.example.org", 6697, false) });
  await channel.start(async () => undefined);
  t.after(() => channel.stop());
  const link = await until(() => server.connections[0], "a connection");
  await until(() => channel.health().state === "connected", "signed in and welcomed");
  assert.ok(link.lines.indexOf("AUTHENTICATE PLAIN") < link.lines.indexOf("CAP END"));
});
