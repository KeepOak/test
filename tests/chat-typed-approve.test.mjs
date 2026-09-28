/**
 * Typed /approve and /deny (Hermes Agent and OpenClaw both have them): for apps without buttons, and for anyone who
 * prefers typing. They answer what a typed y or n answers, the question this chat was shown; /approve always is the
 * standing yes a chat is never given. Scripted model and a stand-in chat app; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { readApprovalAnswer, approvalFallbackNote } from "../dist/channels/router.js";

test("the typed forms read as the letters, with a bot's @name, and nothing else is one", () => {
  assert.deepEqual(readApprovalAnswer("/approve"), readApprovalAnswer("y"));
  assert.deepEqual(readApprovalAnswer("/approve@BranchBot"), readApprovalAnswer("y"));
  assert.deepEqual(readApprovalAnswer("/Approve once"), readApprovalAnswer("y"));
  assert.deepEqual(readApprovalAnswer("/approve always"), readApprovalAnswer("a"));
  assert.deepEqual(readApprovalAnswer("/deny"), readApprovalAnswer("n"));
  for (const other of ["/approve everything", "/approved", "please /approve", "/deny it all"]) assert.equal(readApprovalAnswer(other), null, other);
  assert.match(approvalFallbackNote, /\/approve/);
});

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "chat-typed-approve-"));
  let turn = 0;
  const provider = { name: "scripted", complete: async (request) => {
    turn++;
    if (request.messages.at(-1)?.role === "tool") return { content: "Done.", toolCalls: [] };
    return { content: "", toolCalls: [{ id: `a${turn}`, name: "files.read", arguments: JSON.stringify({ path: "README.md" }) }] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sent = [];
  app.channels.mergeWindowMs = 0;
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { sent.push(text); return String(sent.length); } }, { activation: "always", pairing: true, allowlist: ["owner"] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.read", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  let serial = 0;
  const say = (text) => app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: `m${++serial}` });
  return { app, sent, say };
}

test("/approve answers the question the chat was shown", async (t) => {
  const { app, sent, say } = await world(t);
  await say("read the readme");
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1);
  assert.ok(sent.some((text) => text.includes("/approve")), "a chat without buttons is told it can type /approve");
  await say("/approve");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 0, "answered");
});

test("/deny refuses the question the chat was shown, and nothing runs", async (t) => {
  const { app, say } = await world(t);
  await say("read the readme");
  const run = app.store.runs(app.runtime.owner)[0];
  await say("/deny");
  assert.equal(app.runtime.waitingApprovals(run.sessionId).length, 0, "answered");
  assert.equal(app.store.events(run.id).some((event) => event.kind === "tool.completed" && event.data.name === "files.read"), false, "nothing was read");
});

test("/approve always is the standing yes a chat never gives: it is refused in words and the question still waits", async (t) => {
  const { app, sent, say } = await world(t);
  await say("read the readme");
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  await say("/approve always");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1);
  assert.match(sent.at(-1), /window/i);
});
