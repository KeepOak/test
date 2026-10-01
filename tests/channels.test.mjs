import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, TelegramAdapter } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

/** A stand-in for api.telegram.org: queued updates come out of getUpdates once; sends are recorded. */
async function fakeTelegram(t) {
  const state = { queue: [], sent: [], calls: [] };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const method = req.url.split("/").pop();
    state.calls.push(method);
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "Branch", username: "BranchTestBot" });
    if (method === "getUpdates") {
      const pending = state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!pending.length) await delay(40);
      return reply(pending);
    }
    if (method === "sendMessage") { state.sent.push(body); return reply({ message_id: 1000 + state.sent.length }); }
    res.writeHead(404); res.end(JSON.stringify({ ok: false, description: "unknown method" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, apiBase: `http://127.0.0.1:${server.address().port}` };
}
let nextUpdate = 1;
const telegramRuns = (app) => {
  const sessions = new Set(app.store.list("settings", "local").filter((row) => row.id.startsWith("channel-session:telegram:")).map((row) => row.data.sessionId));
  return app.store.runs("local").filter((run) => sessions.has(run.sessionId));
};
const update = (chat, from, text, extra = {}) => ({ update_id: nextUpdate++, message: {
  message_id: nextUpdate * 10, text, from: { id: from.id, first_name: from.name, username: from.username },
  chat, ...extra } });
const dm = { id: 501, type: "private" };
const group = { id: -700, type: "supergroup", title: "Family" };
const alice = { id: 42, name: "Alice", username: "alice" };
const bob = { id: 77, name: "Bob" };
async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}
function scripted() {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const last = request.messages.at(-1).content;
    return { content: `Echo: ${last}`, toolCalls: [] };
  } };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-channels-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}

test("Telegram: pairing for unknown senders, allowlist, group activation by mention or reply, one conversation per chat", async (t) => {
  const { app, provider } = await fixture(t);
  const { state, apiBase } = await fakeTelegram(t);
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: [String(alice.id)] });
  assert.equal(adapter.botName(), "BranchTestBot");
  // Unknown sender in a direct chat gets a pairing code and nothing reaches the model.
  state.queue.push(update(dm, bob, "hello?"));
  await until(() => state.sent.length === 1, "pairing reply");
  assert.match(state.sent[0].text, /approve code (\d{6})/);
  assert.equal(provider.requests.length, 0);
  const code = /code (\d{6})/.exec(state.sent[0].text)[1];
  assert.equal(app.channels.summary().pending[0].name, "Bob");
  assert.throws(() => app.channels.approve("local", { code: "000000" }), /No pending request/);
  // Allowlisted sender is answered at once, in a conversation tied to that chat.
  state.queue.push(update({ id: 502, type: "private" }, alice, "what is two plus two"));
  await until(() => state.sent.length === 2, "alice reply");
  assert.equal(state.sent[1].text, "Echo: what is two plus two");
  assert.equal(state.sent[1].chat_id, 502);
  state.queue.push(update({ id: 502, type: "private" }, alice, "and three"));
  await until(() => state.sent.length === 3, "alice second reply");
  const sessions = new Set(telegramRuns(app).map((run) => run.sessionId));
  assert.equal(sessions.size, 1, "the same chat continues one conversation");
  assert.equal(provider.requests.at(-1).messages.filter((m) => m.role === "user").length, 2);
  // Bob is approved with his code and then answered.
  const approved = app.channels.approve("local", { code });
  assert.equal(approved.senderId, String(bob.id));
  state.queue.push(update(dm, bob, "second try"));
  await until(() => state.sent.length === 4, "bob answered after approval");
  assert.equal(state.sent[3].text, "Echo: second try");
  assert.equal(new Set(telegramRuns(app).map((run) => run.sessionId)).size, 2, "a different chat has its own conversation");
  // Group: ignored without a mention, answered when mentioned or when replying to the bot.
  const before = state.sent.length, calls = provider.requests.length;
  state.queue.push(update(group, alice, "just chatting"));
  await delay(300);
  assert.equal(state.sent.length, before, "no reply to an unaddressed group message");
  assert.equal(provider.requests.length, calls);
  state.queue.push(update(group, alice, "@BranchTestBot what time is it", { entities: [{ type: "mention", offset: 0, length: 14 }] }));
  await until(() => state.sent.length === before + 1, "mentioned group reply");
  assert.equal(state.sent[before].chat_id, -700);
  assert.match(state.sent[before].text, /^Echo: \[alice in Family\] what time is it$/);
  state.queue.push(update(group, alice, "thanks", { reply_to_message: { from: { id: 999, is_bot: true, username: "BranchTestBot" } } }));
  await until(() => state.sent.length === before + 2, "reply-to-bot group reply");
  assert.equal(state.sent[before + 1].reply_parameters.message_id > 0, true);
  // Channel tasks never receive host command permission.
  assert.ok(telegramRuns(app).every((run) => app.store.events(run.id).every((e) => e.kind !== "tool.started" || e.data.name !== "shell.execute")));
  assert.deepEqual(app.channels.remove("local", { channel: "telegram", senderId: String(bob.id) }), { removed: true });
  await adapter.stop();
});

test("Telegram forum topics keep separate sessions and route replies to the original thread", async (t) => {
  const { app, provider } = await fixture(t);
  const { state, apiBase } = await fakeTelegram(t);
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: [String(alice.id)] });
  const addressed = (text, thread) => update(group, alice, `@BranchTestBot ${text}`, {
    ...(thread === undefined ? {} : { message_thread_id: thread }),
    entities: [{ type: "mention", offset: 0, length: 14 }],
  });
  state.queue.push(addressed("topic seven", 7));
  await until(() => state.sent.length === 1, "topic seven reply");
  state.queue.push(addressed("topic eight", 8));
  await until(() => state.sent.length === 2, "topic eight reply");
  state.queue.push(addressed("continue seven", 7));
  await until(() => state.sent.length === 3, "topic seven followup");
  state.queue.push(addressed("unthreaded"));
  await until(() => state.sent.length === 4, "unthreaded reply");
  assert.deepEqual(state.sent.map((reply) => [reply.chat_id, reply.message_thread_id]),
    [[-700, 7], [-700, 8], [-700, 7], [-700, undefined]]);
  const sessions = telegramRuns(app).map((run) => run.sessionId);
  assert.equal(new Set(sessions).size, 3);
  assert.equal(sessions.filter((session) => session === app.store.get("settings", "local", "channel-session:telegram:-700:7").data.sessionId).length, 2);
  assert.equal(provider.requests[2].messages.filter((message) => message.role === "user").length, 2);
  await adapter.stop();
});

test("integrations file starts a Telegram channel from a locker secret, and the HTTP API lists it", async (t) => {
  const { app, root } = await fixture(t);
  const { state, apiBase } = await fakeTelegram(t);
  await app.store.locker.set("local", "default", "TELEGRAM_BOT_TOKEN", "555:token-value");
  const configPath = join(root, "integrations.json");
  // Telegram now goes through the network settings like Discord and WhatsApp, so a stand-in
  // server on this computer has to be allowed the way any local address is.
  app.web.policy.configure({ allowPrivateAddresses: true });
  await writeFile(configPath, JSON.stringify({ channels: [{ type: "telegram", tokenSecret: "TELEGRAM_BOT_TOKEN", apiBase, activation: "always", pairing: false, allowlist: ["42"] }] }));
  const loaded = await loadIntegrations(app.registry, configPath, {}, app.secretsFor, app.channelHost);
  t.after(() => loaded.close());
  assert.equal(loaded.count, 1);
  assert.equal(state.calls[0], "getMe");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const response = await fetch(server.url + "/api/channels", { headers: { authorization: "Bearer " + server.token, origin: server.url } });
  const summary = await response.json();
  assert.equal(summary.channels[0].botName, "BranchTestBot");
  assert.equal(summary.channels[0].activation, "always");
  state.queue.push(update(dm, bob, "am I allowed?"));
  // UP-CHAT-008: a block is silent.
  await delay(400);
  assert.equal(state.sent.length, 0);
  await assert.rejects(loadIntegrations(app.registry, configPath, {}, app.secretsFor), /cannot host them/);
  const bad = join(root, "bad.json");
  await writeFile(bad, JSON.stringify({ channels: [{ type: "telegram", tokenEnv: "MISSING_TOKEN", apiBase }] }));
  await assert.rejects(loadIntegrations(app.registry, bad, {}, app.secretsFor, app.channelHost), /no bot token/);
});
