/**
 * Parity B1: "Look inside" names what a task read first (the instruction files carried in, how many remembered things it
 * was given), the tools described to the model against those one step away, and, per round, what the provider's own
 * prompt cache served when it said.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { inspectRun } from "../dist/inspect.js";

test("inspectRun carries read-first, tools offered and each round's cached input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-inspect-read-first-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [], usage: { input: 900, output: 12, cachedInput: 600 } }; } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "what is in here" });
  const view = inspectRun(app.store, run.id, { receipts: { items: [], counts: {} }, timeline: null, cost: null, version: "test" });
  assert.ok(Array.isArray(view.readFirst.files), "the files carried in, as a list");
  assert.equal(view.readFirst.remembered, 0, "how many remembered things it was given");
  assert.ok(view.toolsOffered.shown > 0 && Number.isInteger(view.toolsOffered.oneStepAway), "tools shown and one step away");
  const round = view.rounds.at(-1);
  assert.ok(round, "a round was recorded");
  assert.equal(round.tokens.cachedInput, 600, "what the provider's cache served, as it said");
});
