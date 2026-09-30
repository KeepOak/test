/**
 * Telegram from end to end, through the engine's own routes and a stand-in for api.telegram.org that
 * speaks the Bot API over real HTTP: the token is pasted and checked, the bot connects, the owner pairs
 * with the six-digit code, messages come and go, the model answers, an approval is given by pressing a
 * button, a long answer is split to fit, the connection drops and comes back without losing or repeating
 * a message, and a replaced token replaces the bot. Nothing leaves this computer; the token is made up.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, TelegramAdapter } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { saveChatLiveSwitches } from "../dist/channels/chat-live-settings.js";

/** BotFather's shape: digits, a colon, 30 to 64 letters. Made up; it opens nothing anywhere. */
const token = `123456:TEST-fake-token-${"a".repeat(20)}`;
const replacement = `654321:TEST-fake-token-${"b".repeat(20)}`;
const owner = { id: 42, first_name: "Sam", username: "sam" };
const dm = { id: 42, type: "private" };

/**
 * The stand-in Bot API. getUpdates forgets every update below the offset it is asked with, as Telegram
 * does, and holds a poll open briefly when nothing is waiting. `drop()` cuts every open connection and
 * refuses new ones until `restore()`; `cutNextDelivery` loses one answer that carried updates. `hold(skip)`
 * keeps every getMe after the next `skip` waiting until the function it returns is called.
 */
async function fakeBotApi(t) {
  const bots = new Map(); // bot id -> { queue, next }
  const state = { calls: [], sent: [], edits: [], answered: [], tooLong: 0, down: false, cutNextDelivery: false, getMeCount: 0, refused: 0 };
  let gate = null;
  const sockets = new Set();
  const wake = new Set();
  const botFor = (id) => { if (!bots.has(id)) bots.set(id, { queue: [], next: 1 }); return bots.get(id); };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const [, path, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url) ?? [];
    if (!path) { res.writeHead(404); res.end(); return; }
    const botId = path.split(":")[0];
    const body = raw ? JSON.parse(raw) : {};
    state.calls.push({ botId, method, body });
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    const refuse = (code, description) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error_code: code, description })); };
    if (method === "getMe") {
      state.getMeCount += 1;
      if (gate && state.getMeCount > gate.after) await gate.open;
      return reply({ id: Number(botId), is_bot: true, first_name: "Branch", username: `E2E${botId}Bot` });
    }
    if (method === "getUpdates") {
      const bot = botFor(botId);
      bot.queue = bot.queue.filter((update) => update.update_id >= (body.offset ?? 0));
      if (!bot.queue.length) await new Promise((resolve) => { wake.add(resolve); setTimeout(resolve, 300); });
      wake.clear();
      const waiting = bot.queue.filter((update) => update.update_id >= (body.offset ?? 0));
      if (waiting.length && state.cutNextDelivery) { state.cutNextDelivery = false; req.socket.destroy(); return; }
      return reply(waiting);
    }
    if (method === "sendMessage") {
      if (String(body.text).length > 4096) { state.tooLong += 1; return refuse(400, "Bad Request: message is too long"); }
      state.sent.push({ botId, ...body });
      return reply({ message_id: 1000 + state.sent.length, chat: { id: body.chat_id, type: "private" }, text: body.text });
    }
    if (method === "editMessageText") { state.edits.push(body); return reply(true); }
    if (method === "answerCallbackQuery") { state.answered.push(body.callback_query_id); return reply(true); }
    if (["sendChatAction", "setMessageReaction", "setMyCommands", "deleteWebhook"].includes(method)) return reply(true);
    refuse(404, "Not Found");
  });
  server.on("connection", (socket) => {
    if (state.down) { state.refused += 1; socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  const push = (botId, update) => {
    const bot = botFor(botId);
    const full = { update_id: bot.next++, ...update };
    bot.queue.push(full);
    for (const resolve of wake) resolve();
    return full;
  };
  return {
    state, base: `http://127.0.0.1:${server.address().port}`,
    say: (text, botId = "123456") => push(botId, { message: { message_id: 500 + Math.floor(Math.random() * 1e6), text, from: owner, chat: dm } }),
    press: (data, botId = "123456") => push(botId, { callback_query: { id: `press-${Date.now()}`, data, from: owner, message: { message_id: 77, chat: dm } } }),
    drop: () => { state.down = true; for (const socket of sockets) socket.destroy(); },
    restore: () => { state.down = false; },
    renumber: (botId, next) => { botFor(botId).next = next; }, // Telegram's fresh numbering after a quiet week
    hold: (skip = 0) => {
      let release;
      const open = new Promise((resolve) => { release = resolve; });
      gate = { after: state.getMeCount + skip, open };
      return () => { gate = null; release(); };
    },
  };
}

async function until(check, label, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  assert.fail(`Timed out: ${label}`);
}

/** Answers in words, calls the stand-in tool when asked to, and writes a long answer when asked for one. */
function model() {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const last = request.messages.at(-1);
    if (last.role === "tool") return { content: "The tool ran.", toolCalls: [] };
    const said = String(last.content);
    if (/use the tool/.test(said)) return { content: "", toolCalls: [{ id: `call-${provider.requests.length}`, name: "demo.invented", arguments: "{}" }] };
    if (/write a lot/.test(said)) return { content: Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ").repeat(2), toolCalls: [] };
    return { content: `Echo: ${said}`, toolCalls: [] };
  } };
  return provider;
}

test("Telegram end to end: paste, check, pair, talk, approve by button, split, reconnect, replace the token", async (t) => {
  const bot = await fakeBotApi(t);
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-e2e-"));
  const provider = model();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, telegramApiBase: bot.base });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.web.policy.configure({ allowPrivateAddresses: true }); // the stand-in lives on this computer
  app.channels.mergeWindowMs = 0;
  // The chat extras ship when needed (the ship-on rule): steering would fold a message into the task already working.
  // This is about each message answered once, in order, so the owner switches them off.
  saveChatLiveSwitches(app.store, app.runtime.owner, { liveStatus: "off", steering: "off", splitting: "off" });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const texts = () => bot.state.sent.map((sent) => sent.text);

  // 1. Paste and check. Connecting asks Telegram again; the save does not wait on that second answer, which is
  // held here until the save has answered.
  assert.equal((await call("channel-setup", { mode: "on" })).status, 200);
  const release = bot.hold(1);
  const checked = await Promise.race([call("channel-setup/telegram/check", { values: { TELEGRAM_BOT_TOKEN: token }, enable: "on" }),
    delay(10_000, null, { ref: false }).then(() => assert.fail("the save waited for the bot to connect as well"))]);
  release();
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.json.botName, "E2E123456Bot");
  assert.equal(checked.json.connectNote, null);
  assert.ok(!checked.text.includes(token.split(":")[1]), "the token is never sent back");
  await until(async () => (await call("channels")).json.channels.some((c) => c.kind === "telegram" && c.botName === "E2E123456Bot"), "the bot connected");
  const card = (await call("never-break/telegram")).json;
  assert.deepEqual([card.tokenSaved, card.connected, card.botName], [true, true, "E2E123456Bot"]);

  // 2. Pair: the bot answers a stranger with a code, and the owner types it in.
  bot.say("hello");
  await until(() => texts().some((text) => /code (\d{6})/.test(text)), "a pairing code");
  const code = /code (\d{6})/.exec(texts().find((text) => /code (\d{6})/.test(text)))[1];
  assert.equal(provider.requests.length, 0, "nothing reached the model before pairing");
  assert.equal((await call("channels/pairings/approve", { code })).status, 200);
  assert.equal((await call("channels")).json.approved.length, 1);

  // 3. Send and receive, with the model's reply.
  bot.say("what is two plus two");
  await until(() => texts().includes("Echo: what is two plus two"), "the model's reply");
  assert.equal(bot.state.sent.at(-1).chat_id, 42);

  // 4. A long answer is split to fit Telegram's 4096 characters, in order, nothing lost.
  const before = bot.state.sent.length;
  bot.say("write a lot");
  const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ").repeat(2);
  await until(() => bot.state.sent.slice(before).map((sent) => sent.text).join(" ").replace(/\s+/g, " ").length >= long.replace(/\s+/g, " ").length, "every part of the long answer");
  const parts = bot.state.sent.slice(before).map((sent) => sent.text);
  assert.ok(parts.length >= 3, `split into ${parts.length}`);
  assert.ok(parts.every((part) => part.length <= 4096));
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
  assert.equal(bot.state.tooLong, 0, "Telegram never refused a part as too long");

  // 5. Approval by button: a change the owner's line lets this person approve from Telegram.
  app.registry.register({ name: "demo.invented", permission: "invented.power", description: "stand-in", group: "core",
    parameters: z.object({}).strict(), execute: async () => ({ ran: true }) });
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "telegram", sender: "42", allow: ["invented.power"], note: "my phone", approvals: true }] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "demo.invented", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  bot.say("use the tool");
  await until(() => bot.state.sent.some((sent) => sent.reply_markup), "a question with buttons");
  const keyboard = bot.state.sent.find((sent) => sent.reply_markup).reply_markup.inline_keyboard.flat();
  const yes = keyboard.find((button) => button.text === "Yes");
  assert.ok(yes && yes.callback_data.length <= 64, JSON.stringify(keyboard));
  const press = bot.press(yes.callback_data);
  await until(() => bot.state.answered.includes(press.callback_query.id), "the press acknowledged");
  // QA R1 follow-up: the yes carries the waiting task on; the engine runs the tool and the task's reply comes back.
  await until(() => texts().some((text) => /The tool ran\./.test(text)), "the yes landed and the task carried on");
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.equal(decided.length, 1);
  assert.equal(decided[0].outcome, "allowed");

  // 6. The network drops while messages arrive, and comes back: each one is answered once, in order.
  const askedBefore = provider.requests.length;
  bot.drop();
  bot.say("first while down");
  const last = bot.say("second while down");
  bot.state.cutNextDelivery = true; // and the first answer after it is lost on the way back
  bot.restore();
  await until(() => texts().includes("Echo: second while down"), "both answered after the drop", 20_000);
  const polls = (botId) => bot.state.calls.filter((c) => c.method === "getUpdates" && c.botId === botId);
  await until(() => polls("123456").some((c) => c.body.offset > last.update_id), "both acknowledged to Telegram");
  assert.equal(bot.state.cutNextDelivery, false, "an answer carrying updates really was lost on the way");
  const answered = texts().filter((text) => /while down$/.test(text));
  assert.deepEqual(answered, ["Echo: first while down", "Echo: second while down"], "nothing lost or repeated");
  assert.equal(provider.requests.length - askedBefore, 2);
  const offsets = polls("123456").map((c) => c.body.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), "the read position never went back");

  // 7. A new token for a different bot replaces the first, and the new bot's messages are read from its start.
  const replaced = await call("channel-setup/telegram/check", { values: { TELEGRAM_BOT_TOKEN: replacement }, enable: "on" });
  assert.equal(replaced.status, 200, replaced.text);
  assert.equal(replaced.json.botName, "E2E654321Bot");
  await until(async () => (await call("channels")).json.channels.some((c) => c.botName === "E2E654321Bot"), "the new bot connected");
  assert.equal((await call("channels")).json.channels.filter((c) => c.kind === "telegram").length, 1, "one bot, never two");
  const oldPolls = bot.state.calls.filter((c) => c.botId === "123456").length;
  bot.say("hello new bot", "654321");
  await until(() => bot.state.sent.some((sent) => sent.botId === "654321"), "the new bot answered");
  const newPolls = polls("654321").length;
  await until(() => polls("654321").length >= newPolls + 2, "the new bot asked twice more");
  assert.ok(bot.state.calls.filter((c) => c.botId === "123456").length <= oldPolls + 1, "the old bot is no longer read");
  const again = await call("channel-setup/telegram/check", { values: { TELEGRAM_BOT_TOKEN: replacement }, enable: "on" });
  assert.match(again.json.connectNote, /already connected/);
});

test("a bot that does not start is not left behind as connected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-e2e-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const failing = { id: "telegram", kind: "telegram", botName: () => null, async start() { throw new Error("no answer"); }, async stop() {}, async send() { return undefined; } };
  await assert.rejects(app.channels.attach(failing, { activation: "always", pairing: true, allowlist: [] }), /no answer/);
  assert.equal(app.channels.summary().channels.length, 0);
  const working = { ...failing, async start() {} };
  await app.channels.attach(working, { activation: "always", pairing: true, allowlist: [] });
  assert.equal(app.channels.summary().channels.length, 1, "connecting again is not refused as a second copy");
  await app.channels.detach("telegram");
  assert.equal(app.channels.summary().channels.length, 0);
});

test("the card's bot starts while Telegram cannot be reached, and connects once it can", async (t) => {
  const bot = await fakeBotApi(t);
  bot.drop();
  const plain = new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, pollTimeoutSeconds: 1 });
  await assert.rejects(plain.start(async () => undefined), "a settings-file channel still stops its start");
  const refusedBefore = bot.state.refused;
  const received = [];
  const adapter = new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, pollTimeoutSeconds: 1, keepTrying: true });
  await adapter.start(async (message) => { received.push(message.text); });
  t.after(() => adapter.stop());
  assert.equal(adapter.botName(), null);
  bot.say("are you there");
  await until(() => bot.state.refused >= refusedBefore + 2, "its name and its first poll both failed");
  bot.restore();
  await until(() => received.length === 1, "the message after Telegram came back");
  assert.deepEqual(received, ["are you there"]);
  await until(() => adapter.botName() === "E2E123456Bot", "the name learned once it answered");
});

test("the wizard: an answer to a check the owner went back from does not wipe the token being typed", async (t) => {
  const bot = await fakeBotApi(t);
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-e2e-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model(), telegramApiBase: bot.base });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.web.policy.configure({ allowPrivateAddresses: true });
  await fetch(`${server.url}/api/onboarding`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route((url) => !["127.0.0.1", "localhost"].includes(url.hostname), (route) => route.abort());
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-place="customize"][data-v="channels"]').click();
  await page.locator('[data-act="ch-open"][data-v="telegram"]').click();
  await page.locator(".dlg .chw-steps12").waitFor();
  const next = () => page.locator('.dlg [data-act="chw-next"]').click();
  await next(); // Create -> Paste
  const field = page.locator('[data-chf="TELEGRAM_BOT_TOKEN"]');
  await field.fill(token);
  const release = bot.hold(); // Telegram is slow to answer the check
  const isCheck = (r) => r.url().includes("/api/channel-setup/telegram/check");
  const answered = page.waitForEvent("requestfinished", isCheck);
  await next(); // Paste -> Check, asked and waiting
  await page.locator('.dlg [data-act="chw-back"]').click(); // the owner goes back to paste another token
  await field.fill(replacement);
  release();
  assert.equal((await (await answered).response()).status(), 200);
  // The page has read the answer and run what follows it before the field is looked at.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
  assert.equal(await field.inputValue(), replacement, "the late answer was drawn over the token being typed");
  assert.match(await page.locator(".chw-steps12 .now").textContent(), /Paste/);
  const second = page.waitForResponse(isCheck);
  await next(); // Paste -> Check with the new token
  assert.equal((await second).status(), 200);
  await page.locator(".dlg .chw-ok12").waitFor();
  assert.match(await page.locator(".dlg .chw-body12").textContent(), /E2E654321Bot/, "the answer to the check still on screen is drawn");
  assert.deepEqual(errors, []);
});

test("a bot whose token Telegram refused stops at once, without waiting out the pause before it asks again", async (t) => {
  const bot = await fakeBotApi(t);
  const refusing = async (url, init) => /\/getUpdates$/.test(url)
    ? { status: 401, json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }) }
    : fetch(url, init);
  const adapter = new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, fetch: refusing, pollTimeoutSeconds: 1, refusedRetryMs: 60_000 });
  await adapter.start(async () => undefined);
  t.after(() => adapter.stop());
  await until(() => adapter.health().state === "needs attention", "the refusal seen, and the pause begun");
  const stopped = await Promise.race([adapter.stop().then(() => true), delay(5_000, false, { ref: false })]);
  assert.equal(stopped, true, "stop() waited out the minute before the next attempt");
});

test("a Telegram channel from the settings file is never replaced by the card's bot", async (t) => {
  const bot = await fakeBotApi(t);
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-e2e-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model(), telegramApiBase: bot.base });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const fromFile = new TelegramAdapter({ id: "telegram", token: replacement, apiBase: bot.base, pollTimeoutSeconds: 1 });
  await app.channels.attach(fromFile, { activation: "always", pairing: true, allowlist: [] });
  await app.neverBreak.telegram.save({ token, mode: "on" });
  assert.match(await app.neverBreak.telegram.connect(), /from the settings file/);
  assert.equal(app.channels.adapter("telegram"), fromFile, "the settings file's bot is still the one read");
  assert.equal(bot.state.calls.filter((c) => c.botId === "123456").length, 0, "the card's bot never asked Telegram");
});

test("a read position is kept per bot: one saved by another bot, or before bots were named, is never used", async () => {
  const { channelPosition } = await import("../dist/never-break/channel-position.js");
  const saved = new Map();
  const store = { get: (_table, owner, id) => saved.get(`${owner}/${id}`), save: (_table, owner, id, data) => { saved.set(`${owner}/${id}`, { data }); } };
  channelPosition(store, "telegram", "local", "111").save(42);
  assert.equal(saved.get("local/channel-position:telegram").data.reader, "111", "saved with the bot it belongs to");
  assert.equal(channelPosition(store, "telegram", "local", "111").load(), 42);
  assert.equal(channelPosition(store, "telegram", "local", "222").load(), 0, "another bot starts from Telegram's earliest unconfirmed update");
  assert.ok(Math.abs(channelPosition(store, "telegram", "local", "111").savedAt() - Date.now()) < 60_000, "when it was saved");
  assert.equal(channelPosition(store, "telegram", "local", "222").savedAt(), undefined, "another bot's is not its own");
  saved.set("local/channel-position:telegram", { data: { offset: 42 } });
  assert.equal(channelPosition(store, "telegram", "local", "111").load(), 0, "a position saved before bots were named is not trusted");
  assert.equal(channelPosition(store, "telegram", "local").load(), 42, "a position with no reader named reads as before");
});

test("the card's bot never starts from a position another bot left, so its first message is answered", async (t) => {
  const bot = await fakeBotApi(t);
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-e2e-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model(), telegramApiBase: bot.base });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.web.policy.configure({ allowPrivateAddresses: true }); // the stand-in lives on this computer
  const owner = app.runtime.owner;
  // Left by another bot (a settings-file bot, or a token replaced since), far past this bot's first update.
  app.store.save("settings", owner, "channel-position:telegram", { offset: 5000, reader: "654321" });
  await app.neverBreak.telegram.save({ token, mode: "on" });
  bot.say("hello"); // this bot's update 1, waiting at Telegram
  assert.equal(await app.neverBreak.telegram.connect(), null);
  await until(() => bot.state.sent.some((sent) => sent.botId === "123456" && /code \d{6}/.test(sent.text)), "the first message answered");
  const polls = bot.state.calls.filter((c) => c.method === "getUpdates" && c.botId === "123456");
  assert.equal(polls[0].body.offset, 0, "asked from the earliest unconfirmed update, not the other bot's position");
  await until(() => app.store.get("settings", owner, "channel-position:telegram")?.data.reader === "123456", "its own position saved, named for it");
});

test("a settings-file bot never starts from a position the card's bot left under the same name", async (t) => {
  const bot = await fakeBotApi(t);
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-e2e-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.web.policy.configure({ allowPrivateAddresses: true }); // the stand-in lives on this computer
  app.store.save("settings", "local", "channel-position:telegram", { offset: 5000, reader: "123456" }); // the card's bot's
  const configPath = join(root, "integrations.json");
  await writeFile(configPath, JSON.stringify({ channels: [{ type: "telegram", tokenEnv: "E2E_BOT_TOKEN", apiBase: bot.base }] }));
  bot.say("hello", "654321");
  const loaded = await loadIntegrations(app.registry, configPath, { E2E_BOT_TOKEN: replacement }, app.secretsFor, app.channelHost);
  t.after(() => loaded.close());
  await until(() => bot.state.sent.some((sent) => sent.botId === "654321"), "the settings-file bot answered its first message");
  assert.equal(bot.state.calls.find((c) => c.method === "getUpdates" && c.botId === "654321").body.offset, 0);
});

test("after a quiet spell Telegram may number the next update below the saved position; it is read, not lost", async (t) => {
  const bot = await fakeBotApi(t);
  const saved = [];
  const received = [];
  const adapter = new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, pollTimeoutSeconds: 1, renumberAfterMs: 400,
    position: { load: () => 0, save: (offset) => saved.push(offset) } });
  const polls = () => bot.state.calls.filter((c) => c.method === "getUpdates");
  bot.renumber("123456", 500);
  await adapter.start(async (message) => { received.push(message.text); });
  t.after(() => adapter.stop());
  bot.say("before the quiet spell");
  await until(() => saved.at(-1) === 501, "read up to 501");
  const quiet = polls().length;
  await until(() => polls().slice(quiet).some((c) => c.body.offset === 0), "quiet for a while: asked without its position");
  bot.renumber("123456", 7); // the next update is numbered afresh, below 501
  bot.say("after the quiet spell");
  await until(() => received.includes("after the quiet spell"), "the renumbered message read");
  await until(() => saved.at(-1) === 8, "the position saved in the new numbering");
  await until(() => polls().some((c) => c.body.offset === 8), "and asked from there");
  assert.deepEqual(received, ["before the quiet spell", "after the quiet spell"]);
});

test("a position saved over a day ago: an update Telegram numbered below it while Branch was closed is read", async (t) => {
  const bot = await fakeBotApi(t);
  const saved = [];
  const received = [];
  bot.renumber("123456", 7);
  bot.say("sent while Branch was closed");
  const adapter = new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, pollTimeoutSeconds: 1,
    position: { load: () => 501, savedAt: () => Date.now() - 2 * 24 * 60 * 60 * 1000, save: (offset) => saved.push(offset) } });
  await adapter.start(async (message) => { received.push(message.text); });
  t.after(() => adapter.stop());
  await until(() => received.length === 1 && saved.at(-1) === 8, "read, and the position saved in the new numbering");
  assert.deepEqual(received, ["sent while Branch was closed"]);
});

test("a position saved just now: an answered update Telegram was not yet told about is not answered again", async (t) => {
  const bot = await fakeBotApi(t);
  const received = [];
  bot.renumber("123456", 5);
  bot.say("answered just before the restart");
  bot.say("new since");
  const adapter = new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, pollTimeoutSeconds: 1,
    position: { load: () => 6, savedAt: () => Date.now(), save: () => undefined } });
  await adapter.start(async (message) => { received.push(message.text); });
  t.after(() => adapter.stop());
  await until(() => received.includes("new since"), "the new message read");
  assert.deepEqual(received, ["new since"]);
  assert.ok(bot.state.calls.filter((c) => c.method === "getUpdates").every((c) => c.body.offset === 6 || c.body.offset === 7));
});
