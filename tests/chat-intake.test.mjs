/**
 * Settings › Chat apps: what the Trunk sees (edited messages, photo albums as one message, waiting for messages split
 * in two) and staying connected (the watchdog, reconnect after, online status). Every chat service is a stand-in on
 * this computer; the clock for the watchdog is handed in, so nothing waits on a timer.
 *
 * Mutation notes (each turns this file red):
 * - router.ts joinTurn: drop the edited-message swap while gathering        -> "the latest version is answered" fails.
 * - router.ts handle: drop the edited-off check                             -> "switched off, an edit is let go" fails.
 * - router.ts gatherMs: drop the split wait                                  -> "joined into one turn" fails.
 * - router.ts checkStalled: restart without waiting "reconnect after"        -> "quiet but not yet due" fails.
 * - router.ts checkStalled: never set the problem                             -> "says so on its card" fails.
 * - router.ts presence: drop the Lockdown check                               -> "nothing goes out under Lockdown" fails.
 * - telegram.ts: drop edited_message from allowed_updates                     -> "asks Telegram for edits" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { startServer } from "../dist/server.js";
import { createBranch, TelegramAdapter } from "../dist/index.js";
import { readChatIntake, saveChatIntake } from "../dist/channels/intake-settings.js";
import { setLockdown } from "../dist/lockdown.js";

async function until(check, label, tries = 500) {
  for (let i = 0; i < tries; i++) { const value = check(); if (value) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
const lastUser = (request) => String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
function scripted() {
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => { model.requests.push(request); return { content: `Echo: ${lastUser(request)}`, toolCalls: [] }; };
  return model;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-intake-"));
  const model = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  app.channels.liveTiming = { progressAfterMs: 60000, editEveryMs: 10, typingEveryMs: 20, reactEveryMs: 5 };
  return { app, model, root };
}
/** A Telegram Bot API stand-in: `queue` is what getUpdates hands out, `calls` everything Branch asked. */
async function telegram(t) {
  const state = { queue: [], calls: [] };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const method = req.url.split("/").pop(), body = raw ? JSON.parse(raw) : {};
    state.calls.push({ method, body });
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "Branch", username: "BranchTestBot" });
    if (method === "getUpdates") {
      if (state.hang) { await delay(1500); if (state.hang) { res.destroy(); return; } }
      const pending = state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!pending.length) await delay(20);
      return reply(pending);
    }
    if (method === "sendMessage") return reply({ message_id: 5000 + state.calls.length });
    return reply(true);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapter = new TelegramAdapter({ id: "tg", token: "1:x", apiBase: `http://127.0.0.1:${server.address().port}`, pollTimeoutSeconds: 1 });
  return { state, adapter };
}
const from = { id: 42, first_name: "Ann" }, chat = { id: 501, type: "private" };

test("what the Trunk sees ships on; presence ships off; a bad value is refused", () => {
  const rows = new Map(), store = { get: (_t, _o, id) => (rows.has(id) ? { data: rows.get(id) } : undefined), save: (_t, _o, id, data) => rows.set(id, data) };
  assert.deepEqual(readChatIntake(store, "o"), { edited: true, albums: true, telegramMedia: true, splitWaitMs: 1000, watchdog: true, reconnectMinutes: 3, stalledAfterSeconds: 90, presence: false });
  assert.equal(saveChatIntake(store, "o", { splitWaitMs: 3000 }).splitWaitMs, 3000);
  assert.equal(readChatIntake(store, "o").edited, true, "the fields not named keep their value");
  assert.throws(() => saveChatIntake(store, "o", { splitWaitMs: 2000 }));
  assert.throws(() => saveChatIntake(store, "o", { reconnectMinutes: 5 }));
});

test("Telegram: an edited message is asked for, and while it is still being gathered the latest version is answered", async (t) => {
  const { app, model } = await fixture(t);
  const { state, adapter } = await telegram(t);
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  await until(() => state.calls.some((c) => c.method === "getUpdates"), "polling");
  assert.ok(state.calls.find((c) => c.method === "getUpdates").body.allowed_updates.includes("edited_message"), "asks Telegram for edits");
  state.queue.push({ update_id: 1, message: { message_id: 10, text: "tidy the folder", from, chat } });
  state.queue.push({ update_id: 2, edited_message: { message_id: 10, text: "tidy the downloads folder", from, chat } });
  await until(() => model.requests.length === 1, "one task");
  assert.match(lastUser(model.requests[0]), /tidy the downloads folder/, "the latest version is answered");
  assert.doesNotMatch(lastUser(model.requests[0]), /tidy the folder/);
  await until(() => state.calls.some((c) => ["sendMessage", "editMessageText"].includes(c.method) && /^Echo:/.test(c.body.text ?? "")), "the answer");
  assert.equal(model.requests.length, 1, "the edit did not start a second task");
});

test("switched off, an edit is let go and the first version is answered", async (t) => {
  const { app, model } = await fixture(t);
  saveChatIntake(app.store, app.runtime.owner, { edited: false });
  const { state, adapter } = await telegram(t);
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  state.queue.push({ update_id: 1, message: { message_id: 10, text: "tidy the folder", from, chat } });
  state.queue.push({ update_id: 2, edited_message: { message_id: 10, text: "tidy the downloads folder", from, chat } });
  await until(() => model.requests.length === 1, "one task");
  await until(() => state.calls.some((c) => ["sendMessage", "editMessageText"].includes(c.method) && /^Echo:/.test(c.body.text ?? "")), "the answer");
  assert.equal(model.requests.length, 1);
  assert.match(lastUser(model.requests[0]), /tidy the folder/);
});

test("an album's photos, and a message split in two, are joined into one turn; off, each is its own", async (t) => {
  const { app, model } = await fixture(t);
  app.channels.mergeWindowMs = 1000; // gathering on, as shipped
  const seen = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {}, async send(_c, text) { seen.push(text); return "1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  const msg = (id, text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id, ...extra });
  await Promise.all([app.channels.handle(msg("a1", "Here is the first half of it,")), delay(200).then(() => app.channels.handle(msg("a2", "and here is the second half.")))]);
  assert.equal(model.requests.length, 1, "joined into one turn");
  assert.match(lastUser(model.requests[0]), /first half[\s\S]*second half/);
  saveChatIntake(app.store, app.runtime.owner, { splitWaitMs: 0 });
  app.channels.mergeWindowMs = 1000;
  app.channels.setSwitches({ steering: "off" });
  const before = model.requests.length;
  await Promise.all([app.channels.handle(msg("b1", "one")), delay(50).then(() => app.channels.handle(msg("b2", "two")))]);
  assert.equal(model.requests.length - before, 2, "no wait: each its own turn");
  const album = model.requests.length;
  await Promise.all([app.channels.handle(msg("p1", "our holiday", { groupId: "g7" })), delay(300).then(() => app.channels.handle(msg("p2", "", { groupId: "g7" })))]);
  assert.equal(model.requests.length - album, 1, "an album is waited for even with no split wait");
  const mixed = model.requests.length;
  await Promise.all([app.channels.handle(msg("q1", "our trip", { groupId: "g9" })), delay(200).then(() => app.channels.handle(msg("q2", "and a separate question")))]);
  assert.equal(model.requests.length - mixed, 2, "with no split wait, an album's wait takes only that album's photos");
});

/** A chat app the watchdog can look at: its last contact is set by hand, and restarts are counted. */
function watched(fail = null) {
  const adapter = { id: "wd", kind: "telegram", botName: () => "Branch", contact: 0, restarts: 0, async start() {}, async stop() {}, async send() { return "1"; },
    lastContact() { return this.contact; }, async restart() { this.restarts++; if (fail) throw new Error(fail); } };
  return adapter;
}

test("the watchdog: a quiet app is left alone; stalled for 'reconnect after' it is started again once; still stalled, its card says so", async (t) => {
  const { app } = await fixture(t);
  const adapter = watched();
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  const T = 10_000_000;
  adapter.contact = T;
  await app.channels.checkStalled(T + 60_000);
  assert.equal(adapter.restarts, 0, "reached a minute ago: not stalled");
  await app.channels.checkStalled(T + 120_000);
  assert.equal(adapter.restarts, 0, "stalled, but quiet but not yet due (3 minutes)");
  await app.channels.checkStalled(T + 200_000);
  assert.equal(adapter.restarts, 0, "three minutes counted from when it became stalled (90 s), not from its last contact");
  await app.channels.checkStalled(T + 271_000);
  assert.equal(adapter.restarts, 1, "stalled for three minutes: started again");
  await app.channels.checkStalled(T + 300_000);
  assert.equal(adapter.restarts, 1, "once per wait");
  const row = () => app.channels.summary().channels.find((c) => c.id === "wd");
  assert.equal(row().health.state, "connected");
  assert.equal(row().watchdog.reconnectsToday, 1);
  await app.channels.checkStalled(T + 452_000);
  assert.equal(adapter.restarts, 2);
  assert.equal(row().health.state, "needs attention", "still stalled after starting again: says so on its card");
  assert.match(row().health.reason, /stopped receiving, and starting it again did not bring it back/);
  adapter.contact = T + 460_000;
  await app.channels.checkStalled(T + 470_000);
  assert.equal(row().health.state, "connected", "back: the card clears");
  saveChatIntake(app.store, app.runtime.owner, { watchdog: false });
  await app.channels.checkStalled(T + 5_000_000);
  assert.equal(adapter.restarts, 2, "switched off: never restarted");
});

test("the watchdog: an app that cannot start again says why", async (t) => {
  const { app } = await fixture(t);
  const adapter = watched("the token was refused");
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  saveChatIntake(app.store, app.runtime.owner, { reconnectMinutes: 1, stalledAfterSeconds: 30 });
  adapter.contact = 1_000_000;
  await app.channels.checkStalled(1_000_000 + 91_000);
  const row = app.channels.summary().channels.find((c) => c.id === "wd");
  assert.equal(row.health.state, "needs attention");
  assert.match(row.health.reason, /could not start it again: the token was refused/);
});

test("the watchdog: an app taken out while it is being started again is stopped, not left running", async (t) => {
  const { app } = await fixture(t);
  let release;
  const adapter = { ...watched(), running: true, async stop() { this.running = false; },
    async restart() { this.restarts++; await new Promise((resolve) => { release = resolve; }); this.running = true; } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  adapter.contact = 1_000_000;
  const checking = app.channels.checkStalled(1_000_000 + 271_000);
  await until(() => release, "the restart began");
  await app.channels.detach("wd");
  assert.equal(adapter.running, false);
  release();
  await checking;
  assert.equal(adapter.restarts, 1);
  assert.equal(adapter.running, false, "the restart finished after the app was taken out, so it is stopped again");
});

test("Telegram starts again after a stall and keeps receiving; its contact time moves with each poll", async (t) => {
  const { app, model } = await fixture(t);
  const { state, adapter } = await telegram(t);
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  const first = adapter.lastContact();
  await until(() => adapter.lastContact() > first, "a poll came back");
  // A poll that never answers: starting again does not count as contact by itself, so the watchdog can tell.
  state.hang = true;
  const before = adapter.lastContact();
  await adapter.restart((message) => app.channels.handle(message).then(() => undefined));
  await delay(300);
  assert.equal(adapter.lastContact(), before, "no answer, no contact");
  state.hang = false;
  await until(() => adapter.lastContact() > before, "contact again once Telegram answers");
  await adapter.restart((message) => app.channels.handle(message).then(() => undefined));
  state.queue.push({ update_id: 1, message: { message_id: 10, text: "still there?", from, chat } });
  await until(() => model.requests.length === 1, "answered after starting again");
});

test("online status: off as shipped; on, 'Online' at start and 'Offline, back soon' at the end; never under Lockdown", async (t) => {
  const { app, root } = await fixture(t);
  const { state, adapter } = await telegram(t);
  const said = () => state.calls.filter((c) => c.method === "setMyShortDescription").map((c) => c.body.short_description);
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  assert.deepEqual(said(), [], "off: nothing set");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const ask = (body) => fetch(new URL("/api/channels/intake", server.url), { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await ask()).body.intake.presence, false);
  assert.equal((await ask({ presence: true })).body.intake.presence, true);
  await until(() => said().includes("Online"), "Online");
  await ask({ presence: false });
  await until(() => said().at(-1) === "", "cleared");
  assert.equal((await ask({ splitWaitMs: 5 })).status, 400);
  setLockdown(app.store, app.runtime.owner, { on: true });
  const count = said().length;
  await ask({ presence: true });
  await app.channels.detachAll();
  assert.equal(said().length, count, "nothing goes out under Lockdown");
  setLockdown(app.store, app.runtime.owner, { on: false });
  const again = await telegram(t);
  await app.channels.attach(again.adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  await until(() => again.state.calls.some((c) => c.method === "setMyShortDescription" && c.body.short_description === "Online"), "Online at start");
  await app.channels.detachAll();
  assert.equal(again.state.calls.filter((c) => c.method === "setMyShortDescription").at(-1).body.short_description, "Offline, back soon");
});
