import test from "node:test";
import assert from "node:assert/strict";
import { GoalMode } from "../dist/goal-mode.js";
import { currentProject } from "../dist/project-scope.js";

const owner = "fixture-owner";
const sessionId = "00000000-0000-4000-8000-000000000001";
const origin = { source: "channel", permissions: ["files.read"], chat: { channel: "telegram", senderId: "fixture-sender" } };

// Only goal orchestration runs: no runtime, database, provider, workspace or external account is opened.
function fixture({ previous = { id: "previous", owner, sessionId, project: "original" },
  sessionProject = "original", projects = ["original"], round = 1, lastRunId = "previous", beforeRun } = {}) {
  const records = new Map();
  const runs = new Map(previous ? [[previous.id, previous]] : []);
  const calls = [], events = [];
  let finish;
  const terminal = new Promise((resolve) => { finish = resolve; });
  const key = (kind, person, name) => `${kind}:${person}:${name}`;
  const store = {
    get: (kind, person, name) => records.get(key(kind, person, name)),
    save(kind, person, name, data) {
      records.set(key(kind, person, name), { data: structuredClone(data) });
      if (name === `goal:${sessionId}` && ["done", "blocked", "limit", "stopped"].includes(data.status)) finish(data);
    },
    run: (id) => runs.get(id),
    projects: { list(person) { assert.equal(person, owner); return projects.map((id) => ({ id })); } },
    sessionProject: () => sessionProject,
    event: (...args) => events.push(args),
  };
  const runtime = {
    owner, workspace: "unused",
    async run(options) {
      calls.push({ options, project: currentProject() });
      if (beforeRun) await beforeRun(calls.length, { setProject(value) { sessionProject = value; } });
      const run = { id: `round-${calls.length}`, owner, sessionId, project: sessionProject, status: "completed", output: "fixture" };
      runs.set(run.id, run);
      options.onStarted(run);
      return run;
    },
  };
  const goals = new GoalMode(runtime, store, () => 100);
  goals.judge = async () => ({ score: 1, missing: [], done: true, blocked: null });
  store.save("settings", owner, `goal:${sessionId}`, {
    sessionId, objective: "Continue the original project", status: "paused", round, maxRounds: 3,
    score: null, best: 0, flatRounds: 0, missing: [], reason: "", checks: null,
    startedAt: new Date(0).toISOString(), elapsedMs: 0, activeSince: null, lastRunId, origin,
  });
  return { goals, calls, events, terminal };
}

test("recovered goal round uses its original project and keeps chat authority", async () => {
  const f = fixture();
  await f.goals.resume(sessionId);
  assert.equal((await f.terminal).status, "done");
  assert.equal(f.calls.length, 1);
  const { options, project } = f.calls[0];
  assert.equal(project, "original");
  assert.equal(options.sessionId, sessionId);
  assert.equal(options.source, origin.source);
  assert.deepEqual(options.permissions, origin.permissions);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(f.events[0][2], { ...origin.chat, chatKind: "direct" });
  assert.equal(currentProject(), undefined, "the goal does not leak its project into later work");
});

for (const [name, input] of [
  ["missing previous task", { previous: null }],
  ["foreign owner", { previous: { id: "previous", owner: "other", sessionId, project: "original" } }],
  ["foreign conversation", { previous: { id: "previous", owner, sessionId: "other", project: "original" } }],
  ["missing recorded project", { previous: { id: "previous", owner, sessionId } }],
  ["deleted recorded project", { projects: ["replacement"] }],
  ["conversation moved to another project", { sessionProject: "replacement", projects: ["original", "replacement"] }],
  ["later round without previous identity", { lastRunId: null }],
]) {
  test(`recovered goal refuses ${name} before starting any task`, async () => {
    const f = fixture(input);
    await f.goals.resume(sessionId);
    const ended = await f.terminal;
    assert.equal(ended.status, "blocked");
    assert.match(ended.reason, /Reconcile its saved context/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.events.length, 0);
  });
}

test("busy retry rechecks the conversation project before another runtime call", async () => {
  const f = fixture({ beforeRun: async (attempt, state) => {
    assert.equal(attempt, 1);
    state.setProject("replacement");
    throw new Error("conversation already has an active run");
  } });
  f.goals.busyWaitMs = 0;
  await f.goals.resume(sessionId);
  assert.equal((await f.terminal).status, "blocked");
  assert.equal(f.calls.length, 1, "the retry cannot start in the replacement project");
  assert.equal(f.events.length, 0);
});

test("first round without a previous task keeps ordinary project selection", async () => {
  const f = fixture({ previous: null, round: 0, lastRunId: null, sessionProject: "chosen", projects: ["chosen"] });
  await f.goals.resume(sessionId);
  assert.equal((await f.terminal).status, "done");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].project, undefined);
  assert.equal(f.calls[0].options.sessionId, sessionId);
});
