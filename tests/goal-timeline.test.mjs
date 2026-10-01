/* UI-265: retained goals and their recorded timeline (GET /api/goals, GET /api/sessions/<id>/goal-timeline), read-only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const goal = (sessionId, extra = {}) => ({ sessionId, objective: "Ship the report", status: "done", round: 2, maxRounds: 5, score: 0.9, best: 0.9,
  flatRounds: 0, missing: [], reason: "The judge was satisfied.", checks: null, startedAt: "2026-09-29T10:00:00.000Z", elapsedMs: 120000,
  activeSince: null, lastRunId: null, ...extra });

test("finished goals stay listed with their recorded rounds; temporary conversations and strangers' ids are left out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-goal-timeline-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, "Ship the report");
  app.store.save("settings", owner, `goal:${run.sessionId}`, goal(run.sessionId, { lastRunId: run.id }));
  app.store.event(run.id, "goal.state", { startedAt: "2026-09-29T10:00:00.000Z", status: "working", round: 1, maxRounds: 5, score: 0.4,
    missing: ["the totals"], reason: "", elapsedMs: 60000, subgoals: [] });
  app.store.event(run.id, "goal.state", { startedAt: "2026-09-28T10:00:00.000Z", status: "done", round: 9, maxRounds: 9, score: 1,
    missing: [], reason: "An older goal", elapsedMs: 1, subgoals: [] });
  const scratch = app.store.createRun(owner, "Just trying", undefined, true);
  app.store.save("settings", owner, `goal:${scratch.sessionId}`, goal(scratch.sessionId, { objective: "Temporary goal" }));
  const get = async (path) => { const response = await fetch(server.url + path, { headers: { authorization: `Bearer ${server.token}` } });
    return { status: response.status, body: await response.json() }; };
  const index = await get("/api/goals");
  assert.equal(index.status, 200);
  assert.deepEqual(index.body.goals.map((one) => one.objective), ["Ship the report"], "a finished goal is kept; a temporary one is not");
  const timeline = await get(`/api/sessions/${run.sessionId}/goal-timeline`);
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.historyRecorded, true);
  assert.deepEqual(timeline.body.events.map((event) => event.data.round), [1], "only this goal's own recorded rounds");
  assert.equal((await get("/api/sessions/00000000-0000-4000-8000-000000000000/goal-timeline")).status >= 400, true);
});
