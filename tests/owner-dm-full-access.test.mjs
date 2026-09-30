/**
 * owner-dm-full: the owner's own verified direct chat (an account they named as theirs, one to one, on an app whose
 * servers vouch for the sender) is the owner, so its task runs as a task the owner starts in the window: every
 * permission, the window's Access level, and no chat-only refusals (OpenClaw's "main" session). A group, another
 * person, Lockdown, or the switch turned off keeps the chat's short list. The chat app is a stand-in of kind
 * "telegram" and the model is scripted; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveOwnerCommands } from "../dist/channels/owner-commands.js";
import { chatSafePermissions, saveChatPermissionSettings } from "../dist/channels/chat-permissions.js";
import { saveConversationModeSettings, readConversationMode } from "../dist/conversation-mode.js";
import { runOrigin, startedFromChat } from "../dist/key-context.js";
import { setLockdown } from "../dist/lockdown.js";

const OWNER = "5660235788", FRIEND = "friend-2";
const powers = ["files.write", "shell.execute", "settings.write"];

async function fixture(t, tool = "shell.execute", mode = "full", script = null) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-dm-full-"));
  const ran = [], sent = [];
  // Calls the stand-in command tool once, then answers.
  const provider = { name: "scripted", complete: async (request) => script ? script(request) :
    request.messages.at(-1)?.role === "tool" ? { content: "Done.", toolCalls: [] }
      : { content: "", toolCalls: [{ id: `t${ran.length}-${Date.now()}`, name: tool,
        arguments: tool === "shell.execute" ? JSON.stringify({ executable: "node", args: ["-p", "1+1"] }) : "{}" }] } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  if (!app.registry.names().includes("shell.execute"))
    app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in", group: "core",
      parameters: z.object({ executable: z.string(), args: z.array(z.string()) }).strict(), execute: async () => { ran.push(1); return { ran: true }; } });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { ...app.channels.liveTiming, progressAfterMs: 60_000 };
  await app.channels.attach({ id: "tg", kind: "telegram", botName: () => "bot", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); },
    async sendButtons(chatId, text, buttons) { sent.push({ chatId, text, buttons }); return String(sent.length); } },
  { activation: "always", pairing: true, allowlist: [OWNER, FRIEND] });
  t.after(() => app.channels.detachAll());
  saveOwnerCommands(app.store, app.runtime.owner, { on: false, accounts: [{ channel: "tg", sender: OWNER }] });
  // The window's Access level for a new conversation (Full access unless a test says otherwise).
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: mode });
  let n = 0;
  const say = async (senderId, chatKind = "direct", text = "run it") => {
    const before = new Set(app.store.runs(app.runtime.owner).map((r) => r.id));
    await app.channels.handle({ channel: "tg", chatId: chatKind === "direct" ? senderId : "group-1", chatKind, senderId,
      senderName: senderId, chatTitle: "Group", text, addressed: true, messageId: `m${++n}` });
    const run = app.store.runs(app.runtime.owner).find((r) => !before.has(r.id));
    assert.ok(run, "the message started a task");
    const given = app.store.events(run.id).find((e) => e.kind === "run.started").data.permissions;
    return { run: app.store.run(run.id), given, origin: runOrigin(app.store, run.id).source,
      fromChat: startedFromChat({ runId: run.id }, app.store) };
  };
  return { app, say, ran, sent };
}

const shortList = (given) => given.every((p) => chatSafePermissions.includes(p));

test("the owner's verified Telegram DM runs with the owner's full access", async (t) => {
  const { app, say, ran } = await fixture(t);
  const { run, given, origin, fromChat } = await say(OWNER);
  for (const power of powers) assert.ok(given.includes(power), `${power} was given`);
  assert.equal(origin, "owner", "the task counts as the owner's own");
  assert.equal(fromChat, false, "no chat-only refusals apply");
  assert.equal(readConversationMode(app.store, app.runtime.owner, run.sessionId)?.mode, "full", "the window's Access level");
  assert.equal(run.status, "completed", run.output);
  assert.equal(ran.length, 1, "the command ran without waiting, as it does on Full access in the window");
});

test("the same sender in a group, and another person's DM, keep the short list", async (t) => {
  const { say, ran } = await fixture(t);
  for (const [sender, kind] of [[OWNER, "group"], [FRIEND, "direct"]]) {
    const { given, origin, fromChat } = await say(sender, kind);
    assert.ok(shortList(given), `${sender} in a ${kind} chat got only the short list: ${given}`);
    assert.equal(origin, "channel");
    assert.equal(fromChat, true);
  }
  assert.equal(ran.length, 0, "no command ran");
});

test("Lockdown still holds the owner's own chat to the short list", async (t) => {
  const { app, say, ran } = await fixture(t);
  setLockdown(app.store, app.runtime.owner, { on: true });
  const { given, origin, fromChat } = await say(OWNER);
  assert.ok(shortList(given), `under Lockdown: ${given}`);
  assert.equal(origin, "channel");
  assert.equal(fromChat, true);
  assert.equal(ran.length, 0);
});

test("turning the switch off returns the short list, and an earlier task is no longer the owner's", async (t) => {
  const { app, say } = await fixture(t);
  const first = await say(OWNER);
  assert.equal(first.origin, "owner");
  assert.equal(app.channels.permissionSettings().ownerChats, true, "on by default");
  saveChatPermissionSettings(app.store, app.runtime.owner, { ownerChats: false });
  const { given, origin } = await say(OWNER);
  assert.ok(shortList(given), `switch off: ${given}`);
  assert.equal(origin, "channel");
  assert.equal(runOrigin(app.store, first.run.id).source, "channel", "checked afresh, not remembered");
});

test("a real owner-only tool (Branch's own settings) answers the owner's DM and refuses the owner's group", async (t) => {
  const { app, say } = await fixture(t, "settings.list");
  const outcome = (run) => app.store.events(run.id).find((e) => e.kind === "tool.completed" || e.kind === "tool.failed");
  const own = await say(OWNER);
  assert.equal(outcome(own.run)?.kind, "tool.completed", JSON.stringify(outcome(own.run)?.data));
  const group = await say(OWNER, "group");
  assert.equal(outcome(group.run)?.kind, "tool.failed", "a group is not the owner");
});

test("on Ask first, the owner answers the command's own Yes from that DM", async (t) => {
  const { app, say, ran, sent } = await fixture(t, "shell.execute", "ask");
  const { run } = await say(OWNER);
  assert.equal(run.status, "needs_input", "Ask first waits for a yes, as the window does");
  const yes = sent.flatMap((one) => one.buttons ?? []).find((button) => button.value.startsWith("y:"));
  assert.ok(yes, "the DM is offered the Yes (owner commands are off)");
  await app.channels.handle({ channel: "tg", chatId: OWNER, chatKind: "direct", senderId: OWNER, senderName: OWNER,
    text: yes.value, addressed: true, messageId: "yes-1" });
  assert.equal(ran.length, 1, "the owner's Yes from the DM ran it");
});

const command = (id) => ({ content: "", toolCalls: [{ id, name: "shell.execute", arguments: JSON.stringify({ executable: "node", args: ["-p", "1+1"] }) }] });

test("the self-development worktree's Full Access reaches a task from the owner's DM, and not a friend's", async (t) => {
  const seen = [];
  const { app, say } = await fixture(t, "demo.probe");
  app.registry.register({ name: "demo.probe", permission: "files.read", description: "stand-in", group: "core",
    parameters: z.object({}).strict(), execute: async (_input, context) => { seen.push(app.runtime.ownerFullAccessFor(context, true)); return {}; } });
  await say(OWNER);
  assert.match(String(seen.at(-1)), /Full Access in conversation/, "the owner's Full Access, as the window's would be");
  await say(FRIEND);
  assert.equal(seen.at(-1), null, "a friend's chat is never the owner's Full Access");
});

test("turning the switch off ends full access for a running DM task at its next step", async (t) => {
  let app, turn = 0;
  const script = async (request) => {
    turn++;
    if (turn === 1) return command("first");
    if (turn === 2) { app.channels.setPermissionSettings({ ownerChats: false }); return command("second"); }
    return { content: "Done.", toolCalls: [] };
  };
  const made = await fixture(t, "shell.execute", "full", script);
  app = made.app;
  const { run } = await made.say(OWNER);
  assert.equal(made.ran.length, 1, "the first command ran on Full access; the one after the switch went off did not");
  assert.equal(run.status, "needs_input", "it waits for the owner's yes in the window, as a chat's task does");
  assert.equal(runOrigin(app.store, run.id).source, "channel");
});
