import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture, until, delay, setSwitch, assertNoSecret, httpService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { MastodonChannel, mastodonText, dropLeadingMentions } from "../dist/channels/mastodon.js";
import { BlueskyChannel } from "../dist/channels/bluesky.js";
import { RedditChannel } from "../dist/channels/reddit.js";
import { DiscourseChannel } from "../dist/channels/discourse.js";
import { XChannel } from "../dist/channels/x-dm.js";
import { TwistChannel } from "../dist/channels/twist.js";

/**
 * The social services (Mastodon, Bluesky, Reddit, Discourse, X, Twist) are tested against stand-in
 * servers that answer the way each service's documentation says. No real service is contacted.
 */
const MASTODON_TOKEN = "SECRET-MASTODON-TOKEN-11";
const BLUESKY_PASSWORD = "SECRET-BSKY-APP-PW-12";
const REDDIT_SECRET = "SECRET-REDDIT-CLIENT-13";
const REDDIT_PASSWORD = "SECRET-REDDIT-PASSWORD-14";
const DISCOURSE_KEY = "SECRET-DISCOURSE-KEY-15";
const X_TOKEN = "SECRET-X-USER-TOKEN-16";
const TWIST_TOKEN = "SECRET-TWIST-TOKEN-17";

const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
const policy = { activation: "mention", pairing: true, allowlist: [] };

/** Attaches a channel, stops it when the test ends, and waits for its first look to finish. */
async function attach(t, context, channel, options = policy) {
  await context.app.channels.attach(channel, options);
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", `${channel.kind}: first look`);
  await delay(60);
}

/**
 * Proves the settings are strict, the network check is asked about the service's own host, and
 * which saved secrets are read. Returns the names asked for.
 */
async function settingsAreChecked(context, config, host, secret) {
  const full = { ...config, activation: "mention", pairing: true, allowlist: [] };
  const asked = [];
  await assert.rejects(() => buildParityChannel(full, { credential: async () => secret, policy: blocked }),
    new RegExp(`Not allowed: ${host.replace(/\./g, "\\.")}`));
  await assert.rejects(() => buildParityChannel({ ...full, token: secret }, { credential: async () => secret }),
    /token|Unrecognized/i, "a secret value is never a setting");
  const built = await buildParityChannel(full, { credential: async (name) => { asked.push(name); return secret; },
    store: context.app.store, owner: context.app.runtime.owner });
  assert.equal(built.health().state, "needs attention", "a new service starts switched off");
  await assert.rejects(() => built.send("1", "hi"), /switched off/);
  return asked;
}

// ---------------------------------------------------------------------------------------------
// Mastodon

function mastodonServer(t, { token = MASTODON_TOKEN } = {}) {
  const notes = [];
  const posts = [];
  let next = 100;
  const account = (id, acct) => ({ id, acct, username: acct.split("@")[0], display_name: acct });
  const mention = (from, text, { visibility = "direct", fromId = "7" } = {}) => {
    const id = String(next++);
    notes.push({ id, type: "mention", account: account(fromId, from),
      status: { id: `9${id}`, visibility, account: account(fromId, from),
        content: `<p><span class="h-card"><a href="https://social.example/@branch" class="u-url mention">@<span>branch</span></a></span> ${text.replace(/&/g, "&amp;")}</p>` } });
  };
  return httpService(t, (call) => {
    if (call.headers.authorization !== `Bearer ${token}`) return { status: 401, body: { error: "The access token is invalid" } };
    if (call.path === "/api/v1/accounts/verify_credentials") return { body: account("1", "branch") };
    if (call.path === "/api/v1/notifications") {
      const since = call.query.since_id ? BigInt(call.query.since_id) : -1n;
      return { body: notes.filter((n) => BigInt(n.id) > since).reverse() };
    }
    if (call.path === "/api/v1/statuses" && call.method === "POST") {
      posts.push(call);
      return { body: { id: `5${posts.length}` } };
    }
    if (call.path.startsWith("/api/v1/statuses/")) {
      const status = notes.map((n) => n.status).find((s) => s.id === call.path.split("/").at(-1));
      return status ? { body: status } : undefined;
    }
    return undefined;
  }).then((service) => ({ ...service, notes, posts, mention }));
}

test("Mastodon: status HTML becomes plain words, and the assistant's own name is dropped", () => {
  assert.equal(mastodonText("<p>one<br>two &amp; &lt;three&gt; &#39;q&#39; &#x1F600;</p><p>next</p>"), "one\ntwo & <three> 'q' 😀\n\nnext");
  assert.equal(mastodonText("<p>&#0; &#99999999; &bogus;</p>"), " &bogus;".trim());
  assert.equal(dropLeadingMentions("@branch @Branch@social.example, hello @branch", "branch"), "hello @branch");
  assert.equal(dropLeadingMentions("@branchy hi", "branch"), "@branchy hi");
});

test("Mastodon: history is left alone, a stranger pairs, and replies mention them with their own visibility", async (t) => {
  const context = await fixture(t);
  const server = await mastodonServer(t);
  server.mention("old@elsewhere.example", "from before Branch started");
  const channel = new MastodonChannel({ id: "mastodon", instance: `${server.base}/`, token: MASTODON_TOKEN, pollMs: 20 });
  await attach(t, context, channel);
  assert.equal(server.posts.length, 0, "the mention from before Branch started is not answered");
  assert.equal(channel.botName(), "branch");

  const said = () => server.posts.map((p) => p.json.status);
  await pairingWalk(context, { label: "Mastodon", say: async (text) => server.mention("carol@other.example", text), sent: said });
  const last = server.posts.at(-1);
  assert.equal(last.json.status, "@carol@other.example Echo: what is the time", "the @mention is not part of the words");
  assert.equal(last.json.visibility, "direct", "a private mention is answered privately");
  assert.equal(last.json.in_reply_to_id, server.notes.at(-1).status.id);
  assert.match(last.headers["idempotency-key"], /^[0-9a-f]{64}$/);

  // A mention by the assistant's own account is never answered.
  const asked = context.provider.requests.length;
  server.mention("branch", "talking to myself", { fromId: "1" });
  await delay(150);
  assert.equal(context.provider.requests.length, asked);

  // A public mention is answered publicly, in the thread, and a long answer's later pieces follow it.
  server.mention("carol@other.example", "a public question", { visibility: "public" });
  await until(() => server.posts.some((p) => p.json.visibility === "public"), "a public answer");
  const publicPost = server.posts.find((p) => p.json.visibility === "public");
  const status = server.notes.at(-1).status.id;
  assert.equal(publicPost.json.in_reply_to_id, status);
  await channel.send(status, "x".repeat(700));
  assert.equal(server.posts.at(-1).json.in_reply_to_id, status, "a piece with no reply target follows the thread");
  assert.ok(server.posts.at(-1).json.status.length <= 500, "the server's limit is kept");
  await assertNoSecret(context, [MASTODON_TOKEN]);
});

test("Mastodon: a stranger is refused when pairing is off, and a refused token is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await mastodonServer(t);
  const channel = new MastodonChannel({ id: "mastodon", instance: server.base, token: MASTODON_TOKEN, pollMs: 20 });
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "Mastodon", say: async (text) => server.mention("mallory@bad.example", text),
    sent: () => server.posts.map((p) => p.json.status) });

  const wrong = await mastodonServer(t, { token: "some-other-token" });
  const refused = new MastodonChannel({ id: "refused", instance: wrong.base, token: MASTODON_TOKEN, pollMs: 20 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /MASTODON_ACCESS_TOKEN/);
  await assertNoSecret(context, [MASTODON_TOKEN]);
});

test("Mastodon: the connections file takes the server and a secret name, and the network check sees the server", async (t) => {
  const context = await fixture(t);
  const server = await mastodonServer(t);
  server.mention("dave@other.example", "an old public question", { visibility: "public" });
  const status = server.notes.at(-1).status.id;
  assert.deepEqual(await settingsAreChecked(context, { type: "mastodon", id: "masto", instance: "https://social.example.org" }, "social.example.org", MASTODON_TOKEN),
    ["MASTODON_ACCESS_TOKEN"]);
  const built = await buildParityChannel({ type: "mastodon", id: "masto", instance: server.base, pollSeconds: 10, ...policy },
    { credential: async (name) => (name === "MASTODON_ACCESS_TOKEN" ? MASTODON_TOKEN : ""), store: context.app.store, owner: context.app.runtime.owner });
  setSwitch(context.app, "mastodon", "on");
  await context.app.channels.attach(built, policy);
  t.after(() => built.stop());
  await until(() => built.health().state === "connected", "connected with the saved token");
  assert.ok(server.calls.every((c) => c.headers.authorization === `Bearer ${MASTODON_TOKEN}` && !c.path.includes(MASTODON_TOKEN)));

  // A long answer, sent through the switch and the waiting line, is split to fit 500 characters and
  // every piece stays in the thread, with the visibility read back from the status after a restart.
  await delay(80);
  assert.equal(server.posts.length, 0, "the question from before the start is not answered");
  await context.app.channels.deliver("masto", status, `${"word ".repeat(180)}end`, "long-answer", status);
  await until(() => server.posts.length >= 2 && server.posts.at(-1).json.status.endsWith("end"), "every piece sent");
  for (const post of server.posts) {
    assert.equal(post.json.in_reply_to_id, status);
    assert.equal(post.json.visibility, "public");
    assert.ok(post.json.status.startsWith("@dave@other.example ") && post.json.status.length <= 500);
  }
  await assertNoSecret(context, [MASTODON_TOKEN]);
});

// ---------------------------------------------------------------------------------------------
// Bluesky

async function blueskyServer(t, { password = BLUESKY_PASSWORD } = {}) {
  const logs = [];
  const sent = [];
  const state = { access: "access-jwt-1", refresh: "refresh-jwt-1", expireNext: false, refreshes: 0 };
  let next = 1;
  const service = await httpService(t, (call) => {
    const name = call.path.replace("/xrpc/", "");
    if (name === "com.atproto.server.createSession") {
      if (call.json?.identifier !== "branch.bsky.social" || call.json?.password !== password)
        return { status: 401, body: { error: "AuthenticationRequired", message: "Invalid identifier or password" } };
      return { body: { accessJwt: state.access, refreshJwt: state.refresh, did: "did:plc:branchbot", handle: "branch.bsky.social" } };
    }
    if (name === "com.atproto.server.refreshSession") {
      if (call.headers.authorization !== `Bearer ${state.refresh}`) return { status: 400, body: { error: "ExpiredToken" } };
      state.refreshes++;
      state.access = `access-jwt-${state.refreshes + 1}`;
      return { body: { accessJwt: state.access, refreshJwt: state.refresh, did: "did:plc:branchbot" } };
    }
    if (call.headers.authorization !== `Bearer ${state.access}`) return { status: 401, body: { error: "AuthenticationRequired" } };
    if (call.headers["atproto-proxy"] !== "did:web:api.bsky.chat#bsky_chat") return { status: 400, body: { error: "InvalidRequest" } };
    if (state.expireNext) { state.expireNext = false; state.access = "spent"; return { status: 400, body: { error: "ExpiredToken" } }; }
    if (name === "chat.bsky.convo.getLog") {
      const from = Number(call.query.cursor ?? 0);
      return { body: { cursor: String(logs.length), logs: logs.slice(from) } };
    }
    if (name === "chat.bsky.convo.sendMessage") {
      sent.push(call.json);
      return { body: { id: `sent-${sent.length}`, rev: "r", text: call.json.message.text, sender: { did: "did:plc:branchbot" } } };
    }
    return undefined;
  });
  const say = (text, { from = "did:plc:carol", convo = "convo-1" } = {}) => logs.push({
    $type: "chat.bsky.convo.defs#logCreateMessage", rev: String(next), convoId: convo,
    message: { $type: "chat.bsky.convo.defs#messageView", id: `m${next++}`, rev: "r", text, sender: { did: from }, sentAt: new Date().toISOString() },
  });
  return { ...service, logs, sent, state, say };
}

test("Bluesky: the chat log is read from where it stands, a stranger pairs, and a spent token is renewed", async (t) => {
  const context = await fixture(t);
  const server = await blueskyServer(t);
  server.say("an old message");
  const channel = new BlueskyChannel({ id: "bluesky", handle: "branch.bsky.social", password: BLUESKY_PASSWORD, service: server.base, pollMs: 20 });
  await attach(t, context, channel);
  assert.equal(server.sent.length, 0, "the message from before Branch started is not answered");

  const said = () => server.sent.map((m) => m.message.text);
  await pairingWalk(context, { label: "Bluesky", say: async (text) => server.say(text), sent: said });
  assert.ok(server.sent.every((m) => m.convoId === "convo-1"), "answered in the conversation it came from");
  assert.ok(context.app.channels.summary().approved.some((p) => p.channel === "bluesky" && p.senderId === "did:plc:carol"), "the person is their did");

  const asked = context.provider.requests.length;
  server.say("a note from the assistant itself", { from: "did:plc:branchbot" });
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "the assistant's own message is not answered");

  server.state.expireNext = true;
  server.say("still there?");
  await until(() => said().some((text) => /Echo:.*still there/.test(text)), "answered after the token was renewed");
  assert.equal(server.state.refreshes, 1);
  await channel.send("convo-1", "y".repeat(1500));
  assert.equal(server.sent.at(-1).message.text.length, 1000, "cut at Bluesky's limit");
  await assertNoSecret(context, [BLUESKY_PASSWORD, "access-jwt-", "refresh-jwt-1"]);
});

test("Bluesky: a stranger is refused when pairing is off, and a refused app password is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await blueskyServer(t);
  const channel = new BlueskyChannel({ id: "bluesky", handle: "branch.bsky.social", password: BLUESKY_PASSWORD, service: server.base, pollMs: 20 });
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "Bluesky", say: async (text) => server.say(text, { from: "did:plc:mallory" }),
    sent: () => server.sent.map((m) => m.message.text) });

  const wrong = await blueskyServer(t, { password: "another-password" });
  const refused = new BlueskyChannel({ id: "refused", handle: "branch.bsky.social", password: BLUESKY_PASSWORD, service: wrong.base, pollMs: 20, passwordName: "BSKY_PW" });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /app password .* BSKY_PW/);
  await assertNoSecret(context, [BLUESKY_PASSWORD]);
});

test("Bluesky: settings take a handle and a secret name, and the network check sees bsky.social", async (t) => {
  const context = await fixture(t);
  assert.deepEqual(await settingsAreChecked(context, { type: "bluesky", id: "sky", handle: "branch.bsky.social" }, "bsky.social", BLUESKY_PASSWORD),
    ["BLUESKY_APP_PASSWORD"]);
});

// ---------------------------------------------------------------------------------------------
// Reddit

async function redditServer(t, { password = REDDIT_PASSWORD } = {}) {
  const inbox = [];
  const comments = [];
  const state = { grants: 0, token: "", expireNext: false, agents: new Set() };
  let next = 1;
  const service = await httpService(t, (call) => {
    state.agents.add(call.headers["user-agent"]);
    if (call.path === "/api/v1/access_token") {
      const basic = Buffer.from(`abcdefghij12:${REDDIT_SECRET}`).toString("base64");
      if (call.headers.authorization !== `Basic ${basic}`) return { status: 401, body: { message: "Unauthorized" } };
      if (call.form?.grant_type !== "password" || call.form.username !== "branchbot" || call.form.password !== password)
        return { body: { error: "invalid_grant" } };
      state.grants++;
      state.token = `reddit-bearer-${state.grants}`;
      return { body: { access_token: state.token, token_type: "bearer", expires_in: 3600, scope: "*" } };
    }
    if (call.headers.authorization !== `Bearer ${state.token}`) return { status: 401, body: { message: "Unauthorized" } };
    if (state.expireNext) { state.expireNext = false; state.token = "gone"; return { status: 401, body: { message: "Unauthorized" } }; }
    if (call.path === "/message/unread") return { body: { kind: "Listing", data: { children: inbox.filter((i) => !i.read).map(({ read, ...item }) => item).reverse() } } };
    if (call.path === "/api/read_message") { for (const i of inbox) if (i.data.name === call.form.id) i.read = true; return { body: {} }; }
    if (call.path === "/api/comment") {
      comments.push(call.form);
      return { body: { json: { errors: [], data: { things: [{ kind: "t1", data: { name: `t1_reply${comments.length}` } }] } } } };
    }
    return undefined;
  });
  const say = (text, { kind = "t4", author = "carol" } = {}) => {
    const name = `${kind}_${(next++).toString(36)}`;
    inbox.push({ kind, read: false, data: { name, author, author_fullname: `t2_${author}`, body: text,
      subject: kind === "t4" ? "hello" : "username mention", subreddit: kind === "t4" ? null : "branchtest" } });
    return name;
  };
  return { ...service, inbox, comments, state, say };
}

function redditChannel(server, extra = {}) {
  return new RedditChannel({ id: "reddit", clientId: "abcdefghij12", clientSecret: REDDIT_SECRET, username: "branchbot",
    password: REDDIT_PASSWORD, userAgent: "test:branch-agent:1.0 (by /u/branchbot)", authBase: server.base, apiBase: server.base, pollMs: 20, ...extra });
}

test("Reddit: waiting mail is left alone, a stranger pairs, and every answer replies to the exact message", async (t) => {
  const context = await fixture(t);
  const server = await redditServer(t);
  const old = server.say("from before Branch started");
  const channel = redditChannel(server);
  await attach(t, context, channel);
  assert.equal(server.comments.length, 0, "the waiting message is not answered");
  assert.equal(server.inbox.find((i) => i.data.name === old).read, false, "and it is left unread for the owner");

  const said = () => server.comments.map((c) => c.text);
  const names = [];
  await pairingWalk(context, { label: "Reddit", say: async (text) => { names.push(server.say(text)); }, sent: said });
  assert.deepEqual(server.comments.map((c) => c.thing_id), names, "each answer replies to the private message it answers");
  assert.ok(server.inbox.filter((i) => names.includes(i.data.name)).every((i) => i.read), "answered mail is marked read");
  assert.deepEqual([...server.state.agents], ["test:branch-agent:1.0 (by /u/branchbot)"], "every call says what it is");

  // A mention in a thread is answered in that thread, without the username in the words.
  server.state.expireNext = true;
  const mention = server.say("u/branchbot what is new", { kind: "t1", author: "carol" });
  await until(() => server.comments.some((c) => c.thing_id === mention), "answered under the mention");
  assert.match(server.comments.at(-1).text, /Echo: .*what is new/);
  assert.ok(!/u\/branchbot/.test(server.comments.at(-1).text));
  assert.equal(server.state.grants, 2, "an expired token was replaced");
  await channel.send(mention, "a later piece");
  assert.equal(server.comments.at(-1).thing_id, mention, "a piece with no reply target follows the thread");

  const asked = context.provider.requests.length;
  server.say("my own message", { author: "branchbot" });
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "the assistant's own message is not answered");
  await assertNoSecret(context, [REDDIT_SECRET, REDDIT_PASSWORD, "reddit-bearer-"]);
});

test("Reddit: a stranger is refused when pairing is off, and a refused password is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await redditServer(t);
  const channel = redditChannel(server);
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "Reddit", say: async (text) => server.say(text, { author: "mallory" }), sent: () => server.comments.map((c) => c.text) });

  const wrong = await redditServer(t, { password: "another" });
  const refused = redditChannel(wrong);
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /REDDIT_PASSWORD/);
  await assertNoSecret(context, [REDDIT_SECRET, REDDIT_PASSWORD]);
});

test("Reddit: settings take the app id and secret names, and the network check sees reddit.com", async (t) => {
  const context = await fixture(t);
  assert.deepEqual(await settingsAreChecked(context, { type: "reddit", id: "reddit", username: "branchbot", clientId: "abcdefghij12" }, "www.reddit.com", REDDIT_SECRET),
    ["REDDIT_CLIENT_SECRET", "REDDIT_PASSWORD"]);
  const apiBlocked = { assertAllowed: async (url) => { if (url.hostname !== "www.reddit.com") throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  await assert.rejects(() => buildParityChannel({ type: "reddit", id: "reddit", username: "branchbot", clientId: "abcdefghij12", ...policy },
    { credential: async () => "x", policy: apiBlocked }), /Not allowed: oauth\.reddit\.com/);
  await assert.rejects(() => buildParityChannel({ type: "reddit", id: "reddit", username: "branchbot", clientId: "abcdefghij12", password: "x", ...policy },
    { credential: async () => "x" }), /password|Unrecognized/i);
});

// ---------------------------------------------------------------------------------------------
// Discourse

async function discourseServer(t, { key = DISCOURSE_KEY } = {}) {
  const notes = [];
  const posts = new Map();
  const made = [];
  let nextNote = 1, nextPost = 500;
  const service = await httpService(t, (call) => {
    if (call.headers["api-key"] !== key || call.headers["api-username"] !== "branch") return { status: 403, body: { errors: ["invalid key"] } };
    if (call.path === "/notifications.json") return { body: { notifications: [...notes].reverse() } };
    if (call.path === "/notifications/mark-read.json" && call.method === "PUT") {
      for (const n of notes) if (n.id === call.json.id) n.read = true;
      return { body: { success: "OK" } };
    }
    const post = /^\/posts\/(\d+)\.json$/.exec(call.path);
    if (post) return posts.has(Number(post[1])) ? { body: posts.get(Number(post[1])) } : undefined;
    const topic = /^\/t\/(\d+)\/(\d+)\.json$/.exec(call.path);
    if (topic) return { body: { post_stream: { posts: [...posts.values()].filter((p) => p.topic_id === Number(topic[1])).map(({ raw, ...p }) => p) } } };
    if (call.path === "/posts.json" && call.method === "POST") { made.push(call.json); return { body: { id: 9000 + made.length } }; }
    return undefined;
  });
  const say = (text, { topic = 50, type = 6, userId = 9, username = "carol", byId = true } = {}) => {
    const id = nextPost++;
    const postNumber = [...posts.values()].filter((p) => p.topic_id === topic).length + 1;
    posts.set(id, { id, user_id: userId, username, name: username, raw: text, topic_id: topic, post_number: postNumber, topic_title: `Topic ${topic}` });
    notes.push({ id: nextNote++, notification_type: type, read: false, topic_id: topic, post_number: postNumber,
      data: byId ? { original_post_id: id, original_username: username } : { original_username: username } });
    return { id, postNumber };
  };
  return { ...service, notes, posts, made, say };
}

test("Discourse: old notifications are left alone, a stranger pairs by private message, and mentions are answered in their topic", async (t) => {
  const context = await fixture(t);
  const server = await discourseServer(t);
  server.say("from before Branch started");
  const channel = new DiscourseChannel({ id: "forum", forum: server.base, username: "branch", apiKey: DISCOURSE_KEY, pollMs: 20 });
  await attach(t, context, channel);
  assert.equal(server.made.length, 0, "the old notification is not answered");

  const said = () => server.made.map((p) => p.raw);
  let last;
  await pairingWalk(context, { label: "Discourse", say: async (text) => { last = server.say(text); }, sent: said });
  assert.ok(server.made.every((p) => p.topic_id === 50), "answered in the private message topic");
  assert.equal(server.made.at(-1).reply_to_post_number, last.postNumber);
  assert.ok(server.notes.every((n) => n.id === 1 || n.read), "handled notifications are marked read");
  assert.ok(context.app.channels.summary().approved.some((p) => p.channel === "forum" && p.senderId === "9"), "the person is their forum user id");

  // A mention in a public topic, found through the topic because the notification has no post id.
  const mention = server.say("@branch could you look at this", { topic: 60, type: 1, byId: false });
  await until(() => server.made.some((p) => p.topic_id === 60), "answered in the topic");
  assert.equal(server.made.at(-1).reply_to_post_number, mention.postNumber);
  assert.match(server.made.at(-1).raw, /Echo: .*could you look at this/);
  assert.ok(!server.made.at(-1).raw.includes("@branch"));

  const asked = context.provider.requests.length;
  server.say("my own post", { topic: 60, type: 2, userId: 1, username: "branch" });
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "the assistant's own post is not answered");
  await assertNoSecret(context, [DISCOURSE_KEY]);
});

test("Discourse: a stranger is refused when pairing is off, and a refused key is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await discourseServer(t);
  const channel = new DiscourseChannel({ id: "forum", forum: server.base, username: "branch", apiKey: DISCOURSE_KEY, pollMs: 20 });
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "Discourse", say: async (text) => server.say(text, { userId: 13, username: "mallory" }),
    sent: () => server.made.map((p) => p.raw) });

  const wrong = await discourseServer(t, { key: "another-key" });
  const refused = new DiscourseChannel({ id: "refused", forum: wrong.base, username: "branch", apiKey: DISCOURSE_KEY, pollMs: 20 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /DISCOURSE_API_KEY/);
  await assert.rejects(() => channel.send("not-a-topic", "hi"), /not a forum topic/);
  await assertNoSecret(context, [DISCOURSE_KEY]);
});

test("Discourse: settings take the forum and a secret name, and the network check sees the forum", async (t) => {
  const context = await fixture(t);
  assert.deepEqual(await settingsAreChecked(context, { type: "discourse", id: "forum", forum: "https://forum.example.org", username: "branch" }, "forum.example.org", DISCOURSE_KEY),
    ["DISCOURSE_API_KEY"]);
});

// ---------------------------------------------------------------------------------------------
// X

async function xServer(t, { token = X_TOKEN, forbidden = false } = {}) {
  const events = [];
  const sent = [];
  let next = 1000;
  const service = await httpService(t, (call) => {
    if (call.headers.authorization !== `Bearer ${token}`) return { status: 401, body: { title: "Unauthorized" } };
    if (forbidden) return { status: 403, body: { title: "Forbidden" } };
    if (call.path === "/2/users/me") return { body: { data: { id: "100", username: "branchbot", name: "Branch" } } };
    if (call.path === "/2/dm_events") {
      assert.equal(call.query.event_types, "MessageCreate");
      return { body: { data: [...events].reverse(), meta: { result_count: events.length } } };
    }
    const conversation = /^\/2\/dm_conversations\/([\d-]+)\/messages$/.exec(call.path);
    if (conversation && call.method === "POST") {
      sent.push({ conversation: conversation[1], text: call.json.text });
      return { status: 201, body: { data: { dm_conversation_id: conversation[1], dm_event_id: String(next++) } } };
    }
    return undefined;
  });
  const say = (text, { from = "200", conversation = "100-200" } = {}) => events.push({
    id: String(next++), event_type: "MessageCreate", text, sender_id: from, dm_conversation_id: conversation, created_at: new Date().toISOString(),
  });
  return { ...service, events, sent, say };
}

test("X: older messages are left alone, a stranger pairs, and groups are answered only when named", async (t) => {
  const context = await fixture(t);
  const server = await xServer(t);
  server.say("from before Branch started");
  const channel = new XChannel({ id: "x", token: X_TOKEN, api: server.base, pollMs: 20 });
  await attach(t, context, channel);
  assert.equal(server.sent.length, 0, "the old message is not answered");

  const said = () => server.sent.map((m) => m.text);
  await pairingWalk(context, { label: "X", say: async (text) => server.say(text), sent: said });
  assert.ok(server.sent.every((m) => m.conversation === "100-200"), "answered in the conversation it came from");

  const asked = context.provider.requests.length;
  server.say("sent by the assistant", { from: "100" });
  server.say("just chatting in the group", { conversation: "777" });
  await delay(150);
  assert.equal(context.provider.requests.length, asked, "its own message and an unaddressed group message are left alone");
  server.say("@branchbot what now", { conversation: "777" });
  await until(() => server.sent.some((m) => m.conversation === "777" && /Echo: .*what now/.test(m.text)), "answered in the group");
  await assert.rejects(() => channel.send("../2/tweets", "hi"), /not an X conversation/);
  await assertNoSecret(context, [X_TOKEN]);
});

test("X: a stranger is refused when pairing is off, and a plan without direct messages is named", async (t) => {
  const context = await fixture(t);
  const server = await xServer(t);
  const channel = new XChannel({ id: "x", token: X_TOKEN, api: server.base, pollMs: 20 });
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "X", say: async (text) => server.say(text, { from: "300", conversation: "100-300" }), sent: () => server.sent.map((m) => m.text) });

  const paywalled = await xServer(t, { forbidden: true });
  const refused = new XChannel({ id: "refused", token: X_TOKEN, api: paywalled.base, pollMs: 20 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /paid X API plan/);
  await assertNoSecret(context, [X_TOKEN]);
});

test("X: settings take a secret name, and the network check sees api.x.com", async (t) => {
  const context = await fixture(t);
  assert.deepEqual(await settingsAreChecked(context, { type: "x-dm", id: "x" }, "api.x.com", X_TOKEN), ["X_USER_ACCESS_TOKEN"]);
});

// ---------------------------------------------------------------------------------------------
// Twist

async function twistServer(t, { token = TWIST_TOKEN } = {}) {
  const messages = [];
  const sent = [];
  let next = 1;
  const service = await httpService(t, (call) => {
    if (call.headers.authorization !== `Bearer ${token}`) return { status: 401, body: { error_string: "Invalid token" } };
    if (call.path === "/api/v3/users/get_session_user") return { body: { id: 1, name: "Branch" } };
    if (call.path === "/api/v3/conversations/getone")
      return { body: { id: Number(call.query.id), user_ids: call.query.id === "10" ? [1, 2] : [1, 2, 3], title: "Team" } };
    if (call.path === "/api/v3/conversation_messages/get") {
      const since = Number(call.query.newer_than_ts ?? -1);
      return { body: messages.filter((m) => m.conversation_id === Number(call.query.conversation_id) && m.posted_ts > since) };
    }
    if (call.path === "/api/v3/conversation_messages/add" && call.method === "POST") {
      sent.push(call.form);
      return { body: { id: 9000 + sent.length, content: call.form.content } };
    }
    return undefined;
  });
  const say = (text, { conversation = 10, creator = 2 } = {}) => messages.push({
    id: next++, content: text, creator, creator_name: `user ${creator}`, conversation_id: conversation, posted_ts: Math.floor(Date.now() / 1000),
  });
  return { ...service, messages, sent, say };
}

test("Twist: older messages are left alone, a stranger pairs, and a team conversation needs a mention", async (t) => {
  const context = await fixture(t);
  const server = await twistServer(t);
  server.say("from before Branch started");
  const channel = new TwistChannel({ id: "twist", token: TWIST_TOKEN, conversations: [10, 20], api: server.base, pollMs: 20 });
  await attach(t, context, channel);
  assert.equal(server.sent.length, 0, "the old message is not answered");

  const said = () => server.sent.map((m) => m.content);
  await pairingWalk(context, { label: "Twist", say: async (text) => server.say(text), sent: said });
  assert.ok(server.sent.every((m) => m.conversation_id === "10"), "answered in the conversation it came from");
  assert.equal(said().filter((text) => /Echo:.*what is the time/.test(text)).length, 1, "a message is answered once");

  const asked = context.provider.requests.length;
  server.say("sent by the assistant", { creator: 1 });
  server.say("just chatting", { conversation: 20 });
  await delay(150);
  assert.equal(context.provider.requests.length, asked, "its own message and an unaddressed team message are left alone");
  server.say("[Branch](twist-mention://1) any news?", { conversation: 20 });
  await until(() => server.sent.some((m) => m.conversation_id === "20" && /Echo: .*any news/.test(m.content)), "answered in the team conversation");
  assert.ok(!server.sent.at(-1).content.includes("twist-mention"));
  await assertNoSecret(context, [TWIST_TOKEN]);
});

test("Twist: a stranger is refused when pairing is off, and a refused token is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await twistServer(t);
  const channel = new TwistChannel({ id: "twist", token: TWIST_TOKEN, conversations: [10], api: server.base, pollMs: 20 });
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "Twist", say: async (text) => server.say(text, { creator: 5 }), sent: () => server.sent.map((m) => m.content) });

  const wrong = await twistServer(t, { token: "another-token" });
  const refused = new TwistChannel({ id: "refused", token: TWIST_TOKEN, conversations: [10], api: wrong.base, pollMs: 20 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /TWIST_ACCESS_TOKEN/);
  await assertNoSecret(context, [TWIST_TOKEN]);
});

test("Twist: settings take the conversations and a secret name, and the network check sees api.twist.com", async (t) => {
  const context = await fixture(t);
  assert.deepEqual(await settingsAreChecked(context, { type: "twist", id: "twist", conversations: [10] }, "api.twist.com", TWIST_TOKEN), ["TWIST_ACCESS_TOKEN"]);
  await assert.rejects(() => buildParityChannel({ type: "twist", id: "twist", conversations: [], ...policy }, { credential: async () => "x" }), /conversations|too_small|at least/i);
});
