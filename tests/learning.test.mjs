import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => () => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
/** Task requests follow the script; the separate review request (its system prompt says so) gets `review`. */
function scripted(steps, review = say('{"memories":[],"skills":[]}')) {
  const provider = { name: "scripted", requests: [], reviews: [], async complete(request) {
    if (/You review a finished task/.test(request.messages[0].content)) { provider.reviews.push(request); return review(request); }
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, steps, review) {
  const root = await mkdtemp(join(tmpdir(), "branch-learning-"));
  const provider = scripted(steps, review);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
async function served(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? response.status);
    return json;
  };
}
const texts = (app) => app.store.list("memory", "local").map((r) => r.data.text).sort();
async function until(check, label) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(25); } assert.fail(`Timed out: ${label}`); }

test("every memory edit and deletion keeps an exact earlier version that can be restored", async (t) => {
  const { app, root } = await fixture(t, [say("ok")]);
  const api = await served(t, app, root);
  const first = app.store.save("memory", "local", "fact-1", { text: "Likes tea", source: "owner" });
  app.store.updateMemory("local", { id: "fact-1", text: "Likes green tea", source: "owner", expectedRevision: first.revision }, "");
  const { versions } = await api("memory/versions?id=fact-1");
  assert.deepEqual(versions.map((v) => [v.revision, v.data.text, v.reason]), [[1, "Likes tea", "before edit"]]);
  const restored = await api("memory/versions/restore", { id: "fact-1", revision: 1 });
  assert.equal(restored.data.text, "Likes tea");
  assert.equal(restored.revision, 3, "a restore is a new revision, not a rewrite of history");
  assert.equal(app.store.delete("memory", "local", "fact-1"), true);
  assert.equal(app.store.get("memory", "local", "fact-1"), undefined);
  const afterDelete = (await api("memory/versions?id=fact-1")).versions;
  assert.equal(afterDelete[0].reason, "deleted");
  assert.equal(afterDelete[0].data.text, "Likes tea");
  const back = await api("memory/versions/restore", { id: "fact-1", revision: afterDelete[0].revision });
  assert.equal(back.data.text, "Likes tea");
  assert.equal(app.store.get("memory", "local", "fact-1").revision, 1, "a deleted fact comes back as a fresh record");
});

test("with approval on, the model's memory changes wait as suggestions until the owner accepts or rejects them", async (t) => {
  const { app, root } = await fixture(t, [call("memory.put", { text: "Prefers short answers", source: "said so" }), say("noted")]);
  const api = await served(t, app, root);
  assert.deepEqual(await api("memory/settings"), { review: false, requireApproval: false });
  assert.deepEqual(await api("memory/settings", { review: false, requireApproval: true }), { review: false, requireApproval: true });
  const run = await app.runtime.run({ prompt: "remember this" });
  assert.equal(run.status, "completed");
  assert.deepEqual(texts(app), [], "nothing was saved directly");
  const toolResult = JSON.parse(app.store.messages(run.sessionId).find((m) => m.role === "tool").content);
  assert.equal(toolResult.result.staged, true);
  const { proposals } = await api("memory/proposals");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "put");
  assert.equal(proposals[0].runId, run.id);
  const rejected = await api(`memory/proposals/${proposals[0].id}/reject`, {});
  assert.equal(rejected.proposal.status, "rejected");
  assert.deepEqual(texts(app), []);
  const again = app.store.review.propose("local", { kind: "put", text: "Prefers short answers", source: "said so", runId: run.id });
  const accepted = await api(`memory/proposals/${again.id}/accept`, {});
  assert.equal(accepted.proposal.status, "accepted");
  assert.deepEqual(texts(app), ["Prefers short answers"]);
  await assert.rejects(api(`memory/proposals/${again.id}/accept`, {}), /already decided/);
  assert.equal((await api("state")).memoryProposals.length, 0);
});

test("with review on, a finished task is reviewed separately and suggestions link back to it", async (t) => {
  const review = say('Here you go:\n```json\n{"memories":[{"text":"Works in Lagos time","source":"they mentioned their timezone"}],"skills":[{"skillId":"skill-1","note":"Mention the timezone up front"}]}\n```');
  const { app, root, provider } = await fixture(t, [say("done")], review);
  const api = await served(t, app, root);
  await api("memory/settings", { review: true, requireApproval: false });
  const run = await app.runtime.run({ prompt: "what time is it for me" });
  assert.equal(run.status, "completed");
  await until(() => app.store.review.proposals("local").length === 2, "two suggestions from the review");
  const proposals = app.store.review.proposals("local");
  assert.deepEqual(proposals.map((p) => [p.kind, p.runId]).sort(), [["put", run.id], ["skill-note", run.id]]);
  assert.equal(proposals.find((p) => p.kind === "skill-note").skillId, "skill-1");
  assert.equal(provider.reviews.length, 1);
  assert.match(provider.reviews[0].messages[1].content, /Task: what time is it for me/);
  await until(() => app.store.events(run.id).some((e) => e.kind === "learning.reviewed"), "review recorded");
  assert.deepEqual(app.store.events(run.id).find((e) => e.kind === "learning.reviewed").data, { memories: 1, skills: 1 });
  assert.deepEqual(texts(app), [], "review never writes memory by itself");
  const temporary = await app.runtime.run({ prompt: "private", temporary: true });
  await delay(80);
  assert.equal(provider.reviews.length, 1, "temporary conversations are not reviewed");
  assert.equal(temporary.status, "completed");
});

test("a conversation keeps the memory snapshot it started with; a new conversation gets a fresh one", async (t) => {
  const { app, provider } = await fixture(t, [say("ok")]);
  app.store.save("memory", "local", "a", { text: "Fact A", source: "owner" });
  const first = await app.runtime.run({ prompt: "one" });
  const snapshotOf = (request) => request.messages.find((m) => m.role === "system" && /What you remember about the person/.test(m.content))?.content ?? "";
  assert.match(snapshotOf(provider.requests[0]), /- Fact A/);
  app.store.save("memory", "local", "b", { text: "Fact B", source: "owner" });
  await app.runtime.run({ prompt: "two", sessionId: first.sessionId });
  assert.match(snapshotOf(provider.requests[1]), /Fact A/);
  assert.doesNotMatch(snapshotOf(provider.requests[1]), /Fact B/, "the same conversation keeps its snapshot");
  const events = app.store.events(app.store.runs("local")[0].id);
  assert.deepEqual(events.find((e) => e.kind === "memory.snapshot").data.reused, true);
  await app.runtime.run({ prompt: "three" });
  assert.match(snapshotOf(provider.requests[2]), /Fact B/);
});

test("a checkpoint puts memories and skill versions back exactly", async (t) => {
  const { app, root } = await fixture(t, [say("ok")]);
  const api = await served(t, app, root);
  const kept = app.store.save("memory", "local", "keep", { text: "Keep me", source: "owner" });
  app.store.save("memory", "local", "change", { text: "Original", source: "owner" });
  app.store.save("memory", "local", "remove", { text: "Remove me later", source: "owner" });
  const skill = app.store.skills.install("local", { document: "---\nname: helper\ndescription: Helps.\n---\nDo the thing.\n" });
  const checkpoint = await api("memory/checkpoints", { label: "good state" });
  assert.deepEqual([checkpoint.memories, checkpoint.skills], [3, 1]);
  app.store.updateMemory("local", { id: "change", text: "Changed", source: "owner", expectedRevision: 1 }, "");
  app.store.delete("memory", "local", "remove");
  app.store.save("memory", "local", "extra", { text: "Added later", source: "owner" });
  app.store.skills.disable("local", skill.id, { expectedRevision: skill.revision });
  assert.equal(app.store.skills.view("local", skill.id).activeVersion, null);
  const result = await api(`memory/checkpoints/${checkpoint.id}/restore`, {});
  assert.deepEqual(result, { id: checkpoint.id, memories: 3, skills: 1 });
  const now = app.store.list("memory", "local");
  assert.deepEqual(now.map((r) => [r.id, r.data.text, r.revision]).sort(), [["change", "Original", 1], ["keep", "Keep me", 1], ["remove", "Remove me later", 1]]);
  assert.equal(now.find((r) => r.id === "keep").createdAt, kept.createdAt, "times are exactly as kept");
  assert.equal(app.store.skills.view("local", skill.id).activeVersion, 1);
  assert.equal((await api("state")).memoryCheckpoints[0].label, "good state");
});
