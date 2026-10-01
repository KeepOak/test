/**
 * UP-CHAT-002: an edited message never carries out a command. Editing `/bg x` used to start a second background task
 * (its answer swallowed by the ledger's repeated key), and editing an old message into `/new` reset the thread. A
 * stand-in chat app of kind "telegram" is attached to the real router; the model is scripted. Nothing leaves this computer.
 *
 * Mutation notes (each turns this file red):
 * - router.ts handle: drop the `editedCommandShaped` check -> "no second background task" and "/new" tests fail.
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
import { editedCommandShaped } from "../dist/channels/router.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-edited-cmd-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "tg", kind: "telegram", botName: () => "bot", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } }, { pairing: true, allowlist: ["owner-1"] });
  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "tg", sender: "owner-1" }]);
  const say = (text, messageId, extra = {}) => app.channels.handle({ channel: "tg", chatId: "dm-owner-1", chatKind: "direct", senderId: "owner-1",
    senderName: "Owner", text, addressed: true, messageId, ...extra });
  return { app, provider, sent, say };
}
const settle = async (check) => { for (let i = 0; i < 100 && !check(); i++) await delay(20); };

test("what reads as a command, an answer or a button", () => {
  for (const text of ["/bg tidy up", "/new", "/stop@BranchBot", "/platform pause", "/start", "y", "N", "a", "y:8f3a", "n:8f3a:0123456789ab", "m:abc:1", "br:t:x"])
    assert.equal(editedCommandShaped(text), true, text);
  for (const text of ["tidy the downloads folder", "/usr/local/bin is on the path", "yes please", "a cat sat", "/"])
    assert.equal(editedCommandShaped(text), false, text);
});

test("editing /bg from the owner's own chat starts no second background task", async (t) => {
  const { app, say } = await fixture(t);
  const runs = () => app.store.runs(app.runtime.owner).length;
  await say("/bg summarise my notes", "m1");
  await settle(() => runs() >= 1);
  const before = runs();
  assert.ok(before >= 1, "the first /bg started a task");
  assert.equal(await say("/bg summarise my notes again", "m1", { edited: true }), "ignored");
  await delay(100);
  assert.equal(runs(), before, "no second background task");
});

test("editing an old message into /new leaves the thread where it was", async (t) => {
  const { app, say } = await fixture(t);
  await say("hello there", "m1");
  const thread = () => app.store.get("settings", app.runtime.owner, "channel-session:tg:dm-owner-1")?.data?.sessionId;
  await settle(() => thread());
  const before = thread();
  assert.ok(before, "the chat has a conversation");
  assert.equal(await say("/new", "m1", { edited: true }), "ignored");
  assert.equal(thread(), before, "the conversation was not reset");
});

test("an edited y answers nothing, and edited words are still answered as the latest version", async (t) => {
  const { provider, say } = await fixture(t);
  assert.equal(await say("y", "m1", { edited: true }), "ignored");
  const asked = provider.requests.length;
  assert.notEqual(await say("tidy the downloads folder", "m2", { edited: true }), "ignored");
  assert.ok(provider.requests.length > asked, "the edited words went to the model");
});
