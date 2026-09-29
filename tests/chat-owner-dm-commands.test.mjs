/**
 * CHAT-185: the window's commands from the owner's own direct chat (/goal, /bg, /memory, /skills, /health, /lockdown,
 * /queue, /busy, and the looking half of /loop, /heartbeat, /suggestions, /blueprint). A stand-in chat app of kind
 * "telegram" is attached to the real router; the model is scripted. Nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveOwnerAccounts } from "../dist/reach/platform.js";
import { lockdownState } from "../dist/lockdown.js";
import { ownerDmCommand, ownerDmRefusal } from "../dist/channels/owner-dm-commands.js";

async function fixture(t, kind = "telegram") {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-dm-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "tg", kind, botName: () => "bot", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } }, { pairing: true, allowlist: ["owner-1", "friend-2"] });
  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "tg", sender: "owner-1" }]);
  let n = 0;
  const say = (senderId, text, extra = {}) => app.channels.handle({ channel: "tg", chatId: `dm-${senderId}`, chatKind: "direct", senderId,
    senderName: senderId, text, addressed: true, messageId: `m${++n}`, ...extra });
  return { app, provider, sent, say };
}
const last = (sent) => sent.at(-1)?.text ?? "";

test("the lines it reads, and the refusals it gives before running anything", () => {
  assert.deepEqual(ownerDmCommand("/goal ship the report --max 3"), { name: "goal", argument: "ship the report --max 3" });
  assert.deepEqual(ownerDmCommand("/background tidy up"), { name: "bg", argument: "tidy up" }, "aliases count");
  assert.equal(ownerDmCommand("/preset strict"), null, "never the owner's settings");
  assert.equal(ownerDmCommand("/status"), null, "the chat's own commands stay the chat's");
  assert.equal(ownerDmCommand("goal x"), null);
});

test("from the owner's own direct chat: memory, skills, Lockdown on; a friend's same line is an ordinary message", async (t) => {
  const { app, provider, sent, say } = await fixture(t);
  app.store.save("memory", app.runtime.owner, "fact-1", { text: "The owner's sister is called Ada." });
  await say("friend-2", "/memory");
  assert.ok(provider.requests.length >= 1, "a paired friend's /memory went to the model as words");
  assert.doesNotMatch(sent.map((s) => s.text).join("\n"), /sister is called Ada/, "and the owner's memory was not read out to them");

  await say("owner-1", "/memory");
  assert.match(last(sent), /sister is called Ada/);
  await say("owner-1", "/skills");
  assert.match(last(sent), /skill/i);
  await say("owner-1", "/lockdown off");
  assert.match(last(sent), /only be switched off in the app on this computer/);
  const quiet = sent.length;
  await say("owner-1", "/lockdown on");
  assert.equal(lockdownState(app.store, app.runtime.owner).on, true);
  // Under Lockdown nothing goes out to any chat, its own confirmation included (the router's outbound rule).
  await say("owner-1", "/memory");
  assert.equal(sent.length, quiet, "nothing was sent while Lockdown is on");
  assert.equal(ownerDmRefusal(app.store, app.runtime.owner, false, "memory", ""), "Lockdown or the App lock is on, so only /lockdown is taken from a chat.");
  await say("owner-1", "/lockdown off");
  assert.equal(lockdownState(app.store, app.runtime.owner).on, true, "never switched off from a chat");
});

test("nothing that keeps running is made from a chat; looking is fine", async (t) => {
  const { sent, say } = await fixture(t);
  await say("owner-1", "/loop every 10m check the build");
  assert.match(last(sent), /Nothing that keeps running is set up from a chat/);
  await say("owner-1", "/blueprint morning-digest topic=news");
  assert.match(last(sent), /Nothing that keeps running/);
  await say("owner-1", "/blueprint");
  assert.doesNotMatch(last(sent), /Nothing that keeps running|I do not know/);
  await say("owner-1", "/sessions 1234abcd");
  assert.match(last(sent), /Open an earlier conversation in the Branch app/);
});

test("/bg from the owner's chat runs as that chat's task, with the chat's permissions, never as the owner", async (t) => {
  const { app, sent, say } = await fixture(t);
  const before = new Set(app.store.runs(app.runtime.owner).map((run) => run.id));
  await say("owner-1", "/bg summarise my notes");
  assert.match(last(sent), /separate conversation|background/i, last(sent));
  const started = await (async () => { for (let i = 0; i < 100; i++) { const run = app.store.runs(app.runtime.owner).find((r) => !before.has(r.id)); if (run) return run; await delay(20); } })();
  assert.ok(started, "a background task started");
  const origin = app.store.events(started.id).find((event) => event.kind === "run.started").data;
  assert.equal(origin.source, "channel");
  assert.ok(!origin.permissions.includes("shell.execute"), "the chat's short list, not everything");
});

test("/goal from the owner's chat: every round is the chat's task", async (t) => {
  const { app, sent, say } = await fixture(t);
  const before = new Set(app.store.runs(app.runtime.owner).map((run) => run.id));
  await say("owner-1", "/goal write a haiku --max 1");
  assert.match(last(sent), /Goal/, last(sent));
  const round = app.store.runs(app.runtime.owner).find((r) => !before.has(r.id) && r.prompt.includes("haiku"));
  assert.ok(round, "a round started");
  const origin = app.store.events(round.id).find((event) => event.kind === "run.started").data;
  assert.equal(origin.source, "channel");
  assert.ok(!origin.permissions.includes("shell.execute"));
});

test("only a direct chat, only a vouched app, never a message fetched after a restart", async (t) => {
  const { app, sent, say } = await fixture(t);
  app.store.save("memory", app.runtime.owner, "fact-1", { text: "Secret fact" });
  await say("owner-1", "/memory", { chatKind: "group", chatId: "g-1", chatTitle: "Family" });
  assert.doesNotMatch(sent.map((s) => s.text).join("\n"), /Secret fact/, "not in a group");
  const count = sent.length;
  assert.equal(await say("owner-1", "/lockdown on", { caughtUp: true }), "ignored");
  assert.equal(sent.length, count);
  assert.equal(lockdownState(app.store, app.runtime.owner).on, false);

  const mail = await fixture(t, "email");
  mail.app.store.save("memory", mail.app.runtime.owner, "fact-1", { text: "Secret fact" });
  await mail.say("owner-1", "/memory");
  assert.doesNotMatch(mail.sent.map((s) => s.text).join("\n"), /Secret fact/, "an email sender can be made up");
  assert.equal(ownerDmRefusal(app.store, app.runtime.owner, true, "memory", ""), "Lockdown or the App lock is on, so only /lockdown is taken from a chat.", "the App lock holds too");
});
