/* What each connection has left, measured from the services themselves: both plan windows of a ChatGPT sign-in
   (x-codex-{primary,secondary}-used-percent / -window-minutes / -reset-at, as openai/codex reads them) and of Claude
   Code (the rate_limit_event lines `claude -p --output-format stream-json --verbose` prints, as typed in
   @anthropic-ai/claude-agent-sdk SDKRateLimitInfo). The services here are stand-ins that send those real shapes; the
   rest is the real path: the connection's fetch or the program's output, the per-account store, GET /api/usage/glance,
   POST /api/usage/limits/measure, and a restart. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, syncChatGPTPresets, registerCliAgent, answerFrom, cliAgentRows } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { codexPlanWindows } from "../dist/rate-limit-headers.js";
import { claudePlanWindows, planWindowTitle } from "../dist/plan-windows.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })}.sig`;
const fiveHourReset = NOW / 1000 + 4 * 3600, weekReset = NOW / 1000 + 3 * 86400;
const codexHeaders = {
  "x-codex-primary-used-percent": "88", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(fiveHourReset),
  "x-codex-secondary-used-percent": "29", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": String(weekReset),
};
const claudeLines = [
  { type: "system", subtype: "init", session_id: "s" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: fiveHourReset, rateLimitType: "five_hour", utilization: 0.12 }, uuid: "u1", session_id: "s" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: weekReset, rateLimitType: "seven_day", utilization: 0.71, surpassedThreshold: 0.5 }, uuid: "u2", session_id: "s" },
  { type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, session_id: "s" },
  { type: "result", subtype: "success", result: "ok", session_id: "s" },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

test("ChatGPT: both windows are read with their length and reset, as Codex reads them", () => {
  const said = codexPlanWindows(new Headers(codexHeaders), NOW);
  assert.deepEqual(said.map((w) => [w.id, w.usedPercent, w.minutes, w.resetAt]), [
    ["primary", 88, 300, new Date(fiveHourReset * 1000).toISOString()],
    ["secondary", 29, 10080, new Date(weekReset * 1000).toISOString()]]);
  assert.deepEqual(said.map(planWindowTitle), ["This 5-hour window", "This week"]);
  assert.deepEqual(codexPlanWindows(new Headers({ "x-codex-primary-used-percent": "0" }), NOW), [], "0% with nothing else says nothing (Codex's rule)");
  assert.deepEqual(codexPlanWindows(new Headers(), NOW), []);
});

test("Claude Code: rate_limit_event lines give each window; utilization is a fraction; nothing else is guessed", () => {
  const said = claudePlanWindows(claudeLines, NOW);
  assert.deepEqual(said.map((w) => [w.id, w.usedPercent, w.minutes, w.resetAt]), [
    ["five_hour", 12, 300, new Date(fiveHourReset * 1000).toISOString()],
    ["seven_day", 71, 10080, new Date(weekReset * 1000).toISOString()]]);
  const noShare = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } });
  assert.deepEqual(claudePlanWindows(noShare, NOW), [], "an event without utilization adds no number");
  const row = cliAgentRows().find((one) => one.id === "claude-code");
  assert.deepEqual(row.args, ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(answerFrom(row, claudeLines), "ok", "the answer is the result line's field");
  assert.equal(answerFrom(row, JSON.stringify({ result: "plain" })), "plain", "one JSON object still reads");
});

async function open(t, dataDir, root) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const real = globalThis.fetch;
  const answer = () => new Response(["response.output_text.delta", "response.completed"].map((type) =>
    `data: ${JSON.stringify(type === "response.completed" ? { type, response: { usage: { input_tokens: 3, output_tokens: 1 } } } : { type, delta: "ok" })}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream", ...codexHeaders } });
  globalThis.fetch = async () => answer();
  let ids;
  try { ids = syncChatGPTPresets(app.runtime.models, { accessToken: async () => token }, true, "BranchTest"); }
  finally { globalThis.fetch = real; }
  const spawn = async () => ({ code: 0, stdout: claudeLines, stderr: "" });
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  const service = accountsServiceFor(app.runtime.models);
  service.deps.spawnAgent = spawn;
  await fakeClaudeAccounts(t, service);
  service.deps.chatgpt = { accessToken: async () => token, status: async () => ({ signedIn: true }) };
  service.noteSignIn("cli-claude-code", "primary", { installed: true, signedIn: true,
    identity: { authMethod: "claude.ai" }, message: "Fixture subscription signed in." });
  await service.readIdentities();
  const server = await startServer(app, { dataDir, port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  return { app, server, call, ids, close: async () => { await server.close(); await app.close(); } };
}

test("one row per sign-in account (not per model), measured on request, kept across a restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-plan-windows-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data");
  let branch = await open(t, dataDir, root);
  try {
    assert.ok(branch.ids.length > 1, "several ChatGPT models share one sign-in");
    let rows = (await branch.call("/api/usage/glance")).rows;
    const chatgpt = rows.filter((r) => r.connectionName === "ChatGPT plan");
    assert.equal(chatgpt.length, 1, "one row for the sign-in, however many models it carries");
    assert.deepEqual(chatgpt[0].presets.sort(), [...branch.ids].sort());
    assert.equal(chatgpt[0].signIn, true);
    assert.deepEqual(chatgpt[0].windows, [], "never measured: no number");
    assert.match(chatgpt[0].note, /Not measured yet/);

    const measured = await branch.call("/api/usage/limits/measure", { connection: "chatgpt", account: "primary" });
    const row = measured.rows.find((r) => r.connection === "chatgpt");
    assert.deepEqual(row.windows.map((w) => [w.title, w.remaining, w.resetAt, w.state]), [
      ["This 5-hour window", 12, new Date(fiveHourReset * 1000).toISOString(), "measured"],
      ["This week", 71, new Date(weekReset * 1000).toISOString(), "measured"]]);

    await branch.call("/api/usage/limits/measure", { connection: "cli-claude-code", account: "primary" });
    rows = (await branch.call("/api/usage/glance")).rows;
    const claude = rows.find((r) => r.connection === "cli-claude-code");
    assert.equal(claude.connectionName, "Claude plan");
    assert.deepEqual(claude.windows.map((w) => [w.title, w.remaining]), [["This 5-hour window", 88], ["This week", 29]]);
    assert.match(claude.windows[0].from, /as Claude Code reported it on its own answers/); // plain words since 2026-09-27
  } finally { await branch.close(); }

  branch = await open(t, dataDir, root);
  try {
    const rows = (await branch.call("/api/usage/glance")).rows;
    assert.deepEqual(rows.find((r) => r.connection === "chatgpt").windows.map((w) => w.remaining), [12, 71], "kept across a restart, with its time measured");
    assert.deepEqual(rows.find((r) => r.connection === "cli-claude-code").windows.map((w) => w.remaining), [88, 29]);
  } finally { await branch.close(); }
});
