/**
 * Memory search puts the fact that answers first. It used to multiply the fused rank (best and next-best under 2%
 * apart) by how recent, used and confirmed a fact was (a spread of about 36 times), so a fact drawn on often beat the
 * one the question was about, and being shown counted as another use. The nudge is now bounded (hindsight's combined
 * scoring, src/memory-retrieval.ts): relevance decides, and the other signals only reorder near neighbours.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { orderScore, recencySignal, rerankBoost, useSignal } from "../dist/memory-retrieval.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-memory-rank-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const put = (app, id, text, extra = {}) => app.store.save("memory", "local", id, { text, source: "Owner", ...extra });

test("a relevant fact nobody has used outranks an irrelevant one drawn on 200 times", async (t) => {
  const app = await fixture(t);
  // Relevant, never used, 200 days old and not confirmed by the owner (a task saved it once).
  put(app, "dentist", "The dentist appointment is on Tuesday at nine", { sourceRunId: "run-1" });
  app.store.sqlite.prepare("UPDATE memory SET updated_at=? WHERE id=?").run(new Date(Date.now() - 200 * 86_400_000).toISOString(), "dentist");
  // Irrelevant but popular: one shared word, fresh, confirmed, and drawn on 200 times.
  put(app, "tea", "Prefers green tea on Tuesday");
  for (const [id, text] of [["bins", "Bins go out on Tuesday"], ["yoga", "Yoga class every Tuesday evening"], ["piano", "Piano lesson on Tuesday"]])
    put(app, id, text);
  app.memory.retrieval.noteUse("local", Array(50).fill("tea"));
  for (let i = 0; i < 3; i++) app.memory.retrieval.noteUse("local", Array(50).fill("tea"));
  assert.equal(app.memory.retrieval.useCounts("local").get("tea"), 200);
  app.memory.retrieval.configure("local", { useEmbeddings: false });

  const hits = await app.memory.retrieval.search("local", "When is the dentist appointment on Tuesday?");
  assert.equal(hits[0].record.id, "dentist", `order: ${hits.map((hit) => `${hit.record.id} ${hit.score}`).join(", ")}`);
  assert.ok(hits.some((hit) => hit.record.id === "tea"), "the popular fact is still found, just lower");
  for (const hit of hits) assert.ok(hit.importance >= 0.9 && hit.importance <= 1.22, `${hit.record.id}: bounded nudge ${hit.importance}`);
});

test("the nudges are bounded as in hindsight: relevance first, each signal at most half its alpha", () => {
  assert.equal(orderScore(0, 40), 1);
  assert.equal(Number(orderScore(39, 40).toFixed(6)), 0.1);
  assert.equal(orderScore(0, 1), 1, "a single hit");
  assert.equal(recencySignal(0), 1);
  assert.equal(recencySignal(5000), 0.1, "floored");
  assert.equal(useSignal(0), 0.5, "no uses is neutral");
  assert.equal(useSignal(1), 0.5);
  assert.equal(useSignal(1e9), 1, "capped");
  const at = Date.parse("2026-09-29T12:00:00Z");
  const most = rerankBoost({ updatedAt: new Date(at).toISOString(), revision: 2, data: {} }, 1e6, at);
  const least = rerankBoost({ updatedAt: "2020-01-01T00:00:00Z", revision: 1, data: { sourceRunId: "r" } }, 0, at);
  assert.ok(most <= 1.2128 && least >= 0.919, `${least}..${most}`);
  // So a fact eleven or more places down a 40-hit order can never be lifted over the best one.
  assert.ok(orderScore(0, 40) * least > orderScore(11, 40) * most);
});
