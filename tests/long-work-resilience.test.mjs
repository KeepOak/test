/**
 * Long work never silently dies. Each failure is played by a stand-in model (or program) that fails on cue, against a
 * real engine (createBranch + startServer, driven through its HTTP routes); the task must survive, and its live step
 * list (GET /api/runs/:id/live) must say what happened in plain words with the one next step:
 *
 * - a plan limit with a second account the work may move to: it moves, and says so (sharing ships on);
 * - a plan limit with nowhere to move: the task waits for the plan meter's reset time and carries on by itself;
 * - a dropped connection: asked again with a growing wait, then carries on;
 * - a tool that crashes: its error goes back to the model, which recovers;
 * - a model that goes quiet: asked again;
 * - the owner's Pause and Resume: it stops after the step it is on and carries on from there, nothing done twice;
 * - the engine killed mid-task: the next start picks the task up from its last step by itself (no gateway needed) and
 *   nothing that reached outside happens twice.
 *
 * Mutation notes (each turns this file red):
 * - src/runtime.ts waitOutLimit: return false at once and "waits for the reset" ends failed.
 * - src/accounts/pool-provider.ts markLimited: drop `metered` and the limit's reset is unknown, so the task fails.
 * - src/runtime.ts outlast: return false and "dropped connection" fails.
 * - src/accounts/settings.ts autoSwitch default(false) and "moves to the next account" fails.
 * - src/accounts/settings.ts mode default("off") and "moves to the next account" fails (several accounts ships on).
 * - src/runtime.ts checkPaused: drop the call and Pause never takes effect ("pause" times out).
 * - src/long-work.ts resumeMode: return gatewayMode and the restart is never picked up ("killed mid-task").
 * - src/live-steps.ts stateLines: drop a case and its line is missing.
 * - src/accounts/pool-provider.ts shared: drop the "model.account_moved" note and the move is said only after the answer.
 * - src/run-steps.ts runSteps: drop `switched` and the move is not kept once the task ends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode } from "../dist/accounts/manage.js";
import { freshState } from "../dist/accounts/pool.js";
import { isNetworkDrop, limitResetsAt, resumeMode, LongWorkSettingsSchema } from "../dist/long-work.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { switchedLines } from "../dist/run-steps.js";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";

const POOL = "cli-claude-code";

async function fixture(t, provider, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-long-work-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}), ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  /** The live step list, read through the engine's own stream until the task ends. */
  const live = async (runId) => {
    const response = await fetch(`${server.url}/api/runs/${runId}/live`, { headers: { authorization: `Bearer ${server.token}` } });
    const text = await response.text();
    const lists = [...text.matchAll(/^event: steps\ndata: (.*)$/gm)].map((m) => JSON.parse(m[1]));
    return lists.at(-1);
  };
  return { app, server, call, live, root };
}
const stateLines = (snap) => (snap?.steps ?? []).filter((s) => s.kind === "state");
async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise((r) => setTimeout(r, 25)); }
}

/* ---------- plan limits ---------- */
const limited = { code: 1, stdout: "", stderr: "Claude usage limit reached." };
const answer = (text) => ({ code: 0, stdout: JSON.stringify({ result: text }), stderr: "" });
/** Claude Code, answered per account folder by a stand-in; `outcomes(who, n)` says what each call gets. */
async function program(t, fx, service, outcomes) {
  const seen = [];
  const run = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    return outcomes(who, seen.filter((w) => w === who).length) ?? answer(`from ${who}`);
  };
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" }, {}, run);
  fx.app.runtime.models.configure(fx.app.runtime.owner, { activePreset: POOL });
  service.deps.spawnAgent = run;
  await fakeClaudeAccounts(t, service); // Claude Code answers through its native transport; the stand-in plays each account
  return seen;
}

test("a plan limit moves the work to the owner's next account, by default, and says so", async (t) => {
  const fx = await fixture(t);
  const service = accountsServiceFor(fx.app.runtime.models);
  const seen = await program(t, fx, service, (who) => (who === "primary" ? limited : null));
  assert.equal(service.on(), true, "several accounts per connection ships on");
  const work = (await addAccount(service, { pool: POOL, label: "Work" })).accounts.at(-1).id;
  assert.equal(service.settings().pools[0].autoSwitch, true, "moving to the next account ships on");
  const run = await fx.call("run", { prompt: "hello" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, `from ${work}`);
  assert.deepEqual(seen, ["primary", work]);
  const lines = stateLines(await fx.live(run.id));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].label, "Moved to “Work” — “Your usual sign-in” hit its limit");
  assert.equal(lines[0].result, null, "one line says it all");
  const kinds = fx.app.store.events(run.id).map((e) => e.kind);
  const moved = kinds.indexOf("model.account_moved");
  assert.ok(moved >= 0 && moved < kinds.indexOf("model.account"), "said the moment it moved, before the answer");
  // Kept once the task has ended: the task's steps say it in one line, and the conversation now answers through "Work".
  const steps = await fx.call(`runs/${run.id}/steps`);
  assert.deepEqual(steps.switched.map((line) => line.sentence), ["Moved to “Work” — “Your usual sign-in” hit its limit"]);
  const here = await fx.call(`accounts/session?sessionId=${run.sessionId}`);
  assert.equal(here.label, "Work");
  assert.equal(here.chosenHere, true, "the conversation stays on the account it moved to");
});

test("a plan limit with nowhere to move waits for the plan meter's reset and carries on by itself", async (t) => {
  const fx = await fixture(t);
  const service = accountsServiceFor(fx.app.runtime.models);
  let second = "";
  // The plan meter knows when the window refills: 2.5 s after the limit is hit. Set as the limit is hit, so a slow first
  // call (a busy build machine) never finds the reset already past and the limit's end unknown.
  const meter = () => service.statesOf(POOL).set("primary", { ...(service.statesOf(POOL).get("primary") ?? freshState()), resetAt: new Date(Date.now() + 2500).toISOString() });
  const seen = await program(t, fx, service, (who, n) => ((who === "primary" && n === 1) ? (meter(), limited) : who === second ? limited : null));
  setMode(service, { mode: "on" });
  second = (await addAccount(service, { pool: POOL, label: "Second" })).accounts.at(-1).id; // at its limit too: nowhere to move
  const started = Date.now();
  const run = await fx.call("run", { prompt: "hello" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(run.output, "from primary");
  assert.ok(Date.now() - started >= 1000, "it waited for the reset");
  assert.deepEqual(seen, ["primary", second, "primary"], "both at their limit: it waits for the first reset");
  const events = fx.app.store.events(run.id).map((e) => e.kind);
  assert.ok(events.includes("model.limit_wait") && events.includes("model.limit_resumed"), events.join());
  const [move, line] = stateLines(await fx.live(run.id));
  assert.match(move.label, /^Moved to “Second” — “Your usual sign-in” hit its limit, resets /);
  assert.match(line.label, /^“Second” reached its plan limit$/);
  assert.equal(line.state, "done");
  assert.equal(line.result, "The limit reset, so it carried on by itself");
});

test("while it waits for a limit the task shows the wait, its reset time and the next step, and Stop ends it", async (t) => {
  const fx = await fixture(t);
  const service = accountsServiceFor(fx.app.runtime.models);
  await program(t, fx, service, () => limited);
  setMode(service, { mode: "on" });
  await addAccount(service, { pool: POOL, label: "Second" }); // at its limit too: nowhere to move
  const resets = new Date(Date.now() + 60 * 60_000).toISOString();
  service.statesOf(POOL).set("primary", { ...freshState(), resetAt: resets });
  const done = fx.call("run", { prompt: "hello" });
  const running = await until(() => fx.app.store.runs(fx.app.runtime.owner).find((r) => r.status === "running"
    && fx.app.store.events(r.id).some((e) => e.kind === "model.limit_wait")), "the wait");
  const activity = await fx.call("activity?waiting=1");
  const mine = activity.find((a) => a.runId === running.id);
  assert.equal(mine.task.state, "waiting-service");
  assert.equal(mine.task.why, "model.limit_wait");
  assert.ok(Math.abs(Date.parse(mine.task.until) - Date.parse(resets)) < 5000, "the reset time comes from the plan meter");
  const lines = fx.app.store.events(running.id);
  assert.ok(lines.some((e) => e.kind === "model.limit_wait"));
  await fx.call(`runs/${running.id}/cancel`, {});
  const run = await done;
  assert.equal(run.status, "cancelled");
});

/* ---------- a dropped connection, a crashed tool, a quiet model ---------- */
function scripted(script) {
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => { model.requests.push(request); return script(request, model.requests.length); };
  return model;
}
const dropped = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

test("a dropped connection is asked again with a growing wait, then the task carries on", async (t) => {
  const model = scripted((request, n) => { if (n <= 2) throw dropped(); return { content: "back again", toolCalls: [] }; });
  const fx = await fixture(t, model);
  const run = await fx.call("run", { prompt: "hello" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "back again");
  const retries = fx.app.store.events(run.id).filter((e) => e.kind === "model.network_retry").map((e) => e.data.delayMs);
  assert.deepEqual(retries, [1000, 2000]);
  const lines = stateLines(await fx.live(run.id));
  assert.equal(lines.length, 1, "one line for one outage");
  assert.equal(lines[0].label, "Lost the connection to the model service");
  assert.equal(lines[0].result, "Connected again, so it carried on by itself");
});

test("a tool that crashes hands its error back to the model, which recovers", async (t) => {
  const model = scripted((request, n) => {
    if (n === 1) return { content: "", toolCalls: [{ id: "c1", name: "demo.crash", arguments: "{}" }] };
    const result = request.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    return { content: /the disk said no/.test(result?.content ?? "") ? "recovered another way" : "never saw the error", toolCalls: [] };
  });
  const fx = await fixture(t, model);
  fx.app.registry.register({ name: "demo.crash", permission: "files.read", description: "Crashes.", parameters: z.object({}).strict(),
    execute: async () => { throw new Error("the disk said no"); } });
  const run = await fx.call("run", { prompt: "try it" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "recovered another way");
  const line = (await fx.live(run.id)).steps.find((s) => s.kind === "tool");
  assert.equal(line.state, "failed");
  assert.equal(line.result, "the disk said no");
});

test("a model that goes quiet is asked again", async (t) => {
  const model = scripted((request, n) => (n === 1
    ? new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    : { content: "answered the second time", toolCalls: [] }));
  const fx = await fixture(t, model, { reliability: { modelStallMs: 5000 } });
  const run = await fx.call("run", { prompt: "hello" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "answered the second time");
  const [line] = stateLines(await fx.live(run.id));
  assert.equal(line.label, "The model gave no answer for 5 seconds");
  assert.equal(line.result, "Asked it again");
});

/* ---------- Pause and Resume ---------- */
test("Pause stops a working task after its step; Resume carries it on from there and nothing is done twice", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  const model = scripted(async (request) => {
    const done = request.messages.filter((m) => m.role === "tool").length;
    if (done === 1) await gate; // the model is busy with its second step when the owner presses Pause
    if (done < 3) return { content: "", toolCalls: [{ id: `s${done + 1}`, name: "demo.send", arguments: JSON.stringify({ n: done + 1 }) }] };
    return { content: `sent ${sent.join(",")}`, toolCalls: [] };
  });
  t.after(() => release()); // a failed step never leaves the model waiting, so the engine can close
  const fx = await fixture(t, model);
  fx.app.registry.register({ name: "demo.send", permission: "files.read", description: "Sends one thing.",
    parameters: z.object({ n: z.number() }).strict(), execute: async ({ n }) => { sent.push(n); return { sent: n }; } });
  const first = fx.call("run", { prompt: "send three things" });
  const running = await until(() => fx.app.store.runs(fx.app.runtime.owner).find((r) => r.status === "running"), "the task");
  await until(() => sent.length === 1 && model.requests.length === 2, "the first send, and the model at its second step");
  assert.deepEqual(await fx.call(`runs/${running.id}/pause`, {}), { paused: true, message: "Paused after this step. Nothing is lost." });
  release();
  const paused = await first;
  assert.equal(paused.status, "interrupted");
  assert.equal(paused.output, "Paused after this step. Nothing is lost.");
  assert.deepEqual(sent, [1, 2], "the step it was on finished; nothing after it started");
  const waiting = (await fx.call("activity?waiting=1")).find((a) => a.runId === paused.id);
  assert.equal(waiting.task.why, "run.paused");
  const pausedLine = stateLines(await fx.live(paused.id)).find((s) => s.label.startsWith("Paused"));
  assert.equal(pausedLine.state, "done");
  const resumed = await fx.call(`runs/${paused.id}/resume`, {});
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.output, "sent 1,2,3");
  assert.deepEqual(sent, [1, 2, 3], "each thing sent once");
  const [line] = stateLines(await fx.live(resumed.id));
  assert.equal(line.label, "Carried on from its last step");
  const started = fx.app.store.events(paused.id).find((e) => e.kind === "run.started");
  assert.equal(started.data.deadlineMs, 24 * 60 * 60 * 1000, "a window task may work for a day");
});

/* ---------- the engine killed mid-task ---------- */
const exited = (child) => new Promise((done) => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once("exit", () => done()); });
test("the engine killed mid-task: the next start picks it up from its last step by itself, and no send happens twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-long-work-restart-"));
  t.after(() => discardTemp(root));
  const plan = [
    { id: "a", tool: "chaos.look", args: { n: 1 } },
    { id: "b", tool: "chaos.send", args: { n: 2 } },
    { id: "c", tool: "files.write", args: { path: "one.txt", content: "first" } },
    { id: "d", tool: "chaos.send", args: { n: 4 } },
  ];
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BRANCH_") && name !== "NODE_OPTIONS"));
  // No gateway settings are written: "carry on after a restart" ships on without the gateway.
  const env = { ...clean, CHAOS_PLAN: JSON.stringify(plan), CHAOS_DELAY: "10", CHAOS_KILL_AT: "saved:c" };
  const script = resolve("tests/fixtures/never-break-task.mjs");
  const worker = spawn(process.execPath, [script, root, "work"], { env, stdio: ["ignore", "ignore", "inherit"] });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  await exited(worker);
  const log = await readFile(join(root, "calls.log"), "utf8");
  assert.match(log, /killed at saved:c/);
  const again = spawn(process.execPath, [script, root, "recover"], { env: { ...env, CHAOS_KILL_AT: "" }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  again.stdout.on("data", (chunk) => { out += chunk; });
  await exited(again);
  const result = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(result.report.map((r) => r.outcome), ["resumed"], out);
  assert.ok(result.runs.some((r) => r.status === "completed" && r.output === "all done"), out);
  const outbox = (await readFile(join(root, "outbox.log"), "utf8")).trim().split("\n");
  assert.deepEqual(outbox, ["sent 2", "sent 4"], "the send before the restart was not repeated");
  assert.equal(await readFile(join(root, "workspace", "one.txt"), "utf8"), "first");
});

test("the rules underneath: what counts as a dropped connection, a limit with a known reset, and the restart mode", () => {
  assert.equal(isNetworkDrop(dropped()), true);
  assert.equal(isNetworkDrop(new ProviderHttpError(503)), false, "a refusal is not a dropped connection");
  const now = Date.now();
  assert.equal(limitResetsAt(new ProviderHttpError(429, 30_000, "rate_limit_exceeded"), now), now + 30_000);
  assert.equal(limitResetsAt(new ProviderHttpError(429, undefined, "rate_limit_exceeded"), now), null, "no reset said: not waited out");
  assert.equal(limitResetsAt(new ProviderHttpError(429, 30_000, "insufficient_quota"), now), null, "a spent quota does not refill with time");
  assert.equal(resumeMode("off", LongWorkSettingsSchema.parse({})), "on", "ships on without the gateway");
  assert.equal(resumeMode("off", LongWorkSettingsSchema.parse({ resumeAfterRestart: false })), "off");
  assert.equal(resumeMode("when-needed", LongWorkSettingsSchema.parse({})), "when-needed", "the gateway's own mode wins when it runs");
});

test("a move to another account is kept as one line, also for a task recorded before the move was noted", () => {
  const at = (n) => `2026-09-27T00:00:0${n}.000Z`;
  const event = (n, kind, data) => ({ id: n, runId: "r", kind, data, createdAt: at(n) });
  const noted = [event(1, "model.account_limit", { label: "Home" }), event(2, "model.account_moved", { from: "Home", label: "Work" }), event(3, "model.account", { label: "Work" })];
  assert.deepEqual(switchedLines(noted).map((l) => l.sentence), ["Moved to “Work” — “Home” hit its limit"]);
  const older = [event(1, "model.account_limit", { label: "Home" }), event(2, "model.account", { label: "Work" })];
  assert.deepEqual(switchedLines(older).map((l) => l.sentence), ["Moved to “Work” — “Home” hit its limit"]);
  assert.deepEqual(switchedLines([event(1, "model.account", { label: "Work" })]), [], "an answer with no limit is no move");
  assert.deepEqual(switchedLines([event(1, "model.account_limit", { label: "Home" }), event(2, "model.account", { label: "Home" })]), [], "the same account after its reset is no move");
});
