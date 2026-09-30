/**
 * The round limit: how many times one task may go back to the model before it stops and gives the best
 * answer it has. It is the owner's own knob (limits.maxModelRounds), and Branch's own settings tools
 * find it by plain words and change that same knob with the owner's yes. Work on the project's files
 * gets 40 rounds while the owner has set no figure; the owner's figure, once set, wins for every task.
 * A task that runs out of rounds ends with its best answer; one that runs out of steps is not asked again,
 * since that question would be one step too many. Either way it says which limit it met, where to raise
 * it, and that Branch can raise the round limit once the owner says yes.
 *
 * Everything runs on its own data folder with a scripted model; the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readKnobs, saveKnobs, savePolicy } from "../dist/index.js";
import { saveLook } from "../dist/terminal-theme.js";
import { saveLoopGuardSettings } from "../dist/loop-guard.js";

const lastWordAsked = (request) => {
  const last = request.messages.at(-1);
  return last?.role === "user" && /^What you were asked to do:/.test(last.content);
};
const read = (turn) => ({ id: `r${turn}`, name: "files.read", arguments: JSON.stringify({ path: "src/sum.js" }) });

/**
 * A model that, told to change a setting, asks for exactly that change once and then says it is done;
 * otherwise reads the same file every round (as many as it is given), and gives its best answer when
 * the task has run out.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-rounds-setting-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "sum.js"), "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  const script = { change: null, asked: 0, perRound: 1, turn: 0, calls: 0, lastWords: 0 };
  const provider = { name: "scripted", async complete(request) {
    script.calls += 1;
    if (lastWordAsked(request)) { script.lastWords += 1; return { content: "Here is what I found so far.", toolCalls: [] }; }
    if (script.change) return script.asked++ === 0
      ? { content: "", toolCalls: [{ id: "change-call", name: "settings.change", arguments: JSON.stringify({ changes: [script.change] }) }] }
      : { content: "Changed it.", toolCalls: [] };
    script.turn += 1;
    return { content: "", toolCalls: Array.from({ length: script.perRound }, (_, at) => read(`${script.turn}-${at}`)) };
  } };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  // The model reads the same file every round on purpose, to reach the round limit; the loop guard (on as Branch ships)
  // would stop that first, and has tests of its own (tests/loop-guard.test.mjs).
  saveLoopGuardSettings(app.store, owner, { mode: "off" });
  /** A context for a task the owner started, for calling the settings tools directly. */
  const ownerContext = () => {
    const run = app.store.createRun(owner, "look at a setting");
    app.store.event(run.id, "run.started", { source: "owner" });
    return app.runtime.context({ runId: run.id, source: "owner" });
  };
  const tool = (name, args) => app.registry.execute(name, args, ownerContext());
  /** Runs one task that keeps going round, and says how it ended. */
  const loop = async (prompt) => {
    script.change = null;
    const run = await app.runtime.run({ prompt });
    const events = app.store.events(run.id);
    const note = events.find((event) => event.kind === "rounds.exhausted")?.data;
    const coding = events.find((event) => event.kind === "catalog.preselected")?.data.coding;
    return { run, note, coding };
  };
  return { app, owner, script, tool, loop };
}

const setting = "round-limit.maxModelRounds";
const plainTask = "keep going over the numbers";
const codingTask = "fix the bug in src/sum.js";

test("settings.find and settings.list find the round limit by plain words, with its value, what it starts as and its range", async (t) => {
  const { tool } = await fixture(t);
  for (const request of ["rounds", "round limit", "steps per task"]) {
    const found = await tool("settings.find", { request });
    assert.deepEqual(found.choices.map((one) => one.setting), [setting], `"${request}" finds the round limit and nothing else`);
    const [only] = found.choices;
    assert.equal(only.value, "auto", "no figure of the owner's own yet");
    assert.deepEqual(only.range, { min: 2, max: 500, or: "auto", unlimited: "no limit" });
    assert.match(only.note, /12 rounds/);
    assert.match(only.note, /40 when the task works on the project's files/);
    assert.match(found.question, /It is auto now/);
    assert.match(found.question, /from 2 to 500, or auto, or no limit/);
  }
  // Steps are counted two ways (model rounds, and rounds and tool calls together), so "step limit" offers both.
  const steps = await tool("settings.find", { request: "step limit" });
  assert.deepEqual(steps.choices.map((one) => one.setting).sort(), [setting, "step-limit.maxSteps"]);
  const listed = await tool("settings.list", { search: "rounds" });
  assert.deepEqual(listed.shown.map((row) => row.setting), [setting]);
  const [row] = listed.shown;
  assert.equal(row.name, "Round limit");
  assert.equal(row.where, "settings:advanced");
  assert.equal(row.value, "auto");
  assert.equal(row.startsAs, "auto");
  assert.deepEqual(row.choices, { min: 2, max: 500, or: "auto", unlimited: "no limit" });
  assert.equal(row.lessCareful, null, "more rounds spend only on the connected model, so it is an ordinary change");
  const advanced = await tool("settings.list", { search: "settings:advanced" });
  assert.ok(advanced.shown.some((one) => one.setting === setting), "it is listed with the other Advanced settings");
  const ready = await tool("settings.find", { request: "round limit", value: 40 });
  assert.equal(ready.status, "ready");
  assert.equal(ready.useTool, "settings.change");
  assert.deepEqual(ready.preview.map((one) => [one.setting, one.from, one.to]), [[setting, "auto", 40]]);
});

test("settings.change sets the owner's own knob after the usual yes, the next task stops there, and settings.undo puts it back", async (t) => {
  const { app, owner, script, tool, loop } = await fixture(t);
  savePolicy(app.store, owner, { preset: "off" });
  script.change = { setting, value: 20 };
  const paused = await app.runtime.run({ prompt: "let tasks take 20 rounds" });
  assert.equal(paused.status, "needs_input", paused.output);
  const asked = app.runtime.approvals.questionFor(paused.sessionId);
  assert.equal(asked.tool, "settings.change");
  assert.equal(asked.target, `${setting} → 20`);
  assert.match(asked.label, /Round limit, .*: auto → 20/, "the owner is shown the before and after");
  assert.equal(readKnobs(app.store, owner, "limits").maxModelRounds, null, "nothing changes before the yes");
  app.runtime.approve(paused.sessionId, "allow", "session");
  script.asked = 0;
  const done = await app.runtime.run({ prompt: "let tasks take 20 rounds", sessionId: paused.sessionId });
  assert.equal(done.status, "completed", done.output);
  assert.equal(readKnobs(app.store, owner, "limits").maxModelRounds, 20, "the owner's knob holds the new figure");
  assert.equal(app.store.get("settings", owner, "round-limit"), undefined, "and there is no second copy of it");
  const next = await loop(plainTask);
  assert.equal(next.note?.limit, 20, "the next task stops at the new figure");
  const why = await tool("settings.why", { setting });
  assert.equal(why.kind, "recorded");
  assert.equal(why.value, 20);
  const undone = await tool("settings.undo", { record: why.record.id });
  assert.equal(undone.putBack.length, 1);
  assert.equal(readKnobs(app.store, owner, "limits").maxModelRounds, null, "undo puts back no figure at all, not 12");
  assert.equal((await tool("settings.list", { search: "rounds" })).shown[0].value, "auto");
});

test("with no figure of the owner's, work on the project's files gets 40 rounds and anything else 12", async (t) => {
  const { app, owner, loop } = await fixture(t);
  // Room for 40 rounds of one call each: the step budget is its own limit, met in the test below.
  saveKnobs(app.store, owner, "limits", { maxSteps: 200 });
  const coding = await loop(codingTask);
  assert.equal(coding.coding, true, "a request that names a file is work on the project's files");
  assert.equal(coding.note?.limit, 40, coding.run.output.slice(0, 300));
  const plain = await loop(plainTask);
  assert.equal(plain.coding, false);
  assert.equal(plain.note?.limit, 12, plain.run.output.slice(0, 300));
});

test("the owner's figure wins for every task, work on files included", async (t) => {
  const { app, owner, loop } = await fixture(t);
  saveKnobs(app.store, owner, "limits", { maxSteps: 200, maxModelRounds: 20 });
  assert.equal((await loop(codingTask)).note?.limit, 20);
  assert.equal((await loop(plainTask)).note?.limit, 20);
});

test("out of rounds, the task names the round limit, where to raise it, and that Branch raises it on the owner's yes", async (t) => {
  const { app, owner, loop } = await fixture(t);
  saveKnobs(app.store, owner, "limits", { maxModelRounds: 3 });
  await saveLook(app.store, owner, { language: "en" });
  const english = (await loop(plainTask)).run.output;
  assert.match(english, /^Here is what I found so far\./, "the best answer comes first");
  assert.match(english, /went back to the model 3 times/);
  assert.match(english, /the "Round limit" setting/);
  assert.match(english, /in Settings, under Advanced/);
  assert.match(english, /ask me to raise it and I will, once you say yes/);
  await saveLook(app.store, owner, { language: "fr" });
  const french = (await loop(plainTask)).run.output;
  assert.match(french, /est revenue 3 fois vers le modèle/);
  assert.match(french, /le réglage « Limite de tours »/);
  assert.match(french, /dans Réglages, sous Avancé/);
  assert.match(french, /dès que vous aurez dit oui/);
});

test("a task that runs out of steps names the step limit without asking the model again, even part-way through a round", async (t) => {
  const { app, owner, script, loop } = await fixture(t);
  await saveLook(app.store, owner, { language: "en" });
  // One step for each question to the model and one for each tool call. Three calls a round: the second
  // round's model question takes step 5, its first call step 6, and its second call finds none left.
  saveKnobs(app.store, owner, "limits", { maxSteps: 6, maxModelRounds: 40 });
  script.perRound = 3;
  const { run, note } = await loop(plainTask);
  assert.equal(run.status, "budget_exceeded", "it is still recorded as having stopped at a limit");
  assert.doesNotMatch(run.output, /^Step budget exhausted/, "never the budget's bare words");
  assert.match(run.output, /^I stopped here: this task has taken as many steps as one task may \(6\)/);
  assert.match(run.output, /"Most steps in one task" in Settings, under Permissions/);
  assert.deepEqual([note?.by, note?.limit, note?.answered], ["steps", 6, false]);
  // The last question would be a seventh step: the model is asked only the two rounds' questions.
  assert.deepEqual([script.calls, script.lastWords], [2, 0], "a step limit is never passed to ask for a last answer");
  // Between rounds as well: one call a round uses the last step on a call, and the next round has none.
  script.perRound = 1;
  script.calls = 0;
  saveKnobs(app.store, owner, "limits", { maxSteps: 4, maxModelRounds: 40 });
  const between = await loop(plainTask);
  assert.match(between.run.output, /^I stopped here: this task has taken as many steps as one task may \(4\)/);
  assert.equal(between.note?.by, "steps");
  assert.deepEqual([script.calls, script.lastWords], [2, 0], "two rounds of two steps, and no question after them");
});
