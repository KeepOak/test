/**
 * RES-140: the owner's curated skill marketplace. Only HTTPS sources; browsing searches the listing;
 * installing needs a fresh inspection ticket, and a ticket installs (inactive) once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { SkillMarketplace } from "../dist/skill-marketplace.js";

test("RES-140: HTTPS sources only, search, and one inactive install per inspection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-skill-market-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const installs = [];
  const skills = [{ id: "pdf-tidy", name: "PDF tidy", description: "Tidy PDFs", url: "https://example.com/pdf-tidy/SKILL.md", signed: "unsigned" },
    { id: "calendar-helper", name: "Calendar helper", description: "Dates", url: "https://example.com/cal/SKILL.md", signed: "unsigned" }];
  const registry = { browse: async () => ({ name: "Example", key: { published: null, pinned: null }, skills }),
    inspect: async (_url, id) => ({ registry: "https://example.com/index.json", entry: skills.find((s) => s.id === id), findings: [], document: "---\nname: x\n---\n" }),
    installReviewed: async (review, guard) => { guard(); installs.push(review.entry.id); return { id: "s1", active: false } } };
  const market = new SkillMarketplace(app.store, app.runtime.owner, registry, () => false);
  assert.throws(() => market.add({ label: "Plain", url: "http://example.com/index.json" }), /HTTPS/);
  const { sources: [source] } = market.add({ label: "Example", url: "https://example.com/index.json" });
  const found = await market.browse({ source: source.id, query: "pdf" });
  assert.deepEqual(found.skills.map((s) => s.id), ["pdf-tidy"]);
  const { ticket } = await market.inspect({ source: source.id, skillId: "pdf-tidy" });
  await market.install({ ticket, approve: true });
  await assert.rejects(market.install({ ticket, approve: true }), /expired/);
  assert.deepEqual(installs, ["pdf-tidy"]);
});
