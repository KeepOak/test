import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { acceptValue, applyWithPins, changesFor, loosens } from "../dist/settings-kit/changes.js";
import { settingsCatalogue, specFor } from "../dist/settings-kit/catalogue.js";
import { settingsKitApi } from "../dist/settings-kit/api.js";
import { presets } from "../dist/settings-kit/presets.js";
import { saveDictationSettings } from "../dist/voice-dictation.js";
import { discardTemp } from "./temp-dir.mjs";

const numeric = [
  ["wake-word", "sureness", 80, 50, true, "guard"],
  ["live-dictation", "silenceSeconds", 4, 30, true, "reach"],
  ["retention", "keepDays", 0, 3650, false, "plain"],
  ["comfort-mcp", "startupTimeoutSeconds", 10, 300, false, "plain"],
  ["round-limit", "maxModelRounds", 12, 60, false, "plain"],
  ["step-limit", "maxSteps", 60, 120, false, "plain"],
  ["task-tokens", "taskAllowance", 200000, 400000, false, "plain"],
];

for (const [key, name, from, to, expected, direction] of numeric) {
  test(`${key}.${name}: numeric direction, inverse and equality agree with the catalogue`, () => {
    const spec = specFor(key), field = spec.fields.find((entry) => entry.field === name);
    assert.equal(field.guard, direction);
    assert.equal(loosens(field, from, to, spec), expected);
    assert.equal(loosens(field, to, from, spec), false);
    assert.equal(loosens(field, from, from, spec), false);
    for (const invalid of [NaN, Infinity, "50", field.kind.min - 1, field.kind.max + 1, from + 0.5])
      assert.equal(acceptValue(field, invalid), undefined, `${key}: invalid number accepted`);
  });
}

test("every numeric setting is classified, while nonnumeric directions stay intact", () => {
  const ids = settingsCatalogue.flatMap((spec) => spec.fields
    .filter((field) => field.kind.type === "number").map((field) => `${spec.key}.${field.field}`));
  assert.deepEqual(ids.sort(), numeric.map(([key, field]) => `${key}.${field}`).sort());
  const check = (key, name, from, to, expected) => {
    const spec = specFor(key), field = spec.fields.find((entry) => entry.field === name);
    assert.equal(loosens(field, from, to, spec), expected);
  };
  check("wake-word", "mode", "off", "on", true);
  check("loop_guard", "mode", "on", "off", true);
  check("chat-permissions", "extras", false, true, true);
  check("policy", "preset", "ask-before-changes", "off", true);
  const field = specFor("retention").fields.find((entry) => entry.field === "keepDays");
  assert.equal(loosens(field, 1, 2, { key: "permission-limits" }), true, "unknown safety-shaped plain fields still fail closed");
});

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-numeric-settings-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const context = app.runtime.context({ source: "owner" });
  const deps = { store: app.store, owner, workspace: app.runtime.workspace, appVersion: "test" };
  const api = (route, body) => settingsKitApi(deps, "POST", `/api/settings-kit/${route}`, async () => body);
  const tool = (name, args) => app.registry.execute(name, args, context);
  const value = async (id) => (await tool("settings.list", { search: id })).shown[0].value;
  /** A less careful change is put to the owner every time, and the yes is never kept (dogfood A1: one question, one yes). */
  const askedEveryTime = (args) => {
    const held = app.runtime.checkPolicy("settings.change", args, context, `fp-${JSON.stringify(args)}`);
    assert.deepEqual([held.decision, held.remember], ["ask", "never"], "a less careful change is asked about every time");
  };
  return { app, owner, api, tool, value, askedEveryTime };
}

test("numeric loosening is asked about every time, then made by settings.change; tightening too", async (t) => {
  const { tool, value, askedEveryTime } = await fixture(t);
  for (const [key, field, from, to] of numeric.slice(0, 2)) {
    const id = `${key}.${field}`, args = { changes: [{ setting: id, value: to }] };
    const row = (await tool("settings.list", { search: id })).shown[0];
    assert.match(row.lessCareful, key === "wake-word" ? /turning it down/ : /turning it up/);
    askedEveryTime(args);
    assert.equal(await value(id), from, "nothing is written before the owner's yes");
    assert.equal((await tool("settings.change", args)).changed.length, 1, "after that yes, settings.change makes it");
    assert.equal(await value(id), to);
    const tighter = { changes: [{ setting: id, value: from }] };
    await assert.rejects(tool("settings.loosen", tighter), /None of these makes Branch less careful/);
    assert.equal((await tool("settings.change", tighter)).changed.length, 1);
    assert.equal(await value(id), from);
    assert.deepEqual((await tool("settings.change", tighter)).changed, [], "same value is a no-op");
  }
});

const settingsFile = (settings) => JSON.stringify({ format: "branch-settings", version: 1,
  appVersion: "test", exportedAt: "2026-09-23T00:00:00.000Z", settings });

for (const source of ["set", "import", "reset"]) {
  test(`${source}: numeric preview requires separate confirmation and leaves refused values unchanged`, async (t) => {
    const { app, owner, api, value } = await fixture(t);
    for (const [key, field, initial, loose] of numeric.slice(0, 2)) {
      const id = `${key}.${field}`;
      const from = source === "reset" ? (key === "wake-word" ? 99 : 1) : initial;
      const to = source === "reset" ? initial : loose;
      app.store.save("settings", owner, key, { [field]: from });
      const plan = source === "reset" ? { source, key } : source === "set" ? { source, key, field, value: to }
        : { source, file: settingsFile({ [key]: { [field]: to } }) };
      const preview = await api("preview", plan);
      assert.deepEqual(preview.changes.map((change) => [change.id, change.from, change.to, change.loosens]), [[id, from, to, true]]);
      const choice = { plan, accept: [id], confirmLoosening: false };
      await assert.rejects(api("apply", choice), /less careful/);
      assert.equal(await value(id), from);
      assert.equal((await api("apply", { ...choice, confirmLoosening: true })).applied.length, 1);
      assert.equal(await value(id), to);
    }
  });
}

test("numeric pins survive tools and file/reset proposals even with loosening confirmed", async (t) => {
  const { app, owner, api, tool, value } = await fixture(t);
  app.store.save("settings", owner, "wake-word", { sureness: 99 });
  await api("pins", { key: "wake-word", field: "sureness", pinned: true });
  for (const plan of [{ source: "reset", key: "wake-word" },
    { source: "import", file: settingsFile({ "wake-word": { sureness: 50 } }) }]) {
    const result = await api("apply", { plan, accept: ["wake-word.sureness"], confirmLoosening: true });
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
  }
  const result = await tool("settings.loosen", { changes: [{ setting: "wake-word.sureness", value: 50 }] });
  assert.equal(result.changed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(await value("wake-word.sureness"), 99);
});

test("preset shared apply path classifies numeric fixture proposals without adding a shipped preset", async (t) => {
  const { app, owner, value } = await fixture(t);
  const ids = new Set(numeric.map(([key, field]) => `${key}.${field}`));
  assert.ok(presets.every((preset) => preset.sets.every((entry) => !ids.has(`${entry.key}.${entry.field}`))),
    "real presets now contain numeric proposals; add their acceptance cases");
  const fixtureProposals = numeric.slice(0, 2).map(([key, field, , to]) => ({ key, field, value: to }));
  const { changes } = changesFor(app.store, owner, fixtureProposals);
  const choice = { accept: changes.map((change) => change.id), confirmLoosening: false, why: "numeric preset-path fixture" };
  assert.throws(() => applyWithPins(app.store, owner, changes, choice), /less careful/);
  assert.equal(await value("wake-word.sureness"), 80);
  assert.equal(await value("live-dictation.silenceSeconds"), 4);
  assert.equal(applyWithPins(app.store, owner, changes, { ...choice, confirmLoosening: true }).applied.length, 2);
});

test("numeric loosening through a conversation asks each time and cannot remember its approval", async (t) => {
  let calls = 0, threshold = 50;
  const provider = { name: "scripted", async complete() {
    return calls++ === 0 ? { content: "", toolCalls: [{ id: "numeric-change", name: "settings.loosen",
      arguments: JSON.stringify({ changes: [{ setting: "wake-word.sureness", value: threshold }] }) }] }
      : { content: "Finished.", toolCalls: [] };
  } };
  const { app, owner, value } = await fixture(t, provider);
  savePolicy(app.store, owner, { preset: "off" });
  const ask = (sessionId) => {
    calls = 0;
    return app.runtime.run({ prompt: "Change the wake confidence", ...(sessionId ? { sessionId } : {}) });
  };
  const paused = await ask();
  assert.equal(paused.status, "needs_input", paused.output);
  assert.equal(await value("wake-word.sureness"), 80);
  assert.equal(app.runtime.approvals.questionFor(paused.sessionId).remember, "never");
  assert.throws(() => app.runtime.approve(paused.sessionId, "allow", "session"), /once|kept|remember|time/i);
  app.runtime.approve(paused.sessionId, "allow", "never");
  // A yes for 50 is not a yes for another numeric value, even in the same conversation.
  threshold = 60;
  const changedCall = await ask(paused.sessionId);
  assert.equal(changedCall.status, "needs_input", changedCall.output);
  assert.equal(await value("wake-word.sureness"), 80);
  app.runtime.approve(paused.sessionId, "allow", "never");
  assert.equal((await ask(paused.sessionId)).status, "completed");
  assert.equal(await value("wake-word.sureness"), 60);
  app.store.save("settings", owner, "wake-word", { sureness: 80 });
  assert.equal((await ask(paused.sessionId)).status, "needs_input");
  assert.equal(await value("wake-word.sureness"), 80);
});

test("a quiet wait saved between whole seconds is compared as it is, so turning it up still asks every time", async (t) => {
  const { app, owner, value, askedEveryTime } = await fixture(t);
  /* The dictation route itself takes 1.5 (src/voice-dictation.ts); the settings kit only proposes whole seconds. */
  saveDictationSettings(app.store, owner, { silenceSeconds: 1.5 });
  assert.equal(await value("live-dictation.silenceSeconds"), 1.5, "the list shows what is really saved");
  const [change] = changesFor(app.store, owner, [{ key: "live-dictation", field: "silenceSeconds", value: 3 }]).changes;
  assert.deepEqual([change?.from, change?.to, change?.loosens], [1.5, 3, true]);
  askedEveryTime({ changes: [{ setting: "live-dictation.silenceSeconds", value: 3 }] });
  assert.equal(await value("live-dictation.silenceSeconds"), 1.5, "nothing is written before the owner's yes");
});

test("a whole-number setting saved as a fraction is weighed as the app runs it, so lowering it still asks every time", async (t) => {
  const { app, owner, value, askedEveryTime } = await fixture(t);
  /* The wake word keeps whole numbers only (src/voice-wake.ts): a stored 60.5 makes the app run on its starting 80. */
  app.store.save("settings", owner, "wake-word", { mode: "off", word: "", sureness: 60.5, windowSeconds: 2 });
  assert.equal(await value("wake-word.sureness"), 80, "the list shows what is really in force");
  const [change] = changesFor(app.store, owner, [{ key: "wake-word", field: "sureness", value: 70 }]).changes;
  assert.deepEqual([change?.from, change?.to, change?.loosens], [80, 70, true]);
  askedEveryTime({ changes: [{ setting: "wake-word.sureness", value: 70 }] });
});

test("a record the app would not accept is shown as the starting values the app runs on", async (t) => {
  const { app, owner, value } = await fixture(t);
  app.store.save("settings", owner, "wake-word", { mode: "bogus", sureness: 60 });
  assert.equal(await value("wake-word.sureness"), 80, "an unreadable record is not shown as if it were in force");
});

test("only a setting the app keeps between whole steps is read as a fraction; a whole-number one reads its starting value", async (t) => {
  const { app, owner, value } = await fixture(t);
  /* The tool-server start wait is whole seconds in the app (src/comfort/settings.ts), so 10.5 is not a value it runs on. */
  app.store.save("settings", owner, "comfort-mcp", { startupTimeoutSeconds: 10.5 });
  assert.equal(await value("comfort-mcp.startupTimeoutSeconds"), 10);
});

test("a change to a voice setting is written onto what the app runs, so it cannot switch on a mode the app was ignoring", async (t) => {
  const { app, owner } = await fixture(t);
  for (const [key, field, to] of [["wake-word", "sureness", 99], ["live-dictation", "silenceSeconds", 10]]) {
    /* An unreadable record: the app runs its starting values, with the switch off, whatever "on" says. */
    const bad = key === "wake-word" ? { mode: "on", sureness: 60.5 } : { mode: "on", silenceSeconds: "soon" };
    app.store.save("settings", owner, key, bad);
    const [change] = changesFor(app.store, owner, [{ key, field, value: to }]).changes;
    assert.equal(change?.loosens, key === "live-dictation", `${key}: weighed from what is in force`);
    applyWithPins(app.store, owner, [change], { accept: [change.id], confirmLoosening: true, why: "test" });
    const saved = app.store.get("settings", owner, key).data;
    assert.equal(saved.mode, "off", `${key}: the switch the app was ignoring stays off`);
    assert.equal(saved[field], to);
  }
});

test("a dictation record the app would not accept is shown as the starting values the app runs on", async (t) => {
  const { app, owner, value } = await fixture(t);
  app.store.save("settings", owner, "live-dictation", { mode: "bogus", silenceSeconds: 12 });
  assert.equal(await value("live-dictation.silenceSeconds"), 4, "an unreadable record is not shown as if it were in force");
});

test("a voice change made during Lockdown keeps the owner's own switch for when Lockdown ends", async (t) => {
  const { app, owner, tool } = await fixture(t);
  const { setLockdown } = await import("../dist/lockdown.js");
  app.store.save("settings", owner, "wake-word", { mode: "on", word: "hey branch", sureness: 80, windowSeconds: 2 });
  app.store.save("settings", owner, "live-dictation", { mode: "on", silenceSeconds: 4 });
  setLockdown(app.store, owner, { on: true });
  // Q65 review: a change asked for in a conversation is refused while Lockdown is on, as the window's is, so nothing is written.
  await assert.rejects(tool("settings.change", { changes: [{ setting: "wake-word.sureness", value: 90 }, { setting: "live-dictation.silenceSeconds", value: 3 }] }), /Lockdown is on/);
  assert.equal(app.store.get("settings", owner, "wake-word").data.sureness, 80);
  /* The voice cards' own saves (the same ones src/settings-kit/writers.ts uses) still keep the owner's own switch. */
  const { saveWakeWordSettings } = await import("../dist/voice-wake.js");
  const { saveDictationSettings } = await import("../dist/voice-dictation.js");
  saveWakeWordSettings(app.store, owner, { sureness: 90 });
  saveDictationSettings(app.store, owner, { silenceSeconds: 3 });
  assert.equal(app.store.get("settings", owner, "wake-word").data.mode, "on", "the wake word's own switch is kept");
  assert.equal(app.store.get("settings", owner, "wake-word").data.sureness, 90);
  assert.equal(app.store.get("settings", owner, "live-dictation").data.mode, "on", "dictation's own switch is kept");
  setLockdown(app.store, owner, { on: false });
});
