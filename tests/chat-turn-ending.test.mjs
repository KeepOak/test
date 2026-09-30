/**
 * How a chat turn ends, per chat app (the owner's Telegram DM, 2026-09-27): a turn that took no step posts only its
 * answer, with no "Done · 0 steps" message; a turn with steps keeps its steps message above the answer, edited into its
 * last line; and no two messages of one answer both quote the person's message. Quoting and the reaction are each app's
 * own setting (src/channels/reply-style.ts). /start is answered without the model. Stand-in apps and models only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises"; // only as the poll tick of until()
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, TelegramAdapter, DiscordAdapter, SlackAdapter } from "../dist/index.js";
import { nextQuote, quoteState, saveReplyStyle, replyStyle } from "../dist/channels/reply-style.js";

// A progress message may open at once (progressAfterMs 0): each model below waits until the chat shows the task is
// thinking, which is after that moment, so the old "Done · 0 steps" message would have had its chance.
const fast = { progressAfterMs: 0, editEveryMs: 5, typingEveryMs: 1000, reactEveryMs: 5 };
async function until(check, label, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await delay(5); }
  assert.fail(`Timed out: ${label}`);
}
/** Apps whose reply id only quotes (as their real adapters say); on Slack and Matrix it keeps the thread instead. */
const quoting = new Set(["telegram", "discord", "whatsapp"]);
/** A chat app stand-in of one kind; `edit` false is an app like WhatsApp that cannot change a sent message. */
function fakeApp(kind, { edit = true } = {}) {
  const calls = [];
  let next = 1;
  const adapter = { id: kind, kind, maxTextLength: 3500, botName: () => "Branch", async start() {}, async stop() {},
    ...(quoting.has(kind) ? { replyQuotes: true } : {}),
    async send(chatId, text, replyTo, format) { const id = String(next++); calls.push({ op: "send", id, text, replyTo, quiet: !!format?.quiet }); return id; },
    async sendTyping() { calls.push({ op: "typing" }); },
    async react(chatId, messageId, emoji) { calls.push({ op: "react", messageId, emoji }); },
  };
  if (edit) adapter.edit = async (chatId, id, text) => { calls.push({ op: "edit", id, text }); };
  const sends = () => calls.filter((c) => c.op === "send");
  /** The words a message shows last: its last edit, else what was sent. */
  const finalOf = (id) => calls.filter((c) => c.op === "edit" && c.id === id).at(-1)?.text ?? sends().find((s) => s.id === id)?.text;
  return { adapter, calls, sends, finalOf };
}
/**
 * A model that answers once `ready()` holds (the test's condition, never a fixed wait), optionally taking steps first
 * and writing words before its first step; `gate` holds the answer until the test opens it.
 */
function model({ steps = 0, preamble = "", gate } = {}) {
  let round = 0;
  const provider = { name: "stand-in", requests: 0, ready: () => true, preambleShown: () => true, async complete(request) {
    provider.requests++;
    round++;
    await until(provider.ready, "the chat shows the task is thinking");
    if (round <= steps) {
      if (preamble && round === 1) { request.onTextDelta?.(preamble); await until(provider.preambleShown, "the words before the step"); }
      return { content: "", toolCalls: [{ id: `c${round}`, name: "files.list", arguments: "{\"path\":\".\"}" }] };
    }
    if (gate) await gate;
    request.onTextDelta?.("Here it is. ");
    return { content: "Here it is.", toolCalls: [] };
  } };
  return provider;
}
async function fixture(t, kind, provider, { edit = true, style } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-turn-ending-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = fast;
  app.channels.setSwitches({ liveStatus: "on", steps: "on" });
  if (style) saveReplyStyle(app.store, app.runtime.owner, { channel: kind, ...style }, [kind]);
  const chat = fakeApp(kind, { edit });
  await app.channels.attach(chat.adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  // Thinking is shown (🤔) only after the moment a progress message could open, so each turn below lives past it.
  provider.ready = () => !edit || style?.react === false || chat.calls.some((c) => c.op === "react" && c.emoji === "🤔");
  return { app, chat };
}
let ids = 100;
const inbound = (kind, text, extra = {}) => ({ channel: kind, chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
  text, addressed: true, messageId: String(ids++), ...extra });

for (const kind of ["telegram", "discord", "slack", "matrix"]) {
  test(`${kind}: a turn with no step posts only its answer, unquoted in a one-to-one chat`, async (t) => {
    const { app, chat } = await fixture(t, kind, model());
    assert.equal(await app.channels.handle(inbound(kind, "Hi")), "replied");
    const sends = chat.sends();
    assert.equal(sends.length, 1, `one message, not a status and an answer: ${JSON.stringify(sends)}`);
    assert.equal(sends[0].quiet, false);
    assert.ok(!chat.calls.some((c) => /Done|steps?\b/.test(c.text ?? "")), "no Done line anywhere");
    if (quoting.has(kind)) assert.equal(sends[0].replyTo, undefined, "a one-to-one answer does not quote the only message it answers");
    else assert.ok(sends[0].replyTo, "where the id is the thread, the answer stays in it");
    const last = chat.calls.filter((c) => c.op === "edit" && c.id === sends[0].id).at(-1)?.text ?? sends[0].text;
    assert.equal(last, "Here it is.");
    assert.ok(chat.calls.some((c) => c.op === "react"), "the reaction on the message stays");
  });

  test(`${kind}: a turn with steps keeps its steps message above the answer, finished in place, quoting once at most`, async (t) => {
    const { app, chat } = await fixture(t, kind, model({ steps: 2 }), { style: { quote: "first" } });
    assert.equal(await app.channels.handle(inbound(kind, "tidy up")), "replied");
    const sends = chat.sends();
    assert.equal(sends.length, 2, `steps then answer: ${JSON.stringify(sends)}`);
    assert.equal(sends[0].quiet, true, "the steps message comes first and arrives quietly");
    assert.equal(chat.finalOf(sends[1].id), "Here it is.", "the answer comes second");
    await until(() => chat.calls.some((c) => c.op === "edit" && c.id === sends[0].id && /Done/.test(c.text)), "the steps' last line");
    assert.ok(!chat.calls.some((c) => c.op === "send" && /Done/.test(c.text)), "the summary is an edit, not a new message");
    if (quoting.has(kind)) {
      assert.deepEqual(sends.map((s) => s.replyTo), [sends[0].replyTo, undefined], "only the first message quotes");
      assert.ok(sends[0].replyTo, "\"first\" quotes the first message");
    } else assert.ok(sends.every((s) => s.replyTo), "both stay in the thread");
  });
}

test("words written before a step become the steps message, so the answer still lands below the steps", async (t) => {
  const provider = model({ steps: 1, preamble: "Let me look at the folder first, " });
  const { app, chat } = await fixture(t, "telegram", provider);
  provider.preambleShown = () => chat.sends().length === 1; // the start of a reply is already in the chat
  assert.equal(await app.channels.handle(inbound("telegram", "what is here?")), "replied");
  const sends = chat.sends();
  const [first, second] = sends;
  assert.equal(sends.length, 2, JSON.stringify(sends));
  assert.ok(Number(first.id) < Number(second.id));
  const { finalOf } = chat;
  await until(() => /Done/.test(finalOf(first.id)), "the first message ends as the steps");
  assert.equal(finalOf(second.id), "Here it is.", "the answer is the lower message");
});

test("an app that cannot edit gets one message: the answer, with a steps line only when there were steps", async (t) => {
  const { app, chat } = await fixture(t, "whatsapp", model({ steps: 1 }), { edit: false });
  assert.equal(await app.channels.handle(inbound("whatsapp", "tidy up")), "replied");
  assert.equal(chat.sends().length, 1);
  assert.equal(chat.sends()[0].replyTo, undefined);
});

test("auto quoting: a newer message arriving before the answer makes the answer quote the one it answers", async (t) => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const provider = model({ gate });
  const { app, chat } = await fixture(t, "telegram", provider);
  app.channels.setSwitches({ steering: "off" });
  const first = inbound("telegram", "first question");
  const answered = app.channels.handle(first);
  await until(() => provider.requests === 1, "the first question is being answered");
  // Let in synchronously, before handle's first wait, so it is the chat's newest message when the gate opens.
  const later = app.channels.handle(inbound("telegram", "second question"));
  open();
  assert.equal(await answered, "replied");
  await later;
  const replies = chat.sends().filter((s) => chat.finalOf(s.id) === "Here it is.");
  assert.equal(replies.length, 2, JSON.stringify(chat.calls));
  assert.equal(replies[0].replyTo, first.messageId, "the older question's answer says which question it answers");
  assert.equal(replies[1].replyTo, undefined, "the newest question's answer needs no quote");
});

test("groups quote the answer, not the status beside it; off and all do what they say", async (t) => {
  const { app, chat } = await fixture(t, "telegram", model({ steps: 2 }));
  const asked = inbound("telegram", "hello all", { chatKind: "group", chatTitle: "Team", chatId: "g1" });
  await app.channels.handle(asked);
  const sends = chat.sends();
  assert.equal(sends.length, 2, "a short progress message, then the answer");
  assert.equal(sends[0].replyTo, undefined, "the progress message does not use up the quote");
  assert.equal(sends[1].replyTo, asked.messageId, "the answer says who it answers");
  assert.equal(chat.finalOf(sends[1].id), "Here it is.");
  const state = (mode, kind = "direct") => quoteState(mode, kind, () => false);
  const off = state("off"), all = state("all"), first = state("first"), auto = state("auto");
  assert.deepEqual([nextQuote(off, "m"), nextQuote(off, "m")], [undefined, undefined]);
  assert.deepEqual([nextQuote(all, "m"), nextQuote(all, "m")], ["m", "m"]);
  assert.deepEqual([nextQuote(first, "m", "status"), nextQuote(first, "m")], ["m", undefined], "first is the first, status or not");
  assert.deepEqual([nextQuote(auto, "m"), nextQuote(auto, "m")], [undefined, undefined]);
  let late = false;
  const turned = quoteState("auto", "direct", () => late);
  assert.equal(nextQuote(turned, "m"), undefined);
  late = true;
  assert.equal(nextQuote(turned, "m"), "m", "the first message after the answer became unclear quotes");
  assert.equal(nextQuote(turned, "m"), undefined, "and only that one");
});

test("the reaction and quoting are each app's own saved setting", async (t) => {
  const { app, chat } = await fixture(t, "telegram", model(), { style: { react: false, quote: "all" } });
  assert.deepEqual(replyStyle(app.store, app.runtime.owner, "telegram"), { quote: "all", react: false });
  assert.deepEqual(replyStyle(app.store, app.runtime.owner, "discord"), { quote: "auto", react: true });
  const asked = inbound("telegram", "hi");
  await app.channels.handle(asked);
  assert.ok(!chat.calls.some((c) => c.op === "react"), "no reaction when switched off for this app");
  assert.equal(chat.sends()[0].replyTo, asked.messageId);
  assert.throws(() => saveReplyStyle(app.store, app.runtime.owner, { channel: "nowhere", quote: "off" }, ["telegram"]), /no chat app/);
  assert.throws(() => saveReplyStyle(app.store, app.runtime.owner, { channel: "telegram", quote: "sometimes" }, ["telegram"]));
});

test("/start is answered at once with a welcome and never reaches the model", async (t) => {
  const provider = model();
  const { app, chat } = await fixture(t, "telegram", provider);
  assert.equal(await app.channels.handle(inbound("telegram", "/start")), "replied");
  assert.equal(provider.requests, 0);
  const sends = chat.sends();
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /^Hi, I'm .+, running in Branch on .+\./);
  assert.ok(!/Done/.test(sends[0].text));
  assert.equal(sends[0].replyTo, undefined);
  assert.ok(!chat.calls.some((c) => c.op === "react" || c.op === "edit"), "no reaction or status for a welcome");
  // A stranger's /start still gets the pairing words, not the welcome.
  const stranger = await app.channels.handle(inbound("telegram", "/start", { senderId: "someone-else", chatId: "c2" }));
  assert.equal(stranger, "pairing");
});

test("the real adapters say whether their reply id only quotes", () => {
  const fetch = async () => { throw new Error("no network in this test"); };
  assert.equal(new TelegramAdapter({ id: "tg", token: "123:abc", apiBase: "http://telegram.invalid", fetch }).replyQuotes, true);
  assert.equal(new DiscordAdapter({ id: "discord", token: "tok", apiBase: "http://discord.invalid", fetch }).replyQuotes, true);
  assert.equal(new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", apiBase: "http://slack.invalid", fetch }).replyQuotes, undefined,
    "a Slack reply id is its thread, so it is always kept");
});
