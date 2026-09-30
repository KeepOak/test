import test from "node:test";
import assert from "node:assert/strict";
import { CliAgentProvider, cliAgentCatalog } from "../dist/providers/cli-agent.js";

const request = () => ({ messages: [{ role: "user", content: "Say hello" }], signal: new AbortController().signal });
const provider = (id, outcome) => new CliAgentProvider(cliAgentCatalog.find((row) => row.id === id), {}, async () => outcome);

test("Codex trust refusal gives an actionable diagnostic without forwarding output or disabling trust", async () => {
  const outcome = { code: 1, stdout: "", stderr: "Not inside a trusted directory and --skip-git-repo-check was not specified. password=Secret123!" };
  await assert.rejects(provider("codex", outcome).complete(request()), (error) => {
    assert.match(error.message, /trusted.*folder|folder.*trusted/i);
    assert.match(error.message, /Codex/);
    assert.doesNotMatch(error.message, /Secret123|skip-git-repo-check/);
    return true;
  });
});

test("expired Claude authentication is reported as sign-in trouble even when the program exits zero", async () => {
  const outcome = { code: 0, stderr: "", stdout: JSON.stringify({ type: "result", is_error: true, result: "API Error: 401 OAuth token has expired. password=Secret123!" }) };
  await assert.rejects(provider("claude-code", outcome).complete(request()), (error) => {
    assert.match(error.message, /sign in again/i);
    assert.doesNotMatch(error.message, /Secret123/);
    return true;
  });
});

test("Codex failed-turn event cannot become a successful empty or partial answer", async () => {
  const stdout = [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial answer" } }),
    JSON.stringify({ type: "turn.failed", error: { message: "Authentication required" } })].join("\n");
  await assert.rejects(provider("codex", { code: 0, stdout, stderr: "" }).complete(request()), /sign in again/i);
});

test("normal answers that discuss errors are still answers", async () => {
  const stdout = JSON.stringify({ type: "result", is_error: false, result: "401 means authentication failed; OAuth token expired is an example." });
  assert.match((await provider("claude-code", { code: 0, stdout, stderr: "" }).complete(request())).content, /401 means/);
});

test("unknown failures keep program output private and say the exit code and next step", async () => {
  await assert.rejects(provider("codex", { code: 7, stdout: "private note", stderr: "arbitrary credential" }).complete(request()), (error) => {
    assert.match(error.message, /exit code 7/);
    assert.doesNotMatch(error.message, /private note|arbitrary credential/);
    return true;
  });
});

/* QA retest 2026-09-28: the owner's Codex was set to a model its ChatGPT sign-in cannot use, and one of Codex's own MCP
   servers logged that its OAuth refresh token was rejected. Branch read that warning as its own sign-in failing and said
   "sign in again", which could never help. The failed turn is what decides. */
const mcpWarning = "ERROR codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh OAuth tokens for server cloudflare-api: OAuth refresh token was rejected: Server returned error response: invalid_grant: Grant not found";
const failedTurn = (message) => [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "turn.failed", error: { message } })].join("\n");

test("Codex's failed turn decides the reason: a model its sign-in cannot use is said, not read as a sign-in failure", async () => {
  const stdout = failedTurn(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error",
    message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." } }));
  await assert.rejects(provider("codex", { code: 1, stdout, stderr: mcpWarning }).complete(request()), (error) => {
    // QA 2026-09-28: Branch names the model it chose and offers the ones Codex takes, never the program's own words.
    assert.match(error.message, /cannot use gpt-5\.6-terra with this sign-in/);
    assert.match(error.message, /gpt-5\.6-luna, gpt-5\.6-sol, gpt-5\.5\) in Settings › Models › Connections/);
    assert.doesNotMatch(error.message, /sign in again|cloudflare|gpt-6-sol|Grant|own settings/i);
    return true;
  });
});

test("an MCP server's OAuth warning in Codex's error output is never read as Branch's sign-in failing", async () => {
  await assert.rejects(provider("codex", { code: 1, stdout: failedTurn("stream disconnected before completion"), stderr: mcpWarning }).complete(request()), (error) => {
    assert.doesNotMatch(error.message, /sign in again/i);
    assert.match(error.message, /exit code 1/);
    return true;
  });
});

test("with no failed turn to go by, a sign-in failure in the error output is still reported as one", async () => {
  await assert.rejects(provider("codex", { code: 1, stdout: "", stderr: "Error: 401 Unauthorized" }).complete(request()), /sign in again/i);
});
