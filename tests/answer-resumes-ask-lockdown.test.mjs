/**
 * Q050 review: a yes carries the task that asked on under its own id, and the call it asked about is made again and
 * decided again: QA R1, by the engine itself through the same gate, never by the model. Lockdown turned on between the question and the yes still refuses a program: the yes answers the
 * question, never Lockdown. Node only, through the window's own routes.
 * Mutation, turns the Lockdown test red: src/runtime.ts: drop the `lockdownToolRefusal` early return in the policy
 * check (the kept yes then answers the call under Lockdown).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Starts one program (process.start, which Lockdown refuses); never makes a call again (the engine does, QA R1). */
function model() {
  const command = () => ({ content: "", toolCalls: [{ id: `c${Math.random()}`, name: "process.start",
    arguments: JSON.stringify({ program: "node", args: ["-e", "1"], name: "a check" }) }] });
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "start the check") return command();
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-q050-lock-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  /* What became of the call the engine made again after the yes: answered by it ("policy.overruled"), or refused ("policy.denied"). */
  const afterYes = (runId) => {
    const events = app.store.events(runId);
    return events.slice(events.findIndex((event) => event.kind === "run.continued")).filter((event) => event.data.name === "process.start")
      .map((event) => ({ kind: event.kind, reason: String(event.data.reason ?? "") }));
  };
  return { app, call, afterYes };
}
const settled = async (check) => { for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const allow = (f, first, fingerprint) =>
  f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint, carryOn: true });

test("control: with Lockdown off, a yes carries the task on and answers the same call made again", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "start the check" });
  assert.equal(first.status, "needs_input", "it stopped to ask about the program");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await allow(f, first, asked.fingerprint)).body.task, "carrying-on");
  assert.ok(await settled(() => f.app.store.run(first.id).status === "completed"));
  const after = f.afterYes(first.id);
  assert.ok(after.some((event) => event.kind === "policy.overruled"), `the yes answered it: ${JSON.stringify(after)}`);
  assert.equal(f.app.store.events(first.id).filter((event) => event.kind === "run.approved_call").length, 1, "the engine made the call itself");
});

test("Lockdown turned on between the question and the yes: the call made again is refused by Lockdown, not answered by the yes", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "start the check" });
  assert.equal(first.status, "needs_input");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("lockdown", { on: true })).status, 200);
  const said = await allow(f, first, asked.fingerprint);
  assert.equal(said.status, 200, JSON.stringify(said.body));
  assert.ok(await settled(() => f.app.store.run(first.id).status !== "running"), "the task settled");
  assert.ok(f.app.store.events(first.id).some((event) => event.kind === "run.continued"), "control: the task that asked carried on");
  const after = f.afterYes(first.id);
  assert.equal(after.some((event) => event.kind === "policy.overruled"), false, `the yes did not answer it: ${JSON.stringify(after)}`);
  assert.ok(after.some((event) => event.kind === "policy.denied" && /Lockdown is on/.test(event.reason)), "Lockdown refused it, and says so");
  assert.deepEqual(f.app.store.runs(f.app.runtime.owner).filter((run) => run.sessionId === first.sessionId).map((run) => run.id), [first.id],
    "no second task");
});
