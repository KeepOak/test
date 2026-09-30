import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { TasteLearning } from "../dist/taste/learning.js";
import { TasteApi } from "../dist/taste/api.js";
import { discardTemp } from "./temp-dir.mjs";

const preference = (text = "Use short paragraphs.", evidence = "I prefer short paragraphs") =>
  ({ disposition: "durable", preferences: [{ domain: "writing", text, evidence }] });
async function fixture(t, answer = preference()) {
  const root = await mkdtemp(join(tmpdir(), "branch-taste-")), file = join(root, "taste.sqlite");
  const store = new Store(file), run = store.createRun("local", "Write a note");
  const messageId = store.message(run.sessionId, { role: "assistant", content: "A long and flowery note." });
  store.finish(run.id, "completed", "A long and flowery note.");
  const scope = { memoryOwner: "local", project: run.project, agent: null };
  const calls = [], ask = async (...args) => { calls.push(args); return JSON.stringify(typeof answer === "function" ? await answer(...args) : answer); };
  const learning = new TasteLearning(store, ask, () => scope), api = new TasteApi(learning);
  const input = { sessionId: run.sessionId, messageId, outcome: "reject", explanation: "I prefer short paragraphs", remember: true };
  t.after(async () => { store.close(); await discardTemp(root); });
  return { store, file, scope, learning, api, input, calls };
}
const post = (f, path, input = f.input, authorize = () => {}) => f.api.handle("local", "POST", `/api/taste/${path}`, input, authorize);

test("feedback resolves the reply, learns semantically once, persists and gives fresh scoped context", async t => {
  const f = await fixture(t);
  assert.equal(f.learning.context(f.scope), null);
  const [first, duplicate] = await Promise.all([post(f, "feedback"), post(f, "feedback")]);
  assert.deepEqual(first, duplicate); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0][2]).reply, "A long and flowery note.");
  assert.match(f.learning.context(f.scope).content, /short paragraphs/);
  assert.match(f.learning.context(f.scope).content, /current task.*override/);
  assert.equal(f.learning.context({ ...f.scope, project: "another" }), null);
  assert.equal(f.learning.context({ ...f.scope, agent: "trunk:another" }), null);
  assert.equal(f.learning.context({ ...f.scope, memoryOwner: "someone-else" }), null);
  assert.equal(f.learning.context({ ...f.scope, domains: ["design"] }), null);
  for (const exclusion of ["sealed", "isolated", "temporary"]) assert.equal(f.learning.context({ ...f.scope, [exclusion]: true }), null);
  f.store.close();
  const reopened = new Store(f.file);
  try {
    const next = new TasteLearning(reopened, async () => assert.fail("no extraction on read"), () => f.scope);
    assert.match(next.context(f.scope).content, /short paragraphs/);
  } finally { reopened.close(); }
});

test("inspect, correct with version check, forget, and replay cannot resurrect the preference", async t => {
  const f = await fixture(t);
  await post(f, "feedback");
  const { preferences } = await f.api.handle("local", "GET", "/api/taste/preferences", { sessionId: f.input.sessionId }, () => {});
  const item = preferences[0], target = { sessionId: f.input.sessionId, id: item.id, revision: 1 };
  assert.equal(item.messageId, f.input.messageId); assert.equal(item.evidence, f.input.explanation);
  await post(f, "correct", { ...target, text: "Use detailed paragraphs for essays." });
  assert.match(f.learning.context(f.scope).content, /detailed paragraphs/);
  assert.doesNotMatch(f.learning.context(f.scope).content, /short paragraphs/);
  assert.equal(f.learning.list("local", f.input.sessionId)[0].history[0].text, "Use short paragraphs.");
  await assert.rejects(post(f, "correct", { ...target, text: "Stale correction" }), /changed/);
  await post(f, "forget", { ...target, revision: 2 });
  await post(f, "feedback");
  assert.equal(f.learning.context(f.scope), null); assert.equal(f.calls.length, 1);
});

test("bare acceptance, factual corrections and one-time changes do not invent durable taste", async t => {
  const bare = await fixture(t);
  const result = await post(bare, "feedback", { ...bare.input, outcome: "accept", explanation: "" });
  assert.equal(result.receipt.disposition, "insufficient"); assert.equal(bare.calls.length, 0);
  for (const disposition of ["factual", "temporary", "insufficient"]) {
    const f = await fixture(t, { ...preference(), disposition });
    assert.deepEqual((await post(f, "feedback")).receipt.preferenceIds, []);
    assert.equal(f.learning.context(f.scope), null);
  }
});

test("forged source, cross-owner source, tools and temporary conversations are refused", async t => {
  const f = await fixture(t);
  await assert.rejects(post(f, "feedback", { ...f.input, reply: "Forged source" }));
  await assert.rejects(post(f, "feedback", { ...f.input, messageId: 9000 }), /reply/);
  const other = f.store.createRun("other", "private");
  const otherId = f.store.message(other.sessionId, { role: "assistant", content: "private" });
  await assert.rejects(post(f, "feedback", { ...f.input, sessionId: other.sessionId, messageId: otherId }), /conversation/);
  const temporary = f.store.createRun("local", "one off", undefined, true);
  await assert.rejects(post(f, "feedback", { ...f.input, sessionId: temporary.sessionId }), /conversation/);
  const tool = f.store.message(f.input.sessionId, { role: "assistant", content: "", toolCalls: [{ id: "c", name: "file.read", arguments: "{}" }] });
  await assert.rejects(post(f, "feedback", { ...f.input, messageId: tool }), /reply/);
  assert.equal(f.calls.length, 0);
});

test("unquoted evidence, model failure and revoked authorization write nothing", async t => {
  const unsupported = await fixture(t, preference("Use brief replies.", "Made up owner words"));
  await assert.rejects(post(unsupported, "feedback"), /supported/);
  assert.equal(unsupported.learning.context(unsupported.scope), null);
  const failed = await fixture(t, () => { throw new Error("model unavailable"); });
  await assert.rejects(post(failed, "feedback"), /unavailable/);
  assert.equal(failed.learning.context(failed.scope), null);
  let allowed = true;
  const revoked = await fixture(t, () => { allowed = false; return preference(); });
  await assert.rejects(post(revoked, "feedback", revoked.input, () => { if (!allowed) throw new Error("access revoked"); }), /revoked/);
  assert.equal(revoked.learning.context(revoked.scope), null);
});

test("a conversation changing project during extraction cannot save to either scope", async t => {
  let change;
  const f = await fixture(t, () => { change(); return preference(); });
  change = () => { f.scope.project = "moved"; };
  await assert.rejects(post(f, "feedback"), /scope changed/);
  assert.equal(f.learning.context(f.scope), null);
});
