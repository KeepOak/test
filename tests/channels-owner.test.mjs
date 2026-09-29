/**
 * mac7/channels-owner: the chat apps belong to the owner, so every address under /api/channels is
 * theirs.
 *
 * Before this, only `/api/channels/permissions` asked who was there. Somebody else signed in on
 * this computer under their own profile could move the live switches and the parity switches,
 * approve or remove a pairing, point a chat at a conversation, send a test message, and read the
 * secret address each chat service posts to. Every test here drives the real HTTP routes: once as a
 * household person, who must be refused, and once as the owner, who must not be.
 *
 * Nothing leaves this computer: the model is a stand-in and no chat app is ever connected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const refusal = /belongs to the owner/;

/** One app on its own folder, with a server, and a household person ready to be switched on. */
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-channels-owner-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "4321" })).body;
  assert.ok(person.id, "the household person was added");
  const asPerson = async () => assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "4321" })).status, 200);
  const asOwner = async () => assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  return { app, server, call, headers, person, asPerson, asOwner };
}

/**
 * Every address under /api/channels, with a body that is in the right shape. The owner's answer is
 * not always 200 — "that channel is not connected" is a real answer to a test message — so what is
 * asserted for the owner is that the route ran at all, never the profile refusal.
 */
const everyRoute = (sessionId) => [
  ["GET", "/api/channels"],
  ["GET", "/api/channels/catalog"],
  ["GET", "/api/channels/parity"],
  ["POST", "/api/channels/parity", { irc: "on" }],
  ["GET", "/api/channels/slack-automations"],
  ["POST", "/api/channels/slack-automations", { mode: "on" }],
  ["POST", "/api/channels/slack-automations/run", { id: "nothing" }],
  ["POST", "/api/channels/deliveries/sample/retry", {}],
  ["POST", "/api/channels/pairings/approve", { code: "123456" }],
  ["POST", "/api/channels/pairings/remove", { channel: "fake", senderId: "friend" }],
  ["POST", "/api/channels/link", { channel: "fake", chatId: "friend", sessionId }],
  ["POST", "/api/channels/live", { liveStatus: "on" }],
  ["POST", "/api/channels/permissions", { extras: true }],
  ["POST", "/api/channels/test", { channel: "fake", chatId: "friend" }],
  ["GET", "/api/channels/addresses"],
  ["POST", "/api/channels/addresses/rotate", { channel: "fake" }],
  ["POST", "/api/channels/addresses/settings", { acceptOldAddresses: false }],
];

/** The Set up panel next door: the same chat apps, so the same answer to the same question. */
const everySetupRoute = [
  ["GET", "/api/channel-setup"],
  ["POST", "/api/channel-setup", { mode: "on" }],
  ["GET", "/api/channel-setup/telegram"],
  ["POST", "/api/channel-setup/telegram/check", { values: { TELEGRAM_BOT_TOKEN: "not-a-real-token" } }],
];

test("CO-1 every address under /api/channels is refused to a household person and answers the owner", async (t) => {
  const f = await served(t);
  const sessionId = "00000000-0000-4000-8000-000000000000";

  await f.asPerson();
  for (const [method, path, body] of everyRoute(sessionId)) {
    const answer = await f.call(method, path, body);
    assert.equal(answer.status, 400, `${method} ${path} is refused`);
    assert.match(String(answer.body?.error ?? ""), refusal, `${method} ${path} says whose it is`);
    assert.match(String(answer.body?.error ?? ""), /chat apps/, `${method} ${path} says what it is about`);
  }

  await f.asOwner();
  for (const [method, path, body] of everyRoute(sessionId)) {
    const answer = await f.call(method, path, body);
    assert.doesNotMatch(String(answer.body?.error ?? ""), refusal, `${method} ${path} still answers the owner`);
  }
});

test("CO-5 the Set up panel for the same chat apps answers the same way", async (t) => {
  const f = await served(t);

  await f.asPerson();
  for (const [method, path, body] of everySetupRoute) {
    const answer = await f.call(method, path, body);
    assert.match(String(answer.body?.error ?? ""), refusal, `${method} ${path} is refused`);
    assert.match(String(answer.body?.error ?? ""), /Setting up chat apps/, `${method} ${path} says what it is about`);
  }

  await f.asOwner();
  assert.equal((await f.call("GET", "/api/channel-setup")).status, 200, "the owner still sees the list");
  assert.equal((await f.call("GET", "/api/channel-setup/telegram")).status, 200, "and one app's panel");
  assert.equal((await f.call("POST", "/api/channel-setup", { mode: "on" })).status, 200, "and still moves the switch");
});

test("CO-2 a household person cannot approve a pairing code, and the owner still can", async (t) => {
  const f = await served(t);
  const owner = f.app.runtime.owner;
  f.app.store.save("settings", owner, "channel-pair:fake:friend",
    { status: "pending", code: "424242", name: "A friend", requestedAt: new Date().toISOString() });

  await f.asPerson();
  const refused = await f.call("POST", "/api/channels/pairings/approve", { code: "424242" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, refusal);
  assert.equal(f.app.store.get("settings", owner, "channel-pair:fake:friend").data.status, "pending",
    "the pairing is untouched: the person never reached the route");

  await f.asOwner();
  const approved = await f.call("POST", "/api/channels/pairings/approve", { code: "424242" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(f.app.store.get("settings", owner, "channel-pair:fake:friend").data.status, "approved");
});

/* CHAT-159: a pairing is only what was asked, and only for a while. A code older than an hour is refused, a code works
   once, and approving one sender lets in that sender alone. Mutation: make pairingCodeFresh always true in
   src/channels/router.ts and the hour-old code is let in. */
test("CO-2b a pairing code works once, only within the hour, and lets in only the sender who asked", async (t) => {
  const f = await served(t);
  const owner = f.app.runtime.owner;
  const pending = (id, code, minutesAgo) => f.app.store.save("settings", owner, `channel-pair:fake:${id}`,
    { status: "pending", code, name: id, requestedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
  pending("old", "111111", 61);
  pending("fresh", "222222", 5);
  pending("other", "333333", 5);
  await f.asOwner();
  const stale = await f.call("POST", "/api/channels/pairings/approve", { code: "111111" });
  assert.equal(stale.status, 400, "an hour-old code is refused");
  assert.equal(f.app.store.get("settings", owner, "channel-pair:fake:old").data.status, "pending");
  assert.equal((await f.call("POST", "/api/channels/pairings/approve", { code: "222222" })).status, 200);
  assert.equal((await f.call("POST", "/api/channels/pairings/approve", { code: "222222" })).status, 400, "a code works once");
  assert.equal(f.app.store.get("settings", owner, "channel-pair:fake:other").data.status, "pending", "only the sender who asked is let in");
});

test("CO-3 the switches a household person cannot see are the switches they cannot move", async (t) => {
  const f = await served(t);

  await f.asOwner();
  const before = (await f.call("GET", "/api/channels")).body;
  // The ship-on rule: the live status line ships "when needed"; the owner puts it off so a moved switch would show.
  assert.equal(before.live.liveStatus, "when-needed", "the live status switch ships when needed");
  assert.equal((await f.call("POST", "/api/channels/live", { liveStatus: "off" })).body.live.liveStatus, "off");

  await f.asPerson();
  assert.match((await f.call("POST", "/api/channels/live", { liveStatus: "on" })).body.error, refusal);
  assert.match((await f.call("POST", "/api/channels/parity", { irc: "on" })).body.error, refusal);
  assert.match((await f.call("GET", "/api/channels")).body.error, refusal, "nor may they read the pairings and chats");
  assert.match((await f.call("GET", "/api/channels/addresses")).body.error, refusal, "nor the secret address each service posts to");

  await f.asOwner();
  assert.equal((await f.call("GET", "/api/channels")).body.live.liveStatus, "off", "nothing the person sent was saved");
  assert.equal((await f.call("POST", "/api/channels/live", { liveStatus: "on" })).body.live.liveStatus, "on", "the owner still moves it");
  assert.equal((await f.call("POST", "/api/channels/parity", { irc: "on" })).status, 200);
});

test("CO-4 a person signed in on the people page never reaches the chat apps either", async (t) => {
  const f = await served(t);
  assert.equal((await f.call("POST", "/api/people/settings", { mode: "on" })).status, 200);
  const made = f.app.store.profiles.create({ name: "Ada", pin: "1234" });
  const { key } = f.app.people.keys.issue(made.id, 60, "pin", "test");
  for (const [method, path, body] of [["GET", "/api/channels"], ["POST", "/api/channels/live", { liveStatus: "on" }],
    ["GET", "/api/channels/addresses"], ["POST", "/api/channels/pairings/approve", { code: "424242" }]]) {
    const response = await fetch(f.server.url + path, {
      method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin: f.server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.match((await response.json()).error, /only their own page/, `${method} ${path}`);
  }
  // The window is still the owner's: a person's key never switched it.
  assert.equal(f.app.store.profiles.isOwner(), true);
});
