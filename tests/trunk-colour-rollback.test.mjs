/* DG-105 (option B): a colour the owner picks as a value is the Trunk's `chosenColour`, kept outside the look so a
   build from before it can still read and edit the Trunk. That older build keeps a field it does not know and
   writes only the look. These are the writes it makes, done here directly on the saved record, and what this
   build then draws. The real older build was also run against the same data by hand (see the PR). No browser. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { exportTrunk, importedFields } from "../dist/trunks/share.js";
import { TrunkLookSchema } from "../dist/trunks/look.js";
import { TrunkSchema } from "../dist/trunks/record.js";


async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-colour-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const records = app.trunks.records;
  /* Straight into the records, as the Trunks switch (off as shipped) does not matter to what is saved. */
  const made = records.put(records.build(TrunkSchema.parse({ name: "Scout" }), "chat-scout"));
  const trunk = records.edit(made.id, { chosenColour: "#E07033", look: { colour: null } });
  /** What a build from before chosenColour writes: its own picked fields laid over the record, the rest kept. */
  const olderBuildWrites = (change) => records.put({ ...records.get(trunk.id), ...change });
  return { records, trunk, olderBuildWrites };
}

test("DG-105 the look an older build reads has no value in it, so it can still check and edit the Trunk", async (t) => {
  const { trunk } = await branch(t);
  assert.equal(trunk.chosenColour, "#e07033");
  assert.equal(trunk.look.colour, null);
  assert.equal(TrunkLookSchema.safeParse(trunk.look).success, true);
});

test("DG-105 a Trunk's file carries the picked colour, and brings it back", async (t) => {
  const { records, trunk } = await branch(t);
  const file = exportTrunk(records.get(trunk.id));
  assert.equal(file.trunk.chosenColour, "#e07033");
  assert.equal(importedFields(JSON.parse(JSON.stringify(file)), []).chosenColour, "#e07033");
});
