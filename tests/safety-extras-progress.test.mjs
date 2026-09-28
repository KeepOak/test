/**
 * mac7/r17-g: "is this getting anywhere?" (R17-065) and tidying the history before it is sent (R17-067).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { RepeatedText, judgeMessages, readVerdict, roundSignature } from "../dist/safety-extras/progress-judge.js";
import { repairHistory } from "../dist/safety-extras/history-repair.js";
import { saveLoopGuardSettings } from "../dist/loop-guard.js";

test("one passage said over and over is noticed; ordinary text, code and tables are not", () => {
  const stuck = new RepeatedText();
  let found = false;
  for (let i = 0; i < 12 && !found; i++) found = stuck.add("I will now check the configuration file again. ");
  assert.equal(found, true);
  const prose = new RepeatedText();
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau".split(" ");
  let text = "";
  for (let i = 0; i < 400; i++) text += `${words[(i * 7) % words.length]}${i} `;
  assert.equal(prose.add(text), false);
  const code = new RepeatedText();
  assert.equal(code.add("```\n" + "console.log('same line of code here, again');\n".repeat(30) + "```\n"), false);
  const table = new RepeatedText();
  assert.equal(table.add("| a | b |\n" + "|---------------------------|---------------------------|\n".repeat(30)), false);
});

test("the judge is asked with the recent steps as data, and only a clear verdict counts", () => {
  const asked = judgeMessages([{ role: "system", content: "secret instructions" }, { role: "user", content: "fix the build" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "shell.execute", arguments: "{\"executable\":\"make\"}" }] }]);
  assert.equal(asked[0].role, "system");
  assert.match(asked[0].content, /BOTH are true/);
  assert.equal(asked[1].content.includes("secret instructions"), false);
  assert.match(asked[1].content, /shell\.execute\(\{"executable":"make"\}\)/);
  assert.deepEqual(readVerdict('```json\n{"stuck": true, "confidence": 0.95, "reason": "same error"}\n```'), { stuck: true, confidence: 0.95, reason: "same error" });
  assert.equal(readVerdict("I think it is stuck"), null);
  assert.equal(readVerdict('{"stuck": "yes"}'), null);
  assert.equal(readVerdict('{"stuck": true, "confidence": 7}').confidence, 1);
});

async function served(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-progress-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => (await fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return { app, api };
}
const lookup = (i) => ({ id: `c${i}`, name: "memory.search", arguments: JSON.stringify({ query: `thing ${i}` }) });

/* QA 2026-09-28: a round is judged on what it did. The canary's task said the same sentence before reading a different
   file each round and was stopped as stuck; the same call with the same arguments after the same result is stuck. */
test("a round is known by its calls and the results it answers; its words count only when it does nothing else", () => {
  const answer = (content, calls) => ({ role: "assistant", content, ...(calls.length ? { toolCalls: calls } : {}) });
  const turn = (content, calls, results = []) => [{ role: "user", content: "go" }, ...results.map(([id, text]) => result(id, text)), answer(content, calls)];
  const sign = (content, calls, results) => roundSignature(content, turn(content, calls, results));
  assert.notEqual(sign("Let me look.", [lookup(1)]), sign("Let me look.", [lookup(2)]), "same words, another call: progress");
  assert.notEqual(sign("Again.", [lookup(1)], [["c0", "one"]]), sign("Again.", [lookup(1)], [["c0", "two"]]), "same call after a new result: progress");
  assert.equal(sign("Checking.", [lookup(1)], [["c0", "same"]]), sign("Checking once more!", [lookup(1)], [["c0", "same"]]), "same call after the same result: the same round, however worded");
  const reordered = { ...lookup(1), arguments: JSON.stringify({ query: "thing 1" }).replace("{", "{ ") };
  assert.equal(sign("x", [lookup(1)]), sign("x", [reordered]), "the arguments are compared as values");
  assert.notEqual(sign("All done.", []), sign("Nearly done.", []), "a round with no call is known by its words");
});

test("the same words before a different step each round is progress, and the task runs on", async (t) => {
  let turn = 0;
  const provider = { name: "scripted", async complete(request) {
    if (request.messages[0]?.content?.includes("You check whether an assistant is stuck")) return { content: '{"stuck": false, "confidence": 0.99}', toolCalls: [] };
    turn += 1;
    return { content: "Let me look at the next part of this, one more time, carefully.", toolCalls: [lookup(turn)] };
  } };
  const { app, api } = await served(t, provider);
  await api("/api/safety-extras/switch", { part: "progress-judge", mode: "when-needed" });
  const moving = await api("/api/run", { prompt: "go" });
  assert.match(moving.output, /went back to the model 12 times/, moving.output);
  assert.ok(turn >= 12, `every round ran: each one looked up something new (${turn})`);
  assert.equal(app.store.events(moving.id).some((event) => event.kind === "progress.stopped"), false);
});

test("the same call with the same arguments after the same result is stuck, and ended in one sentence", async (t) => {
  let turn = 0;
  const provider = { name: "scripted", async complete() {
    turn += 1;
    return { content: `Checking that again (${turn}).`, toolCalls: [lookup(0)] };
  } };
  const { app, api } = await served(t, provider);
  // The tool loop guard would refuse these calls itself; switched off, the progress check alone is tested.
  saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "off" });
  await api("/api/safety-extras/switch", { part: "progress-judge", mode: "when-needed" });
  const stopped = await api("/api/run", { prompt: "go" });
  assert.match(stopped.output, /^Stopped: the assistant was not getting anywhere \(it gave the same answer again and again\)/, stopped.output);
  assert.equal(turn, 4, "the first round answers nothing yet; the next three are the same call after the same result");
  assert.ok(app.store.events(stopped.id).some((event) => event.kind === "progress.stopped"));
});

test("the judge ends a long task only when it is sure", async (t) => {
  let turn = 0, verdict = '{"stuck": false, "confidence": 0.99}';
  const judged = [];
  const provider = { name: "scripted", async complete(request) {
    if (request.messages[0]?.content?.includes("You check whether an assistant is stuck")) { judged.push(request.tools.length); return { content: verdict, toolCalls: [] }; }
    turn += 1;
    return { content: `Step ${turn}: looking at part ${turn}.`, toolCalls: [lookup(turn)] };
  } };
  const { app, api } = await served(t, provider);
  await api("/api/safety-extras/switch", { part: "progress-judge", mode: "on" });
  const moving = await api("/api/run", { prompt: "go" });
  assert.match(moving.output, /went back to the model 12 times/);
  assert.deepEqual(judged, [0, 0, 0, 0], "asked at rounds 3, 6, 9 and 12, with no tools");
  turn = 0; judged.length = 0;
  verdict = '{"stuck": true, "confidence": 0.95, "reason": "it reads the same thing each round"}';
  const ended = await api("/api/run", { prompt: "go" });
  assert.match(ended.output, /^Stopped: the assistant was not getting anywhere \(it reads the same thing each round\)/);
  assert.equal(turn, 3);
  verdict = '{"stuck": true, "confidence": 0.5}';
  turn = 0; judged.length = 0;
  await api("/api/safety-extras/switch", { part: "progress-judge", mode: "when-needed" });
  const unsure = await api("/api/run", { prompt: "go" });
  assert.match(unsure.output, /went back to the model 12 times/);
  assert.deepEqual(judged, [0, 0], "when needed asks at rounds 6 and 10");
  assert.ok(app.store.events(unsure.id).some((event) => event.kind === "progress.judged" && event.data.round === 6));
});

const call = (id, name = "files.read") => ({ id, name, arguments: "{}" });
const result = (id, content = "ok") => ({ role: "tool", toolCallId: id, content });

test("history repair: orphans, repeats and missing results; the kept list is not touched", () => {
  const history = [
    { role: "user", content: "hi" },
    result("ghost"),
    { role: "assistant", content: "", toolCalls: [call("a"), call("a"), call("b")] },
    result("a"),
    { role: "user", content: "[picture]" },
    result("b"),
    result("b", "again"),
    { role: "assistant", content: "", toolCalls: [call("c")] },
    { role: "user", content: "stop" },
  ];
  const frozen = JSON.stringify(history);
  const { messages, fixes } = repairHistory(history, "needed");
  assert.equal(JSON.stringify(history), frozen);
  assert.deepEqual(messages.map((m) => m.role === "tool" ? `tool:${m.toolCallId}` : m.role === "assistant" ? `assistant:${m.toolCalls.map((c) => c.id).join("")}` : `user:${m.content}`), [
    "user:hi", "assistant:ab", "tool:a", "tool:b", "user:[picture]", "assistant:c", "tool:c", "user:stop",
  ]);
  assert.match(messages[6].content, /may or may not have happened/);
  assert.deepEqual(fixes.sort(), [
    "added a stand-in result for files.read", "dropped 1 repeated call(s)", "dropped a result with no call before it",
    "dropped a second result for one call", "moved 1 message(s) after the results they interrupted",
  ].sort());
  const clean = [{ role: "user", content: "a" }, { role: "assistant", content: "", toolCalls: [call("x")] }, result("x"), { role: "assistant", content: "done" }];
  assert.deepEqual(repairHistory(clean, "full"), { messages: clean, fixes: [] });
});

test("history repair: a local model's call ids, reused in every answer, keep their real results", () => {
  // Ollama and LM Studio number calls afresh each answer. Before, the second "call_0" result was dropped as a repeat,
  // so an approved call looked as if it never happened.
  const history = [
    { role: "user", content: "read both" },
    { role: "assistant", content: "", toolCalls: [call("call_0")] }, result("call_0", "first file"),
    { role: "assistant", content: "", toolCalls: [call("call_0")] }, result("call_0", "second file"),
    { role: "assistant", content: "Both read." },
  ];
  const { messages, fixes } = repairHistory(history, "needed");
  assert.deepEqual(fixes, []);
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.content), ["first file", "second file"]);
  // A repeat inside one answer is still a repeat.
  const twice = repairHistory([{ role: "assistant", content: "", toolCalls: [call("call_0")] }, result("call_0"), result("call_0", "again")], "needed");
  assert.deepEqual(twice.fixes, ["dropped a second result for one call"]);
});

test("history repair when on also joins messages in a row and drops empty answers", () => {
  const { messages, fixes } = repairHistory([
    { role: "user", content: "one" }, { role: "user", content: "two", images: [{ mime: "image/png", data: "x" }] },
    { role: "assistant", content: "  " }, { role: "assistant", content: "first" }, { role: "assistant", content: "second" },
  ], "full");
  assert.deepEqual(messages, [
    { role: "user", content: "one\n\ntwo", images: [{ mime: "image/png", data: "x" }] },
    { role: "assistant", content: "first\n\nsecond" },
  ]);
  assert.equal(fixes.length, 3);
  assert.equal(repairHistory([{ role: "user", content: "one" }, { role: "user", content: "two" }], "needed").fixes.length, 0);
});

test("inside the app the sent copy is repaired and the task says so", async (t) => {
  const seen = [];
  const provider = { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Done.", toolCalls: [] }; } };
  const { app, api } = await served(t, provider);
  const first = await api("/api/run", { prompt: "hello" });
  // A broken history, as an interrupted import might leave it: a result with no call.
  app.store.message(first.sessionId, { role: "tool", toolCallId: "lost", content: "{}" });
  await api("/api/run", { prompt: "again", sessionId: first.sessionId });
  assert.equal(seen[1].some((m) => m.toolCallId === "lost"), false, "ships when needed: the orphan is not sent");
  await api("/api/safety-extras/switch", { part: "history-repair", mode: "off" });
  const offRun = await api("/api/run", { prompt: "off now", sessionId: first.sessionId });
  assert.ok(seen[2].some((m) => m.toolCallId === "lost"), "the owner's off: sent as it was");
  void offRun;
  await api("/api/safety-extras/switch", { part: "history-repair", mode: "when-needed" });
  const third = await api("/api/run", { prompt: "and again", sessionId: first.sessionId });
  assert.equal(seen[3].some((m) => m.toolCallId === "lost"), false);
  assert.ok(app.store.messages(first.sessionId).some((m) => m.toolCallId === "lost"), "the kept conversation is unchanged");
  assert.ok(app.store.events(third.id).some((event) => event.kind === "history.repaired"));
});
