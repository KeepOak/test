/**
 * Parity B1: a question with lettered options. user.ask takes up to five options (title and hint); the question is the
 * assistant's message once, the options stay on the call in the conversation (what the window draws as the choice
 * card), and the owner's next message, an option's title, is the answer the task carries on with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("user.ask with options: the call keeps them, the question is said once, and a picked option answers it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-question-choices-"));
  const question = "How careful should I be?";
  const options = [{ title: "Ask before anything", hint: "Every step waits for you" }, { title: "Ask before sending", hint: "Reading is fine" }];
  let n = 0;
  const heard = [];
  const provider = { name: "scripted", async complete(request) {
    heard.push(request.messages.filter((m) => m.role === "user").map((m) => m.content).at(-1));
    n++;
    if (n === 1) return { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question, options }) }] };
    return { content: "Noted.", toolCalls: [] };
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "set yourself up" });
  assert.equal(run.status, "needs_input");
  const messages = app.store.messages(run.sessionId);
  const call = messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.name === "user.ask");
  assert.deepEqual(JSON.parse(call.arguments).options, options, "the options stay on the call");
  assert.equal(messages.filter((m) => m.role === "assistant" && m.content === question).length, 1, "the question is said once");
  const answered = await app.runtime.run({ prompt: options[1].title, sessionId: run.sessionId });
  assert.equal(answered.status, "completed");
  assert.equal(heard.at(-1), options[1].title, "the picked option is the answer the model reads");
});

test("user.ask refuses more than five options", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-question-choices-"));
  const many = Array.from({ length: 6 }, (_, i) => ({ title: `Option ${i + 1}` }));
  let n = 0;
  const provider = { name: "scripted", async complete() {
    n++;
    if (n === 1) return { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question: "Which?", options: many }) }] };
    return { content: "ok", toolCalls: [] };
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "pick" });
  assert.notEqual(run.status, "needs_input", "six options are refused as arguments, so nothing waits on them");
});
