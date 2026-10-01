/* SELF-104 / SELF-222: each model call records the account it went through, the model, and the tokens the provider
   reported (never an estimate); the connection's own account is named only when its creator bound it; a helper's
   spend is its own row in Data & usage, apart from the owner's. Stand-in providers only; nothing reaches a service. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { AccountPoolProvider } from "../dist/accounts/pool-provider.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { usageByTrunk } from "../dist/usage-by-trunk.js";
import { UsageStore } from "../dist/usage.js";

const at = "2026-09-27T10:00:00.000Z";
const acct = (id) => ({ id, label: `Label ${id}`, pinned: false, disabled: false, monthlyCapUsd: null, shared: false, createdAt: at });

/** A pool whose accounts answer with the given usage (undefined: the provider reported none). */
function pool({ accounts, usage, originalAccount }) {
  const saved = { pool: "p", kind: "api-key", strategy: "priority", autoSwitch: true, defaultAccount: null, accounts: accounts.map(acct) };
  const answer = (who) => ({ name: "stand-in", complete: async () => ({ content: `from ${who}`, toolCalls: [], ...(usage ? { usage } : {}) }) });
  return new AccountPoolProvider(answer("original"), {
    owner: "owner", pool: "p", model: "m1", settings: () => saved, states: new Map(), cursor: { value: 0 }, now: () => Date.parse(at),
    providerFor: async (id) => answer(id), capReached: () => false, record: () => undefined, personIsNotOwner: () => false,
    sessionChoice: () => null, rememberChoice: () => undefined, ...(originalAccount ? { originalAccount } : {}),
  });
}
async function noted(provider) {
  const notes = [];
  await withAccountCall({ sessionId: "s", note: (kind, data) => notes.push({ kind, data }) },
    () => provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }));
  return notes.filter((note) => note.kind === "model.account").map((note) => note.data);
}

test("SELF-222 a pooled call records its account, model and the provider's reported tokens", async () => {
  const [reported] = await noted(pool({ accounts: ["a", "b"], usage: { input: 1200, output: 34 } }));
  assert.equal(reported.account, "a");
  assert.equal(reported.label, "Label a");
  assert.equal(reported.model, "m1");
  assert.deepEqual([reported.usage?.input, reported.usage?.output], [1200, 34]);
  assert.deepEqual([reported.tokenBasis, reported.accountBinding], ["reported", "selected"]);
  const [silent] = await noted(pool({ accounts: ["a", "b"] }));
  assert.deepEqual([silent.usage, silent.tokenBasis], [null, "unreported"], "no reported tokens is never an estimate");
});

test("SELF-222 the connection's own account is named only when its creator bound it", async () => {
  const [bound] = await noted(pool({ accounts: ["only"], usage: { input: 5, output: 6 }, originalAccount: "primary" }));
  assert.deepEqual([bound.pool, bound.account, bound.accountBinding, bound.tokenBasis], ["p", "primary", "connection", "reported"]);
  const [unbound] = await noted(pool({ accounts: ["only"], usage: { input: 5, output: 6 } }));
  assert.deepEqual([unbound.account, unbound.accountBinding], [null, "unbound"], "a pool default is not evidence of the account used");
});

test("SELF-104 a helper's spend is its own row, and the task's timeline names each call's account", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-call-receipts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, store = app.store;
  const lead = store.createRun(owner, "lead");
  store.event(lead.id, "run.started", { source: "owner", parentRunId: null });
  store.event(lead.id, "model.account", { pool: "p", account: "a", label: "Label a", model: "m1", usage: { input: 10, output: 2 }, tokenBasis: "reported", accountBinding: "selected" });
  const helper = store.createRun(owner, "helper");
  store.event(helper.id, "run.started", { source: "owner", parentRunId: lead.id, agent: "researcher", agentName: "Researcher" });
  store.event(helper.id, "model.account", { pool: "p", account: "b", label: "Label b", model: "m1", usage: null, tokenBasis: "unreported", accountBinding: "selected" });
  const { rows } = usageByTrunk({ store, owner, trunkName: () => null, costOf: () => null }, { days: 7 });
  const you = rows.find((row) => !row.trunk && !row.agent), researcher = rows.find((row) => row.agent?.id === "researcher");
  assert.equal(you?.tasks, 1, "the helper is not counted as the owner's own task");
  assert.deepEqual(you.accounts.map((one) => one.account), ["a"]);
  assert.deepEqual([researcher?.agent.name, researcher?.tasks], ["Researcher", 1]);
  assert.deepEqual(researcher.accounts.map((one) => one.account), ["b"]);
  assert.equal(rows[0], you, "the owner's own first");
  const timeline = new UsageStore(store.sqlite).getRunTimeline(lead.id).filter((entry) => entry.type === "model.account");
  assert.equal(timeline.length, 1);
  assert.match(timeline[0].title, /Label a.*m1/);
  assert.deepEqual([timeline[0].details.tokenBasis, timeline[0].details.usage], ["reported", { input: 10, output: 2 }]);
});
