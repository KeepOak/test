import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ToolRegistry } from "../dist/registry.js";
import { ContractBook, contractHash, prepareToolName } from "../dist/self-development-contract.js";
import { offerSourceContractRead, readSourceContractTool } from "../dist/self-development-read.js";
import { underShortLivedKey } from "../dist/key-context.js";

const folder = "branch-agent-source/.branch-worktrees/self-existing";
const terms = { allowedPaths: ["docs/**"], permissions: ["files.read"], expectedTests: ["tests/source-contract-read.test.mjs"],
  definitionOfDone: "Read existing terms without changing them", sideEffects: [], rollbackPlan: "No changes to undo" };
function fixture(t, enabled = true) {
  const db = new DatabaseSync(":memory:"), contracts = new ContractBook(db), registry = new ToolRegistry();
  t.after(() => db.close());
  let owner = true, definition;
  const records = {
    own: [{ kind: "run.started", data: { source: "owner" } }],
    chat: [{ kind: "run.started", data: { source: "channel" } }],
    household: [{ kind: "run.started", data: { source: "owner", personProfileId: "sam" } }],
    key: [{ kind: "run.started", data: { source: "owner", shortLivedKeyId: "fixture-key" } }],
  };
  const store = { profiles: { isOwner: () => owner }, events: id => records[id] ?? [], run: () => undefined, get: () => undefined };
  const register = registry.register.bind(registry);
  registry.register = input => { if (input.name === readSourceContractTool) definition = input; return register(input); };
  const dependency = name => registry.register({ name, permission: "git.read", description: "fixture dependency",
    parameters: z.object({}), execute: async () => { throw new Error("A read must not execute a dependency"); } });
  if (enabled) { dependency("git.push"); dependency(prepareToolName); }
  const stop = offerSourceContractRead({ registry, owner: "local", store, contracts });
  t.after(stop);
  const context = (extra = {}) => ({ owner: "local", runId: "own", source: "owner", permissions: new Set(["git.read"]),
    signal: new AbortController().signal, budget: { step() {}, charge() {} }, ...extra });
  const create = () => contracts.create("local", { worktreePath: folder, taskRunId: "prepared", sourceSha: "a".repeat(40), terms });
  return { registry, contracts, context, create, dependency, definition: () => definition, setOwner: value => { owner = value; },
    read: (input = { name: "existing" }, extra = {}) => registry.execute(readSourceContractTool, input, context(extra)) };
}

test("the registered source-contract handler returns a Promise and reads persisted terms without changing history", async t => {
  const f = fixture(t), contract = f.create();
  const before = JSON.stringify(f.contracts.history("local", folder));
  const promise = f.definition().execute({ name: "existing" }, f.context());
  assert.ok(promise instanceof Promise, "the actual execute handler satisfies the Promise contract");
  const result = await promise;
  assert.deepEqual(result.contract, contract); assert.equal(result.contractHash, contractHash(contract));
  assert.match(result.note, /not permission to change/); assert.match(result.note, /baseline/);
  assert.equal(JSON.stringify(f.contracts.history("local", folder)), before);
  assert.equal(f.registry.permissionOf(readSourceContractTool), "git.read");
});

test("the source-contract read recovers the latest persisted revision and original baseline", async t => {
  const f = fixture(t); f.create();
  const widened = f.contracts.widen("local", folder, { taskRunId: "approved", approvedBy: "local", reason: "Include changelog",
    terms: { allowedPaths: ["docs/**", "CHANGELOG.md"] } });
  const before = JSON.stringify(f.contracts.history("local", folder));
  const result = await f.read();
  assert.deepEqual(result.contract, widened); assert.equal(result.contract.revision, 2);
  assert.equal(result.contract.sourceSha, "a".repeat(40)); assert.equal(result.contractHash, contractHash(widened));
  assert.equal(JSON.stringify(f.contracts.history("local", folder)), before);
});

test("missing or differently named source contracts reject without reconstructing terms", async t => {
  const f = fixture(t); f.create();
  await assert.rejects(f.read({ name: "missing" }), /no persisted source contract.*Do not guess/);
  await assert.rejects(f.read({ name: "../existing" }));
  await assert.rejects(f.read({ name: "existing", contract: terms }));
  assert.equal(f.contracts.history("local", folder).length, 1);
});

for (const runId of ["chat", "household", "key"]) test(`the source-contract read rejects a persisted ${runId} origin`, async t => {
  const f = fixture(t); f.create();
  await assert.rejects(f.read(undefined, { runId }), /Only the owner in the Branch app/);
  assert.equal(f.contracts.history("local", folder).length, 1);
});

test("a household profile, nondefault Trunk and short-lived request key cannot read owner source contracts", async t => {
  const f = fixture(t); f.create();
  f.setOwner(false); await assert.rejects(f.read(), /Only the owner in the Branch app/);
  f.setOwner(true); await assert.rejects(f.read(undefined, { trunk: "other" }), /Only the owner in the Branch app/);
  await assert.rejects(underShortLivedKey(() => f.read()), /Only the owner in the Branch app/);
});

test("source-contract reads follow both existing dependencies without preparing work or invoking remote Git", t => {
  const f = fixture(t, false);
  assert.equal(f.registry.names().includes(readSourceContractTool), false);
  f.dependency("git.push"); assert.equal(f.registry.names().includes(readSourceContractTool), false);
  f.dependency(prepareToolName); assert.equal(f.registry.names().includes(readSourceContractTool), true);
  f.registry.unregister(prepareToolName); assert.equal(f.registry.names().includes(readSourceContractTool), false);
  f.dependency(prepareToolName); assert.equal(f.registry.names().includes(readSourceContractTool), true);
  f.registry.unregister("git.push"); assert.equal(f.registry.names().includes(readSourceContractTool), false);
});
