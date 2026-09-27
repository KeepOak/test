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
