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

/* Telegram behind Branch's checked fetch (web.policy.guard): an edit or delete first waits while its address is checked,
   and then, like the platform's own fetch, sends nothing once its signal has been aborted. The long poll waits for Stop. */
function telegramBehindAdmission() {
  const sent = [], admitting = [];
  const fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    if (method === "getUpdates") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    if (method === "editMessageText" || method === "deleteMessage") await new Promise((resolve) => admitting.push(resolve));
    init.signal?.throwIfAborted();
    sent.push(method);
    const result = method === "getMe" ? { id: 1, is_bot: true, first_name: "Branch", username: "branch_bot" } : method === "sendMessage" ? { message_id: 41 } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  };
  const inAdmission = async () => {
    for (let i = 0; i < 2000 && !admitting.length; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admitting.length, 1, "the request reached its address check");
  };
  return { sent, fetch, inAdmission, admit: () => admitting.shift()() };
}

async function telegramApp(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-own-messages-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const telegram = telegramBehindAdmission();
  await app.channels.attach(new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase: "http://telegram.invalid", fetch: telegram.fetch, pollTimeoutSeconds: 1 }),
    { activation: "always", pairing: true, allowlist: ["owner"] });
  await app.channels.deliver("telegram", "7", "The meeting is at 3.");
  const run = app.store.createRun(app.runtime.owner, "fix my message");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const stop = new AbortController();
  const context = app.runtime.context({ runId: run.id, permissions: app.registry.permissions(), signal: stop.signal });
  return { app, telegram, context, stop };
}

const target = { channel: "telegram", chatId: "7", messageId: "41" };

test("CHAT-023: with nothing changed, a Telegram delete is sent once its address is checked", async (t) => {
  const { app, telegram, context } = await telegramApp(t, "sent");
  const deleted = app.channels.actOnOwnMessage(target, "delete", context);
  await telegram.inAdmission();
  telegram.admit();
  assert.equal((await deleted).confirmed, true);
  assert.deepEqual(telegram.sent.filter((m) => m === "deleteMessage"), ["deleteMessage"]);
});

for (const [what, action, revoke] of [
  ["the task is stopped", "delete", ({ stop }) => stop.abort(new Error("Stopped"))],
  ["Branch is locked", "edit", ({ app }) => app.sessionLock.lock()],
  ["Lockdown comes on", "delete", ({ app }) => setLockdown(app.store, app.runtime.owner, { on: true })],
  ["the chat app is disconnected", "delete", ({ app }) => app.channels.detach("telegram")],
]) {
  test(`CHAT-023: when ${what} while a Telegram ${action}'s address is checked, nothing is sent`, async (t) => {
    const world = await telegramApp(t, action);
    const { app, telegram, context } = world;
    const acting = app.channels.actOnOwnMessage(target, action, context, action === "edit" ? "The meeting is at 4." : undefined);
    await telegram.inAdmission();
    await revoke(world);
    telegram.admit();
    await assert.rejects(acting);
    assert.deepEqual(telegram.sent.filter((m) => m === "editMessageText" || m === "deleteMessage"), [], "no edit or delete went out");
    const [kept] = app.channels.ownMessages({ channel: "telegram", chatId: "7" }).messages;
    assert.equal(kept.text, "The meeting is at 3.");
    assert.equal(kept.deletedAt ?? null, null);
  });
}
