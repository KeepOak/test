import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";
import { defaultPointer } from "../dist/trunks/defaults.js";

test("an introduction's routing fallback never grants owner authority; an explicit same-id choice does", async t => {
  const { app } = await fixture(t);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  assert.equal(app.trunks.defaultTrunk()?.id, ada.id, "setup finished after the introduction, so routing has a fallback");
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer), undefined);
  const before = app.trunks.shapeOf({ prompt: "hello", trunkId: ada.id });
  assert.equal(before.owners, undefined);
  assert.equal(before.agent, `trunk:${ada.id}`);
  assert.equal(before.keepsReach, undefined);
  assert.match(app.channels.trunkIdReach("telegram", ada.id), /does not answer on telegram/);
  app.trunks.setDefault(ada.id);
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer).data.trunkId, ada.id);
  assert.equal(app.trunks.shapeOf({ prompt: "hello", trunkId: ada.id }).owners, true);
  assert.equal(app.channels.trunkIdReach("telegram", ada.id), null);
});

test("trusted default settlement records authority, and removal records its successor; pure reads do neither", async t => {
  const { app } = await fixture(t);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  for (let read = 0; read < 3; read++) assert.equal(app.trunks.defaultTrunk().id, ada.id);
  assert.equal(app.trunks.ownerDefault(), undefined);
  assert.equal(app.trunks.ensureDefault(true).id, ada.id);
  assert.equal(app.trunks.ownerDefault().id, ada.id);
  const designation = app.store.get("governance", app.runtime.owner, defaultPointer);
  const audits = app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).length;
  app.trunks.ensureDefault(true);
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer).revision, designation.revision, "already designated: no rewrite");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).length, audits);
  assert.equal(app.trunks.shapeOf({ prompt: "x", trunkId: bo.id }).owners, undefined);
  app.trunks.remove(ada.id);
  assert.equal(app.trunks.ownerDefault().id, bo.id);
  assert.equal(app.trunks.shapeOf({ prompt: "x", trunkId: bo.id }).owners, true);
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).filter(entry => entry.reason.includes("eligible successor's authority")).length, 1, "successor authority is audited, separately from conversation migration");
  app.trunks.remove(bo.id);
  assert.equal(app.store.get("governance", app.runtime.owner, defaultPointer), undefined, "a removed default cannot regain authority through a future restored id");
});
