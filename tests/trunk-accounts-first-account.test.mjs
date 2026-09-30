/**
 * QA retest 2026-09-28, pass 2: with Claude Code signed in on this computer (one account, never a second added), Edit
 * Trunk › Accounts said "No connection has accounts to pick from yet": the Trunk's lists were read from the saved
 * account settings only, which hold a connection's list once a second account is added. They now come from every
 * connection that can have several accounts, as Settings › Accounts lists them, and the first account can be picked.
 * Node only: the real dist/, stand-in connections that are never called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { accountsSettings } from "../dist/accounts/settings.js";

test("a connection with only its first account is offered to a Trunk, and nothing is saved by looking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-first-account-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const service = accountsServiceFor(app.runtime.models);
  service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" }));
  app.store.save("settings", owner, "model-connections", { connections: [{ id: "openai-work", name: "OpenAI (work)", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: "openai-work", name: "OpenAI (work)", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "ok", toolCalls: [] }) } });
  app.trunks.setMode("trunks", { mode: "on" });
  const trunk = app.trunks.create({ name: "Researcher" });
  assert.deepEqual(accountsSettings(app.store, owner).pools, [], "no list has been saved: only first accounts");

  const view = await app.trunks.keys(trunk.id);
  const pools = Object.fromEntries(view.pools.map((pool) => [pool.id, pool.accounts.map((account) => account.id)]));
  assert.deepEqual(pools["cli-claude-code"], ["primary"], JSON.stringify(view.pools));
  assert.deepEqual(pools["openai-work"], ["primary"]);
  assert.deepEqual(accountsSettings(app.store, owner).pools, [], "reading the Trunk's lists saves nothing");

  app.trunks.edit(trunk.id, { keys: { copyFromOwner: false, accounts: { "cli-claude-code": "primary" } } });
  const after = await app.trunks.keys(trunk.id);
  assert.equal(after.keys.accounts["cli-claude-code"], "primary");
  assert.ok(!after.plan.notes.some((note) => /Claude Code/.test(note) && /pick one/.test(note)), after.plan.notes.join(" | "));
  assert.ok(after.plan.notes.some((note) => /OpenAI \(work\)/.test(note)), "the list with no pick is still named: " + after.plan.notes.join(" | "));
});
