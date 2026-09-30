/**
 * Telegram's read position is acknowledged when an update is saved to the inbox, not when its task finishes
 * (src/channels/telegram-inbox.ts). Before, getUpdates kept asking from the oldest unfinished update: it asked in a
 * hot loop for a whole task, stalled once 100 updates waited above it, and after a restart ran every later update
 * again. Also here: retry_after, 409 Conflict, the restart backlog marked caughtUp, and the delivery ledger's error table.
 *
 * Mutation notes: in src/channels/telegram.ts, holding `this.offset` until a handler settles again fails the poll-count
 * and 150-pending tests; dropping `this.inbox.done(id)` fails the restart test; dropping the retry_after branch in
 * call() fails the 429 test; dropping deleteWebhook or `this.conflict = conflictReason` fails the 409 test; dropping
 * `caughtUp` from rowsOf() or handOver() fails the backlog test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp } from "node:fs/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Deliveries, MemoryInbox, TelegramAdapter, keepDoneMs, telegramInbox } from "../dist/index.js";
import { conflictReason } from "../dist/channels/telegram.js";

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * A Bot API stand-in that behaves like Telegram's getUpdates: an offset confirms (deletes) every lower update, at most
 * `limit` updates come back, and with nothing waiting the request is held open for `timeout` seconds.
 */
async function fakeTelegram(t) {
  const state = { queue: [], polls: [], calls: [], waiting: new Set(), answer: {} };
  state.push = (...updates) => { state.queue.push(...updates); for (const wake of [...state.waiting]) wake(); };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const method = req.url.split("/").pop(), body = raw ? JSON.parse(raw) : {};
    state.calls.push({ method, body, at: Date.now() });
    const reply = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    const scripted = state.answer[method]?.shift();
    if (scripted) return reply(scripted.status, scripted.body);
    if (method === "getMe") return reply(200, { ok: true, result: { id: 7, is_bot: true, username: "InboxBot" } });
    if (method === "getUpdates") {
      state.polls.push({ offset: body.offset, limit: body.limit, at: Date.now() });
      state.queue = state.queue.filter((u) => u.update_id >= (body.offset ?? 0)); // confirmed updates are gone for good
      if (!state.queue.length) await new Promise((resolve) => {
        const done = () => { state.waiting.delete(done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, (body.timeout ?? 0) * 1000); state.waiting.add(done);
      });
      return reply(200, { ok: true, result: state.queue.slice(0, body.limit ?? 100) });
    }
    if (method === "sendMessage") return reply(200, { ok: true, result: { message_id: 900 + state.calls.length, chat: { id: body.chat_id } } });
    return reply(200, { ok: true, result: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const wake of [...state.waiting]) wake(); server.closeAllConnections(); server.close(resolve); }));
  state.base = `http://127.0.0.1:${server.address().port}`;
  return state;
}
const message = (id, chat, text, extra = {}) => ({ update_id: id, message: { message_id: id, text, from: { id: chat, first_name: "P" },
  chat: { id: chat, type: "private" }, ...extra } });
function adapterFor(t, state, extra = {}) {
  const adapter = new TelegramAdapter({ id: "tg", token: "7:x", apiBase: state.base, pollTimeoutSeconds: 1, ...extra });
  t.after(() => adapter.stop());
  return adapter;
}
/** One database file opened twice, as Branch before and after a restart would. */
function restartableDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "branch-tg-inbox-"));
  const opened = [];
  t.after(() => { for (const db of opened) db.close(); rmSync(dir, { recursive: true, force: true }); });
  return () => { const db = new DatabaseSync(join(dir, "inbox.sqlite")); opened.push(db); return { sqlite: db }; };
}
/** The backlog window is closed by the first poll that comes back with less than a full page. */
const firstPollBack = (state) => until(() => state.polls.length >= 2, "the first poll back");

test("a long task does not make the bot ask Telegram over and over: the update is acknowledged once saved", async (t) => {
  const state = await fakeTelegram(t);
  const adapter = adapterFor(t, state);
  let finish;
  const handled = [];
  await adapter.start(async (m) => { handled.push(m.text); if (m.text === "long") await new Promise((r) => { finish = r; }); });
  await firstPollBack(state);
  state.push(message(1, 42, "long"));
  await until(() => handled.includes("long"), "the long task");
  const before = state.polls.length;
  await delay(3000); // the task works for three seconds; each poll is held open for a second
  const asked = state.polls.length - before;
  t.diagnostic(`${asked} getUpdates calls while one three-second task worked`);
  assert.ok(asked <= 5, `asked Telegram ${asked} times while one task worked`);
  assert.ok(state.polls.slice(before).every((p) => p.offset === 2), "the working update was acknowledged at once");
  assert.ok(state.polls.every((p) => p.limit === 100), "the page size is asked for by name");
  finish();
});

test("150 updates waiting behind a long task do not stall a new message from another chat", async (t) => {
  const state = await fakeTelegram(t);
  const adapter = adapterFor(t, state);
  const release = [];
  const handled = [];
  await adapter.start(async (m) => { handled.push(m.text); if (m.chatId === "42") await new Promise((r) => release.push(r)); });
  t.after(() => release.forEach((r) => r()));
  await firstPollBack(state);
  state.push(message(1, 42, "long"));
  await until(() => handled.includes("long"), "the long task");
  state.push(...Array.from({ length: 150 }, (_, i) => message(2 + i, 42, `note ${i}`)));
  await delay(100);
  const sent = Date.now();
  state.push(message(152, 77, "other chat"));
  await until(() => handled.includes("other chat"), "the other chat's message", 3000);
  t.diagnostic(`the other chat's message was handed over ${Date.now() - sent} ms after it arrived`);
  assert.equal(handled.filter((text) => text.startsWith("note")).length, 150, "every waiting update was taken in once");
  assert.deepEqual(handled.filter((text) => text.startsWith("note")), Array.from({ length: 150 }, (_, i) => `note ${i}`), "in order");
});

test("a restart after finished tasks runs none of them again; an unfinished one is handed over once, as caught up", async (t) => {
  const state = await fakeTelegram(t);
  const open = restartableDb(t);
  let saved = 0;
  const position = { load: () => saved, save: (offset) => { saved = offset; } };
  const options = { position, inbox: telegramInbox(open(), "7", "tg") };
  const first = adapterFor(t, state, options);
  const handled = [];
  let hold;
  await first.start(async (m) => { handled.push(m.text); if (m.text === "cut off") await new Promise((r) => { hold = r; }); });
  await firstPollBack(state);
  state.push(message(10, 42, "one"), message(11, 43, "cut off"), message(12, 44, "three"));
  await until(() => handled.length === 3 && saved === 13, "all three taken in");
  await first.stop(); // Branch closes while "cut off" is still being answered
  // Telegram was told about all three the moment they were saved: nothing comes back from it after the restart.
  const replayed = [];
  const second = adapterFor(t, state, { position, inbox: telegramInbox(open(), "7", "tg") });
  await second.start(async (m) => { replayed.push(m); });
  await until(() => replayed.length === 1, "the unfinished one handed over");
  await delay(300);
  assert.deepEqual(replayed.map((m) => m.text), ["cut off"], "the finished ones are not run again");
  assert.equal(replayed[0].caughtUp, true, "cut off by a restart: old news, so an owner command in it is not run again");
  assert.ok(state.polls.at(-1).offset >= 13, "asks only for what came after");
  hold();
});

test("an inbox that could not save acknowledges nothing, and the update is taken in once it can", async (t) => {
  const state = await fakeTelegram(t);
  const inner = telegramInbox({ sqlite: new DatabaseSync(":memory:") }, "7", "tg");
  let broken = true;
  const inbox = { ...inner, add: (rows) => { if (broken) throw new Error("disk unavailable"); inner.add(rows); },
    pending: () => inner.pending(), done: (id) => inner.done(id), markCaughtUp: () => inner.markCaughtUp(), newest: () => inner.newest() };
  const adapter = adapterFor(t, state, { inbox });
  const handled = [];
  state.push(message(30, 42, "hello"));
  await adapter.start(async (m) => { handled.push(m.text); });
  await until(() => state.polls.length >= 1, "a poll");
  await delay(200);
  assert.deepEqual(handled, []);
  assert.ok(state.polls.every((p) => p.offset <= 30), "nothing confirmed that was not saved");
  broken = false;
  await until(() => handled.length === 1, "taken in once the inbox saves", 8000);
  await until(() => state.polls.some((p) => p.offset === 31), "then acknowledged");
  assert.deepEqual(handled, ["hello"]);
});

test("429: a send waits exactly retry_after and then goes through", async (t) => {
  const state = await fakeTelegram(t);
  state.answer.sendMessage = [{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } }];
  const adapter = adapterFor(t, state);
  const began = Date.now();
  const id = await adapter.send("42", "hello");
  const took = Date.now() - began;
  t.diagnostic(`sent after ${took} ms`);
  assert.ok(id, "sent");
  assert.ok(took >= 2900 && took < 4500, `waited ${took} ms for a three-second retry_after`);
  assert.equal(state.calls.filter((c) => c.method === "sendMessage").length, 2);
});

test("a group that became a supergroup: the send follows migrate_to_chat_id, and later sends go there at once", async (t) => {
  const state = await fakeTelegram(t);
  state.answer.sendMessage = [{ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat",
    parameters: { migrate_to_chat_id: -1001234 } } }];
  const adapter = adapterFor(t, state);
  assert.ok(await adapter.send("-55", "one"));
  assert.ok(await adapter.send("-55", "two"));
  assert.deepEqual(state.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.chat_id), [-55, -1001234, -1001234]);
});

test("409 Conflict: the webhook is deleted, the reason shows in health, and it clears once polling works", async (t) => {
  const state = await fakeTelegram(t);
  const conflict = { status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" } };
  state.answer.getUpdates = [conflict];
  const adapter = adapterFor(t, state);
  await adapter.start(async () => undefined);
  await until(() => state.calls.some((c) => c.method === "deleteWebhook"), "deleteWebhook");
  assert.deepEqual(adapter.health(), { state: "needs attention", reason: conflictReason });
  assert.equal(state.calls.find((c) => c.method === "deleteWebhook").body.drop_pending_updates, false, "waiting updates are kept");
  await delay(300);
  assert.equal(state.calls.filter((c) => c.method === "getUpdates").length, 1, "backs off instead of asking again at once");
});

test("409 from a webhook still set: removed, and polling carries on at once", async (t) => {
  const state = await fakeTelegram(t);
  state.answer.getUpdates = [{ status: 409, body: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" } }];
  const adapter = adapterFor(t, state);
  const handled = [];
  state.push(message(5, 42, "after the webhook"));
  await adapter.start(async (m) => { handled.push(m.text); });
  await until(() => handled.length === 1, "the message", 3000);
  assert.ok(state.calls.some((c) => c.method === "deleteWebhook"));
  assert.deepEqual(adapter.health(), { state: "connected" });
});

test("the backlog after a restart is marked caughtUp, capped at the newest 20, and live messages are not", async (t) => {
  const state = await fakeTelegram(t);
  const old = Math.floor(Date.now() / 1000) - 600;
  state.push({ update_id: 1, callback_query: { id: "cb", data: "yes", from: { id: 42, first_name: "P" }, message: { message_id: 3, chat: { id: 42, type: "private" } } } });
  state.push(...Array.from({ length: 24 }, (_, i) => message(2 + i, 42, `old ${i}`, { date: old })));
  const adapter = adapterFor(t, state);
  const handled = [];
  await adapter.start(async (m) => { handled.push(m); });
  await until(() => handled.length === 20, "the backlog");
  await delay(200);
  assert.equal(handled.length, 20, "only the newest 20 of 25 waiting are answered");
  assert.deepEqual(handled.map((m) => m.text), Array.from({ length: 20 }, (_, i) => `old ${i + 4}`));
  assert.ok(handled.every((m) => m.caughtUp === true), "all caught up");
  state.push(message(26, 42, "/status", { date: Math.floor(Date.now() / 1000) }));
  await until(() => handled.length === 21, "the live message");
  assert.equal(handled[20].caughtUp, undefined, "a message sent after the start is live");
});

test("delivery ledger: gone is never retried, flood waits retry_after without spending a try, a cut-off send is marked resent", async () => {
  const rows = new Map();
  const store = {
    list: () => [...rows.values()],
    get: (_table, _owner, id) => rows.get(id),
    save: (_table, owner, id, data) => { const at = new Date().toISOString(); rows.set(id, { id, owner, data, createdAt: at, updatedAt: at }); return rows.get(id); },
    delete: (_table, _owner, id) => rows.delete(id),
  };
  let now = Date.now();
  const ledger = new Deliveries(store, "local", () => new Date(now));
  const failed = [];
  ledger.notifyEvent = (kind, data) => failed.push({ kind, data });
  const refuse = (error) => async () => { throw error; };
  ledger.enqueue("tg", "1", "blocked", "k1");
  await ledger.flush("tg", refuse(Object.assign(new Error("Telegram sendMessage failed: Forbidden: bot was blocked by the user"), { status: 403 })));
  const gone = ledger.list().find((d) => d.key === "k1");
  assert.equal(gone.status, "dead", "a blocked bot is given up at once");
  assert.equal(gone.attempts, 1);
  assert.equal(failed[0]?.kind, "delivery.failed");

  ledger.enqueue("tg", "2", "busy", "k2");
  await ledger.flush("tg", refuse(Object.assign(new Error("Telegram sendMessage failed: Too Many Requests"), { status: 429, retryAfter: 7 })));
  const flood = ledger.list().find((d) => d.key === "k2");
  assert.equal(flood.status, "pending");
  assert.equal(flood.attempts, 0, "a flood wait is not a failed try");
  assert.equal(Date.parse(flood.nextAt) - now, 7000, "due exactly retry_after later");

  ledger.enqueue("tg", "3", "cut off", "k3");
  // Branch stopped between writing "attempting" and hearing back from Telegram.
  const { id, createdAt, updatedAt, ...cut } = ledger.list().find((d) => d.key === "k3");
  void createdAt; void updatedAt;
  store.save("deliveries", "local", id, { ...cut, status: "attempting" });
  now += 8000;
  const sent = [];
  await ledger.flush("tg", async (chatId, text) => { sent.push(text); return "m"; });
  const resent = ledger.list().find((d) => d.key === "k3");
  assert.equal(resent.status, "sent");
  assert.equal(resent.resent, true, "a send Branch was cut off in the middle of is marked as possibly shown twice");
  assert.equal(ledger.list().find((d) => d.key === "k2").resent, undefined, "an ordinary send is not");
  assert.deepEqual(sent.sort(), ["busy", "cut off"]);
});

test("an inbox whose database was closed keeps the poll alive: nothing read, nothing confirmed", () => {
  const store = { sqlite: new DatabaseSync(":memory:"), isOpen: true };
  const inbox = telegramInbox(store, "7", "tg");
  inbox.add([{ updateId: 1, update: { update_id: 1 }, caughtUp: false }]);
  store.isOpen = false;
  assert.deepEqual(inbox.pending(), [], "a closed database reads as empty instead of throwing out of the poll loop");
  assert.equal(inbox.newest(), 0);
  assert.throws(() => inbox.add([{ updateId: 2, update: { update_id: 2 }, caughtUp: false }]), /closed/, "a save that cannot happen stops the offset moving");
  assert.doesNotThrow(() => { inbox.done(1); inbox.markCaughtUp(); });
});

const row = (id) => ({ updateId: id, update: { update_id: id, message: { text: `words ${id}` } }, caughtUp: false });

test("the in-memory inbox drops a handled update at once and remembers only a bounded window of numbers", () => {
  const inbox = new MemoryInbox(50);
  inbox.add(Array.from({ length: 200 }, (_, i) => row(i + 1)));
  for (let id = 1; id <= 200; id++) inbox.done(id);
  assert.deepEqual(inbox.pending(), [], "nothing handled is kept");
  assert.equal(inbox.size, 50, "only the newest 50 handled numbers are remembered, and none of their words");
  inbox.add([row(200)]);
  assert.deepEqual(inbox.pending(), [], "an update handled recently is not taken in twice");
  assert.equal(inbox.newest(), 200, "the newest number survives the handled rows being dropped");
  inbox.add([row(201)]);
  assert.deepEqual(inbox.pending().map((r) => r.updateId), [201]);
});

test("a replaced token drops what the old bot saved under that connection at once; other connections keep theirs", () => {
  const store = { sqlite: new DatabaseSync(":memory:") };
  const old = telegramInbox(store, "111", "telegram");
  old.add([row(1), row(2)]);
  old.done(1);
  const elsewhere = telegramInbox(store, "333", "work-bot");
  elsewhere.add([row(9)]);
  telegramInbox(store, "222", "telegram"); // the card saved with a new token: another bot under the same connection
  const left = store.sqlite.prepare("SELECT bot, update_id FROM telegram_inbox ORDER BY bot").all().map((r) => `${r.bot}:${r.update_id}`);
  assert.deepEqual(left, ["333:9"], "the old bot's rows, handled or not, are gone with their words");
});

test("handled rows are kept only a day, then pruned for every bot", () => {
  const store = { sqlite: new DatabaseSync(":memory:") };
  const inbox = telegramInbox(store, "111", "telegram");
  inbox.add([row(1), row(2), row(3)]);
  inbox.done(1); inbox.done(2);
  const longAgo = new Date(Date.now() - keepDoneMs - 60_000).toISOString();
  store.sqlite.prepare("UPDATE telegram_inbox SET done_at=? WHERE update_id=1").run(longAgo);
  assert.equal(keepDoneMs, 24 * 60 * 60 * 1000);
  assert.equal(store.sqlite.prepare("SELECT body FROM telegram_inbox WHERE update_id=2").get().body, "{}", "a handled row keeps no words");
  telegramInbox(store, "999", "another"); // any inbox opened tidies every bot's old handled rows
  const ids = store.sqlite.prepare("SELECT update_id FROM telegram_inbox ORDER BY update_id").all().map((r) => r.update_id);
  assert.deepEqual(ids, [2, 3], "the day-old handled row is gone; a recent one and the unhandled one stay");
});

test("disconnecting a bot deletes its saved inbox rows straight away, even one still being answered", async (t) => {
  const state = await fakeTelegram(t);
  const root = await mkdtemp(join(tmpdir(), "branch-tg-forget-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { name: "scripted", complete: async (request) => {
    if (JSON.stringify(request.messages ?? request).includes("slow one")) await gate;
    return { content: "ok", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { release(); await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  const adapter = new TelegramAdapter({ id: "tg", token: "7:x", apiBase: state.base, pollTimeoutSeconds: 1, inbox: telegramInbox(app.store, "7", "tg") });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42", "43"] });
  await firstPollBack(state);
  state.push(message(1, 42, "quick one"), message(2, 43, "slow one"));
  const rows = () => app.store.sqlite.prepare("SELECT update_id, done_at FROM telegram_inbox WHERE bot='7' ORDER BY update_id").all();
  await until(() => rows().length === 2 && rows()[0].done_at && !rows()[1].done_at, "one answered, one still being answered", 10000);
  await app.channels.detach("tg");
  assert.deepEqual(rows(), [], "nothing of the disconnected bot is kept, handled or not");
  release();
  await delay(200);
  assert.deepEqual(rows(), [], "the answer finishing later writes nothing back");
});
