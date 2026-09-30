// UI-271: the context audit reads the request actually sent, and the owner may leave a plain read result out of future
// requests (and put it back); policy or approval evidence, and a stale request, cannot be changed.
import test from "node:test";
import assert from "node:assert/strict";
import { ContextAudit } from "../dist/context-audit.js";

function store(runId, sessionId) {
  const rows = new Map(), events = [];
  return { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }),
    runs: () => [{ id: runId, sessionId }], events: () => [], event: (...e) => events.push(e), logged: events };
}
const run = { id: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", owner: "owner" };
const messages = [
  { role: "system", content: "You are Branch." },
  { role: "user", content: "read the notes" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: "{\"path\":\"notes.md\"}" }, { id: "c2", name: "files.read", arguments: "{\"path\":\"POLICY.md\"}" }] },
  { role: "tool", toolCallId: "c1", content: "a very long notes file ".repeat(50) },
  { role: "tool", toolCallId: "c2", content: "approval rules" },
];

test("a plain read result can be left out of future requests and put back; protected evidence cannot", () => {
  const s = store(run.id, run.sessionId), audit = new ContextAudit();
  const requestId = audit.capture(s, run, messages, [{ name: "files.read", description: "read", parameters: {} }], "m", 100000);
  const view = audit.read(s, "owner", run.sessionId);
  assert.equal(view.available, true);
  assert.deepEqual(view.items.map((i) => [i.callId, i.removable]), [["c1", true], ["c2", false]]);
  assert.throws(() => audit.change(s, "owner", run.sessionId, run.id, requestId, "c2", true), /protected/);
  assert.throws(() => audit.change(s, "owner", run.sessionId, run.id, "33333333-3333-4333-8333-333333333333", "c1", true), /changed/);
  audit.change(s, "owner", run.sessionId, run.id, requestId, "c1", true);
  const sent = audit.prepare(s, run, messages);
  assert.match(sent[3].content, /left out of future model context/);
  assert.equal(sent[4].content, "approval rules");
  assert.equal(messages[3].content.startsWith("a very long"), true, "the conversation itself is untouched");
  audit.change(s, "owner", run.sessionId, run.id, requestId, "c1", false);
  assert.equal(audit.prepare(s, run, messages)[3].content, messages[3].content, "put back");
  assert.equal(audit.read(s, "someone-else", run.sessionId).available, false);
});
