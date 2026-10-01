/* CHAT-210: /status and /whoami answered at once from inside an ordinary direct message, when the chat app vouches that
   the words were typed by the person (src/channels/inline-shortcuts.ts); the rest of the message goes on as the task. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { inlineShortcuts } from "../dist/channels/inline-shortcuts.js";
import { setPaused } from "../dist/reach/platform.js";
import { Deliveries } from "../dist/channels/deliveries.js";
import { DiscordAdapter } from "../dist/channels/discord.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

const authored = (text, spans = []) => ({ text, protected: spans });

test("only exact shortcuts outside code, quotes and links are picked, and only they are taken out", () => {
  assert.deepEqual(inlineShortcuts(authored("Please continue /status with the report"), "Please continue /status with the report"),
    { names: ["status"], remainder: "Please continue  with the report" });
  assert.deepEqual(inlineShortcuts(authored("/whoami\n/status /status"), "/whoami\n/status /status")?.names, ["whoami", "status"]);
  for (const text of ["hello /status\"quoted\"", "run `/status` please", "> /status", "\"/status\"", "see https://x.test/status now", "/status2", "/stop now", "/status@bot"])
    assert.equal(inlineShortcuts(authored(text), text), null, text);
  assert.equal(inlineShortcuts(authored("a /status"), "different words"), null, "the vouched text must be the message");
  assert.equal(inlineShortcuts(authored("a /status", [{ offset: 2, length: 7 }]), "a /status"), null, "a code span the app marked stays text");
  assert.equal(inlineShortcuts(authored("a /status", [{ offset: 5, length: 99 }]), "a /status"), null, "a broken span refuses the fast path");
});

const policy = { activation: "always", pairing: true, allowlist: ["owner"] };
const switchesOn = { liveStatus: "off", commands: "on", steering: "on", splitting: "on", steps: "off" };
const fakeAdapter = (id, sent) => ({ id, kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
  async send(chatId, text) { sent.push(text); return String(sent.length); } });

async function fixture(t, adapter) {
  const root = await mkdtemp(join(tmpdir(), "branch-inline-shortcuts-"));
  const prompts = [];
  const provider = { name: "scripted", async complete(request) {
    prompts.push(String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
    return { content: "On it.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.setSwitches(switchesOn);
  const sent = [];
  adapter ??= fakeAdapter("chat", sent);
  await app.channels.attach(adapter, policy);
  let id = 1;
  const message = (text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text, addressed: true, messageId: `m${id++}`, ...extra });
  return { app, sent, prompts, message, adapter };
}

test("a vouched direct message answers /status at once and sends only the rest of the words to the task", async (t) => {
  const f = await fixture(t);
  const text = "Please /status then summarise the notes";
  await f.app.channels.handle(f.message(text, { authoredCommandText: authored(text) }));
  assert.ok(f.sent.includes("Nothing is working right now."), "the shortcut was answered");
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /Please\s+then summarise the notes/);
  assert.doesNotMatch(f.prompts[0], /\/status/, "the shortcut never reached the model");
});

test("without the app vouching for the words, or in a group, a shortcut inside a message stays ordinary text", async (t) => {
  const f = await fixture(t);
  const text = "Please /status then summarise the notes";
  await f.app.channels.handle(f.message(text));
  await f.app.channels.handle(f.message(text, { chatKind: "group", chatId: "g1", authoredCommandText: authored(text) }));
  assert.ok(!f.sent.includes("Nothing is working right now."), "no fast answer");
  assert.match(f.prompts[0] ?? "", /\/status/);
});

test("pausing the chat app while a shortcut's answer goes out stops the rest of the message", async (t) => {
  const f = await fixture(t);
  const text = "Please /status then summarise the notes";
  // The owner pauses the chat app while the first answer is being delivered.
  const deliver = f.app.channels.deliver.bind(f.app.channels);
  f.app.channels.deliver = async (...args) => {
    const done = await deliver(...args);
    setPaused(f.app.store, f.app.runtime.owner, "chat", true, "test");
    return done;
  };
  assert.equal(await f.app.channels.handle(f.message(text, { authoredCommandText: authored(text) })), "ignored");
  assert.equal(f.sent.length, 1, "only the first answer went out");
  assert.equal(f.prompts.length, 0, "the rest never reached the model");
});

test("pausing the chat app while a shortcut's answer is checked or waiting to send keeps that answer from going out", async (t) => {
  // Queue boundary: the pause lands while the outgoing check looks at the answer.
  const f = await fixture(t);
  const guard = f.app.channels.outboundGuard;
  f.app.channels.outboundGuard = async (text) => {
    if (text === answer) setPaused(f.app.store, f.app.runtime.owner, "chat", true, "test");
    return guard(text);
  };
  const text = "Please /status then summarise the notes";
  assert.equal(await f.app.channels.handle(f.message(text, { authoredCommandText: authored(text) })), "ignored");
  assert.deepEqual(f.sent, [], "the answer was held back at the queue");
  assert.equal(f.prompts.length, 0);
  // A bare shortcut whose answer is held back there was not answered, so it is not reported as replied.
  const h = await fixture(t);
  const guardH = h.app.channels.outboundGuard;
  h.app.channels.outboundGuard = async (words) => {
    if (words === answer) setPaused(h.app.store, h.app.runtime.owner, "chat", true, "test");
    return guardH(words);
  };
  assert.equal(await h.app.channels.handle(h.message("/status", { authoredCommandText: authored("/status") })), "ignored");
  assert.deepEqual(h.sent, [], "the bare shortcut's answer was held back at the queue");

  // Send boundary: the first send fails, the chat app is paused, and a later flush must not send the queued answer.
  const g = await fixture(t);
  const send = g.adapter.send;
  g.adapter.send = async () => { g.adapter.send = send; throw new Error("offline for a moment"); };
  await g.app.channels.handle(g.message("/status", { authoredCommandText: authored("/status") }));
  assert.deepEqual(g.sent, []);
  // After a restart nothing remembers who the answer was for, so it stays unsent.
  const restarted = new Deliveries(g.app.store, g.app.runtime.owner);
  for (const row of restarted.outstanding()) restarted.retry(row.id);
  await restarted.flush("chat", async (_chatId, words) => { g.sent.push(words); return "r1"; });
  assert.deepEqual(g.sent, [], "a restart does not release a queued answer");
  setPaused(g.app.store, g.app.runtime.owner, "chat", true, "test");
  for (const row of g.app.channels.deliveries.outstanding()) g.app.channels.deliveries.retry(row.id);
  await g.app.channels.flush();
  assert.deepEqual(g.sent, [], "a queued answer is not sent once the chat app is paused");
  assert.ok(g.app.channels.deliveries.outstanding().every((row) => row.status === "dead"), "the held answer is not retried");
});

const answer = "Nothing is working right now.";
/** Takes the chat's say away and gives it back while the outgoing check looks at the shortcut's answer. */
async function revokedAndRestoredDuringCheck(t, revoke, restore) {
  const f = await fixture(t);
  const guard = f.app.channels.outboundGuard;
  f.app.channels.outboundGuard = async (words) => {
    if (words === answer) { revoke(f.app); restore(f.app); }
    return guard(words);
  };
  assert.equal(await f.app.channels.handle(f.message("/status", { authoredCommandText: authored("/status") })), "ignored");
  assert.deepEqual(f.sent, [], "a revocation stays a revocation even when it is undone before the answer is queued");
}

test("a pause undone during the outgoing check still holds the shortcut's answer back", (t) => revokedAndRestoredDuringCheck(t,
  (app) => setPaused(app.store, app.runtime.owner, "chat", true, "test"),
  (app) => setPaused(app.store, app.runtime.owner, "chat", false, "test")));

test("an App lock undone during the outgoing check still holds the shortcut's answer back", (t) => revokedAndRestoredDuringCheck(t,
  (app) => app.sessionLock.lock(), (app) => app.sessionLock.unlock()));

test("a sender blocked and allowed again during the outgoing check still has the shortcut's answer held back", (t) => revokedAndRestoredDuringCheck(t,
  (app) => app.channels.setSenderAllowlist({ rules: [{ channel: "chat", sender: "owner", decision: "block" }] }),
  (app) => app.channels.setSenderAllowlist({ rules: [] })));

test("chat commands switched off and on during the outgoing check still hold the shortcut's answer back", (t) => revokedAndRestoredDuringCheck(t,
  (app) => app.channels.setSwitches({ ...switchesOn, commands: "off" }), (app) => app.channels.setSwitches(switchesOn)));

test("an answer waiting out Discord's rate limit is not sent when the chat app is paused and resumed during the wait", async (t) => {
  const posts = [];
  const discord = new DiscordAdapter({ id: "chat", token: "test-bot-token", fetch: async (url, init) => {
    if (init?.method === "POST" && /\/channels\/[^/]+\/messages$/.test(String(url))) posts.push(JSON.parse(init.body).content);
    return new Response(JSON.stringify({ id: `posted-${posts.length}` }), { status: 200 });
  } });
  discord.start = async () => {}; discord.stop = async () => {};
  const f = await fixture(t, discord);
  // Discord asked to slow down: the adapter waits before its request, and the owner pauses and resumes meanwhile.
  discord.readyAt = Date.now() + 400;
  setTimeout(() => {
    setPaused(f.app.store, f.app.runtime.owner, "chat", true, "test");
    setPaused(f.app.store, f.app.runtime.owner, "chat", false, "test");
  }, 100);
  assert.equal(await f.app.channels.handle(f.message("/status", { authoredCommandText: authored("/status") })), "ignored");
  assert.deepEqual(posts, [], "the adapter checked the answer's authority at its last step and did not post it");
});

test("the same chat and message ids on two chat apps keep separate answers, each under its own authority", async (t) => {
  const f = await fixture(t);
  const sentB = [];
  await f.app.channels.attach(fakeAdapter("chat2", sentB), policy);
  const send = f.adapter.send;
  f.adapter.send = async () => { f.adapter.send = send; throw new Error("offline for a moment"); };
  const same = { messageId: "same-id", authoredCommandText: authored("/status") };
  await f.app.channels.handle(f.message("/status", same));
  await f.app.channels.handle(f.message("/status", { ...same, channel: "chat2" }));
  assert.deepEqual(sentB, [answer], "the second app's answer is its own and goes out");
  setPaused(f.app.store, f.app.runtime.owner, "chat", true, "test");
  for (const row of f.app.channels.deliveries.outstanding()) f.app.channels.deliveries.retry(row.id);
  await f.app.channels.flush();
  assert.deepEqual(f.sent, [], "the paused app's queued answer was not re-authorized by the other app's");
  assert.deepEqual(sentB, [answer]);
});

test("a queued answer keeps the authority it was queued under when the same message comes again", async (t) => {
  const f = await fixture(t);
  const send = f.adapter.send;
  f.adapter.send = async () => { f.adapter.send = send; throw new Error("offline for a moment"); };
  const same = { messageId: "same-id", authoredCommandText: authored("/status") };
  await f.app.channels.handle(f.message("/status", same));
  setPaused(f.app.store, f.app.runtime.owner, "chat", true, "test");
  setPaused(f.app.store, f.app.runtime.owner, "chat", false, "test");
  await f.app.channels.handle(f.message("/status", same));
  for (const row of f.app.channels.deliveries.outstanding()) f.app.channels.deliveries.retry(row.id);
  await f.app.channels.flush();
  assert.deepEqual(f.sent, [], "a repeat of the message does not re-authorize the answer already queued");
});

test("an idle App lock nobody noticed, then the owner unlocking, refuses the queued answer", async (t) => {
  const f = await fixture(t);
  const lock = f.app.sessionLock;
  let clock = Date.now();
  lock.now = () => clock;
  lock.configure({ idleMinutes: 1 });
  const send = f.adapter.send;
  f.adapter.send = async () => { f.adapter.send = send; throw new Error("offline for a moment"); };
  await f.app.channels.handle(f.message("/status", { authoredCommandText: authored("/status") }));
  assert.deepEqual(f.sent, []);
  // The quiet minute runs out with nothing looking, and the owner's unlock is the first thing to notice it.
  clock += 2 * 60_000;
  lock.unlock();
  for (const row of f.app.channels.deliveries.outstanding()) f.app.channels.deliveries.retry(row.id);
  await f.app.channels.flush();
  assert.deepEqual(f.sent, [], "a lock that lapsed and was unlocked in between still refuses the answer");
});

test("a pause and resume while Discord's reply to the first answer is still arriving stops the next shortcut and the rest", async (t) => {
  const posts = [];
  let releaseBody;
  const held = new Promise((resolve) => { releaseBody = resolve; });
  const discord = new DiscordAdapter({ id: "chat", token: "test-bot-token", fetch: async (url, init) => {
    if (init?.method !== "POST" || !/\/channels\/[^/]+\/messages$/.test(String(url)))
      return new Response(JSON.stringify({}), { status: 200 });
    posts.push(JSON.parse(init.body).content);
    // The first answer is taken by Discord, but its reply body is still on its way.
    if (posts.length === 1) return { ok: true, status: 200, headers: new Headers(), json: () => held };
    return new Response(JSON.stringify({ id: `posted-${posts.length}` }), { status: 200 });
  } });
  discord.start = async () => {}; discord.stop = async () => {};
  const f = await fixture(t, discord);
  saveCommandSettings(f.app.store, f.app.runtime.owner, { mode: "on" }); // /whoami is one of the newer chat commands
  const text = "Please /status /whoami then summarise the notes";
  const handled = f.app.channels.handle(f.message(text, { authoredCommandText: authored(text) }));
  while (posts.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  setPaused(f.app.store, f.app.runtime.owner, "chat", true, "test");
  setPaused(f.app.store, f.app.runtime.owner, "chat", false, "test");
  releaseBody({ id: "posted-1" });
  assert.equal(await handled, "ignored");
  assert.deepEqual(posts, [answer], "only the answer already taken went out; /whoami did not");
  assert.equal(f.prompts.length, 0, "the rest of the message never reached the model");
});
