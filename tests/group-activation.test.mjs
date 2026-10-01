// CHAT-123: a group can be set to answer every message ("always") or only when Branch is named ("mention"), per exact
// group; an unnamed message in a mention group starts nothing. A setting names a configured connection, once.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveGroupResponses, groupResponses } from "../dist/channels/group-responses.js";

let next = 1;
const message = (text, extra = {}) => ({ channel: "chat", chatId: "team", chatKind: "group", senderId: "owner", senderName: "Sam",
  text, addressed: false, messageId: `m${next++}`, ...extra });

test("an exact group set to always answers without being named; others keep the connection's mention rule", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-group-activation-"));
  let asked = 0;
  const provider = { name: "scripted", async complete() { asked++; return { content: "hi", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {}, async send() { return "1"; } };
  await app.channels.attach(adapter, { activation: "mention", pairing: true, allowlist: ["owner"], groupAllowlist: ["team", "other"] });
  assert.equal(await app.channels.handle(message("hello")), "ignored", "mention is the connection's rule");
  saveGroupResponses(app.store, app.runtime.owner, { groups: [{ connection: "chat", chatId: "team", activation: "always" }] });
  assert.equal(await app.channels.handle(message("hello again")), "replied");
  assert.equal(await app.channels.handle(message("hello", { chatId: "other" })), "ignored", "only that exact group");
  assert.ok(asked >= 1);
  assert.throws(() => saveGroupResponses(app.store, app.runtime.owner, { groups: [{ connection: "chat", chatId: "team", autoThread: true }] },
    (_id, thread) => !thread), /threads require Discord/);
  assert.throws(() => saveGroupResponses(app.store, app.runtime.owner, { groups: [{ connection: "chat", chatId: "team" }, { connection: "chat", chatId: "team" }] }), /once/);
  assert.equal(groupResponses(app.store, app.runtime.owner).groups[0].activation, "always");
});
