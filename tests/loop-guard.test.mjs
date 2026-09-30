import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, LoopGuard, canonicalArguments, guardFor, isPollTool, loopGuardMode, repeatingCycle,
  saveLoopGuardSettings, whenNeededAfterCalls,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

const kinds = (guard, calls) => calls.map(([name, args]) => guard.check(name, JSON.stringify(args)).kind);

test("A1769 the same call with the same details is warned about, then refused", () => {
  const guard = new LoopGuard();
  const call = ["files.read", { path: "a.txt" }];
  assert.deepEqual(kinds(guard, [call, call, call, call, call]), ["allow", "allow", "warn", "warn", "block"]);
  // Key order does not make it a different call.
  assert.equal(canonicalArguments('{"b":1,"a":{"d":2,"c":3}}'), canonicalArguments('{"a":{"c":3,"d":2},"b":1}'));
  assert.equal(guard.check("files.read", '{ "path" : "a.txt" }').kind, "block");
  // Different details are a different call.
  assert.equal(guard.check("files.read", JSON.stringify({ path: "b.txt" })).kind, "allow");
});

test("A1769 a call that keeps giving back the same result is refused sooner", () => {
  const guard = new LoopGuard();
  const args = JSON.stringify({ path: "a.txt" });
  assert.equal(guard.check("files.read", args).kind, "allow");
  assert.equal(guard.record("files.read", args, '{"ok":true,"result":"same"}'), null);
  assert.equal(guard.check("files.read", args).kind, "allow");
  assert.match(guard.record("files.read", args, '{"ok":true,"result":"same"}'), /exactly the same result 2 times/);
  // A changed result is a different outcome and does not count towards the same one.
  assert.equal(guard.record("files.read", args, '{"ok":true,"result":"different"}'), null);
  guard.check("files.read", args);
  guard.record("files.read", args, '{"ok":true,"result":"same"}');
  const refused = guard.check("files.read", args);
  assert.equal(refused.kind, "block", "the fourth identical call is refused although the plain limit is five");
  assert.match(refused.reason, /keeps giving back the same result/);
});

test("A1713 back-and-forth between two calls is warned about, then refused", () => {
  const guard = new LoopGuard();
  const a = ["files.read", { path: "a.txt" }], b = ["files.write", { path: "a.txt", content: "x" }];
  assert.deepEqual(kinds(guard, [a, b, a, b]), ["allow", "allow", "allow", "warn"]);
  const [fifth, sixth] = kinds(guard, [a, b]);
  assert.equal(fifth, "warn");
  assert.equal(sixth, "block", "three full cycles are refused even though each call has only been made three times");
  assert.deepEqual(repeatingCycle(["x", "a", "b", "c", "a", "b", "c"]), { pattern: ["a", "b", "c"], repeats: 2 });
  assert.equal(repeatingCycle(["a", "a", "a", "a"]), null, "plain repetition is not a cycle");
  assert.equal(repeatingCycle(["a", "b", "c", "b"]), null);
});

test("tools meant to be polled get gentler limits, judged by name only", () => {
  assert.equal(isPollTool("process.read"), true);
  assert.equal(isPollTool("git.status"), true);
  assert.equal(isPollTool("files.write"), false);
  const guard = new LoopGuard();
  const poll = ["process.read", { id: "p1" }];
  assert.deepEqual(kinds(guard, Array(8).fill(poll)), Array(8).fill("allow"));
  assert.equal(guard.check(...[poll[0], JSON.stringify(poll[1])]).kind, "warn");
  // Words like "status" in the details do not make an ordinary tool a polled one.
  const other = new LoopGuard();
  const sneaky = ["files.write", { path: "status-wait-poll.txt", content: "status" }];
  assert.deepEqual(kinds(other, Array(5).fill(sneaky)), ["allow", "allow", "warn", "warn", "block"]);
});

test("A1769 repeated refusals stop the task, and it stays stopped", () => {
  const guard = new LoopGuard({ stopAfterBlocks: 2 });
  const call = ["files.read", { path: "a.txt" }];
  assert.deepEqual(kinds(guard, Array(7).fill(call)), ["allow", "allow", "warn", "warn", "block", "stop", "stop"]);
  assert.equal(guard.stats().stopped, true);
  assert.equal(guard.check("files.list", "{}").kind, "stop");
  assert.match(guard.stopReason(), /^Stopped: the assistant kept repeating the same steps/);
});

function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return reply(provider.requests.length); } };
  return provider;
}

test("A1769 a task that keeps asking for the same thing is ended with a plain sentence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-loop-"));
  t.after(async () => { await app.close(); await discardTemp(root); });
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "a.txt"), "same every time");
  const provider = scripted((round) => ({ content: "", toolCalls: [{ id: `c${round}`, name: "files.read", arguments: JSON.stringify({ path: "a.txt" }) }] }));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "on" });
  const run = await app.runtime.run({ prompt: "read it" });
  assert.equal(run.status, "failed");
  assert.match(run.output, /^Stopped: the assistant kept repeating the same steps without getting anywhere/);
  const events = app.store.events(run.id).map((event) => event.kind);
  for (const kind of ["loop.warned", "loop.blocked", "loop.stopped"]) assert.ok(events.includes(kind), `${kind} was written down`);
  assert.ok(provider.requests.length < 12, "the task ended well before the round limit");
  // Every call the model asked for has an answer in the conversation, so the next message can follow on.
  const messages = app.store.messages(run.sessionId);
  const asked = messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.id);
  const answered = new Set(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
  assert.deepEqual(asked.filter((id) => !answered.has(id)), []);
  const warned = messages.find((message) => message.role === "tool" && message.content.includes("loopWarning"));
  assert.ok(warned, "the warning travelled beside a result the model read");
  assert.ok(warned.content.indexOf("loopWarning") < warned.content.indexOf("same every time"), "the warning comes first");
  // The next task in the same conversation starts with a fresh guard.
  const next = await app.runtime.run({ prompt: "again", sessionId: run.sessionId });
  assert.equal(app.store.events(next.id).filter((event) => event.kind === "loop.blocked").length > 0, true);
  assert.equal(next.status, "failed");
});

test("ordinary work that does not repeat itself is left alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-loop-ok-"));
  t.after(async () => { await app.close(); await discardTemp(root); });
  const provider = scripted((round) => round <= 4
    ? { content: "", toolCalls: [{ id: `w${round}`, name: "files.write", arguments: JSON.stringify({ path: `n${round}.txt`, content: String(round) }) }] }
    : { content: "done", toolCalls: [] });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "on" });
  const run = await app.runtime.run({ prompt: "write four files" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(app.store.events(run.id).some((event) => event.kind.startsWith("loop.")), false);
});

test("the switch ships on, and switched off leaves a repeating task exactly as before", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-loop-off-"));
  t.after(async () => { await app.close(); await discardTemp(root); });
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "a.txt"), "same");
  const provider = scripted((round) => round <= 7
    ? { content: "", toolCalls: [{ id: `c${round}`, name: "files.read", arguments: JSON.stringify({ path: "a.txt" }) }] }
    : { content: "done", toolCalls: [] });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  assert.equal(loopGuardMode(app.store, app.runtime.owner), "on", "it ships on: it only tightens what a task may do");
  assert.notEqual(guardFor(loopGuardMode(app.store, app.runtime.owner)), null);
  saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "off" });
  assert.equal(loopGuardMode(app.store, app.runtime.owner), "off");
  assert.equal(guardFor("off"), null);
  const run = await app.runtime.run({ prompt: "read it seven times" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(app.store.events(run.id).some((event) => event.kind.startsWith("loop.")), false);
  assert.throws(() => saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "sometimes" }));
});

test("when needed: a small task is left alone except for a tight loop, a bigger one is watched in full", () => {
  assert.equal(whenNeededAfterCalls, 8, "the size at which a task is watched in full");
  const a = ["files.read", { path: "a.txt" }], b = ["files.write", { path: "a.txt", content: "x" }];
  // Back-and-forth in a small task is not warned about...
  const small = guardFor("when-needed");
  assert.deepEqual(kinds(small, [a, b, a, b]), ["allow", "allow", "allow", "allow"]);
  // ...but the very same call a third time is, even from the second step.
  const tight = guardFor("when-needed");
  assert.deepEqual(kinds(tight, [a, a, a]), ["allow", "allow", "warn"]);
  // Past the size, back-and-forth counts again.
  const big = guardFor("when-needed");
  const others = Array.from({ length: whenNeededAfterCalls }, (_, index) => ["files.read", { path: `f${index}.txt` }]);
  assert.deepEqual(kinds(big, others), Array(whenNeededAfterCalls).fill("allow"));
  assert.deepEqual(kinds(big, [a, b, a, b]), ["allow", "allow", "allow", "warn"]);
  // Repeated results are not held against a small task either.
  const quiet = guardFor("when-needed");
  quiet.check("files.read", "{}");
  assert.equal(quiet.record("files.read", "{}", "same"), null);
  quiet.check("files.read", "{}");
  assert.equal(quiet.record("files.read", "{}", "same"), null);
  assert.equal(guardFor("on").check("files.read", "{}").kind, "allow");
});

test("the switch is changed from the settings screen, and not with a short-lived key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-loop-api-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(() => ({ content: "ok", toolCalls: [] })) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (body, token = server.token) => {
    const response = await fetch(server.url + "/api/loop-guard", { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, host: new URL(server.url).host, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await call()).body, { mode: "on" }, "it ships on");
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 });
  assert.equal((await call({ mode: "off" }, key.token)).status, 401);
  assert.equal((await call({ mode: "when-needed" }, key.token)).status, 401);
  assert.deepEqual((await call({ mode: "when-needed" })).body, { mode: "when-needed" });
  assert.equal((await call({ mode: "maybe" })).status, 400);
  assert.equal(loopGuardMode(app.store, app.runtime.owner), "when-needed");
});

test("SELF-022: waiting on checks is a polled tool, so a long CI run and merge queue are waited on, not refused", () => {
  // Seen on the sandbox proof (pull request #5): the fifth identical github.wait_for_checks was refused while the merge queue ran.
  assert.equal(isPollTool("github.wait_for_checks"), true);
  const guard = new LoopGuard();
  const wait = ["github.wait_for_checks", { repo: "KeepOak/branch-selfdev-sandbox", number: 5, seconds: 300 }];
  assert.ok(kinds(guard, Array(8).fill(wait)).every((kind) => kind === "allow"), "eight waits of five minutes each are forty minutes of CI");
  assert.equal(isPollTool("github.merge_pull_request"), false, "merging is never a polled tool");
});
