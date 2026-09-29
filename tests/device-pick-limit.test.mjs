/* Q3: a device picked for a conversation. For the owner's own work it is where a call goes by default, and another
   device can still be named; for anyone else (a household person, a lent conversation) it is the only device there is,
   and a device never shared with them stays out of reach whatever is picked.
   Mutation: drop the pickLimitRefusal line in chooseDevice (src/devices/tools.ts) and the household case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { chooseDevice, pickDevice, pickLimitRefusal, personRefusal } from "../dist/devices/tools.js";

const phone = { id: "a".repeat(16), name: "Phone", platform: "android", sharedWith: ["p1"] };
const tablet = { id: "b".repeat(16), name: "Tablet", platform: "android", sharedWith: ["p1"] };
const ownersOwn = { id: "c".repeat(16), name: "Owner phone", platform: "ios", sharedWith: [] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-device-pick-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const deps = { store: app.store, owner: app.runtime.owner, files: null,
    book: { devices: () => [phone, tablet, ownersOwn] }, hub: { connected: () => true } };
  /** A task started as `started` says, in a conversation with `picked` chosen by the owner. */
  const task = (started, picked) => {
    const run = app.store.createRun(app.runtime.owner, "use a device");
    app.store.event(run.id, "run.started", { source: "owner", ...started });
    if (picked) pickDevice(app.store, app.runtime.owner, run.sessionId, picked);
    return { runId: run.id };
  };
  return { deps, task };
}

test("the owner's pick is a default: another device can still be named", async (t) => {
  const { deps, task } = await fixture(t);
  const context = task({}, phone.id);
  assert.equal(chooseDevice(deps, context, undefined).id, phone.id, "an unnamed call goes to the pick");
  assert.equal(chooseDevice(deps, context, "Tablet").id, tablet.id, "the owner may still name another");
  assert.equal(chooseDevice(deps, context, "Owner phone").id, ownersOwn.id);
});

test("for a household person or a lent conversation the pick is a limit, and the owner's devices stay out of reach", async (t) => {
  const { deps, task } = await fixture(t);
  for (const started of [{ personProfileId: "p1" }, { lentTo: "profile:p1" }]) {
    const context = task(started, phone.id);
    assert.equal(chooseDevice(deps, context, undefined).id, phone.id);
    assert.equal(chooseDevice(deps, context, "Phone").id, phone.id, "naming the pick itself is fine");
    assert.throws(() => chooseDevice(deps, context, "Tablet"), { message: pickLimitRefusal }, JSON.stringify(started));
    assert.throws(() => chooseDevice(deps, context, "Owner phone"), { message: personRefusal }, "never one not shared with them");
    const unpicked = task(started, null);
    assert.equal(chooseDevice(deps, unpicked, "Tablet").id, tablet.id, "with nothing picked, any device shared with them");
    assert.throws(() => chooseDevice(deps, unpicked, "Owner phone"), { message: personRefusal });
    const pickedOwners = task(started, ownersOwn.id);
    assert.throws(() => chooseDevice(deps, pickedOwners, "Owner phone"), { message: personRefusal }, "a pick never lends a device");
  }
});
