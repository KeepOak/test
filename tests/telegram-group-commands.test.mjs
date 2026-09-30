/**
 * UP-CHAT-013..015 (CHAT-013, CHAT-018, CHAT-120, CHAT-161): Telegram groups.
 * - `/cmd@ThisBot` counts as addressed and is read as `/cmd`; `/cmd@OtherBot` is left for that bot.
 * - A reply chain in an ordinary group stays that group's one conversation; only a forum's topics are their own.
 * - Branch's commands are set as Telegram's own "/" menu with setMyCommands, within Telegram's limits.
 * Telegram is a stand-in on this computer; no real bot or token is used.
 *
 * Mutation notes (each turns this file red):
 * - telegram.ts inbound: drop the targeted-command check -> "/stop@OtherBot is left alone" fails.
 * - telegram.ts forumThread: always use the thread       -> "reply chain stays one conversation" fails.
 * - telegram.ts setCommands: removed                     -> "menu" tests fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { TelegramAdapter, telegramMenu } from "../dist/channels/telegram.js";
import { createBranch } from "../dist/index.js";

const from = { id: 5, first_name: "Ann" };
/** A Bot API stand-in: `updates` are handed out once; every other call is written down. */
function botApi(answer = () => ({ ok: true, result: true })) {
  const calls = [], updates = [];
  const fetch = async (url, init) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "BranchBot" } });
    if (method === "getUpdates") { await delay(15); return Response.json({ ok: true, result: updates.splice(0) }); }
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    return Response.json(answer(method, body));
  };
  return { calls, updates, fetch };
}
async function received(updates) {
  const api = botApi();
  const adapter = new TelegramAdapter({ id: "tg", token: "1:fake", pollTimeoutSeconds: 0, fetch: api.fetch });
  const seen = [];
  await adapter.start(async (message) => { seen.push(message); });
  api.updates.push(...updates, { update_id: 999, message: { message_id: 999, text: "end", from, chat: { id: 1, type: "private" } } });
  try { for (let i = 0; i < 200 && !seen.some((m) => m.text === "end"); i++) await delay(10); } finally { await adapter.stop(); }
  return seen.filter((m) => m.text !== "end");
}
const group = { id: -99, type: "supergroup", title: "Team" };

test("/stop@ThisBot is addressed and read as /stop; /stop@OtherBot is left alone", async () => {
  const seen = await received([
    { update_id: 1, message: { message_id: 11, text: "/stop@BranchBot", from, chat: group, entities: [{ type: "bot_command", offset: 0, length: 15 }] } },
    { update_id: 2, message: { message_id: 12, text: "/stop@OtherBot", from, chat: group, entities: [{ type: "bot_command", offset: 0, length: 14 }] } },
    { update_id: 3, message: { message_id: 13, text: "/help@branchbot all", from, chat: group } },
    { update_id: 4, message: { message_id: 14, text: "/status", from, chat: group } },
  ]);
  assert.deepEqual(seen.map((m) => [m.text, m.addressed]), [["/stop", true], ["/help all", true], ["/status", false]]);
});

test("a reply chain in an ordinary group stays one conversation; a forum's topics are their own", async () => {
  const seen = await received([
    { update_id: 1, message: { message_id: 21, message_thread_id: 20, text: "a reply in a chain", from, chat: group } },
    { update_id: 2, message: { message_id: 22, text: "not in a chain", from, chat: group } },
    { update_id: 3, message: { message_id: 23, message_thread_id: 7, text: "in topic 7", from, chat: { ...group, id: -100, is_forum: true } } },
  ]);
  assert.deepEqual(seen.map((m) => m.chatId), ["-99", "-99", "-100:7"]);
});

test("menu: Telegram's own names only, within its limits, unchanged menus not sent again, an empty one cleared", async () => {
  const api = botApi();
  const adapter = new TelegramAdapter({ id: "tg", token: "1:fake", pollTimeoutSeconds: 0, fetch: api.fetch });
  await adapter.setCommands([{ command: "stop", description: "stop the task" }, { command: "bad-name", description: "x" }, { command: "help", description: "" }]);
  assert.deepEqual(api.calls.map((c) => c.method), ["setMyCommands"]);
  assert.deepEqual(api.calls[0].body.commands, [{ command: "stop", description: "stop the task" }, { command: "help", description: "help" }]);
  await adapter.setCommands([{ command: "stop", description: "stop the task" }, { command: "help", description: "" }]);
  assert.equal(api.calls.length, 1, "the same menu is not sent again");
  await adapter.setCommands([]);
  assert.equal(api.calls.at(-1).method, "deleteMyCommands");

  const many = Array.from({ length: 120 }, (_, i) => ({ command: `c${i}`, description: "d".repeat(300) }));
  const fitted = telegramMenu(many);
  assert.equal(fitted.length, 100);
  assert.ok(fitted.reduce((n, one) => n + one.command.length + one.description.length, 0) <= 5700);
  assert.ok(fitted.every((one) => one.description.length >= 1 && one.description.length <= 256));
});

test("menu: a menu Telegram calls too big is sent again, smaller", async () => {
  const api = botApi((method, body) => (method === "setMyCommands" && body.commands.length > 5
    ? { ok: false, error_code: 400, description: "Bad Request: BOT_COMMANDS_TOO_MUCH" } : { ok: true, result: true }));
  const adapter = new TelegramAdapter({ id: "tg", token: "1:fake", pollTimeoutSeconds: 0, fetch: api.fetch });
  await adapter.setCommands(Array.from({ length: 8 }, (_, i) => ({ command: `c${i}`, description: "d" })));
  assert.deepEqual(api.calls.map((c) => c.body.commands.length), [8, 6, 4]);
});

test("the router sets Telegram's menu from the chat commands once they are switched on", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-tg-menu-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const api = botApi();
  const adapter = new TelegramAdapter({ id: "tg", token: "1:fake", pollTimeoutSeconds: 0, fetch: api.fetch });
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: [] });
  app.channels.setSwitches({ commands: "on" });
  let set;
  for (let i = 0; i < 200 && !(set = api.calls.find((c) => c.method === "setMyCommands")); i++) await delay(10);
  assert.ok(set, "setMyCommands was called");
  const names = set.body.commands.map((c) => c.command);
  assert.ok(names.includes("stop") && names.includes("help"), names.join(","));
});

test("the owner's own direct chat gets its menu while commands are off as shipped, and loses it once the owner moves the switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-tg-menu-owner-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const api = botApi();
  const adapter = new TelegramAdapter({ id: "tg", token: "1:fake", pollTimeoutSeconds: 0, fetch: api.fetch });
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  const { saveOwnerAccounts } = await import("../dist/reach/platform.js");
  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "tg", sender: "42" }]);
  app.store.save("settings", app.runtime.owner, "channel-pair:tg:42", { status: "approved", code: "123456", name: "Owner", requestedAt: new Date().toISOString() });
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: [] });
  let scoped;
  for (let i = 0; i < 200 && !(scoped = api.calls.find((c) => c.method === "setMyCommands" && c.body.scope)); i++) await delay(10);
  assert.deepEqual(scoped?.body.scope, { type: "chat", chat_id: 42 });
  assert.ok(scoped.body.commands.some((c) => c.command === "stop"));
  assert.ok(api.calls.some((c) => c.method === "deleteMyCommands" && !c.body.scope), "every other chat gets no menu while commands are off");
  app.channels.setSwitches({ commands: "off" });
  let cleared;
  for (let i = 0; i < 200 && !(cleared = api.calls.find((c) => c.method === "deleteMyCommands" && c.body.scope)); i++) await delay(10);
  assert.deepEqual(cleared?.body.scope, { type: "chat", chat_id: 42 }, "the owner's choice holds in their own chat too");
});
