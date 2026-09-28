/**
 * QA retest R1 (P1): after the owner's yes, Branch asked the model to make the approved call again, and a small local
 * model (qwen2.5:7b) did so in about 2 of 11 tries, so "remember this" almost never saved. Now the engine runs the exact
 * approved call itself (same call id, same bytes, through the same gate) and the model carries on from the real result.
 * The scripted model here NEVER repeats a call: after a tool result it only says what it got.
 * Mutations, each turns a test here red:
 * - src/runtime.ts started: drop `if (approved) await this.runApproved(...)`: nothing is saved, written or run.
 * - src/approved-call.ts approvedWork: drop the `policy.execution_unknown` check: "asked after it started" runs twice.
 * - src/approved-call.ts approvedWork: drop the `ownBytes` check: "asked from inside" runs the outer call again.
 * - src/approved-call.ts approvedWork: drop the `ended` lookup: the restart test runs it twice.
 * - src/runtime.ts oneCall: drop the approvedRepeat check: "a model that repeats anyway" appends a second line.
 * - src/runtime.ts runApproved: call registry.execute in place of oneCall: the lapsed-yes test runs without a yes.
 * - src/store.ts finish: drop replaceNotRun, or askedCall's `event.id > lastStart`: "asks in words itself" keeps "not run".
 * (Each was built and run; all go red. approvedWork's `notRunMark` check is a backstop the `ended` lookup already covers.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, NeedsInputError, savePolicy } from "../dist/index.js";
import { z } from "zod";
import { startServer } from "../dist/server.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

const appendArgs = (line) => ({ executable: "node", args: ["-e", `require("fs").appendFileSync("log.txt", ${JSON.stringify(line + "\n")})`] });

/** Asks for one call per message, and never repeats one: after any tool result it reports what it got. */
function model(seen, options = {}) {
  let serial = 0;
  return { name: "scripted", async complete(request) {
    seen.push(request.messages);
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${++serial}`, name, arguments: JSON.stringify(args) }] });
    if (last?.role === "tool") {
      if (options.repeat && !options.repeated && /"ok":true/.test(text)) { options.repeated = true; return call("shell.execute", options.repeat); }
      return { content: `Got: ${text.slice(0, 200)}`, toolCalls: [] };
    }
    if (last?.role !== "user") return { content: "Done.", toolCalls: [] };
    if (/^remember (.+)$/.test(text)) return call("memory.put", { text: /^remember (.+)$/.exec(text)[1], source: "owner" });
    if (/^write (\S+)$/.test(text)) return call("files.write", { path: /^write (\S+)$/.exec(text)[1], content: "hello" });
    if (/^append (\S+)$/.test(text)) return call("shell.execute", appendArgs(/^append (\S+)$/.exec(text)[1]));
    if (text === "push it") return call("stand.push", { branch: "main" });
    if (text === "two facts") return { content: "", toolCalls: [
      { id: `c${++serial}`, name: "memory.put", arguments: JSON.stringify({ text: "Favourite colour is teal", source: "owner" }) },
      { id: `c${++serial}`, name: "memory.put", arguments: JSON.stringify({ text: "Briefs are five bullets", source: "owner" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-r1-"));
  const seen = [], pushes = { count: 0 };
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  const open = async () => {
    const app = await createBranch({ workspace, dataDir, provider: model(seen, options) });
    // Commands run through the shell tool, which a launch file lends (src/integrations/bootstrap.ts): node only.
    const launch = join(root, "integrations.json");
    await writeFile(launch, JSON.stringify({ shell: { executables: { node: { path: process.execPath } } } }));
    const integrations = await loadIntegrations(app.registry, launch, process.env, app.secretsFor, app.channelHost);
    savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes",
      rules: [{ tool: "memory.put", decision: "ask" }, { tool: "files.write", decision: "ask" }, { tool: "shell.execute", decision: "ask" },
        { tool: "stand.push", decision: "ask" }] });
    // A gated tool that, once it runs, asks the person in words (as git.push to main does without `confirmed`).
    app.registry.register({ name: "stand.push", permission: "files.write", description: "Stand-in for a push.",
      parameters: z.record(z.string(), z.unknown()), target: () => "main",
      execute: async () => { pushes.count++; throw new NeedsInputError("This would send your work straight to main. Shall I go ahead?"); } });
    const server = await startServer(app, { dataDir, port: 0, presence: "app" }); // a real start: lost questions are settled
    return { app, server, integrations };
  };
  let live = await open();
  const shut = async () => { await live.server.close().catch(() => undefined); await live.integrations.close().catch(() => undefined); await live.app.close().catch(() => undefined); };
  t.after(async () => { await shut(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${live.server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${live.server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const yes = async (run, remember = "never") => {
    const asked = live.app.runtime.approvals.questionFor(run.sessionId);
    assert.ok(asked, "control: a question is waiting");
    const said = await call("policy/approve", { sessionId: run.sessionId, decision: "allow", remember, fingerprint: asked.fingerprint, carryOn: true });
    assert.equal(said.status, 200, JSON.stringify(said.body));
    return said.body;
  };
  const settled = async (runId, status = "completed") => {
    for (let i = 0; i < 1200; i++) { if (live.app.store.run(runId)?.status === status) return true; await new Promise((r) => setTimeout(r, 25)); } // up to 30 s on a busy machine
    return false;
  };
  const restart = async () => {
    await shut();
    live = await open();
  };
  const facts = async () => JSON.stringify((await call("memory/export")).body);
  return { root, seen, pushes, call, yes, settled, restart, facts, get app() { return live.app; } };
}

/** The model-issued calls of one conversation, from its transcript. */
const modelCalls = (app, sessionId) => app.store.messages(sessionId).flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []));
const kinds = (app, runId, kind) => app.store.events(runId).filter((event) => event.kind === kind);

test("a yes saves the fact, writes the file and runs the command, though the model never makes a call again", async (t) => {
  const f = await fixture(t);
  for (const [prompt, check] of [
    ["remember my favourite colour is teal", async () => assert.match(await f.facts(), /favourite colour is teal/)],
    ["write a.txt", async () => assert.equal(readFileSync(join(f.root, "workspace", "a.txt"), "utf8"), "hello")],
    ["append one", async () => assert.equal(readFileSync(join(f.root, "workspace", "log.txt"), "utf8"), "one\n")],
  ]) {
    const first = await f.app.runtime.run({ prompt });
    assert.equal(first.status, "needs_input", `control (${prompt}): it stopped to ask`);
    const answered = await f.yes(first);
    assert.equal(answered.task, "carrying-on");
    assert.ok(await f.settled(first.id), `${prompt}: the task that asked finished`);
    await check();
    const calls = modelCalls(f.app, first.sessionId);
    assert.equal(calls.length, 1, `${prompt}: the model made one call, and the engine ran that one`);
    const [only] = calls;
    const done = kinds(f.app, first.id, "tool.completed").filter((event) => event.data.id === only.id);
    assert.equal(done.length, 1, `${prompt}: the approved call ran once, under its own id`);
    assert.ok(done[0].data.receipt?.mac, `${prompt}: with a receipt`);
    assert.deepEqual(kinds(f.app, first.id, "run.approved_call").map((event) => event.data.id), [only.id], `${prompt}: marked as the engine's run`);
    const result = f.app.store.messages(first.sessionId).find((m) => m.role === "tool" && m.toolCallId === only.id);
    assert.match(result.content, /"ok":true/, `${prompt}: the placeholder was replaced by the real result`);
    assert.doesNotMatch(result.content, /not_run/);
    const next = f.seen.at(-1).at(-1);
    assert.equal(next.role, "tool", `${prompt}: the model carried on from that result`);
    assert.equal(next.toolCallId, only.id);
    assert.match(String(f.seen.at(-1)[0].content), /Do not make that call again/);
  }
});

test("the yes still binds the exact request: a yes that lapsed asks again and runs nothing", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "append lapsed" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  // A yes for this conversation, taken back before the task carries on: the gate asks again rather than running it.
  f.app.runtime.approve(first.sessionId, "allow", "session", asked.fingerprint);
  f.app.runtime.approvals.revoke(first.sessionId, asked.tool, asked.target);
  await f.app.runtime.continueAsked(first.id);
  assert.equal(f.app.store.run(first.id).status, "needs_input", "the same task stops on the same call again");
  assert.equal(f.app.runtime.approvals.questionFor(first.sessionId).fingerprint, asked.fingerprint);
  assert.equal(existsSync(join(f.root, "workspace", "log.txt")), false, "nothing ran without a yes");
  const [only] = modelCalls(f.app, first.sessionId);
  assert.match(f.app.store.messages(first.sessionId).find((m) => m.toolCallId === only.id).content, /not_run/, "still marked as not run");
  await f.yes(f.app.store.run(first.id));
  assert.ok(await f.settled(first.id));
  assert.equal(readFileSync(join(f.root, "workspace", "log.txt"), "utf8"), "lapsed\n", "the next yes runs it, once");
});

test("a No still goes to the model as a refusal, and nothing runs", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "append refused" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  const said = await f.call("policy/approve", { sessionId: first.sessionId, decision: "deny", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.equal(said.body.task, "carrying-on");
  assert.ok(await f.settled(first.id));
  assert.equal(existsSync(join(f.root, "workspace", "log.txt")), false);
  assert.equal(kinds(f.app, first.id, "run.approved_call").length, 0);
  const [only] = modelCalls(f.app, first.sessionId);
  assert.match(f.app.store.messages(first.sessionId).find((m) => m.toolCallId === only.id).content, /said no/);
});

test("\"Yes, always\" keeps its rule and the engine runs the call under it", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "write kept.txt" });
  await f.yes(first, "always");
  assert.ok(await f.settled(first.id));
  assert.equal(readFileSync(join(f.root, "workspace", "kept.txt"), "utf8"), "hello");
  const again = await f.app.runtime.run({ prompt: "write kept.txt" });
  assert.equal(again.status, "completed", "the standing rule answers the next time without asking");
});

test("two calls in one reply: after each yes the engine runs it, and the second is asked about in turn", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "two facts" });
  assert.equal(first.status, "needs_input");
  await f.yes(first);
  assert.ok(await f.settled(first.id, "needs_input"), "the second call of the reply is asked about by the engine");
  assert.match(await f.facts(), /teal/);
  await f.yes(f.app.store.run(first.id));
  assert.ok(await f.settled(first.id));
  const saved = await f.facts();
  assert.match(saved, /teal/);
  assert.match(saved, /five bullets/);
  assert.equal(modelCalls(f.app, first.sessionId).length, 2, "the model asked for two calls, once each");
  for (const call of modelCalls(f.app, first.sessionId))
    assert.equal(kinds(f.app, first.id, "tool.completed").filter((event) => event.data.id === call.id).length, 1);
});

test("a model that makes the approved call again anyway is handed its result, and nothing runs twice", async (t) => {
  const args = appendArgs("twice");
  // The model re-sends it with its keys in another order (QA M1): the same request.
  const f = await fixture(t, { repeat: { args: args.args, executable: args.executable } });
  const first = await f.app.runtime.run({ prompt: "append twice" });
  await f.yes(first, "session");
  assert.ok(await f.settled(first.id));
  assert.equal(readFileSync(join(f.root, "workspace", "log.txt"), "utf8"), "twice\n", "one line: the repeat ran nothing");
  assert.equal(kinds(f.app, first.id, "run.approved_repeat").length, 1);
  const repeat = modelCalls(f.app, first.sessionId)[1];
  assert.ok(repeat, "control: the model did make it again");
  assert.match(f.app.store.messages(first.sessionId).find((m) => m.role === "tool" && m.toolCallId === repeat.id).content, /alreadyRun/);
});

test("a step asked about after its call started is never run again by the engine", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "append unknown" });
  const [only] = modelCalls(f.app, first.sessionId);
  // As the network wall or a recipe's inner step records it: the outer call may already have done something.
  f.app.store.event(first.id, "policy.execution_unknown", { id: only.id });
  await f.yes(first);
  assert.ok(await f.settled(first.id));
  assert.equal(kinds(f.app, first.id, "run.approved_call").length, 0, "the engine did not run it");
  assert.equal(existsSync(join(f.root, "workspace", "log.txt")), false);
});

test("a question about something other than the call's own bytes (asked from inside the tool) never runs the call", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "append inner" });
  const [only] = modelCalls(f.app, first.sessionId);
  // As a step inside a tool asks under the outer call's id: another tool, other bytes.
  f.app.store.event(first.id, "policy.ask", { name: "network.site", id: only.id, fingerprint: "0".repeat(32) });
  await f.yes(first);
  assert.ok(await f.settled(first.id));
  assert.equal(kinds(f.app, first.id, "run.approved_call").length, 0, "the engine did not run it");
  assert.equal(existsSync(join(f.root, "workspace", "log.txt")), false);
});

test("an approved call that then asks in words itself: its result says so, not \"not run\"", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "push it" });
  assert.equal(first.status, "needs_input", "control: the policy asked first");
  assert.equal(f.pushes.count, 0);
  await f.yes(first);
  assert.ok(await f.settled(first.id, "needs_input"), "the tool's own question stops the task again");
  assert.equal(f.pushes.count, 1, "the engine ran the approved call once");
  assert.equal(f.app.runtime.approvals.waiting(first.sessionId).length, 0, "nothing is waiting on the policy");
  const [only] = modelCalls(f.app, first.sessionId);
  const result = f.app.store.messages(first.sessionId).find((m) => m.role === "tool" && m.toolCallId === only.id).content;
  assert.match(result, /"outcome":"asked"/, "the question it put is its result now");
  assert.doesNotMatch(result, /not_run/);
});

test("run once across a restart: a call that ran before its result was written is not run again", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "append restart" });
  await f.yes(first);
  assert.ok(await f.settled(first.id));
  assert.equal(readFileSync(join(f.root, "workspace", "log.txt"), "utf8"), "restart\n");
  const [only] = modelCalls(f.app, first.sessionId);
  // Act out the gap between the step finishing and its result reaching the conversation, then a restart.
  f.app.store.setToolResult(first.sessionId, only.id, f.app.store.messages(first.sessionId).find((m) => m.toolCallId === only.id).content.replace(/"ok":true/, '"outcome":"not_run","ok":true'));
  f.app.store.event(first.id, "run.call_not_run", { id: only.id });
  f.app.store.finish(first.id, "interrupted", "");
  await f.restart();
  const again = await f.app.runtime.resume(first.id);
  assert.equal(again.status, "completed");
  assert.equal(readFileSync(join(f.root, "workspace", "log.txt"), "utf8"), "restart\n", "still one line");
  const marked = kinds(f.app, again.id, "run.approved_call");
  assert.deepEqual(marked.map((event) => event.data.ranBefore), [true], "its recorded result was put back instead");
});

test("a question lost to a restart: Continue asks again for the same call, and the yes runs it", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "remember the dog is called Rex" });
  assert.equal(first.status, "needs_input");
  await f.restart();
  assert.equal(f.app.store.run(first.id).status, "interrupted", "control: the question was lost");
  const again = await f.app.runtime.resume(first.id);
  assert.equal(again.status, "needs_input", "the engine put the same call to the gate again");
  const [only] = modelCalls(f.app, first.sessionId);
  assert.equal(f.app.store.events(again.id).filter((event) => event.kind === "attention.needed").at(-1).data.callId, only.id);
  await f.yes(again);
  assert.ok(await f.settled(again.id));
  assert.match(await f.facts(), /Rex/);
  assert.equal(modelCalls(f.app, first.sessionId).length, 1, "the model never made it again");
});
