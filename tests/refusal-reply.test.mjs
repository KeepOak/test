/**
 * Dogfood D5 (qa/DOGFOOD-0005): pressing "Don't allow" ended the whole turn with no words. Now a No to the owner's own
 * task carries it on: the model is told what was refused (nothing is written in the owner's name), it replies with
 * what it can do instead, and the very request that was refused is refused again without asking if it tries it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, refusedAgain } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { underShortLivedKey } from "../dist/key-context.js";

/** A model that writes the file named in the owner's message, tries it again once refused, then answers in words. */
function model(seen) {
  return { name: "writer", async complete(request) {
    seen.push(request);
    const last = request.messages.at(-1);
    const told = String(request.messages[0]?.content ?? "").includes("The owner answered No");
    if (last?.role === "user" && /^write (\S+)/.test(last.content))
      return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: /^write (\S+)/.exec(last.content)[1], content: "hello" }) }] };
    // Carrying on after the No: first the same request again (it must be refused), then a reply.
    if (told && !request.messages.some((m) => m.role === "tool" && m.content.includes("already said No")))
      return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "b.txt", content: "hello" }) }] };
    if (told) return { content: "I could not write b.txt because you said no. I can show you the text here instead.", toolCalls: [] };
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-refusal-"));
  const seen = [];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model(seen) });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const runsIn = (sessionId) => app.store.runs(app.runtime.owner).filter((run) => run.sessionId === sessionId);
  const no = (run) => {
    const asked = app.runtime.approvals.questionFor(run.sessionId);
    return call("policy/approve", { sessionId: run.sessionId, decision: "deny", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  };
  return { app, root, seen, call, runsIn, no };
}
const until = async (check) => { for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("a No to the owner's own task gets a reply with another way, and nothing is said in the owner's name", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "write b.txt" });
  assert.equal(first.status, "needs_input", "control: it stopped to ask");
  const answered = await f.no(first);
  assert.equal(answered.status, 200);
  assert.equal(answered.body.task, "carrying-on", "the window is told the task carries on, so it follows it");
  assert.ok(await until(() => f.runsIn(first.sessionId).some((run) => run.id !== first.id && run.status === "completed")));
  const next = f.runsIn(first.sessionId).find((run) => run.id !== first.id);
  assert.match(next.output, /because you said no/, "the task ends with words: what it could not do and what it can do");
  assert.equal(f.app.store.run(first.id).status, "cancelled", "the asking task's wait is over");
  const messages = f.app.store.messages(first.sessionId);
  assert.deepEqual(messages.filter((m) => m.role === "user").map((m) => m.content), ["write b.txt"], "no words were written as the owner's");
  assert.equal(messages.at(-1).role, "assistant");
  assert.match(messages.at(-1).content, /I can show you the text here instead/);
  assert.equal(existsSync(join(f.root, "workspace", "b.txt")), false, "what was refused was not done");
  const again = f.app.store.events(next.id).filter((event) => event.kind === "policy.denied" && event.data.reason === refusedAgain);
  assert.equal(again.length, 1, "trying the refused request again was refused, without asking");
  assert.equal(f.app.runtime.approvals.waiting(first.sessionId).length, 0, "and nothing was asked again");
  assert.match(String(f.seen.at(-1).messages[0].content), /answered No to this request of yours: "[^"]*b\.txt/, "the model was told what was refused");
});

test("a No to a task that came from elsewhere ends its wait and carries nothing on in the owner's window", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "write c.txt", source: "trigger" });
  assert.equal((await f.no(first)).body.task, "settled");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.runsIn(first.sessionId).length, 1);
  assert.equal(f.app.store.run(first.id).status, "cancelled");
});

test("a No to a short-lived key's task is never carried on as the owner's", async (t) => {
  const f = await fixture(t);
  const keyed = await underShortLivedKey(() => f.app.runtime.run({ prompt: "write k.txt" }), { keyId: "a-key" });
  assert.equal(keyed.status, "needs_input");
  assert.equal((await f.no(keyed)).body.task, "settled");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.runsIn(keyed.sessionId).length, 1);
});

test("with a newer task in the conversation, a No ends the old task's wait and starts nothing", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "write d.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  f.app.store.finish(f.app.store.createRun(f.app.runtime.owner, "tidy my notes", first.sessionId).id, "completed", "Tidied.");
  const said = await f.call("policy/approve", { sessionId: first.sessionId, decision: "deny", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.equal(said.body.task, "settled");
  assert.equal(f.app.store.run(first.id).status, "cancelled");
  assert.equal(f.runsIn(first.sessionId).length, 2, "nothing new started");
});
