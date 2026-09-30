import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

function model() {
  return { name: "scripted", requests: [], analyses: [], async complete(request) {
    if (request.messages.some(message => message.content.includes("Extract lasting taste preferences"))) {
      this.analyses.push(request);
      return { content: JSON.stringify({ disposition: "durable", preferences: [{ domain: "writing", text: "Prefer concise paragraphs.", evidence: "I prefer concise paragraphs" }] }), toolCalls: [] };
    }
    this.requests.push(request);
    return { content: "Here is your finished note.", toolCalls: [] };
  } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-taste-live-")), provider = model();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, token = server.token) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, provider, call };
}
function feedback(app, run) {
  const message = app.store.sessionView(app.runtime.owner, run.sessionId).messages.findLast(item => item.role === "assistant");
  return { sessionId: run.sessionId, messageId: message.messageId, outcome: "reject", explanation: "I prefer concise paragraphs", remember: true };
}

test("owner feedback HTTP route uses configured isolated model and affects the next task in the same chat", async t => {
  const { app, provider, call } = await fixture(t);
  const run = await app.runtime.run({ prompt: "Write a short note." });
  assert.equal(run.status, "completed");
  const input = feedback(app, run), learned = await call("taste/feedback", input);
  assert.equal(learned.status, 200, JSON.stringify(learned.body));
  assert.equal(learned.body.receipt.preferenceIds.length, 1);
  assert.equal(provider.analyses.length, 1);
  assert.equal(provider.analyses[0].tools.length, 0);
  assert.ok(provider.analyses[0].messages.every(message => !message.content.includes("What you remember about the person")));
  await app.runtime.run({ prompt: "Write another note, but make this one detailed.", sessionId: run.sessionId });
  const next = provider.requests.findLast(request => request.messages.some(message => message.content === "Write another note, but make this one detailed."));
  const context = next.messages.find(message => message.content.includes("Owner taste defaults"));
  assert.match(context.content, /concise paragraphs/); assert.match(context.content, /current task.*override/);
  const listed = await call(`taste/preferences?sessionId=${run.sessionId}`), item = listed.body.preferences[0];
  assert.equal(listed.status, 200); assert.equal(item.messageId, input.messageId);
  const corrected = await call("taste/correct", { sessionId: run.sessionId, id: item.id, revision: item.revision, text: "Use numbered steps in tutorials." });
  assert.equal(corrected.status, 200);
  await app.runtime.run({ prompt: "Write a tutorial.", sessionId: run.sessionId });
  const correctedContext = provider.requests.findLast(request => request.messages.some(message => message.content === "Write a tutorial.")).messages.find(message => message.content.includes("Owner taste defaults"));
  assert.match(correctedContext.content, /numbered steps/); assert.doesNotMatch(correctedContext.content, /concise paragraphs/);
  await call("taste/forget", { sessionId: run.sessionId, id: item.id, revision: corrected.body.preference.revision });
  await app.runtime.run({ prompt: "One more tutorial.", sessionId: run.sessionId });
  const afterForget = provider.requests.findLast(request => request.messages.some(message => message.content === "One more tutorial."));
  assert.equal(afterForget.messages.some(message => message.content.includes("Owner taste defaults")), false);
  assert.equal((await call("taste/feedback", input)).body.receipt.id, learned.body.receipt.id);
});

test("HTTP feedback cannot learn from isolated, sealed or temporary tasks, or unauthenticated requests", async t => {
  const { app, call } = await fixture(t);
  const normal = await app.runtime.run({ prompt: "Write a note." });
  assert.notEqual((await call("taste/feedback", feedback(app, normal), "wrong-token")).status, 200);
  const temporary = await app.runtime.run({ prompt: "Write a disposable note.", temporary: true });
  assert.notEqual((await call("taste/feedback", feedback(app, temporary))).status, 200);
  const isolated = await app.runtime.run({ prompt: "Grade a note.", isolated: true });
  assert.notEqual((await call("taste/feedback", feedback(app, isolated))).status, 200);
  const before = app.runtime.learningRules;
  app.runtime.learningRules = id => id === normal.sessionId ? { tools: new Set() } : before(id);
  assert.notEqual((await call("taste/feedback", feedback(app, normal))).status, 200);
});
