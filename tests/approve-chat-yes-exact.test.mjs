// PR #289, second review (Mac mini): with an answer that names no request refused while several wait, a chat's plain "y"
// must still answer the one question the chat vetted (chatMayApprove on waiting[0]), not fall through as an ordinary
// message that names the other request. Scripted model, fake chat app; the probe is the Mac mini's.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";

test("a chat's plain y answers the question it vetted while another waits in the same conversation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chat-yes-exact-"));
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
  const message = (text, id) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id });
  await app.channels.handle(message("read the readme", "m1"));
  const run = app.store.runs(app.runtime.owner)[0];
  // A second request waiting in the same conversation, as a sub-task or a second call would leave it.
  app.runtime.approvals.ask({ runId: "run-other", sessionId: run.sessionId, tool: "network.site", target: "example.com", label: "network.site example.com",
    question: "May it open example.com?", source: "owner", remember: "session", askedAt: new Date().toISOString(), fingerprint: "e".repeat(32) });
  assert.deepEqual(app.runtime.waitingApprovals(run.sessionId).map((q) => q.tool).sort(), ["files.read", "network.site"]);
  const turnsBefore = turn, sentBefore = sent.length;
  await app.channels.handle(message("y", "m2"));
  const left = app.runtime.waitingApprovals(run.sessionId).map((q) => q.tool);
  assert.deepEqual(left, ["network.site"], "the chat's own question is answered; the other still waits");
  assert.ok(!sent.slice(sentBefore).some((text) => /network\.site/.test(text)), "the chat is never told about the other request");
  assert.ok(!sent.slice(sentBefore).some((text) => /^Before I go ahead/.test(text)), "the y is not handed on as an ordinary message");
  assert.ok(turn >= turnsBefore, "sanity");
});

// PR #289 (Legion): the chat is shown the NEWEST waiting question (askInChat), so a plain "y" must answer that one even when
// an older request from elsewhere waits first in the same conversation; it must never land on the older one.
test("a chat's plain y answers the question the chat was shown, even when an older request waits first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chat-yes-shown-"));
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
  const message = (text, id) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id });
  // The conversation exists first (a message that is answered without asking), then an older request from elsewhere waits.
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  app.runtime.approvals.ask({ runId: "run-older", sessionId, tool: "network.site", target: "example.com", label: "network.site example.com",
    question: "May it open example.com?", source: "owner", remember: "session", askedAt: new Date(Date.now() - 60000).toISOString(), fingerprint: "e".repeat(32) });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.read", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  await app.channels.handle(message("read the readme", "m1"));
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["network.site", "files.read"], "the older request waits first");
  await app.channels.handle(message("y", "m2"));
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["network.site"], "the y answered the question the chat was shown");
});
