/**
 * "Show steps in chats": a task's steps as one Telegram message edited in place, the way Hermes Agent shows work.
 * One line per step with the window's own emoji, commands and scripts as Telegram code blocks (a `pre` entity with a
 * language, which Telegram draws with its label and copy button), files as inline code, repeats folded as "(×N)", a
 * last line saying how it went, and the reply as its own message. A saved secret never reaches the chat, a group
 * never sees the steps, and Telegram's "wait N seconds" is waited out rather than ending the message.
 *
 * Everything runs against a stand-in for api.telegram.org on this computer, with a made-up token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch, savePolicy, saveSenderAllowlist, TelegramAdapter } from "../dist/index.js";
import { staleButtonNote } from "../dist/channels/router.js";
import { renderChatSteps, telegramEntities } from "../dist/channels/progress-render.js";
import { LiveStatus, retryAfterMs } from "../dist/channels/live-status.js";
import { STEP_ICONS } from "../dist/live-steps.js";
import { chatLiveSwitches, saveChatLiveSwitches } from "../dist/channels/chat-live-settings.js";

const token = "123456:TEST-fake-token-aaaaaaaaaaaaaaaaaaaa"; // not-a-real-secret
const SECRET = "SAVED-DEPLOY-KEY-7f3a9c2e41"; // not-a-real-secret
const fast = { progressAfterMs: 30, editEveryMs: 20, typingEveryMs: 50, reactEveryMs: 5 };

async function until(check, label, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
/** The words a span covers. */
const covered = (text, span) => text.slice(span.offset, span.offset + span.length);

// ---- the lines -------------------------------------------------------------------------------

const step = (extra) => ({ id: `s${Math.random()}`, kind: "tool", icon: STEP_ICONS.tool, label: "", result: null, state: "done",
  at: new Date().toISOString(), seconds: 1, depth: 0, input: null, output: null, ...extra });

test("each step is one line with its emoji; commands and scripts are code blocks, files inline code", () => {
  const steps = [
    step({ kind: "think", icon: STEP_ICONS.thinking, label: "I should look at the notes first" }),
    step({ tool: "tools.search", label: "Looking for the right tool" }),
    step({ tool: "files.read", icon: STEP_ICONS.read, label: "Reading notes/plan.md", path: "notes/plan.md" }),
    step({ tool: "shell.execute", icon: STEP_ICONS.command, label: "Running npm test", state: "failed", result: "Permission denied: shell.execute",
      say: { label: { key: "window.chat.live.running", values: { command: "npm test" } } } }),
    step({ tool: "code.run", icon: STEP_ICONS.code, label: "Running a small Python script", input: JSON.stringify({ language: "python", source: "import os\nprint(os.getcwd())" }) }),
    step({ kind: "ask", icon: STEP_ICONS.approval, label: "May I send the email?", state: "waiting" }),
    step({ tool: "web.search", icon: STEP_ICONS.search, label: "Searching the web for “tides”", depth: 1 }),
  ];
  const { text, spans } = renderChatSteps({ steps, seconds: 12 }, { limit: 3500 });
  const lines = text.split("\n");
  assert.equal(lines[0], `${STEP_ICONS.read} Reading notes/plan.md`);
  assert.equal(lines[1], `${STEP_ICONS.command} Running ${STEP_ICONS.failed} Permission denied: shell.execute`);
  assert.equal(lines[2], "npm test");
  assert.equal(lines[3], `${STEP_ICONS.code} Running a small Python script`);
  assert.equal(lines[4], "import os …");
  assert.equal(lines[5], `↳ ${STEP_ICONS.search} Searching the web for “tides”`);
  assert.doesNotMatch(text, /notes first|right tool|send the email/, "thoughts, finding a tool and questions are not steps in a chat");
  assert.deepEqual(spans.map((span) => [span.kind, span.language ?? "", covered(text, span)]),
    [["inline", "", "notes/plan.md"], ["block", "shell", "npm test"], ["block", "python", "import os …"]]);
  assert.deepEqual(telegramEntities(spans), [
    { type: "code", offset: spans[0].offset, length: 13 },
    { type: "pre", offset: spans[1].offset, length: 8, language: "shell" },
    { type: "pre", offset: spans[2].offset, length: 11, language: "python" },
  ]);
});

test("repeats fold as (×N) on the step's own line, the ending is one line, and the newest steps are kept", () => {
  const read = () => step({ tool: "files.read", icon: STEP_ICONS.read, label: "Reading a.md", path: "a.md" });
  const run = () => step({ tool: "shell.execute", icon: STEP_ICONS.command, label: "Running ls", say: { label: { key: "window.chat.live.running", values: { command: "ls" } } } });
  const { text, spans } = renderChatSteps({ steps: [read(), read(), read(), run(), run()], seconds: 75 }, { limit: 3500, final: "done" });
  assert.equal(text, `${STEP_ICONS.read} Reading a.md (×3)\n${STEP_ICONS.command} Running (×2)\nls\n${STEP_ICONS.done} Done · 5 steps · 1 min`);
  assert.deepEqual(spans.map((span) => covered(text, span)), ["a.md", "ls"], "the fold moves no span off its words");
  assert.equal(renderChatSteps({ steps: [], seconds: null }, { limit: 100 }).text, "Working on it…");
  assert.equal(renderChatSteps({ steps: [read()], seconds: 3 }, { limit: 100, final: "error" }).text.split("\n").at(-1), `${STEP_ICONS.failed} Stopped · 1 step · 3 s`);
  const many = Array.from({ length: 60 }, (_, i) => step({ label: `Step number ${i}` }));
  const cut = renderChatSteps({ steps: many, seconds: 1 }, { limit: 300 });
  assert.ok(cut.text.length <= 300, `${cut.text.length} is over the limit`);
  assert.match(cut.text, /^\(\d+ earlier\)\n/);
  assert.match(cut.text, /Step number 59$/);
});

test("every piece is scrubbed before a span is measured, so the span still covers the right words", () => {
  const scrub = (text) => text.replaceAll(SECRET, "[hidden]");
  const steps = [step({ tool: "shell.execute", icon: STEP_ICONS.command, label: `Running curl -H ${SECRET}`,
    say: { label: { key: "window.chat.live.running", values: { command: `curl -H ${SECRET}` } } } })];
  const { text, spans } = renderChatSteps({ steps, seconds: 1 }, { limit: 3500, scrub });
  assert.ok(!text.includes(SECRET));
  assert.equal(covered(text, spans[0]), "curl -H [hidden]");
});

// ---- the message -----------------------------------------------------------------------------

/** A chat app stand-in with edits; `refuse(n, seconds)` answers the next n edits with "wait". */
function fakeChat() {
  const calls = [];
  let refusals = 0, wait = 0, next = 100;
  const adapter = {
    id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text, replyTo, format) { calls.push({ op: "send", text, format }); return String(next++); },
    async edit(chatId, messageId, text, format) {
      if (refusals > 0) { refusals--; calls.push({ op: "refused" }); throw Object.assign(new Error("Too Many Requests"), { retryAfter: wait }); }
      calls.push({ op: "edit", text, format });
    },
  };
  return { adapter, calls, refuse: (n, seconds) => { refusals = n; wait = seconds; } };
}
const steady = (lines) => ({ render: (limit, final) => ({ text: [...lines, ...(final ? [`${STEP_ICONS.done} Done`] : [])].join("\n"), spans: lines.length ? [{ offset: 0, length: 2, kind: "inline" }] : [] }) });

test("the steps message goes out quietly with its spans, and the reply is left to go out on its own", async () => {
  const chat = fakeChat();
  const lines = ["ab one"];
  const live = new LiveStatus({ adapter: chat.adapter, chatId: "c1", messageId: "q1" }, async (text) => ({ text, blocked: false }), fast, false, steady(lines));
  live.start();
  live.thinking();
  const opened = await until(() => chat.calls.find((c) => c.op === "send"), "progress message");
  assert.deepEqual(opened.format, { spans: [{ offset: 0, length: 2, kind: "inline" }], quiet: true });
  live.text("words of the reply");
  lines.push("two");
  live.event("tool.completed", { name: "files.read", id: "a" });
  await until(() => chat.calls.some((c) => c.op === "edit" && c.text === "ab one\ntwo"), "the next step");
  assert.ok(chat.calls.every((c) => !/words of the reply/.test(c.text ?? "")), "the reply is not written into the steps");
  assert.equal(await live.finish("done", "The reply."), null, "the reply goes out the ordinary way, as its own message");
  await until(() => chat.calls.some((c) => c.op === "edit" && c.text.endsWith(`${STEP_ICONS.done} Done`)), "the last line");
});

test("words the last look changed go out without spans: a span measured on other words would mark the wrong ones", async () => {
  const chat = fakeChat();
  const live = new LiveStatus({ adapter: chat.adapter, chatId: "c1", messageId: "q1" },
    async (text) => ({ text: text.replace("ab", "[x]"), blocked: false }), fast, false, steady(["ab one"]));
  live.start();
  live.thinking();
  const opened = await until(() => chat.calls.find((c) => c.op === "send"), "progress message");
  assert.equal(opened.text, "[x] one");
  assert.equal(opened.format.spans, undefined);
  live.cancel();
});

test("Telegram's retry_after is waited out and the message carries on; it is never counted as a failure", async () => {
  assert.equal(retryAfterMs(Object.assign(new Error("x"), { retryAfter: 3 })), 3000);
  assert.equal(retryAfterMs(new Error("x")), 0);
  const chat = fakeChat();
  const lines = ["one"];
  const live = new LiveStatus({ adapter: chat.adapter, chatId: "c1", messageId: "q1" }, async (text) => ({ text, blocked: false }), fast, false, steady(lines));
  live.start();
  live.thinking();
  await until(() => chat.calls.some((c) => c.op === "send"), "progress message");
  chat.refuse(3, 0.05); // three "wait 50 ms" answers in a row: more than the two failures that end a message
  for (const word of ["two", "three", "four"]) {
    lines.push(word);
    live.event("tool.started", { name: "files.read", id: word });
    await until(() => chat.calls.filter((c) => c.op === "refused" || c.op === "edit").length >= lines.length - 1, `an attempt for ${word}`);
  }
  await until(() => chat.calls.some((c) => c.op === "edit" && c.text === "one\ntwo\nthree\nfour"), "the steps after the wait");
  chat.refuse(1, 0.05); // and one more on the last line itself
  await live.finish("done");
  await until(() => chat.calls.some((c) => c.op === "edit" && c.text.endsWith("Done")), "the last line after the waits");
});

// ---- end to end, through a stand-in Telegram -------------------------------------------------

async function fakeBotApi(t) {
  const state = { sent: [], edits: [], answered: [], queue: [], next: 1 };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const method = /\/bot[^/]+\/(\w+)$/.exec(req.url)?.[1];
    const body = raw ? JSON.parse(raw) : {};
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 123456, is_bot: true, first_name: "Branch", username: "StepsBot" });
    if (method === "getUpdates") {
      state.queue = state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!state.queue.length) await delay(50);
      return reply(state.queue.filter((u) => u.update_id >= (body.offset ?? 0)));
    }
    if (method === "sendMessage") { state.sent.push(body); return reply({ message_id: 1000 + state.sent.length, chat: { id: body.chat_id } }); }
    if (method === "editMessageText") { state.edits.push(body); return reply(true); }
    if (method === "answerCallbackQuery") { state.answered.push(body.callback_query_id); return reply(true); }
    reply(true);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    state, base: `http://127.0.0.1:${server.address().port}`,
    say: (text, chat = { id: 42, type: "private" }) => state.queue.push({ update_id: state.next++,
      message: { message_id: 500 + state.next, text, from: { id: 42, first_name: "Sam", username: "sam" }, chat } }),
    press: (data) => state.queue.push({ update_id: state.next++, callback_query: { id: `press-${state.next}`, data,
      from: { id: 42, first_name: "Sam", username: "sam" }, message: { message_id: 77, chat: { id: 42, type: "private" } } } }),
  };
}
/** Reads a note twice, tries a command carrying a saved key (a chat's task may not run commands), then waits. */
function model() {
  const provider = { name: "scripted", requests: [], gate: null, async complete(request) {
    provider.requests.push(request);
    // Tool answers since the person's last message: one chat is one conversation, so earlier turns are in it too.
    const lastUser = request.messages.findLastIndex((m) => m.role === "user");
    const tools = request.messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    const call = (name, args) => ({ content: "", toolCalls: [{ id: `call-${tools}`, name, arguments: JSON.stringify(args) }] });
    const asked = /pick (\d)/.exec(String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
    if (asked) return tools ? { content: "Picked.", toolCalls: [] } : call("demo.pick", { n: Number(asked[1]) });
    if (tools === 0) return call("files.read", { path: "notes.md" });
    if (tools === 1) return call("files.read", { path: "notes.md" });
    if (tools === 2) return call("shell.execute", { command: "curl", args: ["-H", `Authorization: Bearer ${SECRET}`, "https://example.test"] });
    if (!provider.closing) await new Promise((resolve) => { provider.gate = resolve; });
    return { content: "The notes say ship it.", toolCalls: [] };
  } };
  return provider;
}
async function fixture(t) {
  const bot = await fakeBotApi(t);
  const root = await mkdtemp(join(tmpdir(), "branch-chat-steps-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "notes.md"), "ship it\n");
  const provider = model();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // A test that fails while the model is held lets it go first, so closing never waits on a task that cannot end.
  t.after(async () => { provider.closing = true; provider.gate?.(); await app.close(); await discardTemp(root); });
  await app.store.secrets.put(app.runtime.owner, "default", "DEPLOY_KEY", SECRET);
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = fast;
  await app.channels.attach(new TelegramAdapter({ id: "telegram", token, apiBase: bot.base, fetch: globalThis.fetch, pollTimeoutSeconds: 1 }),
    { activation: "always", pairing: false, allowlist: ["42"] });
  return { app, bot, provider };
}
const everything = (bot) => JSON.stringify([...bot.state.sent, ...bot.state.edits]);

test("Telegram end to end: the steps, code blocks, (×2), a quiet message, the reply on its own, and no saved key", async (t) => {
  const { app, bot, provider } = await fixture(t);
  assert.equal(chatLiveSwitches(app.store, app.runtime.owner).steps, "on", "Show steps in chats ships on");
  bot.say("check the notes");
  const steps = await until(() => [...bot.state.edits].reverse().find((e) => /Running/.test(e.text)), "the command's step");
  await until(() => provider.gate, "the model is writing the answer");
  const progress = bot.state.sent[0];
  assert.equal(progress.disable_notification, true, "the steps message arrives without a sound");
  assert.match(steps.text, new RegExp(`^${STEP_ICONS.read} Reading notes\\.md \\(×2\\)\\n${STEP_ICONS.command} Running ${STEP_ICONS.failed}`));
  const pre = steps.entities.find((e) => e.type === "pre");
  assert.equal(pre.language, "shell");
  assert.match(covered(steps.text, pre), /^curl -H Authorization: Bearer /, "the code block covers the command, nothing else");
  assert.equal(covered(steps.text, steps.entities.find((e) => e.type === "code")), "notes.md");
  assert.ok(!everything(bot).includes(SECRET), "the saved key never reached Telegram");
  provider.gate();
  const answer = await until(() => bot.state.sent.find((m) => m.text === "The notes say ship it."), "the reply");
  assert.notEqual(answer.disable_notification, true, "the reply is the message that rings");
  await until(() => bot.state.edits.some((e) => e.text.split("\n").at(-1).startsWith(`${STEP_ICONS.done} Done · 3 steps`)), "the last line");
  assert.ok(!everything(bot).includes(SECRET));
});

test("a group gets the short message: no steps, no paths, no commands", async (t) => {
  const { app, bot, provider } = await fixture(t);
  bot.say("check the notes", { id: -100, type: "group", title: "Team" });
  await until(() => provider.gate, "the model is writing the answer");
  await until(() => bot.state.sent.length && bot.state.edits.length, "the progress message was edited");
  for (const message of [...bot.state.sent, ...bot.state.edits]) {
    assert.doesNotMatch(message.text, /curl|Bearer|\(×/, "a group never sees the steps");
    assert.equal(message.entities, undefined);
  }
  assert.match(bot.state.sent[0].text, /^Working on it/, "the short message");
  provider.gate();
  await until(() => bot.state.sent.some((m) => /ship it/.test(m.text)) || bot.state.edits.some((e) => /ship it/.test(e.text)), "the reply");
});

test("with Show steps in chats off, a direct chat gets the short message too", async (t) => {
  const { app, bot, provider } = await fixture(t);
  saveChatLiveSwitches(app.store, app.runtime.owner, { steps: "off" });
  bot.say("check the notes");
  await until(() => provider.gate, "the model is writing the answer");
  await until(() => bot.state.sent.length, "the progress message");
  await delay(60);
  for (const message of [...bot.state.sent, ...bot.state.edits]) assert.doesNotMatch(message.text, /curl|Bearer/);
  provider.gate();
});

// ---- the guards around it: a button answers only its own request ------------------------------

test("an old button never answers a newer question: it carries its own request's fingerprint", async (t) => {
  const { app, bot } = await fixture(t);
  app.registry.register({ name: "demo.pick", permission: "invented.power", description: "stand-in", group: "core",
    parameters: z.object({ n: z.number() }).strict(), execute: async () => ({ ran: true }) });
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "telegram", sender: "42", allow: ["invented.power"], note: "my phone", approvals: true }] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "demo.pick", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  const questions = () => bot.state.sent.filter((m) => m.reply_markup);
  const yesOf = (m) => m.reply_markup.inline_keyboard.flat().find((b) => b.text === "Yes").callback_data;
  bot.say("pick 1");
  await until(() => questions().length === 1, "the first question");
  const first = app.runtime.waitingApprovals()[0];
  const sessionId = first.sessionId;
  app.runtime.approve(sessionId, "deny", "session", first.fingerprint); // answered in the window instead
  await until(() => !app.runtime.waitingApprovals(sessionId).length, "the first question ended");
  bot.say("pick 2");
  await until(() => questions().length === 2, "the second question");
  const second = app.runtime.waitingApprovals(sessionId)[0];
  assert.notEqual(second.fingerprint, first.fingerprint);
  bot.press(yesOf(questions()[0])); // the first question's Yes, pressed late
  await until(() => bot.state.sent.some((m) => m.text === staleButtonNote), "the stale-button note");
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.fingerprint), [second.fingerprint], "the newer question still waits");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).filter((a) => a.outcome === "allowed").length, 0);
  bot.press(yesOf(questions()[1]));
  await until(() => !app.runtime.waitingApprovals(sessionId).length, "its own button answers it");
});

test("a sender the one list blocks gets no task, no steps and no progress, even with the chat's own list allowing them", async (t) => {
  const { app, bot, provider } = await fixture(t);
  saveSenderAllowlist(app.store, app.runtime.owner, { rules: [{ channel: "telegram", sender: "42", decision: "block", note: "lost phone" }] });
  bot.say("check the notes");
  await delay(400);
  assert.deepEqual(bot.state.sent.map((m) => m.text), [], "a block is silent (UP-CHAT-008)");
  assert.equal(bot.state.edits.length, 0);
  assert.equal(provider.requests.length, 0, "no task started");
});
