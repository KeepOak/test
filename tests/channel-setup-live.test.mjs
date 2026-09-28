/**
 * CHAT-147: a chat app set up in the window connects there and then, with no connections-file line and no restart,
 * and connects again when Branch starts. Every recipe's entry is checked against the connections file's own shapes;
 * the live connect is proved against a stand-in Matrix homeserver on this computer. Nothing here reaches a real
 * chat service, and no real program is started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { recipes, recipeFor } from "../dist/channel-setup/recipes.js";
import { readValues } from "../dist/channel-setup/check.js";
import { entryFor, savedEntries, connectNow, connectSaved, disconnect, rememberEntry } from "../dist/channel-setup/live.js";
import { saveSetup, saveSetupMode, removeSetup, setupPanel } from "../dist/channel-setup/service.js";
import { ChannelConfigSchema } from "../dist/integrations/bootstrap.js";
import { parityService } from "../dist/channels/parity-config.js";

const TOKEN = "MATRIX-ACCESS-TOKEN-7788";
async function until(check, label) {
  for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}
async function freshApp(t, dataDir) {
  const root = dataDir ? null : await mkdtemp(join(tmpdir(), "branch-setup-live-"));
  const provider = { name: "scripted", async complete() { return { content: "hello", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root ?? dataDir, "workspace"), dataDir: dataDir ?? join(root, "data"), provider });
  t.after(async () => { await app.close(); if (root) await discardTemp(root); });
  return { app, dataDir: dataDir ?? join(root, "data"), root };
}

/** One value per field the recipes ask for, in the shape each recipe and each service wants. */
const sample = {
  phoneNumberId: "123456789012345", pageId: "123456789012345", address: "helper@example.org", imapHost: "imap.example.org",
  smtpHost: "smtp.example.org", userId: "@helper:example.org", path: resolve("tools", "program"), account: "+15551234567",
  server: "irc.example.org", nick: "helperbot", login: "helperbot", channel: "helperchan", appId: "1234567890", botUserId: "U12345",
  handle: "helper.bsky.social", username: "helper", clientId: "abcdefghij12", conversation: "12345", room: "abcd1234",
  accountSid: `AC${"a".repeat(32)}`, from: "+15551234567", topic: "branch-helper", gatewayId: "*ABCDEFG", jid: "helper@example.org",
  host: "mqtt.example.org", inboundTopic: "branch/in", replyTopic: "branch/out", relay: "wss://relay.example.org", groupId: "12345",
  corpId: "wwabcdefghij12", agentId: "1000002",
};
const special = { "msteams-bot": { appId: "12345678-1234-1234-1234-123456789012" }, "wechat-mp": { appId: "wxabcdefghij123456" },
  mumble: { server: "mumble.example.org" }, "whatsapp-web": { server: "http://127.0.0.1:3000" } };

test("every chat app's panel makes an entry the connections file itself accepts, so none needs a line written by hand", async () => {
  let checked = 0;
  for (const recipe of recipes()) {
    if (recipe.turnOn === "guided") continue;
    const input = {};
    for (const field of recipe.fields) input[field.name] = special[recipe.id]?.[field.name] ?? (field.kind === "url" ? "https://chat.example.org" : sample[field.name]);
    const values = readValues({ ...recipe, paste: [] }, input);
    const entry = entryFor(recipe, values);
    assert.ok(entry, `${recipe.id} has an entry`);
    assert.ok(!JSON.stringify(entry).includes("…") && !JSON.stringify(entry).includes("{{"), `${recipe.id}: nothing left to fill by hand`);
    const parsed = ChannelConfigSchema.safeParse(entry);
    assert.ok(parsed.success, `${recipe.id}: ${JSON.stringify(parsed.error?.issues ?? [])}`);
    const service = await parityService(entry.type); // loaded on first use since perf(channels) d762142a
    if (service) {
      const { id: _id, type: _type, ...settings } = entry;
      const own = service.settings.safeParse(settings);
      assert.ok(own.success, `${recipe.id}: ${JSON.stringify(own.error?.issues ?? [])}`);
    }
    checked++;
  }
  assert.equal(checked, 56, "every app but the Telegram card");
});

test("an entry holds only what the recipe templates: a request cannot add an address or a key of its own", () => {
  const matrix = recipeFor("matrix");
  const values = readValues(matrix, { server: "https://matrix.example.org", userId: "@b:matrix.example.org", MATRIX_ACCESS_TOKEN: "x".repeat(20),
    apiBase: "http://127.0.0.1:1", homeserver: "http://evil.example" });
  const entry = entryFor(matrix, values);
  assert.deepEqual(entry, { type: "matrix", id: "matrix", homeserver: "https://matrix.example.org", userId: "@b:matrix.example.org" });
  assert.ok(!JSON.stringify(entry).includes("x".repeat(20)), "the secret never goes in the entry");
  assert.deepEqual(entryFor(recipeFor("vk"), { groupId: "12345" }), { type: "vk", id: "vk", groupId: 12345 });
  assert.equal(entryFor(recipeFor("telegram"), {}), null);
});

/** A router that records what is attached, for the connect rules alone. */
function fakeRouter() {
  const attached = new Map();
  return {
    attached,
    // As the real router does: a channel that did not start is taken out again.
    async attach(adapter) {
      if (attached.has(adapter.id)) throw new Error("already attached");
      attached.set(adapter.id, adapter);
      try { await adapter.start(async () => {}); } catch (error) { attached.delete(adapter.id); throw error; }
    },
    async detach(id) { const adapter = attached.get(id); attached.delete(id); await adapter?.stop(); },
    adapter: (id) => attached.get(id),
    summary: () => ({ channels: [...attached.values()].map((a) => ({ id: a.id, kind: a.kind })) }),
  };
}
const fakeAdapter = (id, { fail } = {}) => ({ id, kind: id, stopped: false, botName: () => "helper", health: () => ({ state: "connected" }),
  async start() { if (fail) throw new Error(fail); }, async stop() { this.stopped = true; }, async send() { return "1"; } });

test("the connect rules: the connections file wins, a new save replaces only its own, a failure says why, and start connects them all", async (t) => {
  const { app } = await freshApp(t);
  const router = fakeRouter();
  const built = [];
  let fail = null;
  const host = { store: app.store, owner: app.runtime.owner, router, build: async (entry) => { const a = fakeAdapter(entry.id, { fail }); built.push(a); return a; } };
  const discord = recipeFor("discord");
  const entry = { type: "discord", id: "discord", tokenSecret: "DISCORD_BOT_TOKEN" };

  // From the connections file first: the panel leaves it alone and says so.
  await router.attach(fakeAdapter("discord"));
  let outcome = await connectNow(host, discord, entry);
  assert.equal(outcome.connected, false);
  assert.match(outcome.note, /connections file, which wins/);
  await router.detach("discord");

  outcome = await connectNow(host, discord, entry);
  assert.deepEqual([outcome.connected, outcome.channel, outcome.botName], [true, "discord", "helper"]);
  const first = router.adapter("discord");
  outcome = await connectNow(host, discord, entry);
  assert.equal(outcome.connected, true);
  assert.ok(first.stopped, "the panel's own earlier connection is replaced, not doubled");
  assert.notEqual(router.adapter("discord"), first);

  fail = "Discord refused the token TOKEN-SECRET-VALUE";
  outcome = await connectNow(host, discord, entry, { DISCORD_BOT_TOKEN: "TOKEN-SECRET-VALUE" });
  assert.equal(outcome.connected, false);
  assert.match(outcome.note, /did not connect/);
  assert.ok(!outcome.note.includes("TOKEN-SECRET-VALUE"), "what was pasted never comes back in a reason");
  assert.equal(router.adapter("discord"), undefined, "a connection that did not start is not left attached");

  fail = null;
  rememberEntry(app.store, app.runtime.owner, "discord", entry);
  rememberEntry(app.store, app.runtime.owner, "matrix", { type: "matrix", id: "matrix", homeserver: "https://m.example.org", userId: "@b:m.example.org" });
  const results = await connectSaved(host);
  assert.deepEqual(results.map((r) => [r.channel, r.connected]), [["discord", true], ["matrix", true]]);
  assert.equal(await disconnect(host, "matrix"), true);
  assert.equal(router.adapter("matrix"), undefined);
  assert.deepEqual(Object.keys(savedEntries(app.store, app.runtime.owner)), ["discord"], "a disconnected app is not connected again at the next start");
});

/** A stand-in Matrix homeserver: the first sync is the backlog Branch skips, the second carries a stranger's message. */
async function homeserver(t) {
  const sends = [], syncs = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.startsWith("/_matrix/client/v3/sync")) {
      syncs.push(request.headers.authorization);
      const events = syncs.length === 2 ? [{ type: "m.room.message", event_id: "$1", sender: "@alice:example.org", content: { msgtype: "m.text", body: "@branch:example.org hello there" } }] : [];
      if (syncs.length > 2) await delay(40);
      response.end(JSON.stringify({ next_batch: `s${syncs.length}`, rooms: { join: { "!room:example.org": { timeline: { events } } } } }));
      return;
    }
    if (request.url.startsWith("/_matrix/client/v3/account/whoami")) { response.end(JSON.stringify({ user_id: "@branch:example.org" })); return; }
    sends.push({ path: request.url, body: raw ? JSON.parse(raw) : {} });
    response.end(JSON.stringify(request.url.includes("/typing/") ? {} : { event_id: "$sent" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { base: `http://127.0.0.1:${server.address().port}`, sends, syncs };
}

test("Matrix set up in the window connects at once and answers a stranger with a pairing code, then again after a restart", async (t) => {
  const service = await homeserver(t);
  const { app, dataDir } = await freshApp(t);
  app.web.policy.configure({ allowPrivateAddresses: true }); // the stand-in homeserver is on this computer
  await app.store.secrets.put(app.runtime.owner, "default", "MATRIX_ACCESS_TOKEN", TOKEN, { expiresInDays: 0 });
  const matrix = recipeFor("matrix");
  // The panel's own entry, with the stand-in's plain http address put in place of an https one (the panel only takes https).
  const entry = { ...entryFor(matrix, { server: "https://matrix.example.org", userId: "@branch:example.org" }), homeserver: service.base };
  rememberEntry(app.store, app.runtime.owner, "matrix", entry);
  const outcome = await app.channelSetup.connect(matrix, entry, {});
  assert.equal(outcome.connected, true, outcome.note ?? "");
  assert.equal(outcome.channel, "matrix");
  assert.ok(app.channels.summary().channels.some((channel) => channel.id === "matrix"), "attached to the running router, no restart");
  const code = await until(() => service.sends.find((send) => /\b\d{6}\b/.test(send.body.body ?? "")), "a pairing code in the room");
  assert.match(code.path, /\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\//);
  assert.ok(service.syncs.every((auth) => auth === `Bearer ${TOKEN}`), "the token came from the locker");
  await app.close();

  // The same data folder started again: the saved app connects with no one opening the panel.
  const again = await freshApp(t, dataDir);
  again.app.web.policy.configure({ allowPrivateAddresses: true });
  const before = service.syncs.length;
  const results = await again.app.channelSetup.connectSaved();
  assert.deepEqual(results.map((r) => [r.channel, r.connected]), [["matrix", true]]);
  await until(() => service.syncs.length > before, "it is reading the room again");
  await again.app.close(); // before the first app's folder is removed
});

test("saving through the panel keeps the entry, connects it and says so; Remove disconnects it and keeps the secrets", async (t) => {
  const { app } = await freshApp(t);
  const owner = app.runtime.owner;
  saveSetupMode(app.store, owner, { mode: "on" });
  const connects = [];
  const host = { store: app.store, owner, fetch: async () => { throw new Error("nothing is asked"); },
    live: { connect: async (recipe, entry) => { connects.push([recipe.id, entry]); return { connected: false, channel: "signal", botName: null, address: null, note: "Signal needs the signal-cli program, and there is nothing at /nowhere." }; },
      disconnect: async (id) => { connects.push(["removed", id]); return true; } } };
  const answer = await saveSetup(host, "signal", { values: { path: resolve("nowhere", "signal-cli"), account: "+15551234567" }, enable: "on" });
  assert.equal(answer.connected, false);
  assert.match(answer.connectNote, /signal-cli/);
  assert.deepEqual(connects[0][1], { type: "signal", id: "signal", path: resolve("nowhere", "signal-cli"), account: "+15551234567" });
  assert.equal(setupPanel(app.store, owner, "signal").setUpHere, true);

  await saveSetup(host, "bluesky", { values: { handle: "helper.bsky.social", BLUESKY_APP_PASSWORD: "abcd-efgh-ijkl-mnop" }, enable: "off" });
  assert.equal(connects.length, 1, "off keeps the settings without connecting");
  assert.ok(savedEntries(app.store, owner).bluesky);

  assert.deepEqual(await removeSetup(host, "bluesky"), { id: "bluesky", removed: true });
  assert.deepEqual(connects.at(-1), ["removed", "bluesky"]);
  const kept = await app.store.secrets.resolve(owner, "default", ["BLUESKY_APP_PASSWORD"], { purpose: "channel" });
  assert.equal(kept.BLUESKY_APP_PASSWORD, "abcd-efgh-ijkl-mnop", "the secret stays in the locker");
  await assert.rejects(removeSetup(host, "telegram"), (error) => error.status === 404);
  await assert.rejects(removeSetup(host, "slack"), (error) => error.status === 404, "never set up here");
});

/** A vendor stand-in that answers each address with its own JSON, recording what was asked. */
function vendor(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization });
    const [status, body] = routes[new URL(url).pathname] ?? [404, {}];
    return Response.json(body, { status });
  };
  return { calls, fetch };
}

test("the checks go past who-am-I: Discord's Message Content Intent, Slack's Socket Mode token, and Matrix's own account", async (t) => {
  const { app } = await freshApp(t);
  const owner = app.runtime.owner;
  saveSetupMode(app.store, owner, { mode: "on" });
  const live = { connect: async (recipe) => ({ connected: true, channel: recipe.id, botName: null, address: null, note: null }), disconnect: async () => true };
  const discordToken = "MTIz.discord-bot-token-value";

  let service = vendor({ "/api/v10/users/@me": [200, { id: "1", username: "helper" }], "/api/v10/applications/@me": [200, { flags: 0 }] });
  await assert.rejects(saveSetup({ store: app.store, owner, fetch: service.fetch, live }, "discord", { values: { DISCORD_BOT_TOKEN: discordToken }, enable: "on" }),
    (error) => error.status === 422 && /Message Content Intent is off/.test(error.message) && !error.message.includes(discordToken));
  assert.ok(!app.store.secrets.list(owner, "default").some((s) => s.name === "DISCORD_BOT_TOKEN"), "nothing kept when the bot could not read messages");
  service = vendor({ "/api/v10/users/@me": [200, { id: "1", username: "helper" }], "/api/v10/applications/@me": [200, { flags: 1 << 19 }] });
  const discord = await saveSetup({ store: app.store, owner, fetch: service.fetch, live }, "discord", { values: { DISCORD_BOT_TOKEN: discordToken }, enable: "on" });
  assert.deepEqual([discord.connected, discord.botName], [true, "helper"]);
  assert.ok(service.calls.every((call) => call.auth === `Bot ${discordToken}`));

  const slackValues = { SLACK_BOT_TOKEN: `xoxb-${"1".repeat(30)}`, SLACK_APP_TOKEN: `xapp-${"2".repeat(30)}` };
  service = vendor({ "/api/auth.test": [200, { ok: true, user: "helper" }], "/api/apps.connections.open": [200, { ok: false, error: "invalid_auth" }] });
  await assert.rejects(saveSetup({ store: app.store, owner, fetch: service.fetch, live }, "slack", { values: slackValues, enable: "on" }),
    (error) => error.status === 422 && /Socket Mode/.test(error.message) && /invalid_auth/.test(error.message));
  assert.equal(service.calls.find((call) => call.url.endsWith("apps.connections.open")).auth, `Bearer ${slackValues.SLACK_APP_TOKEN}`);

  service = vendor({ "/_matrix/client/v3/account/whoami": [200, { user_id: "@someone:matrix.example.org" }] });
  await assert.rejects(saveSetup({ store: app.store, owner, fetch: service.fetch, live }, "matrix",
    { values: { server: "https://matrix.example.org", userId: "@branch:matrix.example.org", MATRIX_ACCESS_TOKEN: "syt_matrix_token_value" }, enable: "on" }),
    (error) => error.status === 422 && /belongs to @someone:matrix\.example\.org/.test(error.message));
});

/* Review attack on #635: saving Signal, Keybase or Delta Chat starts the program the owner typed, now and at every start.
   A door (a paired phone's own key, a phone holding the window's key through the paired door, a caller beyond this
   computer) is already refused every Set up save by the caller rules (src/caller-policy.ts `outlastsAPhone`); the
   service refuses a program-starting app through a door as well, so the rule holds even if that list changes. */
test("an app that starts a program on this computer is set up only at this computer, never through a door", async (t) => {
  const { world } = await import("./caller-policy-world.mjs");
  const w = await world();
  t.after(() => w.close());
  await w.call("POST", "/api/channel-setup", { mode: "on" });
  const values = { path: "/nonexistent-branch-test/signal-cli", account: "+15551234567" };
  for (const kind of ["phone", "legacy", "remote"]) {
    const who = w.callers[kind];
    const refused = await w.call("POST", "/api/channel-setup/signal/check", { values, enable: "on" }, who.key, who.base, who.headers);
    assert.equal(refused.status, 403, `${kind}: ${refused.text}`);
  }
  assert.equal(savedEntries(w.app.store, w.app.runtime.owner).signal, undefined, "nothing was kept to start later");
  const here = await w.call("POST", "/api/channel-setup/signal/check", { values, enable: "on" });
  assert.equal(here.status, 200, here.text);
  assert.equal(here.body.connected, false, "no program there, so it says so");
  // The service's own refusal, with the caller rules out of the way.
  const host = { store: w.app.store, owner: w.app.runtime.owner, fetch: async () => { throw new Error("nothing is asked"); }, thisComputer: false,
    live: { connect: async () => assert.fail("a door never connects a program"), disconnect: async () => true } };
  for (const id of ["signal", "keybase", "deltachat"])
    await assert.rejects(saveSetup(host, id, { values: { path: "/x/tool", account: "+15551234567" }, enable: "on" }),
      (error) => error.status === 403 && /starts a program on this computer/.test(error.message), id);
  const bluesky = await saveSetup({ ...host, live: { connect: async () => ({ connected: true, channel: "bluesky", botName: null, address: null, note: null }), disconnect: async () => true } },
    "bluesky", { values: { handle: "helper.bsky.social", BLUESKY_APP_PASSWORD: "abcd-efgh-ijkl-mnop" }, enable: "on" });
  assert.equal(bluesky.connected, true, "an app that starts nothing here is not held back by this rule");
});
