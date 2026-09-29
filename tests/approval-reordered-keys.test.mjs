/**
 * QA retest 2026-09-28 (M1): after the owner allowed a request, a local model made the call "again, exactly as before"
 * with the same object but its keys in another order. The yes was bound to the raw bytes, so the task asked the same
 * question again, for ever, and the note was never saved. A yes now covers the same request however its JSON is spelled;
 * any other change to a key or a value is still a new question. Node only: the real dist/, a scripted model, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { argumentFingerprint } from "../dist/runtime.js";

test("a fingerprint is the same for the same JSON however it is spelled, and different for any other request", () => {
  const print = (bytes) => argumentFingerprint("files.write", bytes);
  const one = print('{"path":"a.txt","content":"hello"}');
  assert.equal(print('{"content":"hello","path":"a.txt"}'), one, "keys in another order are the same request");
  assert.equal(print('{ "content" : "hello",\n "path": "a.txt" }'), one, "and so is other spacing");
  assert.equal(print('{"a":{"y":1,"x":[{"q":2,"p":1}]}}'), print('{"a":{"x":[{"p":1,"q":2}],"y":1}}'), "nested objects too");
  assert.notEqual(print('{"path":"a.txt","content":"hellO"}'), one, "one character of a value is a new question");
  assert.notEqual(print('{"path":"a.txt","contents":"hello"}'), one, "so is a renamed key");
  assert.notEqual(print('{"path":"a.txt","content":"hello","mode":"append"}'), one, "and an added one");
  assert.notEqual(print('{"a":[1,2]}'), print('{"a":[2,1]}'), "a list keeps its order");
  assert.notEqual(print('{"a":"1"}'), print('{"a":1}'), "a string is not a number");
  assert.notEqual(print("x"), print(" x"), "bytes that are not JSON stay exact");
  assert.notEqual(argumentFingerprint("files.read", '{"path":"a.txt"}'), argumentFingerprint("files.write", '{"path":"a.txt"}'),
    "the same bytes to another tool are another question");
});

/**
 * Writes the file its first message names. QA R1: after a yes the engine makes the approved call itself, so this model
 * sends a call back only once, after that result: the same call with its keys the other way round, or a changed one.
 */
function reorderingWriter(changeOnRetry) {
  let file = "", retried = false;
  return { name: "reorderer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(last?.content ?? ""));
    if (last?.role === "user" && named) {
      file = named[1];
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: file, content: "hello" }) }] };
    }
    if (last?.role === "tool" && !retried) {
      retried = true;
      const retry = changeOnRetry ? { content: "hello!", path: file } : { content: "hello", path: file };
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify(retry) }] };
    }
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t, changeOnRetry = false) {
  const root = await mkdtemp(join(tmpdir(), "branch-reordered-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: reorderingWriter(changeOnRetry) });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const approve = async (sessionId, fingerprint) => (await fetch(`${server.url}/api/policy/approve`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, decision: "allow", remember: "never", fingerprint, carryOn: true }) })).status;
  const asked = (runId) => app.store.events(runId).filter((event) => event.kind === "policy.ask" && !event.data.step).length;
  return { app, root, approve, asked };
}
const settled = async (check) => { for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("the window's yes carries the task on when the model sends the same call back with its keys in another order", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "write a.txt" });
  assert.equal(first.status, "needs_input", "control: it stopped to ask");
  const question = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal(await f.approve(first.sessionId, question.fingerprint), 200);
  assert.ok(await settled(() => f.app.store.run(first.id).status !== "running"), "the task settled");
  assert.equal(f.app.store.run(first.id).status, "completed", "it finished instead of asking the same question again");
  assert.equal(f.app.store.events(first.id).filter((event) => event.kind === "run.approved_repeat").length, 1,
    "the reordered call got the approved call's result, and nothing ran twice");
  assert.equal(await readFile(join(f.root, "workspace", "a.txt"), "utf8"), "hello", "and did what the yes was for");
  assert.equal(f.asked(first.id), 1, "the owner was asked once");
});

test("a yes still never covers a call that came back changed", async (t) => {
  const f = await fixture(t, true);
  const first = await f.app.runtime.run({ prompt: "write b.txt" });
  const question = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal(await f.approve(first.sessionId, question.fingerprint), 200);
  assert.ok(await settled(() => f.app.store.run(first.id).status !== "running"), "the task settled");
  assert.equal(f.app.store.run(first.id).status, "needs_input", "the changed call is asked about again");
  assert.equal(await readFile(join(f.root, "workspace", "b.txt"), "utf8"), "hello", "only the approved request was written, not the changed one");
  assert.equal(f.asked(first.id), 2, "a second question, for the changed call");
});
