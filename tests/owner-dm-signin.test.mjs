/**
 * owner-dm-signin: the owner's own verified direct chat (an account they named as their own, on an app whose servers
 * vouch for the sender) is the owner, so the default Trunk (and any Trunk the chat is routed to) may answer it through
 * the owner's sign-in. A paired friend, a group, an app that cannot vouch for its senders, or a chat with no router to
 * ask is still refused, and the chat is told why in a line or two instead of the bare status.
 * The sign-in is a stand-in program; the chat app is a stand-in of kind "telegram". Nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";
import { saveOnboarding } from "../dist/onboarding.js";
import { ownerCommands, saveOwnerCommands } from "../dist/channels/owner-commands.js";
import { chatThread } from "../dist/channels/threads.js";
import { chatFailureLine, chatSignInRefusal, reasonAtMost } from "../dist/channels/failure-reason.js";
import { trunkSignInRefusal } from "../dist/accounts/context.js";
import { primaryAccount } from "../dist/accounts/settings.js";
import { setupTrunk } from "./trunks-helpers.mjs";

const OWNER = "5660235788", FRIEND = "friend-2";

async function fixture(t, { kind = "telegram", named = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-dm-signin-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // The owner's model is a sign-in: an installed program signed in to the owner's own account (a stand-in, as in
  // accounts-trunks.test.mjs; the real program is never started).
  const service = accountsServiceFor(app.runtime.models);
  service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  await fakeClaudeAccounts(t, service);
  delete service.deps.policy;
  const seen = [];
  const spawn = async () => { seen.push(1); return { code: 0, stdout: JSON.stringify({ result: "from the sign-in" }), stderr: "" }; };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  service.deps.spawnAgent = spawn;
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  app.trunks.setMode("trunks", { mode: "on" });
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  setupTrunk(app, { name: "TK" });
  await app.trunks.introduced();
  const home = app.trunks.ensureDefault();
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "tg", kind, botName: () => "bot", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } },
  { activation: "always", pairing: true, allowlist: [OWNER, FRIEND] });
  t.after(() => app.channels.detachAll());
  // Marked as the owner's own under Settings › Chat apps › Commands from your own chat, with the switch left off.
  if (named) saveOwnerCommands(app.store, app.runtime.owner, { on: false, accounts: [{ channel: "tg", sender: OWNER }] });
  let n = 0;
  const say = async (senderId, text, chatKind = "direct", extra = {}) => {
    const chatId = chatKind === "direct" ? senderId : "group-1";
    const before = seen.length, earlier = new Set(app.store.runs(app.runtime.owner).map((r) => r.id));
    await app.channels.handle({ channel: "tg", chatId, chatKind, senderId, senderName: senderId, chatTitle: "Group",
      text, addressed: true, messageId: `m${++n}`, ...extra });
    const thread = chatThread(app.store, app.runtime.owner, "tg", chatId);
    // The task this message started: the one run in the chat's conversation that was not there before it.
    const run = app.store.runs(app.runtime.owner).find((r) => r.sessionId === thread?.sessionId && !earlier.has(r.id));
    return { run, reply: sent.at(-1)?.text ?? "", programRan: seen.length > before, thread };
  };
  return { app, say, home };
}

test("the owner's own direct chat on the default Trunk answers through the owner's sign-in", async (t) => {
  const { app, say, home } = await fixture(t);
  const { run, reply, programRan, thread } = await say(OWNER, "Hola");
  assert.equal(thread.trunkId, home.id, "a loose chat went to the default Trunk");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "trunk.turn"), "it was the Trunk's turn");
  assert.equal(run.status, "completed", run.output);
  assert.equal(programRan, true, "the owner's sign-in answered");
  assert.match(reply, /from the sign-in/);
});

test("the owner's message fetched after a restart is still the owner's (the app vouched for it), so it answers too", async (t) => {
  const { say } = await fixture(t);
  const { run, programRan } = await say(OWNER, "Hola", "direct", { caughtUp: true });
  assert.equal(run.status, "completed", run.output);
  assert.equal(programRan, true);
});

test("a conversation with a pinned helper model: the owner's DM still reaches the sign-in, a friend's still does not", async (t) => {
  for (const [who, allowed] of [[OWNER, true], [FRIEND, false]]) {
    await t.test(who === OWNER ? "the owner" : "a paired friend", async (t) => {
      const { app, say } = await fixture(t);
      const first = await say(who, "Hola");
      // The conversation's helper model and account are pinned (src/delegation.ts keepHelperRoute), so the next turn picks
      // its connection before anything else: before the chat's message was ever written down.
      app.store.save("settings", app.runtime.owner, `helper-route:${first.thread.sessionId}`,
        { model: "cli-claude-code", accountRef: { pool: "cli-claude-code", account: primaryAccount } });
      const { run, programRan } = await say(who, "Otra vez");
      assert.equal(run.sessionId, first.thread.sessionId);
      assert.ok(app.store.events(run.id).some((e) => e.kind === "channel.inbound"), "the chat's message is written down first");
      if (allowed) assert.ok(app.store.events(run.id).some((e) => e.kind === "helper.selected"), "the pinned route was taken");
      assert.equal(run.status, allowed ? "completed" : "failed", run.output);
      assert.equal(programRan, allowed);
      if (!allowed) assert.match(run.output, /only for your own work/);
    });
  }
});

test("a Trunk the owner's own chat is bound to answers through the sign-in too", async (t) => {
  const { app, say } = await fixture(t);
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  app.trunks.edit(ed.id, { reach: { channels: ["tg"], commands: false } });
  app.channels.bindingFor = (_channel, chatId) => (chatId === OWNER ? ed.id : null);
  const { run, programRan, thread } = await say(OWNER, "Hola");
  assert.equal(thread.trunkId, ed.id);
  assert.equal(run.status, "completed", run.output);
  assert.equal(programRan, true);
});

test("a paired friend, a group, or the owner's account not named as theirs is still refused, and told why", async (t) => {
  await t.test("a paired friend in a direct chat", async (t) => {
    const { say } = await fixture(t);
    const { run, reply, programRan } = await say(FRIEND, "Hola");
    assert.equal(run.status, "failed");
    assert.match(run.output, /only for your own work/);
    assert.equal(programRan, false, "the sign-in was never started");
    assert.equal(reply, `I could not answer that. ${chatSignInRefusal.direct}`);
    assert.doesNotMatch(reply, /\(failed\)/, "never the bare status");
  });
  await t.test("the owner's own account, in a group", async (t) => {
    const { say } = await fixture(t);
    const { run, reply, programRan } = await say(OWNER, "Hola", "group");
    assert.equal(run.status, "failed");
    assert.match(run.output, /only for your own work/);
    assert.equal(programRan, false);
    assert.equal(reply, `I could not answer that. ${chatSignInRefusal.group}`);
  });
  await t.test("the owner's paired account, not named as theirs (fails closed)", async (t) => {
    const { say } = await fixture(t, { named: false });
    const { run, reply, programRan } = await say(OWNER, "Hola");
    assert.equal(run.status, "failed");
    assert.match(run.output, /only for your own work/);
    assert.equal(programRan, false, "pairing alone is not ownership");
    assert.match(reply, /Settings › Chat apps › Commands from your own chat/);
  });
  await t.test("a named account on an app that cannot vouch for its senders", async (t) => {
    const { say } = await fixture(t, { kind: "email" });
    const { run, programRan } = await say(OWNER, "Hola");
    assert.equal(run.status, "failed");
    assert.match(run.output, /only for your own work/);
    assert.equal(programRan, false);
  });
  await t.test("with no router to ask, a chat is never the owner", async (t) => {
    const { app, say } = await fixture(t);
    app.runtime.ownerChatRun = null;
    const { run, programRan } = await say(OWNER, "Hola");
    assert.equal(run.status, "failed");
    assert.match(run.output, /only for your own work/);
    assert.equal(programRan, false);
  });
});

test("the chat's failure line carries the task's own reason, scrubbed and short", () => {
  const same = (text) => text;
  assert.equal(chatFailureLine("failed", "Plan limit reached until 09:00 UTC.", "direct", same),
    "I could not finish that: Plan limit reached until 09:00 UTC.");
  assert.equal(chatFailureLine("failed", "", "direct", same), "I could not finish that (failed).");
  assert.equal(chatFailureLine("failed", trunkSignInRefusal, "group", same), `I could not answer that. ${chatSignInRefusal.group}`);
  const long = chatFailureLine("failed", `${"word ".repeat(200)}end.`, "direct", same);
  assert.ok(long.length <= "I could not finish that: ".length + reasonAtMost, long);
  assert.match(long, /…$/);
  assert.equal(chatFailureLine("failed", "One. Two. Three.", "direct", same), "I could not finish that: One. Two.", "two sentences at most");
  const scrubbed = chatFailureLine("failed", "Bad key sk-live-abc123.", "direct", (text) => text.replace(/sk-[\w-]+/g, "[hidden]"));
  assert.equal(scrubbed, "I could not finish that: Bad key [hidden].");
});

test("approving a pairing in the window may name the first owner account, once, and only on an app that vouches", async (t) => {
  const { app, say } = await fixture(t, { named: false });
  const owner = app.runtime.owner;
  const codeFrom = async (senderId) => {
    const { reply } = await say(senderId, "hi");
    return /code (\d{6})/.exec(reply)[1];
  };
  const first = app.channels.approve(owner, { code: await codeFrom("new-owner") }, { firstOwner: true });
  assert.equal(first.madeOwner, true);
  assert.deepEqual(ownerCommands(app.store, owner).accounts, [{ channel: "tg", sender: "new-owner" }]);
  assert.equal(ownerCommands(app.store, owner).on, false, "the commands switch is left as it was");
  const { run, programRan } = await say("new-owner", "Hola");
  assert.equal(run.status, "completed", run.output);
  assert.equal(programRan, true, "the named account now answers through the owner's sign-in");
  // Once an owner exists, approving another pairing only lets that person talk; it never adds or replaces an owner.
  const second = app.channels.approve(owner, { code: await codeFrom("someone-else") }, { firstOwner: true });
  assert.equal(second.madeOwner, false);
  assert.deepEqual(ownerCommands(app.store, owner).accounts, [{ channel: "tg", sender: "new-owner" }]);
  const plain = app.channels.approve(owner, { code: await codeFrom("third") });
  assert.equal(plain.madeOwner, false);
});

test("an app that cannot vouch for its senders never gets a first owner from a pairing", async (t) => {
  const { app, say } = await fixture(t, { kind: "email", named: false });
  const { reply } = await say("mail-person", "hi");
  const made = app.channels.approve(app.runtime.owner, { code: /code (\d{6})/.exec(reply)[1] }, { firstOwner: true });
  assert.equal(made.madeOwner, false);
  assert.deepEqual(ownerCommands(app.store, app.runtime.owner).accounts, []);
});
