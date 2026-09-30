/* CHAT-210: /status and /whoami answered at once from inside an ordinary direct message, when the chat app vouches that
   the words were typed by the person (src/channels/inline-shortcuts.ts); the rest of the message goes on as the task. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { inlineShortcuts } from "../dist/channels/inline-shortcuts.js";

const authored = (text, spans = []) => ({ text, protected: spans });

test("only exact shortcuts outside code, quotes and links are picked, and only they are taken out", () => {
  assert.deepEqual(inlineShortcuts(authored("Please continue /status with the report"), "Please continue /status with the report"),
    { names: ["status"], remainder: "Please continue  with the report" });
  assert.deepEqual(inlineShortcuts(authored("/whoami\n/status /status"), "/whoami\n/status /status")?.names, ["whoami", "status"]);
  for (const text of ["run `/status` please", "> /status", "\"/status\"", "see https://x.test/status now", "/status2", "/stop now", "/status@bot"])
    assert.equal(inlineShortcuts(authored(text), text), null, text);
  assert.equal(inlineShortcuts(authored("a /status"), "different words"), null, "the vouched text must be the message");
  assert.equal(inlineShortcuts(authored("a /status", [{ offset: 2, length: 7 }]), "a /status"), null, "a code span the app marked stays text");
  assert.equal(inlineShortcuts(authored("a /status", [{ offset: 5, length: 99 }]), "a /status"), null, "a broken span refuses the fast path");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-inline-shortcuts-"));
  const prompts = [];
  const provider = { name: "scripted", async complete(request) {
    prompts.push(String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
    return { content: "On it.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.setSwitches({ liveStatus: "off", commands: "on", steering: "on", splitting: "on", steps: "off" });
  const sent = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(sent.length); } };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  let id = 1;
  const message = (text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text, addressed: true, messageId: `m${id++}`, ...extra });
  return { app, sent, prompts, message };
}

test("a vouched direct message answers /status at once and sends only the rest of the words to the task", async (t) => {
  const f = await fixture(t);
  const text = "Please /status then summarise the notes";
  await f.app.channels.handle(f.message(text, { authoredCommandText: authored(text) }));
  assert.ok(f.sent.includes("Nothing is working right now."), "the shortcut was answered");
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /Please\s+then summarise the notes/);
  assert.doesNotMatch(f.prompts[0], /\/status/, "the shortcut never reached the model");
});

test("without the app vouching for the words, or in a group, a shortcut inside a message stays ordinary text", async (t) => {
  const f = await fixture(t);
  const text = "Please /status then summarise the notes";
  await f.app.channels.handle(f.message(text));
  await f.app.channels.handle(f.message(text, { chatKind: "group", chatId: "g1", authoredCommandText: authored(text) }));
  assert.ok(!f.sent.includes("Nothing is working right now."), "no fast answer");
  assert.match(f.prompts[0] ?? "", /\/status/);
});
