import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on, setupTrunk } from "./trunks-helpers.mjs";
import { defaultPointer } from "../dist/trunks/defaults.js";

test("an authority grant rolls back when its audit cannot be written", async t => {
  const { app } = await fixture(t);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  app.store.sqlite.exec("CREATE TRIGGER test_authority_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'authority audit unavailable'); END");
  try {
    for (const grant of [() => app.trunks.setDefault(ada.id), () => app.trunks.ensureDefault(true)]) {
      assert.throws(grant, /authority audit unavailable/);
      assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer), undefined);
      assert.equal(app.trunks.shapeOf({ prompt: "hello", trunkId: ada.id }).owners, undefined);
    }
  } finally { app.store.sqlite.exec("DROP TRIGGER test_authority_audit_failure"); }
});

test("an introduction's routing fallback never grants owner authority; an explicit same-id choice does", async t => {
  const { app } = await fixture(t);
  on(app);
  const ada = setupTrunk(app, { name: "Ada" });
  await app.trunks.introduced();
  assert.equal(app.trunks.defaultTrunk()?.id, ada.id, "setup finished after the introduction, so routing has a fallback");
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer), undefined);
  const before = app.trunks.shapeOf({ prompt: "hello", trunkId: ada.id });
  assert.equal(before.owners, undefined);
  assert.equal(before.agent, `trunk:${ada.id}`);
  assert.equal(before.keepsReach, undefined);
  assert.match(app.channels.trunkIdReach("telegram", ada.id), /does not answer on telegram/);
  assert.equal(app.channels.chatTrunk("telegram", "unbound-chat"), ada.id, "the actual external router can resolve its implicit fallback");
  assert.equal(app.trunks.homeForNew(), ada.id, "a new conversation can resolve the same routing fallback");
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer), undefined, "neither routing lookup designates authority");
  assert.equal(app.trunks.shapeOf({ prompt: "hello", trunkId: ada.id }).owners, undefined);
  assert.match(app.channels.trunkIdReach("telegram", ada.id), /does not answer on telegram/, "channel reach stays narrow after resolution");
  app.trunks.setDefault(ada.id);
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer).data.trunkId, ada.id);
  assert.equal(app.trunks.shapeOf({ prompt: "hello", trunkId: ada.id }).owners, true);
  assert.equal(app.channels.trunkIdReach("telegram", ada.id), null);
});

test("trusted default settlement records authority, and removal records its successor; pure reads do neither", async t => {
  const { app } = await fixture(t);
  on(app);
  const ada = setupTrunk(app, { name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  for (let read = 0; read < 3; read++) assert.equal(app.trunks.defaultTrunk().id, ada.id);
  assert.equal(app.trunks.ownerDefault(), undefined);
  assert.equal(app.trunks.ensureDefault(true).id, ada.id);
  assert.equal(app.trunks.ownerDefault().id, ada.id);
  const designation = app.store.get("governance", app.runtime.owner, defaultPointer);
  const audits = app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).length;
  app.store.sqlite.exec("CREATE TRIGGER test_default_no_rewrite BEFORE UPDATE ON governance WHEN OLD.id='trunk-default' BEGIN SELECT RAISE(ABORT, 'already designated authority must not be rewritten'); END");
  try { app.trunks.ensureDefault(true); }
  finally { app.store.sqlite.exec("DROP TRIGGER test_default_no_rewrite"); }
  assert.deepEqual(app.store.get("governance", app.runtime.owner, defaultPointer), designation, "already designated: no rewrite");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).length, audits);
  assert.equal(app.trunks.shapeOf({ prompt: "x", trunkId: bo.id }).owners, undefined);
  app.trunks.remove(ada.id);
  assert.equal(app.trunks.ownerDefault().id, bo.id);
  assert.equal(app.trunks.shapeOf({ prompt: "x", trunkId: bo.id }).owners, true);
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).filter(entry => entry.reason.includes("eligible successor's authority")).length, 1, "successor authority is audited, separately from conversation migration");
  app.trunks.remove(bo.id);
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer), undefined, "a removed default cannot regain authority through a future restored id");
});
