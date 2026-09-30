/**
 * SELF-052: "Try a bad change" runs a real rollback on throwaway programs. The bad program fails, the
 * real rollback puts the previous one back, the real gateway starts it, and the report is kept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { lastRecoveryDrill, runRecoveryDrill } from "../dist/never-break/drill.js";

test("SELF-052: the isolated drill rolls a bad fixture back and keeps its report", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-drill-"));
  t.after(() => discardTemp(dataDir));
  assert.equal(await lastRecoveryDrill(dataDir), null);
  const [drill, second] = await Promise.allSettled([runRecoveryDrill(dataDir), runRecoveryDrill(dataDir)]);
  assert.equal(second.status, "rejected", "a second drill at once is refused");
  assert.equal(drill.value.ok, true, drill.value.detail);
  assert.ok(drill.value.ledger.length > 0, "the rollback ledger is reported");
  assert.deepEqual(await lastRecoveryDrill(dataDir), drill.value);
});
