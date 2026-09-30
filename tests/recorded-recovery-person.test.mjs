import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { recordedRecoveryPerson } from "../dist/never-break/recorded-person.js";
import { asPerson } from "../dist/people/context.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-recorded-person-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "unused", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const ada = app.store.profiles.create({ name: "Ada", pin: "1234" });
  const bea = app.store.profiles.create({ name: "Bea", pin: "5678" });
  const run = app.store.createRun(app.runtime.owner, "interrupted person task");
  const start = { source: "owner", personProfileId: ada.id, lentTo: `profile:${ada.id}`,
    permissions: [], deadlineMs: 30_000, depth: 0, delegates: false };
  const record = (data = start) => {
    app.store.event(run.id, "run.started", data);
    app.store.finish(run.id, "interrupted", "fixture interruption");
    app.store.reassignSession(run.sessionId, `profile:${ada.id}`);
  };
  const recover = () => recordedRecoveryPerson(app.store, run.id, app.runtime.owner);
  return { app, ada, bea, run, start, record, recover };
}

const refusal = /recorded person and conversation ownership/;

test("an actual person's original personal Trunk remains scoped through continuation", async (t) => {
  const f = await fixture(t);
  const original = await asPerson({ profileId: f.ada.id, keyId: "fixture" }, () =>
    f.app.runtime.run({ prompt: "Describe the isolated task.", lentTo: `profile:${f.ada.id}` }));
  assert.equal(original.status, "completed");
  const start = f.app.store.events(original.id).find((event) => event.kind === "run.started").data;
  assert.ok(start.trunkScope, "the original personal Trunk was recorded");
  f.app.store.finish(original.id, "interrupted", "fixture interruption");
  const resumed = await f.app.runtime.resume(original.id);
  assert.equal(resumed.status, "completed");
  const continued = f.app.store.events(resumed.id).find((event) => event.kind === "run.started").data;
  assert.deepEqual(continued.trunkScope, start.trunkScope);
  assert.equal(continued.personProfileId, f.ada.id);
});

test("returned lent task retains its existing person's identity and restricted role", async (t) => {
  const f = await fixture(t);
  f.app.runtime.roles.save(f.ada.id, { role: "child" });
  f.record();
  const person = f.recover();
  assert.equal(person, f.ada.id);
  asPerson({ profileId: person, keyId: "resumed" }, () => {
    assert.equal(f.app.store.profiles.isOwner(), false);
    assert.equal(f.app.store.profiles.scope(), `profile:${f.ada.id}`);
    assert.match(f.app.runtime.roleRefusal("files.write", "files.write", f.run.id), /does not cover/);
  });
  assert.equal(f.app.store.profiles.isOwner(), true, "validation never switches the window profile");
  assert.equal(f.app.store.run(f.run.id).owner, `profile:${f.ada.id}`, "validation never reassigns the task to the owner");
});

test("another current person cannot recover the recorded person's task", async (t) => {
  const f = await fixture(t); f.record();
  asPerson({ profileId: f.bea.id, keyId: "other" }, () => assert.throws(f.recover, refusal));
});

test("a different lent scope does not authorize returned task ownership", async (t) => {
  const f = await fixture(t);
  f.record({ ...f.start, lentTo: `profile:${f.bea.id}` });
  assert.throws(f.recover, refusal);
});

test("a different recorded profile cannot authorize the current task owner", async (t) => {
  const f = await fixture(t);
  f.record({ ...f.start, personProfileId: f.bea.id, lentTo: `profile:${f.bea.id}` });
  assert.throws(f.recover, refusal);
});

test("removed recorded profile never falls back to owner identity", async (t) => {
  const f = await fixture(t); f.record();
  f.app.store.profiles.remove(f.ada.id);
  assert.throws(f.recover, refusal);
});

test("missing lifecycle identity cannot authorize recovery", async (t) => {
  const f = await fixture(t);
  f.app.store.finish(f.run.id, "interrupted", "fixture interruption");
  assert.throws(f.recover, refusal);
});

test("returned profile ownership requires explicit immutable lent proof", async (t) => {
  const f = await fixture(t);
  const { lentTo, ...withoutLending } = f.start;
  f.record(withoutLending);
  assert.throws(f.recover, refusal);
});
