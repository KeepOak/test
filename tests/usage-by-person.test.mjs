/* MODEL-108: Team › Usage shows each person's recorded model usage (src/usage-by-person.ts, GET /api/usage?people=1). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { usageByPerson } from "../dist/usage-by-person.js";

test("the owner's recorded model use is counted as theirs, and the owner window's usage route carries it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage-person-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [], usage: { input: 120, output: 30 } }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  await app.runtime.run({ prompt: "Say done" });
  await app.runtime.run({ prompt: "Say done again" });
  const report = usageByPerson({ store: app.store, owner: app.runtime.owner, modelCostOf: () => 0.25 }, 30);
  assert.equal(report.rows.length, 1);
  const [mine] = report.rows;
  assert.equal(mine.kind, "owner");
  assert.equal(mine.tasks, 2);
  assert.deepEqual(mine.tokens, { input: 240, output: 60 });
  assert.equal(mine.estimatedModelCost, 0.5);
  assert.equal(usageByPerson({ store: app.store, owner: app.runtime.owner, modelCostOf: () => null }).rows[0].unpricedTasks, 2, "no price is said as unknown, never as zero");
  const response = await fetch(`${server.url}/api/usage?range=30d&people=1`, { headers: { authorization: `Bearer ${server.token}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.byPerson?.rows?.[0]?.kind, "owner");
  const plain = await (await fetch(`${server.url}/api/usage?range=30d`, { headers: { authorization: `Bearer ${server.token}` } })).json();
  assert.equal(plain.byPerson, null, "only asked for, never sent by default");
});
