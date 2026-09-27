/**
 * Redesign security review (F2), a backstop in Runtime.approve behind the callers' own checks (Q257, Q258, the chat's
 * shown question): an answer that names no request (no fingerprint) lands on a question only when it is the only one
 * waiting in that conversation. With several waiting it is refused and nothing is answered, because the oldest may be a
 * different request from the one the person was shown. Scripted; nothing reaches a provider.
 * Mutation: dropping the check in Runtime.approve turns the first test red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-approve-names-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const question = (sessionId, runId, tool, target, fingerprint) => ({
  runId, sessionId, tool, target, label: `${tool} ${target}`, question: `May it ${tool}?`, source: "owner",
  remember: "session", askedAt: new Date().toISOString(), ...(fingerprint ? { fingerprint } : {}),
});

test("with two requests waiting, an answer that names neither is refused and both still wait", async (t) => {
  const app = await branch(t);
  const session = "11111111-1111-4111-8111-111111111111";
  app.runtime.approvals.ask(question(session, "run-a", "network.site", "example.com", "d".repeat(32)));
  app.runtime.approvals.ask(question(session, "run-b", "process.start", "rm -rf build", "a".repeat(32)));
  assert.throws(() => app.runtime.approve(session, "allow", "never"), /More than one request in this conversation is waiting/);
  assert.equal(app.runtime.approvals.waiting(session).length, 2, "nothing was answered");
});

test("with one request waiting, an answer that names none still lands on it", async (t) => {
  const app = await branch(t);
  const session = "44444444-4444-4444-8444-444444444444";
  app.runtime.approvals.ask(question(session, "run-a", "network.site", "example.com", "d".repeat(32)));
  assert.equal(app.runtime.approve(session, "deny", "never").tool, "network.site");
  assert.equal(app.runtime.approvals.waiting(session).length, 0);
});

test("an answer that names its request still lands on exactly that one", async (t) => {
  const app = await branch(t);
  const session = "22222222-2222-4222-8222-222222222222";
  app.runtime.approvals.ask(question(session, "run-a", "network.site", "example.com"));
  app.runtime.approvals.ask(question(session, "run-b", "process.start", "rm -rf build", "b".repeat(32)));
  const answered = app.runtime.approve(session, "deny", "never", "b".repeat(32));
  assert.equal(answered.tool, "process.start");
  assert.deepEqual(app.runtime.approvals.waiting(session).map((q) => q.tool), ["network.site"]);
});

test("an answer that names a request no longer waiting (a stale card) is refused, and both still wait", async (t) => {
  const app = await branch(t);
  const session = "33333333-3333-4333-8333-333333333333";
  app.runtime.approvals.ask(question(session, "run-a", "process.start", "rm -rf build", "a".repeat(32)));
  app.runtime.approvals.ask(question(session, "run-b", "network.site", "example.com", "b".repeat(32)));
  assert.throws(() => app.runtime.approve(session, "allow", "never", "c".repeat(32)), /different request/);
  assert.equal(app.runtime.approvals.waiting(session).length, 2, "nothing was answered");
});
