/**
 * RES-189: a scheduled task can keep its result as a dashboard. The page is built only from the task's finished JSON,
 * a failed source keeps the last good value marked stale, a bad refresh keeps the last valid page, and nothing the
 * task wrote is served as markup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, recordScheduledDashboard, readScheduledDashboard } from "../dist/index.js";

const cell = (value, status = "fresh") => ({ value, source: "status page", observedAt: new Date(Date.now() - 60_000).toISOString(), status });
const page = (value, status) => JSON.stringify({ columns: [{ id: "state", label: "State" }],
  rows: [{ id: "site", label: "Web site", cells: { state: cell(value, status) } }], attention: [] });

test("RES-189: a scheduled dashboard keeps its last good value, marks a failed source stale, and never serves the task's markup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sched-dash-"));
  const replies = [];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: replies.shift() ?? "", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, id = randomUUID();
  const data = { kind: "task", prompt: "Check the site", dashboard: { title: "Site health" } };
  app.store.save("schedules", owner, id, data);
  // A real finished task, as the scheduler hands over: the page is read from what the task answered.
  const run = async (output) => { replies.push(output); return app.runtime.run({ prompt: "Check the site" }); };
  assert.equal(readScheduledDashboard(app.store, owner, id).html, null, "nothing before a finished run");

  assert.equal(recordScheduledDashboard(app.store, owner, id, data, await run(page("<script>up</script>"))), true);
  const first = readScheduledDashboard(app.store, owner, id).html;
  assert.match(first, /&lt;script&gt;up&lt;\/script&gt;/);
  assert.doesNotMatch(first, /<script>/);

  recordScheduledDashboard(app.store, owner, id, data, await run(page("ignored", "stale")));
  const stale = readScheduledDashboard(app.store, owner, id).html;
  assert.match(stale, /&lt;script&gt;up/, "the last good value is kept");
  assert.match(stale, /STALE/);

  recordScheduledDashboard(app.store, owner, id, data, await run("not json at all"));
  const kept = readScheduledDashboard(app.store, owner, id);
  assert.match(kept.error, /last valid page is retained/);
  assert.match(kept.html, /Site health/);

  const other = { ...data, dashboard: { title: "Changed" } };
  assert.equal(recordScheduledDashboard(app.store, owner, id, other, await run(page("x"))), null, "a run for a changed schedule is not recorded");
});
