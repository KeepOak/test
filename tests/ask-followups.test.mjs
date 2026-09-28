/**
 * Q050 follow-ups, through the window's own routes:
 * - A one-time yes is spent on the attempt it was given for, even when that attempt is refused (Lockdown turned on
 *   between the question and the yes). Once Lockdown is off, the same request is asked about again, never answered
 *   by the old yes.
 * - A tool the task was not given is refused before any question: nothing is put to the owner about it.
 * - An answer to a practice run's (dry run's) question keeps it a practice run: nothing is really done.
 * Mutations, each turns a test here red:
 * - src/approval-reviewer.ts reviewCall: drop the `check.decision === "deny"` spend: the old yes answers the later call.
 * - src/runtime.ts runToolCall: drop the `outsideReach` refusal: the out-of-reach call is put to the owner first.
 * - src/runtime.ts execute: drop the `startedAsDryRun` carry: the reply really writes the file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savePracticeRuns } from "../dist/practice-runs.js";

const repliedNote = /their answer is their newest message/;
const system = (request) => String(request.messages[0]?.content ?? "");
const start = () => ({ content: "", toolCalls: [{ id: `p${Math.random()}`, name: "process.start",
  arguments: JSON.stringify({ program: "node", args: ["-e", "1"], name: "a check" }) }] });
const write = (path) => ({ content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path, content: "hello" }) }] });

/** Starts a program when told to (after a yes the engine starts it, QA R1); asks where a trip goes, and writes the answer down. */
function model() {
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1), text = String(last?.content ?? "");
    if (last?.role === "user" && text === "start the check") return start();
    if (last?.role === "user" && text === "plan my trip")
      return { content: "", toolCalls: [{ id: `a${Math.random()}`, name: "user.ask", arguments: JSON.stringify({ question: "Where to?" }) }] };
    if (last?.role === "user" && repliedNote.test(system(request))) return write("trip.txt");
    if (last?.role === "user" && text === "write out.txt") return write("out.txt");
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-ask-followups-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const kinds = (runId, name) => app.store.events(runId).filter((event) => event.data?.name === name).map((event) => event.kind);
  return { app, root, call, kinds };
}
const settled = async (check) => { for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("a one-time yes Lockdown refused is spent: once Lockdown is off, the same request is asked about again", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "start the check" });
  assert.equal(first.status, "needs_input", "control: it asked about the program");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("lockdown", { on: true })).status, 200);
  const yes = await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.ok(await settled(() => f.app.store.run(first.id).status === "completed"), "the carried-on task finished");
  assert.ok(f.kinds(first.id, "process.start").includes("policy.denied"), "control: Lockdown refused the call the yes was for");
  assert.ok(f.kinds(first.id, "process.start").includes("policy.yes_spent"), "and the yes was spent on it");
  assert.equal((await f.call("lockdown", { on: false })).status, 200);
  // The same exact request, in the same conversation, after Lockdown is off.
  const again = await f.app.runtime.run({ prompt: "start the check", sessionId: first.sessionId });
  assert.equal(f.kinds(again.id, "process.start").includes("policy.overruled"), false, "the old yes did not answer it");
  assert.equal(again.status, "needs_input", "it is asked about again");
  assert.equal(f.app.runtime.approvals.questionFor(first.sessionId).fingerprint, asked.fingerprint, "the very same request");
});

test("a tool the task was not given is refused before any question, and nothing is put to the owner", async (t) => {
  const f = await fixture(t);
  const run = await f.app.runtime.run({ prompt: "write out.txt", permissions: ["files.read"] });
  assert.equal(run.status, "completed", "the task did not stop to ask");
  const seen = f.kinds(run.id, "files.write");
  assert.equal(seen.includes("policy.ask"), false, `no question about it: ${seen.join(", ")}`);
  assert.ok(f.app.store.events(run.id).some((event) => event.kind === "tool.failed" && event.data.error === "Permission denied: files.write"));
  assert.equal(f.app.runtime.approvals.waiting(run.sessionId).length, 0);
  assert.equal(existsSync(join(f.root, "workspace", "out.txt")), false);
  // Control: given the tool, the same message is asked about as before.
  const given = await f.app.runtime.run({ prompt: "write out.txt" });
  assert.equal(given.status, "needs_input");
  assert.ok(f.kinds(given.id, "files.write").includes("policy.ask"));
});

test("a reply to a practice run's question keeps it a practice run: nothing is really written", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "plan my trip", dryRun: true });
  assert.equal(first.status, "needs_input", "control: the practice run asked where to");
  savePracticeRuns(f.app.store, f.app.runtime.owner, { enabled: false });
  const reply = await f.call("run", { prompt: "Paris", sessionId: first.sessionId });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.id, first.id, "control: the reply went to the task that asked");
  assert.ok(await settled(() => f.app.store.run(first.id).status === "completed"));
  assert.equal(existsSync(join(f.root, "workspace", "trip.txt")), false, "the reply did not really write the file");
  assert.ok(f.kinds(first.id, "files.write").includes("tool.simulated"), "the write was practised, as a dry run does");
  assert.ok(f.app.store.events(first.id).some((event) => event.kind === "dryrun.report"));
});
