/**
 * usagefix: what a plan sign-in has left, read again on request (each look at the popover, Check now, the status bar's
 * cadence) without sending the model a message. ChatGPT is answered by a stand-in fetch and Claude Code by a stand-in
 * reader, so nothing reaches OpenAI or runs the real program.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ChatGPTAuth } from "../dist/chatgpt-auth.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { asPerson } from "../dist/people/context.js";
import { usageLimitsRoute } from "../dist/usage-limits-api.js";
import {
  chatgptUsageUrl, chatgptUsageWindows, claudeNoLimits, claudeUsageAnswer, claudeUsageArgs, claudeUsageWindows,
} from "../dist/accounts/plan-read.js";

const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${part({ alg: "none" })}.${part(claims)}.sig`;
const TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
const vault = () => { const v = { tokens: { accessToken: TOKEN, refreshToken: "r", idToken: jwt({ email: "o@example.com" }), expiresAt: "2099-01-01T00:00:00.000Z" },
  read: async () => v.tokens, write: async (t) => { v.tokens = t; }, clear: async () => { v.tokens = null; } }; return v; };
const usageBody = { plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 600, reset_at: 1790000000 },
  secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 9000, reset_at: 1790500000 } } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-plan-read-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), chatgpt: new ChatGPTAuth(vault()) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  let clock = Date.parse("2026-09-27T10:00:00Z");
  Object.defineProperty(service, "now", { value: () => clock });
  const calls = [];
  let answer = () => new Response(JSON.stringify(usageBody), { status: 200, headers: { "content-type": "application/json" } });
  service.deps.fetchImpl = async (url, init) => { calls.push({ url: String(url), headers: new Headers(init.headers) }); return answer(); };
  const route = (path, body) => usageLimitsRoute(app, { method: "POST" }, path, async () => body);
  return { app, service, root, calls, route, tick: (ms) => { clock += ms; }, answer: (fn) => { answer = fn; } };
}
const rowOf = (glance, connection) => glance.rows.find((row) => row.connection === connection);

test("R1 ChatGPT's usage answer becomes its two windows; any other shape gives none", () => {
  const now = Date.parse("2026-09-27T10:00:00Z");
  assert.deepEqual(chatgptUsageWindows(usageBody, now), [
    { id: "primary", usedPercent: 12, minutes: 300, resetAt: new Date(1790000000 * 1000).toISOString(), measuredAt: "2026-09-27T10:00:00.000Z" },
    { id: "secondary", usedPercent: 40, minutes: 10080, resetAt: new Date(1790500000 * 1000).toISOString(), measuredAt: "2026-09-27T10:00:00.000Z" },
  ]);
  assert.deepEqual(chatgptUsageWindows({ rate_limit: null }, now), []);
  assert.deepEqual(chatgptUsageWindows({ rate_limit: { primary_window: { used_percent: "a lot" } } }, now), []);
  assert.deepEqual(chatgptUsageWindows("<html>", now), []);
});

test("R2 Claude Code's get_usage says a percent and an ISO time; only the 5-hour and weekly windows are kept", () => {
  const now = Date.parse("2026-09-27T10:00:00Z");
  const said = claudeUsageWindows({ rateLimitsAvailable: true, rateLimits: {
    five_hour: { utilization: 37, resets_at: "2026-09-27T13:00:00Z" }, seven_day: { utilization: 61.5, resets_at: null },
    seven_day_sonnet: { utilization: 5, resets_at: null }, seven_day_opus: null } }, now);
  assert.deepEqual(said, [
    { id: "five_hour", usedPercent: 37, minutes: 300, resetAt: "2026-09-27T13:00:00.000Z", measuredAt: "2026-09-27T10:00:00.000Z" },
    { id: "seven_day", usedPercent: 61.5, minutes: 10080, resetAt: null, measuredAt: "2026-09-27T10:00:00.000Z" },
  ]);
  assert.deepEqual(claudeUsageWindows({ rateLimitsAvailable: true, rateLimits: null }, now), [], "no limits given: no figure made up");
  assert.deepEqual(claudeUsageWindows({ rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: null, resets_at: null } } }, now), []);
});

test("R3 only the program's answer to Branch's own question is read; its other lines are dropped", () => {
  const line = (id, subtype, response) => JSON.stringify({ type: "control_response", response: { subtype, request_id: id, response } });
  assert.deepEqual(claudeUsageAnswer(line("branch-usage", "success", { rate_limits_available: true, rate_limits: { five_hour: { utilization: 1, resets_at: null } }, behaviors: { day: {} } })),
    { rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: 1, resets_at: null } } }, "its activity statistics are not kept");
  assert.equal(claudeUsageAnswer(line("branch-start", "success", {})), null);
  assert.equal(claudeUsageAnswer(line("branch-usage", "error", {})), "refused");
  assert.equal(claudeUsageAnswer('{"type":"system","subtype":"init"}'), null);
  assert.equal(claudeUsageAnswer("not json \"control_response\" \"branch-usage\""), null);
  assert.ok(!claudeUsageArgs.some((arg) => /^[^-{]/.test(arg) && !["stream-json"].includes(arg)), "no prompt is ever passed");
  assert.ok(claudeUsageArgs.includes("--strict-mcp-config") && claudeUsageArgs.some((arg) => arg.includes("disableAllHooks")));
});

test("R4 Check now reads a ChatGPT plan with its own sign-in, once at a time and at most every 30 seconds", async (t) => {
  const fx = await fixture(t);
  const before = rowOf(await fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" }), "chatgpt");
  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].url, chatgptUsageUrl);
  assert.equal(fx.calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(fx.calls[0].headers.get("chatgpt-account-id"), "acct-1");
  assert.equal(before.readable, true);
  assert.deepEqual(before.windows.map((w) => [w.id, w.remaining, w.measuredAt]), [["primary", 88, "2026-09-27T10:00:00.000Z"], ["secondary", 60, "2026-09-27T10:00:00.000Z"]]);

  await fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" });
  assert.equal(fx.calls.length, 1, "asked again within 30 seconds: the last reading answers");
  fx.tick(31_000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fx.answer(() => gate.then(() => new Response(JSON.stringify(usageBody), { status: 200 })));
  const three = Promise.all([1, 2, 3].map(() => fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" })));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  for (const glance of await three)
    assert.equal(rowOf(glance, "chatgpt").windows[0].measuredAt, "2026-09-27T10:00:31.000Z", "each look waits for the one read and shows it");
  assert.equal(fx.calls.length, 2, "three looks at once share one read");

  fx.tick(31_000);
  fx.answer(() => new Response("busy", { status: 503 }));
  const failed = rowOf(await fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" }), "chatgpt");
  assert.equal(failed.windows.length, 2, "a failed read keeps the last windows, with their age");
  assert.equal(failed.windows[0].measuredAt, "2026-09-27T10:00:31.000Z");
  assert.match(failed.note, /did not say what is left just now \(HTTP 503\)/);
  fx.tick(31_000);
  fx.answer(() => new Response(JSON.stringify(usageBody), { status: 200 }));
  assert.equal(rowOf(await fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" }), "chatgpt").note, "", "a good read clears it");
});

test("R5 only the owner may make Branch read a plan; a bad request is refused before anything is read", async (t) => {
  const fx = await fixture(t);
  const person = fx.app.store.profiles.create({ name: "Sam", pin: "1234" });
  await assert.rejects(() => asPerson({ profileId: person.id, keyId: "phone" }, () => fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" })),
    (error) => error.status === 403);
  fx.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(() => fx.route("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" }), (error) => error.status === 403);
  await assert.rejects(() => fx.route("/api/usage/limits/look", {}), (error) => error.status === 403);
  fx.app.store.profiles.switch({ profileId: null });
  assert.equal(fx.calls.length, 0);
  for (const body of [{ connection: "openai", account: "primary" }, { connection: "chatgpt", account: "../x" }, { connection: "chatgpt", account: "abcdef12" }, {}])
    await assert.rejects(() => fx.route("/api/usage/limits/refresh", body), (error) => error.status === 400, JSON.stringify(body));
  assert.equal(fx.calls.length, 0);
});

test("R6 a Claude Code sign-in shows its 5-hour and weekly windows from the program itself, or says why not", async (t) => {
  const fx = await fixture(t);
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" });
  const asked = [];
  let limits = { five_hour: { utilization: 37, resets_at: "2026-09-27T13:00:00Z" }, seven_day: { utilization: 80, resets_at: "2026-10-01T09:00:00Z" } };
  fx.service.deps.claudeUsage = async (env) => { asked.push(env); return { rateLimitsAvailable: true, rateLimits: limits }; };
  const row = rowOf(await fx.route("/api/usage/limits/refresh", { connection: "cli-claude-code", account: "primary" }), "cli-claude-code");
  assert.equal(row.connectionName, "Claude plan");
  assert.equal(row.readable, true);
  assert.deepEqual(row.windows.map((w) => [w.title, w.remaining, w.resetAt]), [["This 5-hour window", 63, "2026-09-27T13:00:00.000Z"], ["This week", 20, "2026-10-01T09:00:00.000Z"]]);
  assert.equal(asked[0].CLAUDE_CONFIG_DIR, fx.service.primaryClaudeHome, "the same primary profile that status and answers use");
  assert.ok(!Object.keys(asked[0]).some((name) => /ANTHROPIC|CLAUDE/.test(name) && name !== "CLAUDE_CONFIG_DIR"), "only the selected profile location is handed over");

  fx.tick(121_000);
  limits = null;
  const expired = rowOf(await fx.route("/api/usage/limits/refresh", { connection: "cli-claude-code", account: "primary" }), "cli-claude-code");
  assert.equal(expired.note, claudeNoLimits);
  assert.equal(expired.windows[0].remaining, 63, "the last real reading stays, with its own time");
});

test("R7 a Claude Code signed in here but not added is offered once, and not after it is connected", async (t) => {
  const fx = await fixture(t);
  const bin = join(fx.root, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });
  let runs = 0, code = 0;
  fx.service.deps.statusRun = async (row, args) => { runs++; assert.deepEqual([row.command, ...args], ["claude", "auth", "status"]); return { code, missing: false }; };

  const glance = await fx.route("/api/usage/limits/look", {});
  assert.deepEqual(glance.addable, [{ program: "claude-code", connectionName: "Claude plan", note: "Claude Code is signed in on this computer. Connect it to see what its plan has left here." }]);
  await fx.route("/api/usage/limits/look", {});
  assert.equal(runs, 1, "its status command is asked at most every five minutes");
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" });
  assert.equal((await fx.route("/api/usage/limits/look", {})).addable, undefined, "connected: it is a row of its own");
  assert.equal(runs, 1);

  const other = await fixture(t);
  other.service.deps.statusRun = async () => ({ code: 1, missing: false });
  assert.equal((await other.route("/api/usage/limits/look", {})).addable, undefined, "not signed in: nothing is offered");
});

test("R8 Claude Code accounts are read one at a time, each from its own folder", async (t) => {
  const fx = await fixture(t);
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" });
  const { addAccount } = await import("../dist/accounts/manage.js");
  const work = (await addAccount(fx.service, { pool: "cli-claude-code", label: "Work" })).accounts.find((a) => a.label === "Work").id;
  let running = 0, most = 0;
  const homes = [];
  const gates = [];
  fx.service.deps.claudeUsage = async (env) => {
    running++; most = Math.max(most, running); homes.push(env.CLAUDE_CONFIG_DIR ?? null);
    await new Promise((resolve) => gates.push(resolve));
    running--;
    return { rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: 10, resets_at: null } } };
  };
  const both = Promise.all(["primary", work].map((account) => fx.route("/api/usage/limits/refresh", { connection: "cli-claude-code", account })));
  for (let i = 0; i < 2; i++) { await until(() => gates.length > i); gates[i](); }
  await both;
  assert.equal(most, 1, "one program at a time");
  assert.deepEqual(homes, [fx.service.primaryClaudeHome, fx.service.homeOf("cli-claude-code", work)]);
});
async function until(done) {
  for (let i = 0; i < 500; i++) { if (done()) return; await new Promise((resolve) => setImmediate(resolve)); }
  throw new Error("timed out");
}
