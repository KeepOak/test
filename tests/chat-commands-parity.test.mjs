/**
 * The chat-parity build's commands (Hermes Agent and OpenClaw): /sethome and deliveries sent home, /agents with the
 * helpers each task started, /title and /commands, on the window's shared code and in a chat app. The model and the
 * chat app are stand-ins; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { lookup } from "../dist/commands/catalog.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { runChatCommand, parseChatCommand } from "../dist/channels/chat-commands.js";
import { homeChat, noHome, resolveHome } from "../dist/channels/home-chat.js";
import { saveOwnerAccounts } from "../dist/reach/platform.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-commands-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  return { app, owner: app.runtime.owner };
}
const windowLine = (app, line, sessionId) =>
  executeCommand(commandHost(app.runtime, app), { surface: "window", line, access: "full", ownWindow: true, ...(sessionId ? { sessionId } : {}) });
const chatLine = (app, line, extra = {}) => {
  const parsed = parseChatCommand(line, "on");
  assert.ok(parsed, `${line} is a chat command`);
  return runChatCommand(parsed, { runtime: app.runtime, channel: "telegram", chatId: "chat-1", sessionId: undefined, turn: undefined,
    permissions: [], dropWaiting: () => false, forget: () => undefined, ...extra });
};
/** A chat that has talked to Branch, as the router keeps it. */
const talked = (app, channel, chatId, title) => app.store.save("settings", app.runtime.owner, `channel-session:${channel}:${chatId}`,
  { channel, chatId, title, updatedAt: new Date().toISOString() });

test("the new commands are in the one table, on the surfaces they claim", () => {
  assert.deepEqual(lookup("sethome").surfaces, ["window", "phone", "terminal"], "owner commands stay off the chat surface; a chat's /sethome is a gate");
  assert.equal(lookup("tasks").name, "agents");
  assert.equal(lookup("subagents").name, "agents");
  assert.equal(lookup("name").name, "title");
  assert.equal(lookup("commands").name, "commands");
});

/** A chat app stand-in attached to the router: `say` hands it a message, `sent` is what Branch sent back. */
async function standIn(app) {
  const sent = [];
  let handler = null;
  await app.channels.attach({ id: "telegram", kind: "telegram", botName: () => "bot", start: async (onMessage) => { handler = onMessage; },
    stop: async () => undefined, send: async (chatId, text) => { sent.push({ chatId, text }); return String(sent.length); } }, {});
  let n = 0;
  const say = (senderId, text, extra = {}) => handler({ channel: "telegram", chatId: `dm-${senderId}`, chatKind: "direct", senderId,
    senderName: senderId, text, addressed: true, messageId: String(++n), ...extra });
  return { sent, say };
}

test("/sethome in a chat is taken only from the owner's own account in a direct chat, and results sent home arrive there", async (t) => {
  const { app, owner } = await fixture(t);
  app.channels.setSwitches({ commands: "on" });
  const chat = await standIn(app);
  await chat.say("friend-7", "/sethome");
  assert.equal(homeChat(app.store, owner), null, "a stranger's /sethome is an ordinary message: no home, only a pairing code");
  assert.match(chat.sent.at(-1).text, /I don't know you yet/);
  saveOwnerAccounts(app.store, owner, [{ channel: "telegram", sender: "owner-1" }]);
  await chat.say("owner-1", "/sethome", { chatKind: "group", chatId: "group-1" });
  await chat.say("owner-1", "/sethome", { caughtUp: true });
  assert.equal(homeChat(app.store, owner), null, "never from a group, never from a message fetched after a restart");

  await chat.say("owner-1", "/sethome");
  assert.match(chat.sent.at(-1).text, /This chat is home now/);
  assert.deepEqual(resolveHome(app.store, owner, "home", "home"), { channel: "telegram", chatId: "dm-owner-1" });
  assert.deepEqual(resolveHome(app.store, owner, "discord", "d-9"), { channel: "discord", chatId: "d-9" }, "a named chat is left as it is");

  // The router reads home when it sends: a schedule's result sent "home" reaches that chat through its app.
  await app.channels.deliver("home", "home", "The nightly check found nothing new.", "schedule:test-1");
  assert.deepEqual(chat.sent.at(-1), { chatId: "dm-owner-1", text: "The nightly check found nothing new." });

  await chat.say("owner-1", "/sethome off");
  assert.match(chat.sent.at(-1).text, /no longer home/);
  await assert.rejects(app.channels.deliver("home", "home", "held", "schedule:test-2"), (error) => error.message === noHome);
});

test("/sethome at the window shows home, chooses a chat that has talked to Branch, and forgets it", async (t) => {
  const { app, owner } = await fixture(t);
  assert.match((await windowLine(app, "/sethome")).text, /No chat is home yet/);
  assert.match((await windowLine(app, "/sethome discord")).text, /No chat on discord has talked to Branch yet/);
  talked(app, "discord", "dm-42", "Taofik");
  talked(app, "telegram", "t-1", "Family");
  assert.match((await windowLine(app, "/sethome discord")).text, /Home is Taofik on discord now/);
  assert.deepEqual(resolveHome(app.store, owner, "home", "home"), { channel: "discord", chatId: "dm-42" });
  assert.match((await windowLine(app, "/sethome telegram family")).text, /Home is Family on telegram now/);
  assert.match((await windowLine(app, "/sethome")).text, /Home is Family on telegram, since/);
  assert.match((await windowLine(app, "/sethome off")).text, /No chat is home now/);
  assert.equal(homeChat(app.store, owner), null);
  const phone = await executeCommand(commandHost(app.runtime, app), { surface: "phone", line: "/sethome telegram", access: "run" });
  assert.equal(phone.refused, true, "choosing home needs the key of this computer");
});

test("/agents lists what is working with each helper under the task that started it; a chat sees only its own", async (t) => {
  const { app } = await fixture(t);
  const store = app.store, owner = app.runtime.owner;
  const main = store.createRun(owner, "Plan the trip to Lagos");
  const helper = store.createRun(owner, "Find flights");
  store.event(helper.id, "run.started", { parentRunId: main.id });
  const other = store.createRun(owner, "Tidy the downloads folder");
  // A new task record starts as working (store.createRun), which is all /agents reads.

  const text = (await windowLine(app, "/agents")).text;
  assert.match(text, /^2 tasks working, with 1 helper:/);
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes("Plan the trip"));
  assert.match(lines[at + 1], /^\s+helper .*Find flights/, "the helper sits under its task");
  assert.ok(lines.some((line) => line.includes("Tidy the downloads")));

  const inChat = await chatLine(app, "/tasks", { sessionId: main.sessionId });
  assert.match(inChat, /Plan the trip/);
  assert.match(inChat, /helper .*Find flights/);
  assert.doesNotMatch(inChat, /Tidy the downloads/, "the owner's other work is not the chat's business");
  assert.equal(await chatLine(app, "/agents", { sessionId: "00000000-0000-4000-8000-000000000000" }), "Nothing is working in this chat.");
});

test("/title names the conversation it is typed in, from the window and from a chat", async (t) => {
  const { app, owner } = await fixture(t);
  const run = app.store.createRun(owner, "hello");
  assert.match((await windowLine(app, "/title")).text, /Say the name/);
  assert.match((await windowLine(app, "/title Trip   planning", run.sessionId)).text, /called Trip planning now/);
  assert.equal(app.store.conversations.titleOf(run.sessionId), "Trip planning");
  assert.match(await chatLine(app, "/name Lagos notes", { sessionId: run.sessionId }), /called Lagos notes now/);
  assert.equal(app.store.conversations.titleOf(run.sessionId), "Lagos notes");
});

test("/commands lists every command a surface can use", async (t) => {
  const { app } = await fixture(t);
  const text = (await windowLine(app, "/commands")).text;
  for (const name of ["/sethome", "/agents", "/title", "/help", "/stop"]) assert.ok(text.includes(name), name);
  const chat = await chatLine(app, "/commands");
  assert.ok(chat.includes("/agents") && chat.includes("/title"), chat);
  assert.ok(!chat.includes("/lockdown"), "a chat is not offered what it cannot send");
});

test("/sethome also takes the paired accounts the owner marked as their own under Commands from your own chat", async (t) => {
  const { app, owner } = await fixture(t);
  const chat = await standIn(app);
  app.store.save("settings", owner, "chat-owner-commands", { on: false, accounts: [{ channel: "telegram", sender: "owner-9" }] });
  await chat.say("owner-9", "/sethome");
  assert.match(chat.sent.at(-1).text, /This chat is home now/, "named as the owner's own, even with running commands off");
  assert.deepEqual(resolveHome(app.store, owner, "home", "home"), { channel: "telegram", chatId: "dm-owner-9" });
});
