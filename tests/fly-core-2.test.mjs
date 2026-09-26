import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { exportBackup, importBackup } from "../dist/backup.js";
import { skillInstructions } from "../dist/skill-tools.js";
import { Expansion } from "../dist/fly-core/encode.js";
import { Circuit, prune } from "../dist/fly-core/circuit.js";
import { activeCells, kenyonCells, maximumWeightsPerSide } from "../dist/fly-core/sizes.js";
import { FlyState, maximumActions } from "../dist/fly-core/state.js";
import { dropIndex } from "../dist/fly-core/fast-index.js";
import { FlyCore, watchTask } from "../dist/fly-core/hook.js";
import { advisedFacts, advisedPreload, advisedSkills, postAdvice, preloadReason, takeDownAdvice } from "../dist/fly-core/apply.js";
import { suggestToolName } from "../dist/fly-core/settings.js";
import { switchedOffAnswer } from "../dist/fly-core/tool.js";
import { inspectRun } from "../dist/inspect.js";

/**
 * The learning core, version 2: its advice changes what a task starts with when the switch is on,
 * it answers fast and stays small at its cap, the owner can see and forget what it learned, and a
 * backup carries it whole. A scripted provider stands in for every model; nothing here leaves a
 * temporary folder.
 */
const day = 86_400_000, start = Date.UTC(2026, 0, 1);
const wiring = new Expansion("fly-core-2-seed");

function scripted(steps) {
  let at = 0;
  return { name: "scripted", async complete() {
    const step = steps[at % steps.length];
    at += 1;
    return typeof step === "function" ? step() : step;
  } };
}
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const writeThenRead = () => scripted([
  call("files.write", { path: "note.txt", content: "hi" }), call("files.read", { path: "note.txt" }), { content: "done", toolCalls: [] },
]);
async function fixture(t, mode = "on", provider = writeThenRead()) {
  const root = await mkdtemp(join(tmpdir(), "branch-fly-core-2-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about the learning core, not reading first
  if (mode !== "off") app.learningCore.configure({ mode });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const eventOf = (app, runId, kind) => app.store.events(runId).find((event) => event.kind === kind)?.data;
const eventsOf = (app, runId, kind) => app.store.events(runId).filter((event) => event.kind === kind).map((event) => event.data);

/** A seeded random generator, so the fixtures at the cap are the same on every machine. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let x = Math.imul(state ^ (state >>> 15), state | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
/** `count` actions, each with a full side of learned weights, as a long-used install would have. */
function actionsAtCap(count, now, perSide = maximumWeightsPerSide, seed = 7) {
  const next = seeded(seed), kinds = ["tool", "skill", "memory"], states = [];
  for (let at = 0; at < count; at += 1) {
    const side = () => {
      const map = new Map();
      while (map.size < perSide) map.set(Math.floor(next() * kenyonCells), -Math.fround(0.05 + next() * 0.9));
      return map;
    };
    states.push({ action: `action-${at}`, kind: kinds[at % 3], approach: side(), avoid: side(), uses: 1 + (at % 9), net: next() - 0.5, updatedAt: now - Math.floor(next() * 30 * day) });
  }
  return states;
}

test("F13 the fast index ranks exactly as the full read did, and follows every save and another connection's writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-fly-index-"));
  const file = join(root, "fly.db"), db = new DatabaseSync(file), other = new DatabaseSync(file);
  // Written ahead, as Branch's own database is (store.ts): the default journal is a new file made
  // and deleted on every save, and on Windows each one is scanned before it may be used.
  db.exec("PRAGMA journal_mode=WAL");
  t.after(async () => { db.close(); other.close(); await discardTemp(root); });
  const state = new FlyState(db);
  const circuit = new Circuit(), codes = ["fix the build", "write to grandma", "plot the sales numbers", "rename the photos"].map((prompt) => wiring.code({ prompt }));
  const next = seeded(3);
  for (let round = 0; round < 60; round += 1) {
    const code = codes[round % codes.length];
    const uses = [{ action: `tool-${Math.floor(next() * 8)}`, kind: "tool", step: 1 }, { action: `skill-${Math.floor(next() * 3)}`, kind: "skill", step: 2 }];
    state.save("local", circuit.learn(code, uses, next() > 0.4 ? 1 : -1, start + round * day));
  }
  const now = start + 70 * day, fresh = state.load("local");
  for (const code of codes) {
    const fast = state.rank("local", code, now);
    for (const kind of ["tool", "skill"]) {
      const full = fresh.rank(code, kind, now).filter((s) => s.evidence > 0);
      assert.deepEqual(fast[kind].map((s) => s.action), full.map((s) => s.action), `${kind} order matches`);
      fast[kind].forEach((s, at) => assert.ok(Math.abs(s.score - full[at].score) < 1e-6, `${kind} ${s.action} score matches`));
    }
  }
  // A save is seen at once, without reading the table again.
  const extra = new Circuit();
  state.save("local", extra.learn(codes[0], [{ action: "tool-new", kind: "tool", step: 1 }], 1, now));
  assert.equal(state.rank("local", codes[0], now).tool[0].action, "tool-new");
  // Another connection's write is noticed through SQLite's change counter.
  other.exec("DELETE FROM fly_synapses WHERE action='tool-new'");
  assert.notEqual(state.rank("local", codes[0], now).tool[0]?.action, "tool-new");
});

test("F14 each side keeps at most its cap of learned synapses, faintest dropped first, and storage at the cap is measured", async (t) => {
  const side = new Map([[1, -0.9], [2, -0.01], [3, -0.5], [4, -0.02]]);
  prune(side, 2);
  assert.deepEqual([...side.keys()].sort(), [1, 3], "the strongest learned changes stay");
  assert.ok(maximumWeightsPerSide >= activeCells, "one whole situation always fits");

  const circuit = new Circuit();
  for (let at = 0; at < 40; at += 1)
    circuit.learn(wiring.code({ prompt: `situation number ${at} about topic ${at * 7}` }), [{ action: "busy-tool", kind: "tool", step: 1 }], at % 2 ? 1 : -1, start);
  const busy = circuit.actions.get("tool:busy-tool");
  assert.ok(busy.approach.size <= maximumWeightsPerSide && busy.avoid.size <= maximumWeightsPerSide, `${busy.approach.size}/${busy.avoid.size} kept`);

  const root = await mkdtemp(join(tmpdir(), "branch-fly-size-"));
  t.after(() => discardTemp(root));
  const file = join(root, "fly.db"), db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  new FlyState(db).save("local", actionsAtCap(maximumActions, start));
  db.exec("VACUUM");
  db.close();
  const bytes = (await stat(file)).size;
  t.diagnostic(`fly_* tables at the cap (${maximumActions} actions × 2 × ${maximumWeightsPerSide}): ${(bytes / 1048576).toFixed(2)} MB`);
  assert.ok(bytes < 12 * 1048576, `well under 20 MB (${bytes} bytes)`);
});

/**
 * Time spent by this thread, in milliseconds. The builders share their machines, so the clock on the
 * wall mostly measures who else is running; the thread's own CPU time measures the work.
 */
function spent(work) {
  const cpu = process.threadCpuUsage(), wall = performance.now();
  const value = work();
  const used = process.threadCpuUsage(cpu);
  return { value, cpu: (used.user + used.system) / 1000, wall: performance.now() - wall };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
/* CPU time is the mean, not the median: the thread clock moves in whole ticks (about 15.6 ms on Windows), so each short
   start reads 0 or one tick, and on a busy machine more than half of them can straddle a tick while each still costs
   well under a millisecond. The mean of those readings is the true cost on average, whatever the tick. */
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("F15 at the cap a task start stays under 10 ms once the index is ready", async (t) => {
  const { app } = await fixture(t, "on");
  const now = start + 31 * day, core = new FlyCore(app.store, () => now);
  core.state.save("local", actionsAtCap(maximumActions, now));
  const first = spent(() => core.suggest("local", core.code("local", { prompt: "fix the failing build in the payments repo" })));
  const starts = [];
  for (let at = 0; at < 21; at += 1)
    starts.push(spent(() => {
      const fresh = new FlyCore(app.store, () => now);
      return fresh.suggest("local", fresh.code("local", { prompt: `fix the failing build number ${at}` }));
    }));
  const cpu = mean(starts.map((s) => s.cpu)), wall = median(starts.map((s) => s.wall));
  t.diagnostic(`at ${maximumActions} actions: first suggest, which builds the index, ${first.cpu.toFixed(1)} ms CPU (${first.wall.toFixed(1)} ms wall); `
    + `later task starts mean ${cpu.toFixed(2)} ms CPU (median ${wall.toFixed(2)} ms wall, slowest ${Math.max(...starts.map((s) => s.wall)).toFixed(1)} ms wall)`);
  assert.ok(cpu < 10, `task start took ${cpu} ms of CPU`);

  const run = await app.runtime.run({ prompt: "save a note about the garden" });
  const hooks = [];
  for (let at = 0; at < 11; at += 1) {
    const hooked = spent(() => watchTask(app.store, run, "local"));
    hooked.value(run);
    hooks.push(hooked);
  }
  const hookCpu = mean(hooks.map((h) => h.cpu));
  t.diagnostic(`the whole start hook (switch, code, ranking, its event) at the cap: mean ${hookCpu.toFixed(2)} ms CPU (median ${median(hooks.map((h) => h.wall)).toFixed(2)} ms wall)`);
  assert.ok(hookCpu < 10, `the start hook took ${hookCpu} ms of CPU`);
});

test("F16 with the switch on the top tools are pre-loaded and each applied piece is one line in Look inside", async (t) => {
  const { app } = await fixture(t, "on");
  for (let at = 0; at < 3; at += 1) await app.runtime.run({ prompt: `save a note about the garden ${at}` });
  const run = await app.runtime.run({ prompt: "save a note about the garden again" });
  const preloaded = eventOf(app, run.id, "catalog.preselected").preloadedFromHistory;
  const fromCore = preloaded.filter((entry) => entry.reason === preloadReason).map((entry) => entry.name).sort();
  assert.deepEqual(fromCore, ["files.read", "files.write"], "the tools that worked are loaded first");
  const applied = eventsOf(app, run.id, "fly.applied");
  assert.deepEqual(applied.find((a) => a.what === "tools").names.sort(), ["files.read", "files.write"]);
  const view = inspectRun(app.store, run.id, { receipts: { items: [], counts: {} }, timeline: [], cost: null, version: "test" });
  assert.equal(view.learned.find((line) => line.what === "tools").names.length, 2, "Look inside carries the line");
  assert.equal(takeDownAdvice(run.id), undefined);
  assert.deepEqual(advisedPreload(run.id, [{ name: "x", reason: "y" }], [{ name: "x" }]), [{ name: "x", reason: "y" }], "advice is taken down when the task settles");
});

test("F17 when-needed and off leave the pre-load exactly as it was", async (t) => {
  const preloads = [];
  for (const mode of ["off", "when-needed"]) {
    const { app } = await fixture(t, mode);
    for (let at = 0; at < 3; at += 1) await app.runtime.run({ prompt: `save a note about the garden ${at}` });
    const run = await app.runtime.run({ prompt: "save a note about the garden again" });
    preloads.push(JSON.stringify(eventOf(app, run.id, "catalog.preselected").preloadedFromHistory));
    assert.deepEqual(eventsOf(app, run.id, "fly.applied"), [], `${mode}: nothing is applied`);
  }
  assert.equal(preloads[0], preloads[1]);
});

test("F18 a tool to avoid is only left out of the pre-load; skills and memories are put first, nothing is removed", () => {
  const notes = [];
  const advice = (runId, sessionId, suggestions) => postAdvice({ runId, sessionId, note: (what, names) => notes.push({ what, names }), suggestions: {
    tools: [], skills: [], memories: [], avoid: [], ...suggestions,
  } });
  advice("r1", "s1", { tools: [{ name: "web.fetch", score: 0.4 }, { name: "not.installed", score: 0.3 }], avoid: [{ name: "tool:shell.run", score: -0.4 }] });
  const preload = advisedPreload("r1", [{ name: "shell.run", reason: "history" }, { name: "files.read", reason: "history" }], [{ name: "web.fetch" }, { name: "shell.run" }, { name: "files.read" }]);
  assert.deepEqual(preload.map((p) => p.name), ["web.fetch", "files.read"], "the avoided tool is only not pre-loaded; a missing tool is never added");
  assert.deepEqual(notes.map((n) => n.what), ["tools", "left-out"]);
  notes.length = 0;
  const offPreload = advisedPreload("r1", [], [{ name: "web.fetch" }, { name: "shell.run" }], ["web.fetch"]);
  assert.deepEqual(offPreload, [], "a tool the owner switched off is never pre-loaded on the core's advice");
  assert.deepEqual(notes, [], "and no line claims it was chosen");

  advice("r2", "s2", { skills: [{ name: "b", score: 0.5 }], memories: [{ name: "m3", score: 0.5 }] });
  const skills = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  assert.deepEqual(advisedSkills("r2", skills).map((s) => s.id), ["b", "a", "c"]);
  assert.deepEqual(advisedFacts("s2", [{ id: "m1" }, { id: "m2" }, { id: "m3" }]).map((m) => m.id), ["m3", "m1", "m2"]);
  assert.deepEqual(advisedSkills("nobody", skills), skills, "a task with no advice is unchanged");
  for (const id of ["r1", "r2"]) takeDownAdvice(id);
});

test("F19 the skill list and the memory snapshot really take the advice", async (t) => {
  const { app } = await fixture(t, "on");
  const first = app.store.skills.install("local", { document: "---\nname: first-skill\ndescription: Comes first.\n---\n\nOne.\n" });
  const second = app.store.skills.install("local", { document: "---\nname: second-skill\ndescription: Comes second.\n---\n\nTwo.\n" });
  assert.ok(first && second);
  const run = await app.runtime.run({ prompt: "hello" });
  const catalogue = app.store.skills.catalog("local");
  const last = catalogue.at(-1);
  postAdvice({ runId: run.id, sessionId: run.sessionId, note: (what, names) => app.store.event(run.id, "fly.applied", { what, names }),
    suggestions: { tools: [], skills: [{ name: last.id, score: 0.5 }], memories: [], avoid: [] } });
  const context = app.runtime.context({ runId: run.id, permissions: new Set(["skills.read"]) });
  const text = skillInstructions(app.store, context);
  assert.equal(catalogue.length, 2);
  assert.ok(text.indexOf(last.name) < text.indexOf(catalogue[0].name), "the advised skill is listed first");
  assert.deepEqual(eventsOf(app, run.id, "fly.applied").map((a) => a.what), ["skills"]);
  takeDownAdvice(run.id);

  const facts = ["The garden is watered on Sundays.", "The cat is called Pepper.", "Lunch is at noon."]
    .map((text, at) => app.store.save("memory", "local", `fact-${at}`, { text, source: "test" }));
  const session = "fly-core-2-session";
  postAdvice({ runId: "snapshot-run", sessionId: session, note: () => undefined,
    suggestions: { tools: [], skills: [], memories: [{ name: facts.at(-1).id, score: 0.5 }], avoid: [] } });
  const snapshot = app.store.review.sessionSnapshot("local", session);
  assert.match(snapshot.text.split("\n")[0], /Lunch is at noon/, "the advised fact comes first in the snapshot");
  takeDownAdvice("snapshot-run");
});

test("F20 learning.suggest reads the switch of the person whose task is asking", async (t) => {
  const { app } = await fixture(t, "when-needed");
  await app.runtime.run({ prompt: "save a note about the garden" });
  const mine = await app.registry.execute(suggestToolName, { request: "save a note about the garden" }, app.runtime.context());
  assert.ok(Array.isArray(mine.tools));
  const before = app.store.sqlite.prepare("SELECT count(*) AS n FROM fly_wiring").get().n;
  const theirs = await app.registry.execute(suggestToolName, { request: "anything" }, { ...app.runtime.context(), owner: "someone-else" });
  assert.deepEqual(theirs, { off: true, note: switchedOffAnswer });
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM fly_wiring").get().n, before, "nothing is made for them");
});

test("F21 a backup carries what was learned, and a restore leaves no orphan traces or foreign weights", async (t) => {
  const { app: source } = await fixture(t, "on");
  await source.runtime.run({ prompt: "save a note about the garden" });
  await source.runtime.run({ prompt: "save a note about the garden again" });
  const archive = exportBackup(source.store.sqlite, "test");
  assert.ok(archive.tables.fly_wiring.length === 1 && archive.tables.fly_synapses.length >= 2 && archive.tables.fly_traces.length >= 1);
  const code = new FlyCore(source.store).code("local", { prompt: "save a note about the garden", project: "default", source: "owner" });
  const expected = new FlyCore(source.store).suggest("local", code).tools.map((s) => s.name);

  const { app: target } = await fixture(t, "on");
  await target.runtime.run({ prompt: "something unrelated to write" });
  const targetState = new FlyState(target.store.sqlite);
  targetState.save("local", actionsAtCap(3, Date.now()));
  targetState.saveTrace("local", { runId: "gone-run", sessionId: "gone", code: [1, 2], uses: [], at: Date.now() });
  new FlyCore(target.store).suggest("local", [1, 2, 3]); // the index is warm before the restore
  const withOrphan = structuredClone(archive);
  const real = withOrphan.tables.fly_traces[0];
  withOrphan.tables.fly_traces.push({ ...real, run_id: "not-in-this-archive" });
  // Integration review: a trace may not borrow a task that belongs to someone else or another conversation.
  const otherTask = withOrphan.tables.tasks.find((task) => task.id !== real.run_id);
  withOrphan.tables.fly_wiring.push({ owner: "someone-else", seed: "foreign-seed", created_at: new Date().toISOString() });
  withOrphan.tables.fly_traces.push({ ...real, run_id: otherTask.id, owner: "someone-else", session_id: otherTask.session_id });
  real.session_id = "not-its-conversation"; // the owner's own task, but claimed for another conversation
  importBackup(target.store.sqlite, withOrphan, { replaceExisting: true });
  const orphans = target.store.sqlite.prepare("SELECT count(*) AS n FROM fly_traces WHERE run_id NOT IN (SELECT id FROM tasks)").get().n;
  assert.equal(orphans, 0, "no trace points at a task that is not there");
  const borrowed = target.store.sqlite.prepare(`SELECT count(*) AS n FROM fly_traces WHERE NOT EXISTS (SELECT 1 FROM tasks
    WHERE tasks.id = fly_traces.run_id AND tasks.owner = fly_traces.owner AND tasks.session_id = fly_traces.session_id)`).get().n;
  assert.equal(borrowed, 0, "no trace points at another person's task or another conversation");
  assert.equal(target.store.sqlite.prepare("SELECT count(*) AS n FROM fly_traces WHERE owner='someone-else'").get().n, 0);
  assert.equal(target.store.sqlite.prepare("SELECT seed FROM fly_wiring WHERE owner='local'").get().seed, archive.tables.fly_wiring[0].seed);
  assert.equal(target.store.sqlite.prepare("SELECT count(*) AS n FROM fly_synapses WHERE action LIKE 'action-%'").get().n, 0, "weights learned under another wiring are gone");
  const restored = new FlyCore(target.store).suggest("local", code).tools.map((s) => s.name);
  assert.deepEqual(restored, expected, "the restored core advises as the original did, not from a stale index");
});

test("F22 a restore into an install that never switched the core on makes the tables it needs", async (t) => {
  const { app: source } = await fixture(t, "on");
  await source.runtime.run({ prompt: "save a note about the garden" });
  const archive = exportBackup(source.store.sqlite, "test");
  const { app: fresh } = await fixture(t, "off");
  assert.equal(fresh.store.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'fly_%'").get().n, 0);
  importBackup(fresh.store.sqlite, archive);
  assert.equal(fresh.store.sqlite.prepare("SELECT count(*) AS n FROM fly_synapses").get().n, archive.tables.fly_synapses.length);

  const { app: never } = await fixture(t, "off");
  await never.runtime.run({ prompt: "save a note about the garden" });
  const plain = exportBackup(never.store.sqlite, "test");
  assert.equal("fly_synapses" in plain.tables, false, "an install that never used the core has nothing to carry");
  const { app: other } = await fixture(t, "off");
  assert.ok(importBackup(other.store.sqlite, plain).rows > 0, "and its backup still restores");
  assert.equal(other.store.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'fly_%'").get().n, 0, "without making the core's tables");
});

test("F23 the owner's routes: the switch, what it learned in plain terms, and forgetting only on confirmation", async (t) => {
  const { app, root } = await fixture(t, "off");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const off = await api("GET", "/api/learning-core");
  assert.deepEqual(off.body, { settings: { mode: "off" }, kept: { actions: 0, traces: 0, patterns: 0 }, habits: [] });
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'fly_%'").get().n, 0, "reading makes nothing");
  assert.equal((await api("POST", "/api/learning-core/settings", { mode: "sometimes" })).status, 400);
  assert.equal((await api("POST", "/api/learning-core/settings", { mode: "on" })).body.settings.mode, "on");
  for (let at = 0; at < 3; at += 1) await app.runtime.run({ prompt: `save a note about the garden ${at}` });
  const learned = (await api("GET", "/api/learning-core")).body;
  const habit = learned.habits.find((h) => h.name === "files.write");
  assert.deepEqual({ kind: habit.kind, uses: habit.uses, leaning: habit.leaning }, { kind: "tool", uses: 3, leaning: "well" });
  assert.equal((await api("POST", "/api/learning-core/forget", {})).status, 400, "forgetting needs the word");
  const forgotten = (await api("POST", "/api/learning-core/forget", { confirm: "forget" })).body;
  assert.ok(forgotten.removed > 0);
  assert.deepEqual(forgotten.habits, []);
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM fly_synapses WHERE owner='local'").get().n, 0);
  const code = new FlyCore(app.store).code("local", { prompt: "save a note about the garden" });
  assert.deepEqual(new FlyCore(app.store).suggest("local", code).tools, [], "nothing is left in memory either");
});

test("F24 the core never pre-loads a tool the owner switched off, even one it learned to like", async (t) => {
  const { app } = await fixture(t, "on");
  const screenTool = "desktop.windows";
  if (!app.registry.names().includes(screenTool)) return t.skip("no screen tools in this launch");
  for (let at = 0; at < 3; at += 1) await app.runtime.run({ prompt: `save a note about the garden ${at}` });
  // What it learned about writing a file is moved onto a screen tool, as if learned while that switch was on.
  app.store.sqlite.prepare("UPDATE fly_synapses SET action=? WHERE owner='local' AND kind='tool' AND action='files.write'").run(screenTool);
  dropIndex(app.store.sqlite, "local");
  const run = await app.runtime.run({ prompt: "save a note about the garden again" });
  assert.ok(eventOf(app, run.id, "fly.suggested").tools.some((s) => s.name === screenTool), "the core did advise it");
  const preloaded = eventOf(app, run.id, "catalog.preselected").preloadedFromHistory.map((entry) => entry.name);
  assert.equal(preloaded.includes(screenTool), false, "the screen switch is off, so it is not loaded");
  const chosen = eventsOf(app, run.id, "fly.applied").filter((a) => a.what === "tools").flatMap((a) => a.names);
  assert.equal(chosen.includes(screenTool), false, "and Look inside does not claim it was chosen");
});

test("F25 a short-lived key may read the learning core but not switch it or make it forget", async (t) => {
  const { app, root } = await fixture(t, "on");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  await app.runtime.run({ prompt: "save a note about the garden" });
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 }).token;
  const api = async (method, path, body, token = key) => (await fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${token}`, host: new URL(server.url).host, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })).status;
  const kept = () => app.store.sqlite.prepare("SELECT count(*) AS n FROM fly_synapses WHERE owner='local'").get().n;
  const before = kept();
  assert.ok(before > 0);
  assert.equal(await api("GET", "/api/learning-core"), 200, "looking is allowed");
  assert.equal(await api("POST", "/api/learning-core/settings", { mode: "off" }), 401);
  assert.equal(await api("POST", "/api/learning-core/forget", { confirm: "forget" }), 401);
  assert.equal(app.learningCore.settings().mode, "on", "the switch did not move");
  assert.equal(kept(), before, "nothing was forgotten");
  assert.equal(await api("POST", "/api/learning-core/settings", { mode: "when-needed" }, server.token), 200, "the computer's own key still can");
});
