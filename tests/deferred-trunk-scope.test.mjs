import test from "node:test";
import assert from "node:assert/strict";
import { fixture, setupTrunk, on, call } from "./trunks-helpers.mjs";
import { setTimeout as delay } from "node:timers/promises";

test("non-default Trunk deferred continuation preserves identity and refuses changed keys", async (t) => {
  const { app } = await fixture(t, [({ last }) => last?.role === "user" && last.content === "defer scoped work"
    ? call("user.later", { description: "scoped next step" }) : null]);
  on(app);
  setupTrunk(app, { name: "Main" });
  const trunk = app.trunks.create({ name: "Scout" });
  await app.trunks.introduced();
  const run = await app.runtime.run({ prompt: "defer scoped work", sessionId: trunk.chatSessionId });
  const waiting = app.runtime.deferrals.list({ waiting: true }).find((job) => job.runId === run.id);
  assert.ok(waiting);
  const original = app.store.events(run.id).find((event) => event.kind === "run.started").data;
  assert.equal(original.deferredScope.credentials.owners, false);
  app.trunks.edit(trunk.id, { keys: { copyFromOwner: false, accounts: {} } });
  assert.throws(() => app.runtime.settleDeferred(waiting.id, undefined, "finish"), /credential identity or key restrictions/);
  assert.equal(app.runtime.deferrals.get(waiting.id).settledAt, null);
  app.trunks.edit(trunk.id, { keys: original.deferredScope.credentials.keys });
  app.runtime.settleDeferred(waiting.id, undefined, "finish");
  let next;
  for (let i = 0; i < 200 && !next; i++) {
    next = app.store.runs(app.runtime.owner).find((one) => one.id !== run.id && one.sessionId === run.sessionId
      && app.store.events(one.id).some((event) => event.kind === "run.started" && event.data.originFrom === run.id));
    if (!next) await delay(20);
  }
  assert.ok(next, "a scoped continuation started");
  const restored = app.store.events(next.id).find((event) => event.kind === "run.started").data;
  assert.deepEqual(restored.permissions, original.permissions);
  assert.deepEqual(restored.deferredScope.credentials, original.deferredScope.credentials);
});
