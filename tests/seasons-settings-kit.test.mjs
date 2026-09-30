/* SELF-068: the Seasons switches are a settings-kit setting, so a conversation request ("learn only when a skill gains at
   least 25 points") changes them the way every Settings card does. The catalogue speaks whole percentage points while
   the engine keeps the gain on its 0..1 scale, and paid models overnight is a loosening that needs the owner's yes.
   Mutation: drop the seasons entry from src/settings-kit/catalogue.ts and every case here goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { specFor } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor } from "../dist/settings-kit/changes.js";
import { seasonsSettings } from "../dist/seasons/settings.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-seasons-settings-kit-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { store: app.store, owner: app.runtime.owner };
}
const all = (changes, confirmLoosening = true) => ({ accept: changes.map((change) => change.id), confirmLoosening, why: "test" });

test("a request sets the Seasons gain in whole points, and the engine keeps it on its own scale", async (t) => {
  const { store, owner } = await fixture(t);
  assert.ok(specFor("seasons"), "Seasons is in the settings catalogue");
  const { changes, refused } = changesFor(store, owner, [{ key: "seasons", field: "minGainPercent", value: 25 }]);
  assert.deepEqual(refused, []);
  assert.equal(changes.length, 1);
  applyChanges(store, owner, changes, all(changes));
  assert.equal(seasonsSettings(store, owner).minGain, 0.25, "saved on the engine's 0..1 scale");
  const again = changesFor(store, owner, [{ key: "seasons", field: "minGainPercent", value: 25 }]);
  assert.equal(again.changes.length, 0, "read back as 25 points, so nothing is left to change");
});

test("paid models overnight from a request needs the owner's separate yes", async (t) => {
  const { store, owner } = await fixture(t);
  const { changes } = changesFor(store, owner, [{ key: "seasons", field: "paidModels", value: true }]);
  assert.equal(changes.length, 1);
  assert.throws(() => applyChanges(store, owner, changes, all(changes, false)), /less careful/);
  assert.equal(seasonsSettings(store, owner).paidModels, false, "nothing was written without the yes");
  applyChanges(store, owner, changes, all(changes));
  assert.equal(seasonsSettings(store, owner).paidModels, true);
});
