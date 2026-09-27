import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Expansion, codeOverlap, requestKind } from "../dist/fly-core/encode.js";
import { Circuit, eligibilityOf, retention, scoreOf } from "../dist/fly-core/circuit.js";
import { activeCells, forgetHalfLifeDays, kenyonCells } from "../dist/fly-core/sizes.js";
import { packWeights, unpackWeights } from "../dist/fly-core/state.js";
import { outcomeOf, usesOf } from "../dist/fly-core/signals.js";
import { FlyCore, patternSuccesses, watchTask } from "../dist/fly-core/hook.js";
import { FlyState, maximumPatterns } from "../dist/fly-core/state.js";
import { suggestToolName } from "../dist/fly-core/settings.js";
import { inferToolGroup } from "../dist/catalog.js";

/**
 * The learning core (src/fly-core): a sparse code for the situation, three-factor learning at the
 * output synapses, slow forgetting, and a runtime hook that only ever advises. A fake provider
 * stands in for every model call; nothing here touches the machine outside a temporary folder.
 */
const day = 86_400_000, start = Date.UTC(2026, 0, 1);
const wiring = new Expansion("test-seed");
const situation = (prompt, project = "home") => wiring.code({ prompt, project });

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
/** A fresh app with the learning core switched to `mode` (it ships off). */
async function fixture(t, provider, mode = "on") {
  const root = await mkdtemp(join(tmpdir(), "branch-fly-core-"));
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const app = await open();
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about the learning core, not reading first
  if (mode !== "off") app.learningCore.configure({ mode });
  const state = { app };
  t.after(async () => { await state.app.close(); await discardTemp(root); });
  return { state, open };
}
const eventOf = (app, runId, kind) => app.store.events(runId).find((event) => event.kind === kind)?.data;

test("F1 a situation becomes a fixed, sparse code of about 5% of 2,000 cells", () => {
  const code = situation("fix the failing build in the payments repo");
  assert.equal(kenyonCells, 2000);
  assert.equal(code.length, activeCells, "exactly the active share stays on");
  assert.equal(activeCells, 100);
  assert.deepEqual(code, situation("fix the failing build in the payments repo"), "the same situation always gives the same code");
  assert.notDeepEqual(new Expansion("another-seed").code({ prompt: "fix the failing build in the payments repo", project: "home" }), code,
    "the wiring comes from the seed");
  const alike = codeOverlap(code, situation("fix the failing build in the payments repo again"));
  const unlike = codeOverlap(code, situation("write a birthday letter to grandma", "family"));
  assert.ok(alike > unlike + 0.2, `similar situations share more cells (${alike}) than different ones (${unlike})`);
  assert.equal(requestKind("plot the numbers in this spreadsheet"), "data");
  assert.equal(requestKind("hello there"), "general");
});

test("F2 reward and punishment tip the balance for that situation, and mostly only that one", () => {
  const circuit = new Circuit();
  const code = situation("fix the failing build in the payments repo");
  const other = situation("write a birthday letter to grandma", "family");
  circuit.learn(code, [{ action: "shell.run", kind: "tool", step: 1 }], 1, start);
  circuit.learn(code, [{ action: "web.search", kind: "tool", step: 1 }], -1, start);
  const [first, last] = [circuit.rank(code, "tool", start)[0], circuit.rank(code, "tool", start).at(-1)];
  assert.equal(first.action, "shell.run");
  assert.ok(first.score > 0.3, `reward depresses the avoid side (${first.score})`);
  assert.equal(last.action, "web.search");
  assert.ok(last.score < -0.3, `punishment depresses the approach side (${last.score})`);
  const elsewhere = scoreOf(circuit.actions.get("tool:shell.run"), other, start).score;
  assert.ok(Math.abs(elsewhere) < first.score / 3, `a different situation is barely moved (${elsewhere})`);
  const state = circuit.actions.get("tool:shell.run");
  for (const value of [...state.approach.values(), ...state.avoid.values()])
    assert.ok(value <= 0 && value >= -1, "weights stay between nothing and their starting strength");
});

test("F3 what was learned fades slowly, and a failing call is punished even in a finished task", () => {
  assert.equal(retention(forgetHalfLifeDays * day), 0.5);
  const circuit = new Circuit(), code = situation("tidy the photo folders");
  circuit.learn(code, [{ action: "files.move", kind: "tool", step: 2 }, { action: "files.list", kind: "tool", step: 1, failed: true }], 1, start);
  const fresh = scoreOf(circuit.actions.get("tool:files.move"), code, start).score;
  const later = scoreOf(circuit.actions.get("tool:files.move"), code, start + forgetHalfLifeDays * day).score;
  assert.ok(Math.abs(later - fresh / 2) < 1e-6, `half is left after one half-life (${fresh} → ${later})`);
  assert.ok(scoreOf(circuit.actions.get("tool:files.list"), code, start).score < 0, "the failed call is learned as a poor choice");
  assert.ok(eligibilityOf(1, 5) < eligibilityOf(5, 5), "earlier steps get less credit");
  assert.equal(eligibilityOf(0, 100), 0.3, "but never less than the floor");
});

test("F4 outcomes and actions are read from the task's own events", () => {
  const events = [
    { kind: "skills.pinned", data: { id: "skill-1" } },
    { kind: "tool.started", data: { name: "memory.search" } },
    { kind: "tool.completed", data: { name: "memory.search", result: [{ id: "m1" }, { id: "m2" }] } },
    { kind: "tool.started", data: { name: "shell.run" } },
    { kind: "tool.failed", data: { name: "shell.run", error: "exit 1" } },
    { kind: "run.check_passed", data: {} },
  ];
  const uses = usesOf(events);
  assert.deepEqual(uses.map((u) => `${u.kind}:${u.action}`).sort(), ["memory:m1", "memory:m2", "skill:skill-1", "tool:memory.search", "tool:shell.run"]);
  assert.equal(uses.find((u) => u.action === "shell.run").failed, true);
  assert.equal(outcomeOf("completed", events, 0).signal, 1, "finished plus a passed check, capped at 1");
  assert.equal(outcomeOf("failed", [], 0).signal, -1);
  assert.equal(outcomeOf("needs_input", [], 0).signal, 0, "waiting for the owner teaches nothing");
  const costly = outcomeOf("completed", [], 400_000);
  assert.ok(Math.abs(costly.signal - 0.7) < 1e-9 && costly.reasons.some((r) => /tokens/.test(r)), "an expensive task is rewarded less");
  const packed = new Map([[0, -0.5], [1999, -0.25]]);
  assert.deepEqual(unpackWeights(packWeights(packed)), packed);
});

test("F5 a real task is advised at the start and learned from at the end, and it survives a restart", async (t) => {
  const { state, open } = await fixture(t, writeThenRead());
  const first = await state.app.runtime.run({ prompt: "save a note about the garden" });
  assert.equal(first.status, "completed");
  const before = eventOf(state.app, first.id, "fly.suggested");
  assert.deepEqual(before.tools, [], "nothing is known yet");
  const learned = eventOf(state.app, first.id, "fly.learned");
  assert.ok(learned.signal > 0 && learned.actions === 2, `the finished task is a reward for both tools (${JSON.stringify(learned)})`);

  const core = new FlyCore(state.app.store);
  const code = core.code("local", { prompt: "save a note about the garden", project: "default", source: "owner" });
  const scoreBefore = core.suggest("local", code).tools.find((s) => s.name === "files.write")?.score;
  await state.app.close();
  state.app = await open();
  const reopened = new FlyCore(state.app.store);
  assert.deepEqual(reopened.code("local", { prompt: "save a note about the garden", project: "default", source: "owner" }), code,
    "the wiring is the same after a restart");
  assert.equal(reopened.suggest("local", code).tools.find((s) => s.name === "files.write")?.score, scoreBefore, "and so is what was learned");

  const second = await state.app.runtime.run({ prompt: "save a note about the garden" });
  const advice = eventOf(state.app, second.id, "fly.suggested");
  assert.deepEqual(advice.tools.map((s) => s.name).sort(), ["files.read", "files.write"], "a similar task gets them suggested");
  assert.equal(state.app.store.review.proposals("local", "pending").length, 0, "advice alone changes nothing the owner owns");
});

test("F6 steps that keep working are offered as a skill idea, once, and accepting it opens a draft without installing anything", async (t) => {
  const { state } = await fixture(t, writeThenRead());
  for (let at = 0; at < patternSuccesses + 1; at += 1) await state.app.runtime.run({ prompt: `save a note about the garden, part ${at}` });
  const ideas = state.app.store.review.proposals("local", "pending").filter((p) => p.source === "Noticed by Branch's learning core");
  assert.equal(ideas.length, 1, "offered once, not every time after");
  assert.equal(ideas[0].kind, "skill-note");
  assert.match(ideas[0].text, /files\.write, then files\.read/);
  assert.equal(ideas[0].learned.signal, "learning-core", "it says it came from the learning core");
  assert.deepEqual(ideas[0].learned.evidence, ["files.write", "files.read"], "and carries the steps, in order");
  const memories = state.app.store.list("memory", "local").length;
  const skills = state.app.store.skills.list("local").length;
  const decided = await state.app.store.review.decide("local", ideas[0].id, true);
  const draft = decided.applied.skillDraft;
  assert.match(draft.document, /^---\nname: [a-z-]+-steps\n/, "a skill file the editor can open");
  assert.match(draft.document, /1\. Use `files\.write`\.\n2\. Use `files\.read`\./);
  assert.equal(state.app.store.list("memory", "local").length, memories, "nothing is remembered by accepting it");
  assert.equal(state.app.store.skills.list("local").length, skills, "and nothing is installed");
  const other = state.app.store.review.propose("local", { kind: "skill-note", skillId: null, text: "a model's note" });
  assert.deepEqual((await state.app.store.review.decide("local", other.id, true)).applied, { noted: true }, "other skill notes still only note");
});

test("F7 a correction in the next message counts against what the previous task did", async (t) => {
  const { state } = await fixture(t, writeThenRead());
  const first = await state.app.runtime.run({ prompt: "save a note about the garden" });
  const core = new FlyCore(state.app.store);
  const code = core.code("local", { prompt: "save a note about the garden", project: "default", source: "owner" });
  const score = () => core.suggest("local", code).tools.find((s) => s.name === "files.write")?.score ?? 0;
  const before = score();
  const second = await state.app.runtime.run({ prompt: "No, that is the wrong file", sessionId: first.sessionId });
  assert.equal(eventOf(state.app, second.id, "fly.suggested").corrected, true);
  assert.ok(score() < before, `the correction lowered the earlier choice (${before} → ${score()})`);
});

test("F8 temporary conversations teach nothing, and a broken core never fails a task", async (t) => {
  const { state } = await fixture(t, writeThenRead());
  const temporary = await state.app.runtime.run({ prompt: "save a private note", temporary: true });
  assert.equal(eventOf(state.app, temporary.id, "fly.suggested"), undefined);
  assert.equal(eventOf(state.app, temporary.id, "fly.learned"), undefined);

  state.app.store.sqlite.exec("DROP TABLE IF EXISTS fly_synapses; CREATE TABLE fly_synapses(broken TEXT)");
  const run = await state.app.runtime.run({ prompt: "save a note about the garden" });
  assert.equal(run.status, "completed", "the task still finishes");
  assert.ok(eventOf(state.app, run.id, "fly.failed"), "and the failure is written down");
});

test("F9 memories whose use keeps going well or badly are named for keeping or fading", async (t) => {
  const { state } = await fixture(t, writeThenRead());
  const core = new FlyCore(state.app.store, () => start);
  const circuit = new Circuit(), code = situation("plan the weekend");
  for (let at = 0; at < 3; at += 1) {
    circuit.learn(code, [{ action: "helpful-fact", kind: "memory", step: 1 }], 1, start);
    circuit.learn(code, [{ action: "stale-fact", kind: "memory", step: 1 }], -1, start);
  }
  core.state.save("local", [...circuit.actions.values()]);
  assert.deepEqual(core.memoryAdvice("local"), { strengthen: ["helpful-fact"], fade: ["stale-fact"] });
});

test("F10 the switch ships off; off runs and stores nothing, when-needed only learns and waits to be asked", async (t) => {
  const { state } = await fixture(t, writeThenRead(), "off");
  const app = state.app;
  const tables = () => app.store.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'fly_%'").all().length;
  const hasTool = () => app.registry.descriptions(new Set(["memory.read"])).some((tool) => tool.name === suggestToolName);
  assert.deepEqual(app.learningCore.settings(), { mode: "off" }, "a fresh install has it off");
  const quiet = await app.runtime.run({ prompt: "save a note about the garden" });
  assert.equal(quiet.status, "completed");
  assert.ok(!app.store.events(quiet.id).some((event) => event.kind.startsWith("fly.")), "off: no hook ran");
  assert.equal(tables(), 0, "off: nothing is stored, not even an empty table");
  assert.equal(hasTool(), false, "off: the model is not offered the tool");
  assert.throws(() => app.learningCore.configure({ mode: "sometimes" }), "only the three positions are accepted");

  app.learningCore.configure({ mode: "when-needed" });
  assert.equal(hasTool(), true, "when needed: one short tool waits in the catalog");
  assert.equal(inferToolGroup(suggestToolName), "memory", "filed in the memory box by name, not in the unrecognised one");
  const learning = await app.runtime.run({ prompt: "save a note about the garden" });
  assert.equal(eventOf(app, learning.id, "fly.suggested"), undefined, "when needed: nothing is worked out at the start");
  assert.ok(eventOf(app, learning.id, "fly.learned").signal > 0, "but the outcome is still learned from");
  const asked = await app.registry.execute(suggestToolName, { request: "save a note about the garden" }, app.runtime.context());
  assert.deepEqual(asked.tools.map((s) => s.name).sort(), ["files.read", "files.write"], "asking the tool gives the ranking");

  app.learningCore.configure({ mode: "off" });
  assert.equal(hasTool(), false, "switching off takes the tool away at once");
});

test("F11 off costs the task nothing: no core is built and the check takes well under a millisecond", async (t) => {
  const { state } = await fixture(t, writeThenRead(), "off");
  const app = state.app, run = await app.runtime.run({ prompt: "save a note about the garden" });
  let built = 0;
  const makeCore = () => { built += 1; throw new Error("the core must not be built while the switch is off"); };
  const started = performance.now();
  for (let at = 0; at < 1000; at += 1) watchTask(app.store, run, "local", makeCore)(run);
  const each = (performance.now() - started) / 1000;
  assert.equal(built, 0);
  assert.ok(each < 1, `one off check took ${each} ms`);
  assert.ok(!app.store.events(run.id).some((event) => event.kind.startsWith("fly.")), "and wrote nothing");
});

test("F12 what the core keeps stays bounded: step patterns are capped like weights and traces", async (t) => {
  const { state } = await fixture(t, writeThenRead());
  const fly = new FlyState(state.app.store.sqlite);
  for (let at = 0; at < maximumPatterns + 50; at += 1) fly.countPattern("local", `p${at}`, true, start + at);
  const count = state.app.store.sqlite.prepare("SELECT count(*) AS n FROM fly_patterns WHERE owner='local'").get().n;
  assert.equal(count, maximumPatterns);
  assert.equal(fly.countPattern("local", `p${maximumPatterns + 49}`, true, start + maximumPatterns + 50).successes, 2, "the newest are kept");
});
