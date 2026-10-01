/**
 * UP-CHAT-011 / UP-CHAT-012 (CHAT-114, CHAT-115, CHAT-050): replies in each app's own formatting, and streamed replies
 * that end cleanly.
 * - Telegram gets entities, Signal gets text styles, WhatsApp gets its own marks; nobody reads literal ** or backticks.
 * - Streamed pieces follow the owner's careful-splitting switch, and a preview closes a code block left open.
 * Every chat service is a stand-in; nothing leaves this computer.
 *
 * Mutation notes (each turns this file red):
 * - telegram.ts send: pass the words raw            -> "Telegram: a reply's Markdown becomes entities" fails.
 * - reply-stream.ts chunks: drop this.splitting()    -> "careful splitting" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { readMarkdown, telegramMarkdown, signalMarkdown, whatsappMarkdown } from "../dist/channels/chat-markdown.js";
import { TelegramAdapter } from "../dist/channels/telegram.js";
import { SignalAdapter } from "../dist/channels/signal-cli.js";
import { WhatsAppAdapter } from "../dist/channels/whatsapp.js";
import { ReplyStream, closeFence } from "../dist/channels/reply-stream.js";

const sample = "# Result\n**All 3 tests** passed, see [the log](https://ci.example.test/1) and `npm test`.\n- first _item_\n```js\nconst a = '**not bold**';\n```";

test("one reading of Markdown: words without marks, styles where they lie, nothing styled inside code", () => {
  const { text, styles } = readMarkdown(sample);
  assert.equal(text, "Result\nAll 3 tests passed, see the log and npm test.\n• first item\nconst a = '**not bold**';");
  const at = (kind) => styles.filter((s) => s.kind === kind).map((s) => text.slice(s.offset, s.offset + s.length));
  assert.deepEqual(at("bold"), ["Result", "All 3 tests"]);
  assert.deepEqual(at("link"), ["the log"]);
  assert.deepEqual(at("code"), ["npm test"]);
  assert.deepEqual(at("italic"), ["item"]);
  assert.deepEqual(at("pre"), ["const a = '**not bold**';"]);
  assert.equal(styles.find((s) => s.kind === "pre").language, "js");
  assert.deepEqual(readMarkdown("snake_case_name, 2 * 3 * 4 and a_b"), { text: "snake_case_name, 2 * 3 * 4 and a_b", styles: [] }, "ordinary words are left alone");
  const nested = readMarkdown("**bold _both_**");
  assert.deepEqual(nested.styles.map((s) => [s.kind, s.offset, s.length]), [["bold", 0, 9], ["italic", 5, 4]]);
  const emoji = readMarkdown("😀 **hi**");
  assert.deepEqual(emoji.styles.map((s) => [s.offset, s.length]), [[3, 2]], "offsets count UTF-16 units, as Telegram and Signal do");
});

test("Signal text styles and WhatsApp marks", () => {
  const signal = signalMarkdown("**Bold** and _it_ with `code`, [docs](https://x.test/d)");
  assert.equal(signal.text, "Bold and it with code, docs (https://x.test/d)");
  assert.deepEqual(signal.textStyle, ["0:4:BOLD", "9:2:ITALIC", "17:4:MONOSPACE"]);
  assert.equal(whatsappMarkdown("## Plan\n**Bold** and _it_ ~~gone~~ `code` [docs](https://x.test/d)"), "*Plan*\n*Bold* and _it_ ~gone~ `code` docs (https://x.test/d)");
  assert.equal(whatsappMarkdown("**bold _both_**"), "*bold _both_*", "inner marks close before outer ones");
  assert.equal(whatsappMarkdown("```sh\nls -la\n```"), "```\nls -la\n```");
});

test("Telegram: a reply's Markdown becomes entities; plain words stay plain; refused entities fall back to the words", async () => {
  const sent = [];
  let refuse = false;
  const adapter = new TelegramAdapter({ id: "tg", token: "fake", pollTimeoutSeconds: 0, fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ method: String(url).split("/").at(-1), body });
    if (refuse && body.entities) return Response.json({ ok: false, description: "Bad Request: can't parse entities" });
    return Response.json({ ok: true, result: { message_id: 5 } });
  } });
  await adapter.send("42", sample);
  const { text, entities } = telegramMarkdown(sample);
  assert.equal(sent[0].body.text, text);
  assert.doesNotMatch(sent[0].body.text, /\*\*All|```|`npm|^# /m);
  assert.deepEqual(sent[0].body.entities, entities);
  assert.ok(entities.some((e) => e.type === "text_link" && e.url === "https://ci.example.test/1"));
  assert.ok(entities.some((e) => e.type === "pre" && e.language === "js"));
  await adapter.edit("42", "5", "now **done**");
  assert.deepEqual([sent[1].body.text, sent[1].body.entities], ["now done", [{ type: "bold", offset: 4, length: 4 }]]);
  await adapter.send("42", "**kept**", undefined, { plain: true });
  assert.deepEqual([sent[2].body.text, sent[2].body.entities], ["**kept**", undefined], "the owner's plain words are not read as Markdown");
  await adapter.send("42", "code", undefined, { spans: [{ offset: 0, length: 4, kind: "inline" }] });
  assert.deepEqual(sent[3].body.entities, [{ type: "code", offset: 0, length: 4 }], "words with their own spans keep them");
  refuse = true;
  assert.equal(await adapter.send("42", "**still sent**"), "5");
  assert.deepEqual([sent.at(-1).body.text, sent.at(-1).body.entities], ["**still sent**", undefined]);
});

test("Signal: a reply goes with its text styles", async (t) => {
  const written = [];
  const child = { stdout: new PassThrough(), stdin: { writable: true, write: (line) => written.push(JSON.parse(line)) }, on: () => undefined, kill: () => undefined };
  const adapter = new SignalAdapter({ id: "signal", path: "anything", account: "+15550000000", exists: async () => true, spawnProcess: () => child });
  await adapter.start(async () => undefined);
  t.after(() => adapter.stop());
  void adapter.send("+15551111111", "**Done** with `ls`").catch(() => undefined);
  void adapter.send("+15551111111", "**as is**", undefined, { plain: true }).catch(() => undefined);
  const [styled, plain] = written.filter((call) => call.method === "send").map((call) => call.params);
  // signal-cli takes the ranges as one textStyle list (base's form, tests/signal-monospace.test.mjs).
  assert.deepEqual([styled.message, styled.textStyle], ["Done with ls", ["0:4:BOLD", "10:2:MONOSPACE"]]);
  assert.deepEqual([plain.message, plain.textStyle], ["**as is**", undefined]);
  void adapter.send("+15551111111", "**one**").catch(() => undefined);
  const one = written.filter((call) => call.method === "send").at(-1).params;
  assert.deepEqual([one.message, one.textStyle], ["one", ["0:3:BOLD"]]);
});

test("WhatsApp: a reply goes in WhatsApp's own marks", async () => {
  const calls = [];
  const secret = "app-secret";
  const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ messages: [{ id: "wamid.1" }] }); };
  const adapter = new WhatsAppAdapter({ id: "whatsapp", token: "tok", phoneNumberId: "123", verifyToken: "v", appSecret: secret, fetch, apiBase: "https://graph.example.test/v21.0" });
  await adapter.start(async () => undefined);
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "15551234567", profile: { name: "Sam" } }],
    messages: [{ id: "wamid.in1", from: "15551234567", type: "text", text: { body: "hi" } }] } }] }] }));
  await adapter.receive(raw, `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  await adapter.send("15551234567", "**Done**, see `notes.md`");
  assert.equal(calls.at(-1).text.body, "*Done*, see `notes.md`");
  await adapter.stop();
});

/** A chat app that can edit, whose edits can be made to fail. */
function editable(limit = 3500) {
  const state = { sent: [], edits: [], deleted: [], failEdits: false };
  const adapter = { id: "tg", kind: "telegram", maxTextLength: limit, botName: () => "bot", async start() {}, async stop() {},
    async send(_chat, text) { state.sent.push(text); return `m${state.sent.length}`; },
    async edit(_chat, _id, text) { if (state.failEdits) throw new Error("edit refused"); state.edits.push(text); },
    async deleteMessage(_chat, id) { state.deleted.push(id); } };
  return { state, adapter };
}
const guard = async (text) => ({ blocked: false, text });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("streamed pieces follow careful splitting, and a preview closes a code block left open", async () => {
  const long = `Intro.\n\n\`\`\`js\n${"const x = 1;\n".repeat(60)}\`\`\``;
  const careful = editable(300), plain = editable(300);
  const on = new ReplyStream({ adapter: careful.adapter, chatId: "c", messageId: "1" }, guard, 5, () => "on");
  const off = new ReplyStream({ adapter: plain.adapter, chatId: "c", messageId: "1" }, guard, 5);
  for (const stream of [on, off]) { stream.text("Intro. More"); }
  await settle();
  const carefully = await on.finish(long), plainly = await off.finish(long);
  assert.ok(carefully.rest.every((piece) => /^```js/.test(piece)), "each later piece reopens the code block");
  assert.ok(!plainly.rest.every((piece) => /^```js/.test(piece)), "with the switch off the old cut is kept");
  assert.equal(closeFence("text\n```js\nconst x", 100), "text\n```js\nconst x\n```");
  assert.equal(closeFence("no code here", 100), "no code here");
});
