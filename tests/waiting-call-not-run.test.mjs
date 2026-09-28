/**
 * QA retest 2026-09-28 (M2): a task that stops to ask the person left its waiting call with the result "No durable tool
 * result was recorded (needs_input). Side effects may have occurred". The call never ran (Dogfood F8), and a local model
 * read that as a failure and gave up instead of making the allowed call again. A waiting call now says it has not run and
 * to carry on from the answer (the note after the answer says what to send); a question the model itself asked says the answer is the next message; any other gap
 * is still an unknown outcome. Node only: the real dist/, a scripted model, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { reconcileTranscript } from "../dist/transcript.js";

const turn = (...names) => [{ role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: names.map((name, i) => ({ id: `c${i}`, name, arguments: "{}" })) }];
const results = (messages) => messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));

test("a call waiting on the person's answer is marked not run; the model's own question is marked asked; others stay unknown", () => {
  const [waiting, asked] = results(reconcileTranscript(turn("files.write", "user.ask"), "needs_input").messages);
  assert.equal(waiting.outcome, "not_run");
  assert.match(waiting.error, /^Not run:/);
  assert.match(waiting.error, /Carry on from their answer/);
  assert.doesNotMatch(waiting.error, /exactly as before/, "what to send next is the answer note's to say (a push is sent again with confirmed)");
  assert.doesNotMatch(waiting.error, /Side effects may have occurred/);
  assert.equal(asked.status, "asked");
  assert.match(asked.note, /next message .* is their answer/);
  for (const reason of ["interrupted", "failed", "budget_exceeded", "startup recovery"]) {
    const [gap] = results(reconcileTranscript(turn("files.write"), reason).messages);
    assert.equal(gap.outcome, "unknown", `${reason} keeps the unknown outcome`);
    assert.match(gap.error, /Side effects may have occurred/);
  }
});

test("after the window's yes, the model is handed the waiting call as not run, and the carried-on task does the work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-waiting-"));
  const seen = [];
  const provider = { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user") return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) }] };
    if (last?.role === "tool" && !/"ok":true/.test(last.content)) {
      seen.push(JSON.parse(last.content));
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) }] };
    }
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const first = await app.runtime.run({ prompt: "write a.txt" });
  assert.equal(first.status, "needs_input", "control: it stopped to ask");
  const stored = app.store.messages(first.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.deepEqual(stored.map((r) => r.outcome), ["not_run"], "the waiting call is kept as not run");
  const question = app.runtime.approvals.questionFor(first.sessionId);
  const answered = await fetch(`${server.url}/api/policy/approve`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint, carryOn: true }) });
  assert.equal(answered.status, 200);
  for (let i = 0; i < 100 && app.store.run(first.id).status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.store.run(first.id).status, "completed");
  assert.equal(seen[0]?.outcome, "not_run", "the model was told the call had not run");
  assert.equal(await readFile(join(root, "workspace", "a.txt"), "utf8"), "hi", "and the allowed call ran");
});
