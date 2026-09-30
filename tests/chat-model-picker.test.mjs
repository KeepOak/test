/**
 * CHAT-079: `/model` on its own in a chat app whose buttons carry a list (Telegram, Discord, Slack) is a menu of the
 * connections, this chat's marked, plus "Default". A press is typed `/model <that one>` in effect, by the same rules, and
 * the choice is saved for this chat's conversation only. A button carries a menu number, never a connection's id; an old
 * menu, another chat's menu, or a press when /model is no longer allowed is refused in words. Stand-ins only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, DiscordAdapter, SlackAdapter, TelegramAdapter } from "../dist/index.js";
import { ModelPicker, modelPickPayload, staleModelMenu } from "../dist/channels/model-picker.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

const answer = (name) => ({ name, async complete() { return { content: `${name} here.`, toolCalls: [] }; } });
async function fixture(t, { listButtons = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-model-picker-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider: answer("alpha"), model: "a-1" }, { id: "beta", name: "Beta", provider: answer("beta"), model: "b-1" }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.setSwitches({ commands: "on" });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" }); // /model is one of the shared commands
  const calls = [];
  let next = 1;
  const adapter = { id: "tg", kind: "telegram", botName: () => "TK", async start() {}, async stop() {},
    async send(chatId, text, replyTo) { calls.push({ op: "send", chatId, text, replyTo }); return String(next++); },
    async sendButtons(chatId, text, buttons) { calls.push({ op: "buttons", chatId, text, buttons }); return String(next++); },
    ...(listButtons ? { listButtons: true } : {}) };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner", "friend"] });
  let id = 100;
  const say = (text, extra = {}) => app.channels.handle({ channel: "tg", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text, addressed: true, messageId: String(id++), ...extra });
  return { app, calls, say };
}
const sessionOf = (app, chat = "c1") => app.store.get("settings", app.runtime.owner, `channel-session:tg:${chat}`).data.sessionId;

test("/model on its own is a menu, a press switches this chat's model, and the choice is saved for this chat", async (t) => {
  const { app, calls, say } = await fixture(t);
  assert.equal(await say("hello"), "replied"); // the chat's conversation starts
  assert.equal(await say("/model"), "replied");
  const menu = calls.find((c) => c.op === "buttons");
  assert.ok(menu, "sent as buttons");
  assert.match(menu.text, /Which model answers in this chat\? Now: Alpha\./);
  assert.deepEqual(menu.buttons.map((b) => b.label), ["✓ Alpha", "Beta", "Default"]);
  assert.ok(menu.buttons.every((b) => modelPickPayload.test(b.value) && b.value.length <= 64 && !/alpha|beta/.test(b.value)),
    "a button carries a menu number, never a connection's id");
  assert.equal(await say(menu.buttons[1].value), "replied");
  assert.match(calls.at(-1).text, /now uses Beta \(b-1\)/);
  assert.equal(app.runtime.models.session(app.runtime.owner, sessionOf(app)).preset, "beta");
  await say("which model?");
  assert.equal(calls.at(-1).text, "beta here.", "the chat's next answer comes from the chosen model");
  // Default puts it back.
  await say(menu.buttons.at(-1).value);
  assert.match(calls.at(-1).text, /back to the usual choice: Alpha/);
  assert.equal(app.runtime.models.session(app.runtime.owner, sessionOf(app)).preset ?? null, null);
});

test("an old menu, another chat's menu and a press after /model was switched off are refused in words", async (t) => {
  const { app, calls, say } = await fixture(t);
  await say("hello");
  await say("/model");
  const first = calls.filter((c) => c.op === "buttons").at(-1);
  await say("/model");
  const second = calls.filter((c) => c.op === "buttons").at(-1);
  assert.notEqual(first.buttons[1].value, second.buttons[1].value);
  await say(first.buttons[1].value);
  assert.equal(calls.at(-1).text, staleModelMenu, "a press on the older menu");
  await say("hi", { chatId: "c2", senderId: "friend" });
  await say(second.buttons[1].value, { chatId: "c2", senderId: "friend" });
  assert.equal(calls.at(-1).text, staleModelMenu, "another chat's menu");
  assert.equal(app.runtime.models.session(app.runtime.owner, sessionOf(app, "c2")).preset ?? null, null);
  app.channels.setSwitches({ commands: "off" });
  await say(second.buttons[1].value);
  assert.equal(calls.at(-1).text, staleModelMenu, "commands switched off: the press does nothing");
  assert.equal(app.runtime.models.session(app.runtime.owner, sessionOf(app)).preset ?? null, null);
});

test("an app whose buttons are yes and no only, or a chat with no conversation yet, gets the list as words", async (t) => {
  const { calls, say } = await fixture(t, { listButtons: false });
  await say("/model");
  assert.ok(!calls.some((c) => c.op === "buttons"));
  assert.match(calls.at(-1).text, /Type \/model followed by a name/);
  await say("hello");
  await say("/model");
  assert.ok(!calls.some((c) => c.op === "buttons"), "no list buttons on this app");
});

test("menus expire and are kept per chat and conversation", () => {
  let now = 0;
  const picker = new ModelPicker(() => now);
  const buttons = picker.offer("chat", "s1", [{ id: "alpha", name: "Alpha" }], null);
  assert.deepEqual(picker.read("chat", "s1", buttons[0].value), { preset: "alpha" });
  assert.deepEqual(picker.read("chat", "s1", buttons[1].value), { preset: "default" });
  assert.deepEqual(picker.read("chat", "s2", buttons[0].value), { stale: true }, "the chat has moved to another conversation");
  assert.equal(picker.read("chat", "s1", "hello"), null, "an ordinary message is not a press");
  now = 16 * 60_000;
  assert.deepEqual(picker.read("chat", "s1", buttons[0].value), { stale: true });
  const many = picker.offer("chat", "s1", Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), null);
  assert.equal(many.length, 25, "at most 25 buttons, Default included");
});

test("the real apps lay a menu out as a list and take its presses back", async () => {
  const sent = [];
  const fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 }, id: "9", ts: "1.2" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const menu = [{ label: "✓ Alpha", value: "m:0123456789ab:0" }, { label: "Beta", value: "m:0123456789ab:1" },
    { label: "Gamma", value: "m:0123456789ab:2" }, { label: "Default", value: "m:0123456789ab:d" }];
  const telegram = new TelegramAdapter({ id: "tg", token: "123:abc", apiBase: "http://telegram.invalid", fetch });
  assert.equal(telegram.listButtons, true);
  await telegram.sendButtons("501", "Which model?", menu);
  assert.deepEqual(sent.at(-1).body.reply_markup.inline_keyboard.map((row) => row.map((b) => b.text)), [["✓ Alpha"], ["Beta"], ["Gamma"], ["Default"]]);
  await telegram.sendButtons("501", "May I?", [{ label: "Yes", value: "y:1" }, { label: "No", value: "n:1" }]);
  assert.deepEqual(sent.at(-1).body.reply_markup.inline_keyboard.map((row) => row.length), [2], "a yes / no question stays one row");
  const rows = DiscordAdapter.components(Array.from({ length: 12 }, (_, i) => ({ label: `P${i}`, value: `m:0123456789ab:${i}` })));
  assert.deepEqual(rows.map((row) => row.components.length), [5, 5, 2]);
  const slack = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", apiBase: "http://slack.invalid", fetch });
  assert.equal(slack.listButtons, true);
  await slack.sendButtons("C1", "Which model?", Array.from({ length: 12 }, (_, i) => ({ label: `P${i}`, value: `m:0123456789ab:${i}` })));
  const actions = sent.at(-1).body.blocks.find((block) => block.type === "actions").elements;
  assert.equal(actions.length, 12);
  assert.equal(actions[11].action_id, "branch_answer_11");
  // Discord takes a menu press back from its gateway like an approval's.
  const discord = new DiscordAdapter({ id: "discord", token: "tok", apiBase: "http://discord.invalid", fetch });
  assert.equal(discord.listButtons, true);
  const heard = [];
  await discord["button"]({ id: "i1", token: "t", type: 3, channel_id: "D1", context: 1, user: { id: "u1", username: "sam" },
    data: { custom_id: "m:0123456789ab:1", component_type: 2 } }, async (message) => { heard.push(message.text); });
  assert.deepEqual(heard, ["m:0123456789ab:1"]);
});
