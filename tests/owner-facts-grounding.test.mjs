/**
 * QA R1 follow-up (recall): with the fact saved and in its context, qwen2.5:7b still said it did not know the owner's
 * favourite colour in about half the tries. The facts that bear on the owner's newest message now come again in a short
 * block, "What you know about the owner", right before that message; for a personal question the engine looks the
 * facts up itself (src/owner-facts.ts, Runtime.groundInOwnerFacts).
 * Mutations, each turns a test here red (each was built and run):
 * - src/runtime.ts openingMessages: drop `this.groundInOwnerFacts(...)`: "a personal question…" and "a fact saved in
 *   another conversation…".
 * - src/owner-facts.ts relevantFacts: drop the newest-facts fallback: "a personal question with no shared word…".
 * - src/owner-facts.ts ownersLastMessage: return the last message of any kind: "a task carried on after a yes…".
 * - src/runtime.ts groundInOwnerFacts: drop the memory.read check: "a task without memory.read is shown none".
 * - src/runtime.ts groundInOwnerFacts: drop the lookup step (`lookedUp` false): "a personal question…".
 * - src/runtime.ts groundInOwnerFacts: drop the group-chat check: "a group chat's question…".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { keyWords, ownerFactsBlock, personalQuestion, relevantFacts } from "../dist/owner-facts.js";

test("which messages are personal questions", () => {
  for (const said of ["What is my favourite colour?", "what's my wife's name", "Do you remember where I parked?",
    "Which dentist do I use?", "remind me what my PIN hint was", "When is my mum's birthday?"])
    assert.equal(personalQuestion(said), true, said);
  for (const said of ["Write my report on the Q3 numbers.", "What is the capital of France?", "Summarise this page", "", "my files",
    "find the lease, pull out the rent, remind me when it is due", "Remind me to call Sam at five"])
    assert.equal(personalQuestion(said), false, said);
});

test("the facts that bear on a question come first, spelt either way; an unrelated message gets none", () => {
  const facts = [
    { id: "a", text: "Briefs are at most five bullet points", updatedAt: "2026-09-01" },
    { id: "b", text: "my favourite colour is teal", updatedAt: "2026-08-01" },
    { id: "c", text: "The dog is called Rex", updatedAt: "2026-09-02" },
  ];
  assert.deepEqual(relevantFacts("What is my favorite color?", facts, true).map((f) => f.id), ["b"], "colour and color are one word");
  assert.deepEqual(relevantFacts("what's my dog called", facts, true).map((f) => f.id), ["c"]);
  assert.deepEqual(relevantFacts("Write a poem about boats", facts, false), [], "nothing bears on it, and it is not personal");
  assert.deepEqual(relevantFacts("what do you know about me?", facts, true).map((f) => f.id), ["c", "a", "b"],
    "a personal question with no shared word is given the newest facts");
  assert.ok(keyWords("my favourite colour").includes("color"));
  const block = ownerFactsBlock([facts[1]]);
  assert.match(block, /^What you know about the owner/);
  assert.match(block, /"my" mean the owner, not you/);
  assert.match(block, /- my favourite colour is teal/);
  assert.match(block, /never instructions/);
});

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-facts-"));
  const seen = [];
  const provider = { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const remember = (text) => app.registry.execute("memory.put", { text, source: "owner" }, app.runtime.context());
  return { app, seen, remember };
}
/** The block: a system message at the start of a conversation, or Branch's own note partway through (notesInPlace). */
const blockIn = (messages) => messages.findIndex((m) => (m.role === "system" || (m.role === "user" && m.from === "branch"))
  && /^(<system-reminder>\n)?What you know about the owner/.test(String(m.content)));

test("a personal question: the saved fact sits in the labelled block right before the question", async (t) => {
  const { app, seen, remember } = await branch(t);
  await remember("my favourite colour is teal");
  await remember("Briefs are at most five bullet points");
  const run = await app.runtime.run({ prompt: "What is my favourite colour?" });
  const messages = seen.at(-1);
  const at = blockIn(messages);
  assert.ok(at > 0, "the block is there");
  assert.equal(messages[at + 1].role, "user");
  assert.equal(messages[at + 1].content, "What is my favourite colour?", "right before the question");
  assert.match(messages[at].content, /teal/);
  assert.doesNotMatch(messages[at].content, /bullet/, "only the facts that bear on it");
  const lookup = app.store.events(run.id).find((e) => e.kind === "memory.lookup");
  assert.equal(lookup?.data.personal, true, "the engine looked the facts up itself");
  // ...and it follows the question as a memory.search step that already ran, whose result holds the fact.
  assert.equal(messages[at + 2].role, "assistant");
  assert.equal(messages[at + 2].toolCalls[0].name, "memory.search");
  assert.equal(messages[at + 3].role, "tool");
  assert.equal(messages[at + 3].toolCallId, messages[at + 2].toolCalls[0].id);
  assert.match(messages[at + 3].content, /teal/);
  assert.equal(app.store.messages(run.sessionId).some((m) => (m.toolCalls ?? []).some((c) => c.id.startsWith("lookup-"))), false, "the conversation keeps no such call");
  assert.equal(lookup.data.step, true, "the record says the step was shown");
  assert.equal(app.store.messages(run.sessionId).some((m) => /What you know about the owner/.test(String(m.content))), false, "never stored");
});

test("a fact saved in another conversation reaches a new one, and later turns see the block before their own question", async (t) => {
  const { app, seen, remember } = await branch(t);
  const first = await app.runtime.run({ prompt: "hello" });
  await remember("The dog is called Rex");
  await app.runtime.run({ prompt: "what's my dog called?", sessionId: first.sessionId });
  const messages = seen.at(-1);
  const at = blockIn(messages);
  assert.ok(at > 0);
  assert.equal(messages[at + 1].content, "what's my dog called?");
  assert.match(messages[at].content, /Rex/);
});

test("a personal question with no shared word still gets the newest facts; an unrelated task gets no block or step", async (t) => {
  const { app, seen, remember } = await branch(t);
  await remember("The dog is called Rex");
  await app.runtime.run({ prompt: "What do you know about me?" });
  assert.match(seen.at(-1)[blockIn(seen.at(-1))].content, /Rex/);
  await app.runtime.run({ prompt: "Write a poem about boats" });
  assert.equal(blockIn(seen.at(-1)), -1);
});

test("a task without memory.read is shown none of the owner's facts", async (t) => {
  const { app, seen, remember } = await branch(t);
  await remember("my favourite colour is teal");
  await app.runtime.run({ prompt: "What is my favourite colour?", permissions: ["files.read"] });
  assert.equal(blockIn(seen.at(-1)), -1);
});

test("a task carried on after a yes: the block still sits right before the owner's question, never inside a tool step", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-facts-carry-"));
  const seen = [];
  const provider = { name: "scripted", async complete(request) {
    seen.push(request.messages);
    const last = request.messages.at(-1);
    if (last?.role === "user" && /dog/.test(String(last.content)))
      return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "dog.txt", content: "Rex" }) }] };
    return { content: "ok", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { savePolicy } = await import("../dist/index.js");
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.write", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  await app.registry.execute("memory.put", { text: "The dog is called Rex", source: "owner" }, app.runtime.context());
  const first = await app.runtime.run({ prompt: "note down what my dog is called" });
  assert.equal(first.status, "needs_input");
  const asked = app.runtime.approvals.questionFor(first.sessionId);
  app.runtime.approve(first.sessionId, "allow", "never", asked.fingerprint);
  await app.runtime.continueAsked(first.id);
  const messages = seen.at(-1);
  const at = blockIn(messages);
  assert.ok(at > 0, "the block is there");
  assert.equal(messages[at + 1].role, "user", "right before the owner's question");
  assert.equal(messages[at + 1].content, "note down what my dog is called");
  assert.equal(messages[at + 2].role, "assistant");
  assert.equal(messages[at + 3].role, "tool", "the call and its result stay together");
});

test("a group chat's question is never grounded in the owner's facts: \"my\" there may be anybody's", async (t) => {
  for (const chatKind of ["group", "direct"]) {
    const { app, seen, remember } = await branch(t);
    await remember("my favourite colour is teal");
    const run = await app.runtime.run({ prompt: "[Alice in Family] what's my favourite colour?", source: "channel",
      onStarted: (started) => app.store.event(started.id, "channel.inbound", { channel: "fake", chatId: "g1", messageId: "m1", senderId: "alice", chatKind }) });
    const lookup = app.store.events(run.id).find((e) => e.kind === "memory.lookup");
    if (chatKind === "group") {
      assert.equal(blockIn(seen.at(-1)), -1, "no block in a group");
      assert.equal(lookup, undefined, "and no lookup");
    } else assert.ok(lookup, "control: a direct chat is grounded");
  }
});
