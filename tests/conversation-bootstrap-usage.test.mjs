import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";
import { conversationBootstrap, conversationBootstrapIds } from "../dist/conversation-bootstrap.js";
import { peopleUsing } from "../dist/usage-report.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { startServer } from "../dist/server.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageStore } from "../dist/usage.js";

const total = (app, scope) => app.store.usageStore().aggregateUsage("all", "day", {}, scope ? (id) => app.store.ownsSession(scope, id) : undefined).reduce((sum, day) => sum + day.runs, 0);
const personCounts = (app) => peopleUsing(app.store.sqlite, "2000-01-01", "2200-01-01", new Map([[app.runtime.owner, "Owner"]]));
const tallies = (app) => app.store.achievementTallies(app.runtime.owner, { through: 0, tools: {}, events: {} }).tallies;
const opening = (app, marker = conversationBootstrap) => {
  const run = app.store.createRun(app.runtime.owner, "Trunk: Branch Agent");
  app.store.markAside(run.id);
  if (marker) app.store.event(run.id, "run.bootstrap", marker);
  return app.store.finish(run.id, "completed", "Opened");
};

test("an engine opening counts zero; real runtime work with the same prompt and Opened answer counts one", async t => {
  const { app } = await fixture(t, [() => "Opened"]);
  on(app);
  const trunk = app.trunks.ensureDefault(true);
  const bootstrap = app.store.runs(app.runtime.owner).find((run) => run.sessionId === trunk.chatSessionId);
  assert.equal(total(app), 0);
  assert.deepEqual([tallies(app).tasks, tallies(app).conversations], [0, 0], "no achievement is earned for an empty bootstrap");
  assert.deepEqual(app.store.events(bootstrap.id).find((event) => event.kind === "run.bootstrap").data, conversationBootstrap);
  assert.equal(bootstrap.project, "default", "the synthetic row still anchors the default project");
  assert.equal(app.store.usageStore().getMonthlyStats().unpricedRuns, 0);
  assert.deepEqual(personCounts(app), []);
  const real = await app.runtime.run({ prompt: bootstrap.prompt, sessionId: trunk.chatSessionId });
  assert.equal(real.output, "Opened");
  app.store.markAside(real.id);
  app.store.event(real.id, "run.bootstrap", conversationBootstrap); // A copied marker never erases real work.
  assert.equal(total(app), 1);
  assert.deepEqual([tallies(app).tasks, tallies(app).conversations], [1, 1], "the first real task earns its own task and conversation");
  assert.equal(app.store.usageStore().getMonthlyStats().unpricedRuns, 1);
  assert.deepEqual(personCounts(app).map((row) => [row.name, row.tasks]), [["Owner", 1]]);
});

test("malformed or duplicated markers, reported usage, tool work and spend remain counted", async t => {
  const { app } = await fixture(t);
  for (const marker of [{ version: "1", kind: "conversation-opened" }, { version: 2, kind: "conversation-opened" }, { version: 1, kind: "other" }]) opening(app, marker);
  const duplicate = opening(app); app.store.event(duplicate.id, "run.bootstrap", conversationBootstrap);
  const tokens = opening(app); app.store.sqlite.prepare("UPDATE usage SET reported_input=1 WHERE run_id=?").run(tokens.id);
  const attempted = opening(app); app.store.sqlite.prepare("UPDATE usage SET attempts=1 WHERE run_id=?").run(attempted.id);
  const work = opening(app); app.store.event(work.id, "tool.started", { name: "files.read" });
  const spend = opening(app); app.store.event(spend.id, "spend.recorded", { dollars: 1 });
  assert.equal(total(app), 8, "every ambiguous or performed task remains in the report");
  assert.equal(app.store.usageStore().getMonthlyStats().unpricedRuns, 8);
  assert.equal(app.store.usageStore().getMonthlyStats().estimatedCost, 1, "actual spend survives the filter");
  assert.equal(personCounts(app)[0].tasks, 8);
  assert.equal(tallies(app).tasks, 8, "ambiguous and actual work also remain in achievement counts");
});

test("window state omits the ghost completed card while retaining ambiguous rows and real work", async t => {
  const { app, root } = await fixture(t, [() => "Opened"]);
  on(app);
  const trunk = app.trunks.ensureDefault(true);
  const bootstrap = app.store.runs(app.runtime.owner).find((run) => run.sessionId === trunk.chatSessionId);
  const ambiguous = opening(app, { version: 2, kind: "conversation-opened" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const state = () => fetch(new URL("/api/state", server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((response) => response.json());
  assert.deepEqual((await state()).runs.map((run) => run.id), [ambiguous.id], "the unknown marker remains visible, the validated opening does not");
  const real = await app.runtime.run({ prompt: bootstrap.prompt, sessionId: trunk.chatSessionId });
  assert.deepEqual((await state()).runs.map((run) => run.id).sort(), [ambiguous.id, real.id].sort());
  assert.ok(app.store.run(bootstrap.id), "the anchor remains stored for export, audit and project selection");
});

test("NULL output in otherwise matching marked or legacy rows is ambiguous and stays counted and visible", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, owner TEXT);
      CREATE TABLE tasks(id TEXT PRIMARY KEY, session_id TEXT, owner TEXT, status TEXT, output TEXT, created_at TEXT, source TEXT);
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT, data TEXT, created_at TEXT);
      CREATE TABLE usage(run_id TEXT PRIMARY KEY, estimated_input INTEGER DEFAULT 0, estimated_output INTEGER DEFAULT 0,
        reported_input INTEGER DEFAULT 0, reported_output INTEGER DEFAULT 0, reports INTEGER DEFAULT 0);
      CREATE TABLE governance(id TEXT, owner TEXT, data TEXT);`);
    const now = new Date().toISOString();
    for (const id of ["marked", "legacy"]) {
      db.prepare("INSERT INTO sessions VALUES(?,?)").run(id, "local");
      db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)").run(id, id, "local", "completed", null, now, "web");
      db.prepare("INSERT INTO usage(run_id) VALUES(?)").run(id);
      db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(id, "run.aside", "{}", now);
    }
    db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run("marked", "run.bootstrap", JSON.stringify(conversationBootstrap), now);
    db.prepare("INSERT INTO governance VALUES(?,?,?)").run("trunk:legacy", "local", JSON.stringify({ id: "legacy", chatSessionId: "legacy" }));
    const usage = new UsageStore(db);
    assert.equal(usage.aggregateUsage("all").reduce((sum, day) => sum + day.runs, 0), 2);
    assert.equal(usage.getMonthlyStats().unpricedRuns, 2);
    assert.equal(peopleUsing(db, "2000-01-01", "2200-01-01", new Map())[0].tasks, 2);
    assert.deepEqual([...conversationBootstrapIds(db, "local")], [], "neither ambiguous row is hidden in the window");
  } finally { db.close(); }
});

test("legacy openings require the current canonical association in the exact task owner's scope", async t => {
  const { app } = await fixture(t);
  on(app);
  const trunk = app.trunks.ensureDefault(true);
  app.store.sqlite.prepare("DELETE FROM events WHERE kind='run.bootstrap'").run();
  assert.equal(total(app), 0, "the old canonical opening is recognized without a prompt comparison");
  opening(app, null);
  assert.equal(total(app), 1, "an unbound old-looking row is ambiguous and remains counted");
  app.store.sqlite.prepare("UPDATE sessions SET owner='another-owner' WHERE id=?").run(trunk.chatSessionId);
  assert.equal(total(app), 2, "a mismatched session owner makes the legacy row ambiguous");
  app.store.sqlite.prepare("UPDATE sessions SET owner=? WHERE id=?").run(app.runtime.owner, trunk.chatSessionId);
  assert.equal(total(app), 1);
  app.store.sqlite.prepare("UPDATE governance SET owner='another-owner' WHERE owner=? AND id=?").run(app.runtime.owner, `trunk:${trunk.id}`);
  assert.equal(total(app), 2, "another owner's association cannot hide this owner's task");
});

test("household defaults perform no task; real work is counted only in its person's scope", async t => {
  const { app } = await fixture(t, [() => "Opened"]);
  on(app);
  app.trunks.ensureDefault(true);
  const person = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(person.id, { role: "adult" });
  const scope = `profile:${person.id}`;
  app.store.profiles.switch({ profileId: person.id, pin: "2468" });
  const ownDefault = app.trunks.personDefault();
  assert.equal(total(app, scope), 0);
  assert.ok(app.store.ownsSession(scope, ownDefault.trunk.chatSessionId));
  await runForCurrentPerson(app, { prompt: "Trunk: Branch Agent" });
  assert.equal(total(app, scope), 1);
  assert.equal(total(app, app.runtime.owner), 0, "the household task is never counted as the owner's");
  assert.equal(personCounts(app)[0].tasks, 1);
  app.store.profiles.switch({ profileId: null });
});
