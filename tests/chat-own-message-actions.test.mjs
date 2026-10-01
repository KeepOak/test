/**
 * CHAT-023: Branch edits or deletes an earlier message only when it has its own record of sending
 * that exact message to that exact chat. Somebody else's message id is refused before the chat app is asked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, TelegramAdapter } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { DiscordAdapter } from "../dist/channels/discord.js";
import { MatrixAdapter } from "../dist/channels/matrix.js";

test("CHAT-023: an own sent message is edited once recorded; an unknown id is refused untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-own-messages-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const asked = [];
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send() { return "m-41"; },
    async edit(chatId, messageId, text) { asked.push(["edit", chatId, messageId, text]); },
    async deleteMessage(chatId, messageId) { asked.push(["delete", chatId, messageId]); } }, { activation: "always", pairing: true, allowlist: ["owner"] });
  await app.channels.deliver("chat", "7", "The meeting is at 3.");
  const run = app.store.createRun(app.runtime.owner, "fix my message");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const context = app.runtime.context({ runId: run.id, permissions: app.registry.permissions() });
  const listed = await app.registry.execute("channels.own_messages", { channel: "chat", chatId: "7" }, context);
  assert.equal(listed.messages[0].messageId, "m-41");
  await assert.rejects(app.registry.execute("channels.delete_message", { channel: "chat", chatId: "7", messageId: "someone-else" }, context), /no retained record/);
  await assert.rejects(app.registry.execute("channels.delete_message", { channel: "chat", chatId: "8", messageId: "m-41" }, context), /no retained record/);
  assert.deepEqual(asked, []);
  const edited = await app.channels.actOnOwnMessage({ channel: "chat", chatId: "7", messageId: "m-41" }, "edit", context, "The meeting is at 4.");
  assert.equal(edited.confirmed, true);
  assert.deepEqual(asked, [["edit", "7", "m-41", "The meeting is at 4."]]);
  assert.equal(app.channels.ownMessages({ channel: "chat", chatId: "7" }).messages[0].text, "The meeting is at 4.");
});

test("CHAT-023: deleting a sent message asks once, even where a rule would allow it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-own-messages-ask-"));
  const call = { id: "d1", name: "channels.delete_message", arguments: JSON.stringify({ channel: "chat", chatId: "7", messageId: "m-41" }) };
  let turn = 0;
  const provider = { name: "scripted", async complete() { return turn++ === 0 ? { content: "", toolCalls: [call] } : { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const asked = [];
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send() { return "m-41"; }, async deleteMessage(chatId, messageId) { asked.push([chatId, messageId]); } },
    { activation: "always", pairing: true, allowlist: ["owner"] });
  await app.channels.deliver("chat", "7", "The meeting is at 3.");
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "channels.delete_message", match: "*", applies: "any", decision: "allow", remember: "session" }] });
  const run = await app.runtime.run({ prompt: "Delete the message you sent about the meeting" });
  assert.notEqual(run.status, "completed", `the delete waited for the owner (${run.status})`);
  assert.deepEqual(asked, [], "nothing was deleted before the owner answered");
});

test("CHAT-023: an edit whose chat app was detached or replaced while its text was checked goes nowhere", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-own-messages-swap-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const asked = [];
  const chat = (name) => ({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send() { return "m-41"; }, async edit(chatId, messageId, text) { asked.push([name, chatId, messageId, text]); } });
  const policy = { activation: "always", pairing: true, allowlist: ["owner"] };
  await app.channels.attach(chat("old"), policy);
  await app.channels.deliver("chat", "7", "The meeting is at 3.");
  const run = app.store.createRun(app.runtime.owner, "fix my message");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const context = app.runtime.context({ runId: run.id, permissions: app.registry.permissions() });
  const plain = app.channels.outboundGuard;
  for (const swap of [() => app.channels.detach("chat"), async () => { await app.channels.detach("chat"); await app.channels.attach(chat("new"), policy); }]) {
    if (!app.channels.adapter("chat")) await app.channels.attach(chat("old"), policy);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    app.channels.outboundGuard = async (text) => { await held; return plain(text); };
    const edit = app.channels.actOnOwnMessage({ channel: "chat", chatId: "7", messageId: "m-41" }, "edit", context, "The meeting is at 4.");
    await swap();
    release();
    await assert.rejects(edit, /changed while/);
    app.channels.outboundGuard = plain;
  }
  assert.deepEqual(asked, [], "neither the detached adapter nor its replacement edited the message");
});

/* A chat app behind Branch's checked fetch (web.policy.guard): an edit or delete first waits while its address is checked,
   and then, like the platform's own fetch, sends nothing once its signal has been aborted. Telegram's long poll waits for
   Stop; Slack's socket is a stand-in. */
/* A chat app's live socket that says nothing until it is closed. */
function quietSocket() { let done; const closed = new Promise((resolve) => { done = resolve; }); return Promise.resolve({ send() {}, close() { done(); }, closed }); }
const APPS = {
  telegram: { chatId: "7", messageId: "41", mutations: ["editMessageText", "deleteMessage"],
    answer: (method) => ({ ok: true, result: method === "getMe" ? { id: 1, is_bot: true, first_name: "Branch", username: "branch_bot" } : method === "sendMessage" ? { message_id: 41 } : true }),
    adapter: (fetch) => new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase: "http://telegram.invalid", fetch, pollTimeoutSeconds: 1 }) },
  slack: { chatId: "C7", messageId: "171.1", mutations: ["chat.update", "chat.delete"],
    answer: (method) => (method === "auth.test" ? { ok: true, user_id: "U1", user: "branch" } : method === "chat.postMessage" ? { ok: true, ts: "171.1" } : { ok: true }),
    adapter: (fetch) => new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", apiBase: "http://slack.invalid/api", fetch, socketUrl: "wss://slack.invalid",
      connect: quietSocket }) },
  discord: { chatId: "900", mutations: ["edit", "delete"],
    label: (url, init) => (init.method === "PATCH" ? "edit" : init.method === "DELETE" && /\/messages\/[^/]+$/.test(url) ? "delete" : `${init.method} ${new URL(url).pathname}`),
    answer: (label) => (label.startsWith("POST") ? { id: "555" } : {}),
    adapter: (fetch) => new DiscordAdapter({ id: "discord", token: "tok", apiBase: "http://discord.invalid", gatewayUrl: "wss://discord.invalid", fetch, connect: quietSocket }) },
  matrix: { chatId: "!room:test", mutations: ["edit", "delete"],
    label: (url, init) => (/\/sync\b/.test(url) ? "sync" : /\/redact\//.test(url) ? "delete"
      : /\/send\/m\.room\.message\//.test(url) ? (String(init.body).includes("m.new_content") ? "edit" : "send") : `${init.method} ${new URL(url).pathname}`),
    answer: (label) => (label === "send" || label === "edit" ? { event_id: "$sent1" } : label === "delete" ? { event_id: "$gone1" } : {}),
    adapter: (fetch) => new MatrixAdapter({ id: "matrix", homeserver: "http://matrix.invalid", accessToken: "tok", userId: "@branch:test", fetch }) },
};

function behindAdmission(app) {
  const sent = [], admitting = [], wire = { throttled: false };
  const fetch = async (url, init) => {
    const method = app.label ? app.label(String(url), init ?? {}) : String(url).split("/").pop();
    if (method === "getUpdates" || method === "sync") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    if (app.mutations.includes(method)) await new Promise((resolve) => admitting.push(resolve));
    init.signal?.throwIfAborted();
    sent.push(method);
    if (wire.throttled && app.mutations.includes(method)) return new Response("{}", { status: 429, headers: { "retry-after": "3" } });
    return new Response(JSON.stringify(app.answer(method)), { headers: { "content-type": "application/json" } });
  };
  const inAdmission = async () => {
    for (let i = 0; i < 2000 && !admitting.length; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admitting.length, 1, "the request reached its address check");
  };
  return Object.assign(wire, { sent, fetch, inAdmission, admit: () => admitting.shift()() });
}

async function chatApp(t, kind, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-own-messages-${kind}-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const chat = APPS[kind], wire = behindAdmission(chat);
  await app.channels.attach(chat.adapter(wire.fetch), { activation: "always", pairing: true, allowlist: ["owner"] });
  await app.channels.deliver(kind, chat.chatId, "The meeting is at 3.");
  const [delivered] = app.channels.ownMessages({ channel: kind, chatId: chat.chatId }).messages;
  assert.ok(delivered?.messageId, `${kind}: the message was sent and recorded`);
  const run = app.store.createRun(app.runtime.owner, "fix my message");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const stop = new AbortController();
  const context = app.runtime.context({ runId: run.id, permissions: app.registry.permissions(), signal: stop.signal });
  return { app, wire, context, stop, target: { channel: kind, chatId: chat.chatId, messageId: delivered.messageId }, mutations: chat.mutations };
}

for (const kind of Object.keys(APPS)) {
  test(`CHAT-023: with nothing changed, a ${kind} delete is sent once its address is checked`, async (t) => {
    const { app, wire, context, target, mutations } = await chatApp(t, kind, "sent");
    const deleted = app.channels.actOnOwnMessage(target, "delete", context);
    await wire.inAdmission();
    wire.admit();
    assert.equal((await deleted).confirmed, true);
    assert.deepEqual(wire.sent.filter((m) => mutations.includes(m)), [mutations[1]]);
  });

  for (const [what, action, revoke] of [
    ["the task is stopped", "delete", ({ stop }) => stop.abort(new Error("Stopped"))],
    ["Branch is locked", "edit", ({ app }) => app.sessionLock.lock()],
    ["Lockdown comes on", "delete", ({ app }) => setLockdown(app.store, app.runtime.owner, { on: true })],
    ["the chat app is disconnected", "edit", ({ app }) => app.channels.detach(kind)],
    ["another person's profile is switched to", "delete", ({ app }) => {
      const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
      app.store.profiles.switch({ profileId: person.id, pin: "1234" });
    }],
  ]) {
    test(`CHAT-023: when ${what} while a ${kind} ${action}'s address is checked, nothing is sent`, async (t) => {
      const world = await chatApp(t, kind, action);
      const { app, wire, context, target, mutations } = world;
      const acting = app.channels.actOnOwnMessage(target, action, context, action === "edit" ? "The meeting is at 4." : undefined);
      await wire.inAdmission();
      await revoke(world);
      wire.admit();
      await assert.rejects(acting);
      assert.deepEqual(wire.sent.filter((m) => mutations.includes(m)), [], "no edit or delete went out");
      const [kept] = app.channels.ownMessages({ channel: kind, chatId: target.chatId }).messages;
      assert.equal(kept.text, "The meeting is at 3.");
      assert.equal(kept.deletedAt ?? null, null);
    });
  }
}

/* Slack's rate limit (#1361) and the send gate go through the same call(): the gate is checked before sending, and a
   429 after it is Slack's "wait", so nothing is recorded as deleted. */
test("CHAT-023: a Slack delete that Slack rate-limits after its gate passed is refused and recorded as not done", async (t) => {
  const { app, wire, context, target } = await chatApp(t, "slack", "throttled");
  wire.throttled = true;
  const deleting = app.channels.actOnOwnMessage(target, "delete", context);
  await wire.inAdmission();
  wire.admit();
  await assert.rejects(deleting, /slow down/);
  assert.deepEqual(wire.sent.filter((m) => m === "chat.delete"), ["chat.delete"], "it was sent once, after the gate");
  assert.equal(app.channels.ownMessages({ channel: "slack", chatId: target.chatId }).messages[0].deletedAt ?? null, null);
});

test("CHAT-023: a rate-limited Slack path still stops at the gate when Branch locks during the address check", async (t) => {
  const world = await chatApp(t, "slack", "throttled-lock");
  world.wire.throttled = true;
  const deleting = world.app.channels.actOnOwnMessage(world.target, "delete", world.context);
  await world.wire.inAdmission();
  world.app.sessionLock.lock();
  world.wire.admit();
  await assert.rejects(deleting);
  assert.deepEqual(world.wire.sent.filter((m) => m === "chat.delete"), [], "nothing went out behind the lock");
});
