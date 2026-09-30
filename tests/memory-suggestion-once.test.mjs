/**
 * QA retest 2026-09-28 (m12): the same fact suggested twice showed twice in Library › Memory, to be accepted or rejected
 * twice. A suggestion to remember the same words with the same details while the first still waits is that suggestion;
 * other words, other details, or one after the first was decided are new. Node only: the real dist/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

test("the same fact suggested again while it waits is the same suggestion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-suggestion-once-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.store.review.configure("local", { review: false, requireApproval: true });
  const waiting = () => app.store.review.proposals("local", "pending");
  const first = await app.runtime.executeTool("memory.put", { text: "My favourite colour is teal.", source: "Owner", kind: "preference" });
  const again = await app.runtime.executeTool("memory.put", { text: "  my favourite colour is   teal. ", source: "Someone else", kind: "preference" });
  assert.equal(first.staged, true);
  assert.equal(again.proposalId, first.proposalId, "the waiting suggestion, not a second one");
  assert.equal(waiting().length, 1);

  await app.runtime.executeTool("memory.put", { text: "My favourite colour is teal.", source: "Owner", kind: "fact-about-person" });
  assert.equal(waiting().length, 2, "the same words with other details are a new suggestion");
  await app.runtime.executeTool("memory.put", { text: "My dog is called Juniper.", source: "Owner", kind: "preference" });
  assert.equal(waiting().length, 3, "other words are a new suggestion");

  await app.store.review.decide("local", first.proposalId, false);
  const afterNo = await app.runtime.executeTool("memory.put", { text: "My favourite colour is teal.", source: "Owner", kind: "preference" });
  assert.notEqual(afterNo.proposalId, first.proposalId, "once decided, the same words may be suggested again");
  assert.equal(waiting().length, 3);
});
