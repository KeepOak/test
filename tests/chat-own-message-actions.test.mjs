/**
 * CHAT-023: Branch edits or deletes an earlier message only when it has its own record of sending
 * that exact message to that exact chat. Somebody else's message id is refused before the chat app is asked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("CHAT-023: an own sent message is edited once recorded; an unknown id is refused untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-own-messages-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const asked = [];
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send() { return "m-41"; },
    async edit(chatId, messageId, text) { asked.push(["edit", chatId, messageId, text]); },
    async deleteMessage(chatId, messageId) { asked.push(["delete", chatId, messageId]); } }, { activation: "always", pairing: true, allowlist: ["owner"] });
  await app.channels.deliver("chat", "7", "The meeting is at 3.");
  const run = app.store.createRun(app.runtime.owner, "fix my message");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const context = app.runtime.context({ runId: run.id, permissions: app.registry.permissions() });
  const listed = await app.registry.execute("channels.own_messages", { channel: "chat", chatId: "7" }, context);
  assert.equal(listed.messages[0].messageId, "m-41");
  await assert.rejects(app.registry.execute("channels.delete_message", { channel: "chat", chatId: "7", messageId: "someone-else" }, context), /no retained record/);
  await assert.rejects(app.registry.execute("channels.delete_message", { channel: "chat", chatId: "8", messageId: "m-41" }, context), /no retained record/);
  assert.deepEqual(asked, []);
  const edited = await app.channels.actOnOwnMessage({ channel: "chat", chatId: "7", messageId: "m-41" }, "edit", context, "The meeting is at 4.");
  assert.equal(edited.confirmed, true);
  assert.deepEqual(asked, [["edit", "7", "m-41", "The meeting is at 4."]]);
  assert.equal(app.channels.ownMessages({ channel: "chat", chatId: "7" }).messages[0].text, "The meeting is at 4.");
});
