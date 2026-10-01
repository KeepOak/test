/* provider-audit: a Claude subscription preset budgets for the window its route really has: 200K behind Branch's relay,
   or 1M where the account's plan includes the model's 1M route. The program is a stand-in; nothing is started. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { claudeInitializeAnswer } from "../dist/accounts/plan-read.js";
import { claudeNativeRoute, longContextIncluded } from "../dist/providers/claude-models.js";

async function fixture(t, plan) {
  const root = await mkdtemp(join(tmpdir(), "branch-claude-window-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  service.deps.statusRun = async () => ({ code: 0, missing: false,
    stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", ...(plan ? { subscriptionType: plan } : {}) }) });
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  registerCliAgent(app.runtime.models, { id: "claude-code" });
  const windowOf = (id) => app.runtime.contextWindowFor(app.runtime.models.presets.get(id));
  return { app, service, windowOf };
}

test("provider-audit: a Claude preset on a plan with 1M included reports the 1M window; Haiku and other plans 200K", async (t) => {
  const max = await fixture(t, "max");
  // Before the plan is known the window is the 200K Claude Code keeps behind the relay, not Branch's 128K guess.
  assert.equal(max.windowOf("cli-claude-code"), 200_000);
  await max.service.readIdentities(["cli-claude-code"]);
  assert.equal(max.app.runtime.models.presets.get("cli-claude-code").contextWindow, 1_000_000);
  assert.equal(max.windowOf("cli-claude-code"), 1_000_000);
  assert.equal(max.windowOf("cli-claude-code-sonnet"), 1_000_000);
  assert.equal(max.windowOf("cli-claude-code-haiku"), 200_000, "Haiku has no 1M route");
  assert.equal(max.app.runtime.models.presets.get("cli-claude-code").model, "claude-opus-5-5", "the preset keeps the model's own id");

  const pro = await fixture(t, "pro");
  await pro.service.readIdentities(["cli-claude-code"]);
  assert.equal(pro.windowOf("cli-claude-code"), 200_000, "Pro does not include the 1M route");
  const unknown = await fixture(t, null);
  await unknown.service.readIdentities(["cli-claude-code"]);
  assert.equal(unknown.windowOf("cli-claude-code"), 200_000, "an unknown plan is not promised 1M");
});

test("provider-audit: the initialize answer's plan and model picker decide the 1M route too", async (t) => {
  const line = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "branch-start", response: {
    account: { subscriptionType: "max", email: "never-kept@example.com" }, commands: [{ name: "x" }],
    models: [{ value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", description: "Opus 5.5 with 1M context · Draws from usage credits" },
      { value: "sonnet[1m]", resolvedModel: "claude-sonnet-5[1m]", description: "Sonnet 5 with 1M context" }] } } });
  const read = claudeInitializeAnswer(line);
  assert.equal(read.plan, "max");
  assert.equal(JSON.stringify(read).includes("never-kept"), false, "only the plan and the picker rows are kept");
  assert.equal(longContextIncluded("claude-opus-5-5", read.plan, read.picker), false, "a 1M route that draws usage credits is not used");
  assert.equal(longContextIncluded("sonnet", read.plan, read.picker), true);
  assert.equal(claudeInitializeAnswer(line.replace("branch-start", "branch-usage")), null);

  const f = await fixture(t, null);
  f.service.deps.claudeUsage = async () => ({ rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: 10, resets_at: null } }, ...read });
  await f.service.readPlan("cli-claude-code", "primary");
  assert.equal(f.windowOf("cli-claude-code"), 200_000, "Opus 1M would draw usage credits here");
  assert.equal(f.windowOf("cli-claude-code-sonnet-5"), 1_000_000);
});

test("provider-audit: the native program is started on the 1M route only where it is included", () => {
  assert.equal(claudeNativeRoute("claude-opus-5-5", true), "claude-opus-5-5[1m]");
  assert.equal(claudeNativeRoute("opus", true), "claude-opus-5-5[1m]");
  assert.equal(claudeNativeRoute("claude-opus-5-5", false), "claude-opus-5-5");
  assert.equal(claudeNativeRoute("haiku", true), "haiku");
  assert.equal(claudeNativeRoute("claude-haiku-4-5", true), "claude-haiku-4-5");
});
