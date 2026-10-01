import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";
import { withAccountCall, currentAccountCall } from "../dist/accounts/context.js";

async function scopedRun(t) {
  const f = await fixture(t);
  on(f.app);
  const home = f.app.trunks.ensureDefault(true);
  const run = await f.app.runtime.run({ prompt: "Explain this isolated fixture task.", trunkId: home.id });
  assert.equal(run.status, "completed");
  const started = f.app.store.events(run.id).find((event) => event.kind === "run.started");
  assert.equal(started?.data.trunkScope?.id, home.id, "an explicitly routed conversation records its original Trunk authority");
  assert.equal(typeof started.data.trunkScope.owners, "boolean");
  assert.deepEqual(started.data.trunkScope.keys, f.app.trunks.shapeOf({ prompt: "", sessionId: run.sessionId }).keys);
  f.app.store.finish(run.id, "interrupted", "fixture interruption");
  return { ...f, home, run, saved: started.data.trunkScope };
}

test("unchanged original Trunk snapshot permits actual runtime continuation", async (t) => {
  const { app, run, saved } = await scopedRun(t);
  const resumed = await app.runtime.resume(run.id);
  assert.equal(resumed.status, "completed");
  const started = app.store.events(resumed.id).find((event) => event.kind === "run.started");
  assert.equal(started.data.resumedFrom, run.id);
  assert.deepEqual(started.data.trunkScope, saved, "continuation retains the exact credential and designation ceiling");
});

test("changed Trunk credential copying refuses continuation instead of widening scope", async (t) => {
  const { app, home, run, saved, provider } = await scopedRun(t);
  app.trunks.edit(home.id, { keys: { copyFromOwner: !saved.keys.copyFromOwner, accounts: {} } });
  const requests = provider.requests.length;
  await assert.rejects(app.runtime.resume(run.id), /Trunk|credential|authority/i);
  assert.equal(provider.requests.length, requests, "changed authority is refused before calling the model");
  assert.equal(app.store.run(run.id).status, "interrupted");
});

test("legacy Trunk task missing its immutable credential snapshot stays held", async (t) => {
  const { app, provider } = await fixture(t);
  on(app);
  const home = app.trunks.ensureDefault(true);
  const run = app.store.createRun(app.runtime.owner, "legacy scoped task", home.chatSessionId);
  app.store.event(run.id, "run.started", { source: "owner", permissions: app.registry.permissions(),
    deadlineMs: 30_000, depth: 0, delegates: false, dryRun: false, ownCopy: false });
  app.store.event(run.id, "trunk.turn", { trunkId: home.id });
  app.store.finish(run.id, "interrupted", "fixture interruption");
  const requests = provider.requests.length;
  await assert.rejects(app.runtime.resume(run.id), /Trunk|credential|authority/i);
  assert.equal(provider.requests.length, requests);
  assert.equal(app.store.run(run.id).status, "interrupted");
});

test("default migration leaves unfinished originally unscoped conversations unclaimed", async (t) => {
  const { app } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "originally unscoped unfinished task");
  app.store.event(run.id, "run.started", { source: "owner", permissions: [], deadlineMs: 30_000,
    depth: 0, delegates: false, dryRun: false, ownCopy: false });
  app.store.finish(run.id, "interrupted", "fixture interruption");
  on(app);
  const home = app.trunks.ensureDefault(true);
  assert.ok(home);
  const claim = app.store.sqlite.prepare("SELECT trunk_id FROM trunk_threads WHERE session_id=?").get(run.sessionId);
  assert.equal(claim, undefined, "migration cannot invent Trunk authority for unfinished unscoped work");
  assert.equal(app.trunks.shapeOf({ prompt: "", sessionId: run.sessionId }), null);
  assert.equal(app.store.events(run.id).some((event) => event.kind === "trunk.turn"), false);
});



test("Trunk recovery refuses conflicting ambient credentials and retains matching caller ceilings", async (t) => {
  const { app, home, run, saved } = await scopedRun(t);
  assert.equal(saved.owners, true);
  const altered = { copyFromOwner: !saved.keys.copyFromOwner, accounts: { fixture: "ambient-only" } };
  for (const id of ["foreign-fixture-trunk", home.id]) {
    const ambient = { owner: app.runtime.owner, sessionId: "ambient-session", runId: "ambient-run",
      trunk: { id, keys: altered, signIns: false } };
    await withAccountCall(ambient, async () => {
      assert.throws(() => app.runtime.recoveryTrunkContext(run.id, app.runtime.context({ runId: run.id, permissions: [] })),
        /existing account scope conflicts/);
      assert.equal(currentAccountCall(), ambient, "refusal never changes the surrounding caller's authority");
      assert.deepEqual(currentAccountCall().trunk.keys, altered);
    });
  }
  const matching = { owner: app.runtime.owner, sessionId: "ambient-session", runId: "ambient-run",
    trunk: { id: home.id, keys: saved.keys, signIns: false } };
  await withAccountCall(matching, async () => {
    const context = app.runtime.recoveryTrunkContext(run.id, app.runtime.context({ runId: run.id, permissions: [] }));
    assert.equal(context.trunk, undefined, "owner-designated recovery clears inherited identity");
    assert.deepEqual(context.trunkKeys, saved.keys);
    await app.runtime.inRecoveryAccountScope(context, async () => {
      const actual = currentAccountCall();
      assert.equal(actual.runId, run.id, "matching credentials still receive a fresh task-specific scope");
      assert.equal(actual.trunk.id, undefined);
      assert.deepEqual(actual.trunk.keys, saved.keys);
      assert.equal(actual.trunk.signIns, false, "a caller's sign-in refusal remains a ceiling");
    });
    assert.equal(currentAccountCall(), matching);
  });
});

test("unscoped recovery refuses ambient Trunk authority and clears inherited context fields", async (t) => {
  const { app } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "bounded originally unscoped task");
  app.store.event(run.id, "run.started", { source: "owner", permissions: [], deadlineMs: 30_000,
    depth: 0, delegates: false, dryRun: false, ownCopy: false });
  app.store.finish(run.id, "interrupted", "fixture interruption");
  const keys = { copyFromOwner: false, accounts: { fixture: "ambient-only" } };
  const ambient = { owner: app.runtime.owner, sessionId: "ambient-session", runId: "ambient-run",
    trunk: { id: "foreign-fixture-trunk", keys, signIns: false } };
  await withAccountCall(ambient, async () => {
    assert.throws(() => app.runtime.recoveryTrunkContext(run.id, app.runtime.context({ runId: run.id, permissions: [] })),
      /existing account scope conflicts/);
    assert.equal(currentAccountCall(), ambient);
  });
  const inherited = { ...app.runtime.context({ runId: run.id, permissions: [] }), trunk: ambient.trunk.id, trunkKeys: keys };
  const context = app.runtime.recoveryTrunkContext(run.id, inherited);
  assert.equal(context.trunk, undefined);
  assert.equal(context.trunkKeys, undefined);
  await app.runtime.inRecoveryAccountScope(context, async () => {
    assert.equal(currentAccountCall().runId, run.id);
    assert.equal(currentAccountCall().trunk, undefined, "unscoped work receives no account authority from stale context fields");
  });
});
