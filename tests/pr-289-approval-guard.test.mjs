/**
 * PR #289: a chat answering "y" to an approval.
 *
 * The bug: shownInChat was recorded before the outbound guard passed, and a bare "y" used a
 * fallback that approved an unshown request when the shown one was no longer waiting.
 *
 * The fix: (1) record shownInChat only after guard+send; (2) use fallback only when nothing
 * was ever shown; (3) if shown fingerprint no longer waits, re-show the waiting one; (4) on
 * restart (empty shownInChat), first bare "y" re-shows instead of answering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { staleButtonNote } from "../dist/channels/router.js";
const askAboutReads = [{ tool: "files.read", match: "*", applies: "any", decision: "ask", remember: "session" }];

async function fixture(t, { failing, noIds, onSend } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pr-289-"));
  let turn = 0;
  // Reads the file the message names (README.md unless it names SECRET.md), then says it is done.
  const provider = { name: "scripted", complete: async (request) => {
    turn++;
    if (request.messages.at(-1)?.role === "tool") return { content: "Done.", toolCalls: [] };
    const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const path = /SECRET\.md/.test(asked) ? "SECRET.md" : "README.md";
    return { content: "", toolCalls: [{ id: `a${turn}`, name: "files.read", arguments: JSON.stringify({ path }) }] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sent = [];
  app.channels.mergeWindowMs = 0;
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { if (failing?.(text)) throw new Error("the chat app is down"); sent.push(text); onSend?.(text); return noIds ? undefined : String(sent.length); } }, { activation: "always", pairing: true, allowlist: ["owner"] });
  const message = (text, id) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: id });
  return { app, sent, message };
}

test("(a) the shown question answered in the window, a different one waiting alone: y answers nothing and shows it", async (t) => {
  const { app, sent, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  const fp1 = "f" + "1".repeat(31), fp2 = "f" + "2".repeat(31);
  app.runtime.approvals.ask({ runId: "run-1", sessionId, tool: "files.read", target: "README.md",
    label: "files.read README.md", question: "May it read README.md?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: fp1 });
  await app.channels["askInChat"](message("", "m1"), sessionId, app.runtime.waitingApprovals(sessionId).find((q) => q.fingerprint === fp1), "", "ask:test-a");
  assert.ok(sent.some((text) => /README\.md/.test(text)), "the chat was shown README.md");
  // The owner answers it in the window; then a different request, one a chat may approve, waits alone.
  app.runtime.approve(sessionId, "allow", "session", fp1);
  app.runtime.approvals.ask({ runId: "run-2", sessionId, tool: "files.read", target: "SECRET.md",
    label: "files.read SECRET.md", question: "May it read SECRET.md?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: fp2 });
  const before = sent.length;
  await app.channels.handle(message("y", "m2"));
  const after = sent.slice(before);
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.target), ["SECRET.md"], "the unseen request is not approved");
  assert.ok(after.some((text) => /no longer waiting/.test(text)), "the chat is told its question no longer waits");
  assert.ok(after.some((text) => /SECRET\.md/.test(text)), "and is shown the one waiting now");
  // Now it has seen it, its next yes answers it.
  await app.channels.handle(message("y", "m3"));
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 0, "the question it was shown is answered");
});

test("(b) a question whose send failed was never shown, so a y does not answer it", async (t) => {
  const { app, sent, message } = await fixture(t, { failing: (text) => /SECRET\.md/.test(text) && !globalThis.__chatBack });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  app.runtime.approvals.ask({ runId: "run-1", sessionId, tool: "files.read", target: "SECRET.md",
    label: "files.read SECRET.md", question: "May it read SECRET.md?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: "f" + "3".repeat(31) });
  await app.channels["askInChat"](message("", "m1"), sessionId, app.runtime.waitingApprovals(sessionId)[0], "", "ask:test-b");
  assert.ok(!sent.some((text) => /SECRET\.md/.test(text)), "the question never reached the chat");
  t.after(() => { delete globalThis.__chatBack; });
  globalThis.__chatBack = true;
  await app.channels.handle(message("y", "m2"));
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.target), ["SECRET.md"], "a y about nothing it saw answers nothing");
  // The failed question stays in the delivery queue under its own key, and goes out when the chat app is back.
});

test("(c) nothing recorded, one waiting: y re-shows instead of answering", async (t) => {
  const { app, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  // Add an approval that was never shown to this chat.
  const fp = "f" + "0".repeat(31);
  app.runtime.approvals.ask({ runId: "run-0", sessionId, tool: "files.read", target: "secret.txt",
    label: "files.read secret.txt", question: "May it read secret.txt?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: fp });
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["files.read"]);
  // Chat sends bare "y" (nothing was ever shown).
  const sentBefore = app.sent?.length ?? 0;
  await app.channels.handle(message("y", "m1"));
  // Question should still be waiting (re-shown, not answered).
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["files.read"]);
  // Now send "y" again - it should answer (was shown in previous step).
  await app.channels.handle(message("y", "m2"));
  const left = app.runtime.waitingApprovals(sessionId);
  assert.deepEqual(left.length, 0, "question shown in previous step should be answered");
});

test("(d) a question with no fingerprint: with nothing shown a y shows it; with two waiting it is refused", async (t) => {
  const { app, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [] });
  await app.channels.handle(message("hello", "m0"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  // Add approval with no fingerprint (rooms-style).
  app.runtime.approvals.ask({ runId: "run-room", sessionId, tool: "files.read", target: "data.txt",
    label: "files.read data.txt", question: "May it read data.txt?", source: "owner", remember: "session",
    askedAt: new Date().toISOString() });
  // With one waiting and nothing shown: should re-show.
  await app.channels.handle(message("y", "m1"));
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool), ["files.read"]);
  // Add a second approval (with its own fingerprint: two questions that both name nothing are one question to the list).
  app.runtime.approvals.ask({ runId: "run-room2", sessionId, tool: "network.site", target: "example.com",
    label: "network.site example.com", question: "May it open example.com?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: "f" + "9".repeat(31) });
  // With multiple waiting and no fingerprint: should refuse.
  const sentBefore = (app.sent || []).length;
  await app.channels.handle(message("y", "m2"));
  // Both should still be waiting (refused, not answered).
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.tool).sort(), ["files.read", "network.site"]);
});

// NAS's review 2 of #289 (probe nas-289-creal, real runs only): the chat must be shown its own task's question, with that
// question's own buttons, never the newest in the conversation with the chat's words on it.
test("(e) the chat is shown its own task's question and buttons, so its y never approves a newer request from the window", async (t) => {
  const { app, sent, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: askAboutReads });
  await app.channels.handle(message("read README.md", "m1"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  // A window task in the same conversation asks about another file.
  await app.runtime.run({ prompt: "read SECRET.md", sessionId });
  // The chat asks for README.md again, which replaces its older question in place (the same request).
  const before = sent.length;
  await app.channels.handle(message("read README.md", "m2"));
  const shown = sent.slice(before).join("\n");
  assert.match(shown, /README\.md/, "the chat is shown its own question");
  assert.doesNotMatch(shown, /SECRET\.md/, "and nothing of the window's");
  await app.channels.handle(message("y", "m3"));
  const left = app.runtime.waitingApprovals(sessionId).map((q) => q.target);
  assert.ok(left.some((target) => /SECRET\.md/.test(target)), "the window's request still waits");
  assert.ok(!left.some((target) => /README\.md/.test(target)), "the chat's own request is the one answered");
});

// NAS's review 2 (probe A): iMessage, IRC, MQTT and others send without returning a message id. A question they sent is
// still shown, so the chat's y answers it rather than being shown it again for ever.
test("(f) on a chat app that returns no message id, a y answers the question it was sent", async (t) => {
  const { app, message } = await fixture(t, { noIds: true });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: askAboutReads });
  await app.channels.handle(message("read README.md", "m1"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1);
  await app.channels.handle(message("y", "m2"));
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 0, "the y answered it");
});

// NAS's review 2 (probe B): a pressed button whose request no longer waits gets the stale-button note, even when this chat
// was shown a question before, and answers nothing.
test("(g) a button pressed for a request that no longer waits gets the stale-button note and answers nothing", async (t) => {
  const { app, sent, message } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: askAboutReads });
  await app.channels.handle(message("read README.md", "m1"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  const first = app.runtime.waitingApprovals(sessionId)[0];
  app.runtime.approve(sessionId, "deny", "session", first.fingerprint); // answered in the window
  await app.runtime.run({ prompt: "read SECRET.md", sessionId });
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "one other request waits");
  const before = sent.length;
  await app.channels.handle(message(`y:${first.fingerprint}`, "m2"));
  assert.deepEqual(sent.slice(before), [staleButtonNote], "the stale-button note, and nothing else");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "nothing was answered");
});

// NAS's review 2 (probe C2): a question that arrives while the chat is being told its old one has gone is not the one shown
// next: the chat is shown the question decided on, and a y then answers that one and nothing newer.
test("(h) a question arriving while the chat is told its question has gone is not shown or answered in its place", async (t) => {
  let arrive = null;
  const { app, sent, message } = await fixture(t, { onSend: (text) => { if (/no longer waiting/.test(text)) arrive?.(); } });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: askAboutReads });
  await app.channels.handle(message("read README.md", "m1"));
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  const readme = app.runtime.waitingApprovals(sessionId)[0];
  app.runtime.approve(sessionId, "allow", "session", readme.fingerprint); // answered in the window
  app.runtime.approvals.ask({ runId: "run-notes", sessionId, tool: "files.read", target: "NOTES.md", label: "files.read NOTES.md",
    question: "May it read NOTES.md?", source: "owner", remember: "session", askedAt: new Date().toISOString(), fingerprint: "a".repeat(32) });
  // While the chat is told README's question has gone, a newer request arrives.
  arrive = () => { arrive = null; app.runtime.approvals.ask({ runId: "run-secret", sessionId, tool: "files.read", target: "SECRET.md",
    label: "files.read SECRET.md", question: "May it read SECRET.md?", source: "owner", remember: "session", askedAt: new Date().toISOString(), fingerprint: "b".repeat(32) }); };
  const before = sent.length;
  await app.channels.handle(message("y", "m2"));
  const told = sent.slice(before).join("\n");
  assert.match(told, /NOTES\.md/, "the chat is shown the question decided on");
  assert.doesNotMatch(told, /SECRET\.md/, "not the one that arrived meanwhile");
  await app.channels.handle(message("y", "m3"));
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((q) => q.target), ["SECRET.md"], "its y answered NOTES.md, never SECRET.md");
});
