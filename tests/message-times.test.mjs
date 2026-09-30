/**
 * Parity B1: each message keeps when it was written (the conversation's day stamps, "Sent at" and a pin's time), beside
 * the message and never inside what a model is sent; a copy made from an earlier message keeps the first time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("messages carry when they were written, kept through a copy, and never reach the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-message-times-"));
  const seen = [];
  const provider = { name: "scripted", async complete(request) { seen.push(JSON.stringify(request.messages)); return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const before = Date.now() - 1000;
  const run = await app.runtime.run({ prompt: "hello there" });
  const view = app.store.sessionView(app.runtime.owner, run.sessionId);
  const said = view.messages.filter((m) => m.role === "user" || m.role === "assistant");
  assert.ok(said.length >= 2, "the question and the answer are there");
  for (const m of said) {
    assert.equal(typeof m.at, "string", "each message says when it was written");
    const at = Date.parse(m.at);
    assert.ok(at >= before && at <= Date.now() + 1000, `a real time: ${m.at}`);
  }
  assert.ok(!seen.some((body) => body.includes('"at"')), "the time never travels to the model");
  const reply = said.find((m) => m.role === "assistant");
  const copy = (await app.store.branchSession(app.runtime.owner, { sessionId: run.sessionId, messageId: reply.messageId }));
  const copied = app.store.sessionView(app.runtime.owner, copy.sessionId).messages.filter((m) => m.role === "user");
  assert.equal(copied[0].at, said.find((m) => m.role === "user").at, "the copy keeps when the message was first written");
  const again = await app.runtime.run({ prompt: "and again", sessionId: run.sessionId });
  assert.equal(again.status, "completed");
  assert.ok(!seen.some((body) => body.includes('"at"')), "the next task's request carries no time either");
});
