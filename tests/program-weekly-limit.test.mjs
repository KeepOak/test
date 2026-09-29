/**
 * QA retest 2026-09-28, pass 2: Claude Code at its weekly cap printed {"type":"result","is_error":true,"result":"You've
 * hit your weekly limit · resets 5am (America/New_York)","api_error_status":429} and exited 1. Branch said "could not
 * finish the task (exit code 1). Run claude in a terminal to check its setup", and a second account was never tried,
 * because none of its plan-limit words matched. Now it says the plan limit was reached and when it resets, and an
 * account list treats it as a limit. Node only: the real dist/, a stand-in for the program.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerCliAgent } from "../dist/providers/cli-agent.js";

/** Only what registerCliAgent needs: somewhere to put the connection it makes. */
class ModelRouter { presets = new Map(); register(preset) { this.presets.set(preset.id, preset); } }
const said = (result, status = 429) => JSON.stringify({ type: "result", subtype: "success", is_error: true, result, terminal_reason: "api_error", api_error_status: status });
const program = (stdout) => async () => ({ code: 1, stdout, stderr: "" });
const ask = (provider) => provider.complete({ messages: [{ role: "user", content: "Reply with OK" }], tools: [], signal: AbortSignal.timeout(5000) });

test("a coding program at its weekly limit says so, with the reset time", async () => {
  const models = new ModelRouter();
  registerCliAgent(models, { id: "claude-code" }, {}, program(said("You've hit your weekly limit · resets 5am (America/New_York)")));
  const provider = models.presets.get("cli-claude-code").provider;
  await assert.rejects(ask(provider), (error) => {
    assert.equal(error.message, "Claude Code (installed on this computer) has reached its plan limit; it resets at 5am (America/New_York). Wait for the limit to reset or choose another account or model.");
    return true;
  });
});

test("other plan-limit words still read as a limit, and anything else is the program's own trouble", async () => {
  for (const [result, words] of [
    ["You've hit your session limit", /reached its plan limit\. Wait/],
    ["Claude AI usage limit reached|1790000000", /reached its plan limit/],
    ["Something unexpected happened", /could not finish the task \(exit code 1\)/],
  ]) {
    const models = new ModelRouter();
    registerCliAgent(models, { id: "claude-code" }, {}, program(said(result, 500)));
    await assert.rejects(ask(models.presets.get("cli-claude-code").provider), words);
  }
});

test("a reset phrase is only repeated in its own shape", async () => {
  const models = new ModelRouter();
  registerCliAgent(models, { id: "claude-code" }, {}, program(said("You've hit your weekly limit · resets whenever <script>")));
  await assert.rejects(ask(models.presets.get("cli-claude-code").provider), (error) => {
    assert.doesNotMatch(error.message, /script|whenever/);
    assert.match(error.message, /reached its plan limit\. Wait/);
    return true;
  });
});
