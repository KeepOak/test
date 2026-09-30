/**
 * The steps in every chat app, each in its own way (docs/chat-parity.md, piece 3):
 * - Discord: Markdown fences with the language, quiet sends, and its "slow down" waited out;
 * - Slack: fences without a language, which Slack would print as a first line of code;
 * - Matrix: edits in place (m.replace), with the code as HTML;
 * - an app that cannot edit (WhatsApp, Signal, iMessage, email): one line above the reply naming no file or command,
 *   never where each message costs money, never in a group;
 * - a group: the short message counts kinds of step ("Reading 2 files") and never shows a label.
 * Every service is a stand-in fetch on this computer; nothing leaves it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, DiscordAdapter, SlackAdapter, MatrixAdapter } from "../dist/index.js";
import { compactSummary, fenced, kindLines, matrixHtml } from "../dist/channels/progress-render.js";
import { LiveStatus, retryAfterMs } from "../dist/channels/live-status.js";
import { STEP_ICONS } from "../dist/live-steps.js";

const fast = { progressAfterMs: 30, editEveryMs: 20, typingEveryMs: 50, reactEveryMs: 5 };
async function until(check, label, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
const text = `${STEP_ICONS.read} Reading notes/a.md\n${STEP_ICONS.command} Running\nnpm test <x>`;
const spans = [{ offset: text.indexOf("notes/a.md"), length: 10, kind: "inline" }, { offset: text.indexOf("npm test"), length: 12, kind: "block", language: "shell" }];

// ---- the shapes ------------------------------------------------------------------------------

test("fences: the language on Discord, none on Slack, and words holding backticks stay plain", () => {
  assert.equal(fenced(text, spans, { tag: true }), `${STEP_ICONS.read} Reading \`notes/a.md\`\n${STEP_ICONS.command} Running\n\`\`\`shell\nnpm test <x>\n\`\`\``);
  assert.equal(fenced(text, spans, { tag: false }), `${STEP_ICONS.read} Reading \`notes/a.md\`\n${STEP_ICONS.command} Running\n\`\`\`\nnpm test <x>\n\`\`\``);
  const odd = "Running\necho `id`";
  assert.equal(fenced(odd, [{ offset: 8, length: 9, kind: "block", language: "shell" }], { tag: true }), odd, "a backtick inside is not fenced");
});

test("Matrix HTML: escaped words, a code block with its language, a file as code", () => {
  assert.equal(matrixHtml(text, spans),
    `${STEP_ICONS.read} Reading <code>notes/a.md</code><br>${STEP_ICONS.command} Running<pre><code class="language-shell">npm test &lt;x&gt;</code></pre>`);
  assert.doesNotMatch(matrixHtml("<script>", []), /<script>/);
});

test("a group sees kinds and counts, never a file name, page or command", () => {
  assert.deepEqual(kindLines(["files.read", "files.read", "web.search", "shell.execute", "files.read"]),
    [`${STEP_ICONS.read} Reading 3 files`, `${STEP_ICONS.search} 1 search`, `${STEP_ICONS.command} Running 1 command`]);
  const chat = { calls: [] };
  chat.adapter = { id: "g", kind: "fake", botName: () => "B", async start() {}, async stop() {},
    async send(chatId, words) { chat.calls.push(words); return "1"; }, async edit(chatId, id, words) { chat.calls.push(words); } };
  const live = new LiveStatus({ adapter: chat.adapter, chatId: "c", messageId: "m", kindsOnly: true }, async (words) => ({ text: words, blocked: false }), fast);
  live.start();
  live.thinking();
  live.event("tool.started", { name: "files.read", id: "a", label: "Reading secret-plan.md" });
  live.event("tool.started", { name: "files.read", id: "b", label: "Reading payroll.xlsx" });
  return until(() => chat.calls.some((c) => c.includes("Reading 2 files")), "the kinds").then(() => {
    assert.ok(chat.calls.every((c) => !/secret-plan|payroll/.test(c)), chat.calls.join(" | "));
    live.cancel();
  });
});

test("the line for an app that cannot edit names nothing and says how it ended", () => {
  const step = (icon, label, extra = {}) => ({ id: label, kind: "tool", icon, label, result: null, state: "done", at: "", seconds: 1, depth: 0, input: null, output: null, ...extra });
  const view = { steps: [step(STEP_ICONS.read, "Reading secret.md"), step(STEP_ICONS.read, "Reading b.md"), step(STEP_ICONS.search, "Searching the web for “x”"),
    step(STEP_ICONS.thinking, "a thought", { kind: "think" })], seconds: 12 };
  assert.equal(compactSummary(view, "done"), `${STEP_ICONS.read}×2 ${STEP_ICONS.search} · ${STEP_ICONS.done} Done · 3 steps · 12 s`);
  assert.equal(compactSummary({ steps: [], seconds: 1 }, "done"), null);
});

// ---- each app, against a stand-in of its API ---------------------------------------------------

/** A stand-in fetch: records each call and answers with `answer(url, init)`. */
function standIn(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(url), method: init.method, body });
    const { status = 200, json = {}, headers = {} } = (await answer(String(url), init)) ?? {};
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fetch, calls };
}

test("Discord: fences with the language, a quiet progress message, and its 429 carried as a wait", async () => {
  let limited = false;
  const api = standIn((url, init) => (init.method === "PATCH" && limited ? { status: 429, json: { retry_after: 0.2 }, headers: { "retry-after": "0.2" } } : { json: { id: "m1" } }));
  const discord = new DiscordAdapter({ id: "discord", token: "not-a-real-secret", apiBase: "http://discord.test/api", fetch: api.fetch });
  assert.equal(await discord.send("c1", text, "q1", { spans, quiet: true }), "m1");
  assert.equal(api.calls[0].body.content, fenced(text, spans, { tag: true }));
  assert.equal(api.calls[0].body.flags, 4096, "SUPPRESS_NOTIFICATIONS");
  await discord.edit("c1", "m1", text, { spans });
  assert.match(api.calls[1].body.content, /```shell\nnpm test <x>\n```/);
  await discord.send("c1", "the reply");
  assert.equal(api.calls[2].body.flags, undefined, "the reply notifies");
  limited = true;
  const refused = await discord.edit("c1", "m1", "again").catch((error) => error);
  assert.ok(retryAfterMs(refused) > 0, "a 429 is a wait, not a failure");
  const tooLong = "x".repeat(1995);
  await new Promise((resolve) => setTimeout(resolve, 250));
  limited = false;
  await discord.send("c1", tooLong, undefined, { spans: [{ offset: 0, length: 10, kind: "block" }] });
  assert.equal(api.calls.at(-1).body.content, tooLong, "fences that would pass the limit are left off");
});

test("Slack: fences without a language", async () => {
  const api = standIn(() => ({ json: { ok: true, ts: "1.2" } }));
  const slack = new SlackAdapter({ id: "slack", token: "not-a-real-secret", appToken: "not-a-real-secret", apiBase: "http://slack.test/api", fetch: api.fetch });
  await slack.send("C1", text, undefined, { spans });
  await slack.edit("C1", "1.2", text, { spans });
  for (const call of api.calls) {
    assert.match(call.body.text, /```\nnpm test/);
    assert.doesNotMatch(call.body.text, /```shell/);
    assert.match(call.body.text, /`notes\/a\.md`/);
  }
});

test("Matrix: a progress message edited in place, with the code as HTML", async () => {
  const api = standIn(() => ({ json: { event_id: `$event-${Math.random()}` } }));
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "http://matrix.test", accessToken: "not-a-real-secret", userId: "@branch:matrix.test", fetch: api.fetch });
  const id = await matrix.send("!room:matrix.test", "one", undefined, { spans: [] });
  const first = api.calls[0];
  await matrix.edit("!room:matrix.test", id, text, { spans });
  const edit = api.calls.at(-1).body;
  assert.equal(edit["m.relates_to"].rel_type, "m.replace");
  assert.ok(edit["m.relates_to"].event_id.startsWith("$event-"), "the edit names the event it replaces");
  assert.equal(edit["m.new_content"].body, text);
  assert.match(edit["m.new_content"].formatted_body, /<pre><code class="language-shell">npm test &lt;x&gt;<\/code><\/pre>/);
  assert.equal(first.body.format, undefined, "plain words need no HTML");
  await assert.rejects(matrix.edit("!room:matrix.test", "somebody-else", "x"), /cannot be edited/);
});

// ---- an app that cannot edit, end to end ------------------------------------------------------

async function fixture(t, parts = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-renderers-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "notes.md"), "ship it\n");
  const slow = { ms: 20 };
  const provider = { name: "scripted", async complete(request) {
    const lastUser = request.messages.findLastIndex((m) => m.role === "user");
    const tools = request.messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    if (tools < 2) return { content: "", toolCalls: [{ id: `c${tools}`, name: "files.read", arguments: JSON.stringify({ path: "notes.md" }) }] };
    await delay(slow.ms);
    return { content: "Ship it.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { ...fast, progressAfterMs: 0 };
  const sent = [];
  const adapter = { id: "wa", kind: "fake", botName: () => "B", async start() {}, async stop() {},
    async send(chatId, words) { sent.push(words); return String(sent.length); }, ...parts };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  const say = (words, extra = {}) => app.channels.handle({ channel: "wa", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: words, addressed: true, messageId: `m${Math.random()}`, ...extra });
  return { app, sent, say, slow };
}

test("an app without edits gets one line above the reply, naming nothing", async (t) => {
  const { sent, say } = await fixture(t);
  assert.equal(await say("check the notes"), "replied");
  assert.equal(sent.length, 1, "one message: nothing extra was sent");
  assert.match(sent[0], new RegExp(`^${STEP_ICONS.read}×2 · ${STEP_ICONS.done} Done · 2 steps · \\d+ s\\n\\nShip it\\.$`));
  assert.doesNotMatch(sent[0], /notes\.md/);
});

test("no line where each message costs money, in a group, or with Show steps in chats off", async (t) => {
  const paid = await fixture(t, { paidPerMessage: true });
  await paid.say("check the notes");
  assert.deepEqual(paid.sent, ["Ship it."]);
  const group = await fixture(t);
  await group.say("check the notes", { chatKind: "group", chatTitle: "Team" });
  assert.match(group.sent[0], /Ship it\.$/);
  assert.doesNotMatch(group.sent[0], /Done ·/);
  const off = await fixture(t);
  off.app.channels.setSwitches({ steps: "off" });
  await off.say("check the notes");
  assert.deepEqual(off.sent, ["Ship it."]);
});

test("through the router, a group's progress message counts kinds and never names the file", async (t) => {
  const shown = [];
  const { app, say, slow } = await fixture(t, {
    async edit(chatId, id, words) { shown.push(words); },
    async sendTyping() {},
    async send(chatId, words) { shown.push(words); return String(shown.length); },
  });
  app.channels.groupEditEveryMs = 20;
  slow.ms = 300;
  await say("check the notes", { chatKind: "group", chatTitle: "Team" });
  assert.ok(shown.some((words) => /Reading \d files?/.test(words)), shown.join(" | "));
  assert.ok(shown.every((words) => !/notes\.md/.test(words)), shown.join(" | "));
});
