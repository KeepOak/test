/**
 * Changing Branch's own settings by asking for it (src/settings-kit/tools.ts): settings.list,
 * settings.change and settings.loosen.
 *
 * What a hostile caller would try, and the test for each:
 *   1. a household profile changing the owner's settings                  → refused before anything is read
 *   2. a short-lived key doing it                                          → refused
 *   3. a chat app doing it, or a helper of a chat's task                   → refused
 *   4. a schedule, a trigger or another program (MCP, A2A) doing it        → refused
 *   5. an ordinary change slipping through with no question                → asked, under every rule set, even "allow everything"
 *   6. the model answering "yes, less careful" by itself                   → never: a less careful change is asked of the owner every time, never kept
 *   7. a change saved around the setting's own save (a tool left behind)   → saved through the window's writers
 *   8. reaching something that is not a setting (a key, a connection)     → refused by name, nothing written
 * Everything runs on its own data folder and a closed port; the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { settingsHold } from "../dist/settings-kit/tools.js";
import { secretShaped } from "../dist/settings-kit/catalogue.js";
import { savePins } from "../dist/settings-kit/pins.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-talk-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  /** A context for a task begun the given way. */
  const as = (start = { source: "owner" }) => {
    const run = app.store.createRun(owner, "change a setting");
    app.store.event(run.id, "run.started", start);
    return app.runtime.context({ runId: run.id, source: start.source ?? "owner" });
  };
  return { app, owner, as, run: (name, args, context = as()) => app.registry.execute(name, args, context) };
}

test("the owner lists settings by words, and each says what it is set to now", async (t) => {
  const { run } = await fixture(t);
  const all = await run("settings.list", {});
  assert.ok(all.total > 50, `only ${all.total} settings were listed`);
  const learning = await run("settings.list", { search: "fly-core" });
  assert.deepEqual(learning.shown.map((row) => row.setting), ["fly-core.mode"]);
  assert.equal(learning.shown[0].value, "off");
  assert.deepEqual(learning.shown[0].choices, ["off", "when-needed", "on"]);
  const off = await run("settings.list", { onlyOff: true });
  assert.ok(off.shown.every((row) => row.value === "off" || row.value === false));
  // The catalogue never holds a secret-shaped field; a switch named after the Keychain is still a switch.
  assert.ok(!all.shown.some((row) => secretShaped.test(row.setting.slice(row.setting.indexOf(".") + 1))), "nothing secret-shaped is ever listed");
});

test("an ordinary change is saved through the setting's own save, so its tool comes with it", async (t) => {
  const { app, run } = await fixture(t);
  const before = new Set(app.registry.names());
  const done = await run("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] });
  assert.equal(done.changed.length, 1);
  assert.match(done.changed[0], /Switch: off → on$/);
  assert.equal(app.learningCore.settings().mode, "on");
  const added = app.registry.names().filter((name) => !before.has(name));
  assert.ok(added.length > 0, "the learning core's own tool appears, as it does when the card's switch is moved");
  const audit = app.store.audit.list(app.runtime.owner, { limit: 5 });
  assert.ok(audit.some((entry) => /asked for in a conversation/.test(entry.subject)), "the change is written down");
  const again = await run("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] });
  assert.deepEqual(again.changed, [], "asking for what is already so changes nothing");
});

test("a change that makes Branch less careful is asked about every time, and the one yes lets settings.change make it", async (t) => {
  const { run, app, as } = await fixture(t);
  const loose = (await run("settings.list", {})).shown.find((row) => row.lessCareful?.startsWith("turning it up") && row.value === "off");
  assert.ok(loose, "the catalogue has a switch that reaches further when turned on");
  const ask = { changes: [{ setting: loose.setting, value: "on" }] };
  const held = app.runtime.checkPolicy("settings.change", ask, as(), "fp-loose");
  assert.deepEqual([held.decision, held.remember], ["ask", "never"], "the owner is asked every time, and the yes is never kept");
  assert.equal((await run("settings.list", { search: loose.setting })).shown[0].value, "off", "nothing is written before that yes");
  await assert.rejects(run("settings.loosen", { changes: [{ setting: "fly-core.mode", value: "on" }] }), /None of these makes Branch less careful/);
  const made = await run("settings.change", ask);
  assert.equal(made.changed.length, 1);
  assert.equal((await run("settings.list", { search: loose.setting })).shown[0].value, "on");
  assert.ok(app.store.audit.list(app.runtime.owner, { limit: 5 }).length);
});

test("nobody but the owner, in a conversation the owner started, gets any of it", async (t) => {
  const { app, as, run } = await fixture(t);
  const change = { changes: [{ setting: "fly-core.mode", value: "on" }] };
  for (const [who, start, refusal] of [
    ["a short-lived key", { source: "owner", shortLivedKey: true }, /short-lived key/],
    ["a chat app", { source: "channel" }, /chat app/],
    ["a schedule", { source: "schedule" }, /not from a schedule/],
    ["a trigger", { source: "trigger" }, /not from a trigger/],
    ["another program over MCP", { source: "mcp" }, /not from a mcp/],
    ["another agent over A2A", { source: "a2a" }, /not from a a2a/],
    ["somebody else's lent conversation", { source: "owner", lentTo: "sam" }, /belongs to somebody else/],
  ]) {
    for (const tool of ["settings.list", "settings.change", "settings.loosen"])
      await assert.rejects(run(tool, tool === "settings.list" ? {} : change, as(start)), refusal, `${who} reached ${tool}`);
  }
  // A helper of a chat's task counts as the chat's.
  const chat = app.store.createRun(app.runtime.owner, "from a chat");
  app.store.event(chat.id, "run.started", { source: "channel" });
  const helper = app.store.createRun(app.runtime.owner, "a helper");
  app.store.event(helper.id, "run.started", { source: "owner", parentRunId: chat.id });
  await assert.rejects(run("settings.change", change, app.runtime.context({ runId: helper.id })), /chat app/);
  // A household profile's task: Branch judges by whom the task was started for (src/profiles.ts, judged()).
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  for (const tool of ["settings.list", "settings.change"])
    await assert.rejects(run(tool, tool === "settings.list" ? {} : change, as({ source: "owner", personProfileId: person.id })),
      /owner/i, `Sam's task reached ${tool}`);
  assert.equal(app.learningCore.settings().mode, "off", "no refused call wrote anything");
});

test("what is not a setting is refused by name, and nothing is written", async (t) => {
  const { run } = await fixture(t);
  const done = await run("settings.change", { changes: [
    { setting: "secrets.value", value: "x" }, { setting: "nonsense", value: true }, { setting: "fly-core.mode", value: "loud" },
  ] });
  assert.deepEqual(done.changed, []);
  assert.equal(done.refused.length, 3);
});

test("the owner is asked before any change, under every rule set, and a less careful one every time", async (t) => {
  const { app, as } = await fixture(t);
  assert.deepEqual(settingsHold("settings.list"), null, "looking is free");
  const change = { changes: [{ setting: "fly-core.mode", value: "on" }] };
  for (const policy of [{ preset: "off" }, { preset: "workspace" }, { preset: "ask-before-changes" },
    { preset: "custom", rules: [{ tool: "*", decision: "allow" }] }]) {
    savePolicy(app.store, app.runtime.owner, policy);
    const context = as();
    const ordinary = app.runtime.checkPolicy("settings.change", change, context, "fp-change");
    assert.equal(ordinary.decision, "ask", `settings.change went through unasked under ${policy.preset}`);
    // Dogfood E2: the label says the change in words, which says why it is asked; the reason is not repeated after it.
    assert.match(ordinary.label, /Switch: off → on$/);
    assert.equal(ordinary.worded, true);
    assert.equal(ordinary.target, "fly-core.mode → on", "the question names exactly what was asked for");
    const loosen = app.runtime.checkPolicy("settings.loosen", change, context, "fp-loosen");
    assert.equal(loosen.decision, "ask", `settings.loosen went through unasked under ${policy.preset}`);
    assert.equal(loosen.remember, "never", "a yes to a less careful change is never kept");
    assert.equal(app.runtime.checkPolicy("settings.list", {}, context).decision, "allow");
  }
});

test("Branch answers questions about itself from its own handbook, and looking is free", async (t) => {
  const { app, as, run } = await fixture(t);
  const lockdown = await run("help.search", { question: "what does Lockdown do" });
  assert.equal(lockdown.passages[0].heading, "Lockdown: one switch");
  assert.match(lockdown.passages[0].text, /Lockdown/);
  const model = await run("help.search", { question: "how do I connect a model" });
  assert.equal(model.passages[0].chapter, "Connect a model");
  const nothing = await run("help.search", { question: "zzqx vvbn" });
  assert.deepEqual(nothing.passages, []);
  assert.ok(nothing.chapters.length >= 10, "and it says which chapters there are");
  assert.equal(app.runtime.checkPolicy("help.search", { question: "anything" }, as()).decision, "allow");
});

test("a refused caller cannot make Branch read the owner's settings, even through the approval question", async (t) => {
  const { app, as } = await fixture(t);
  const realGet = app.store.get.bind(app.store);
  let reads = 0;
  app.store.get = (kind, owner, key) => { if (kind === "settings" && key === "fly-core") reads++; return realGet(kind, owner, key); };
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const change = { changes: [{ setting: "fly-core.mode", value: "on" }] };
  for (const start of [{ source: "channel" }, { source: "owner", shortLivedKey: true }, { source: "schedule" }, { source: "mcp" },
    { source: "a2a" }, { source: "owner", personProfileId: person.id }]) {
    for (const tool of ["settings.change", "settings.loosen"]) {
      const check = app.runtime.checkPolicy(tool, change, as(start), "fp");
      assert.equal(check.target, "fly-core.mode → on");
      assert.doesNotMatch(check.label, /off →/, "and the question carries no current value");
    }
  }
  assert.equal(reads, 0, "working out the question read the setting");
  // Q50: only the owner, in a conversation they started, is asked with the current value in the
  // question; what the rules match against is still exactly what the call asked for.
  for (const tool of ["settings.change", "settings.loosen"]) {
    const check = app.runtime.checkPolicy(tool, change, as({ source: "owner" }), "fp");
    assert.equal(check.target, "fly-core.mode → on");
    assert.match(check.label, /off → on/);
  }
});

test("a pinned setting stays as the owner fixed it, whichever tool asks", async (t) => {
  const { app, run } = await fixture(t);
  const loose = (await run("settings.list", {})).shown.find((row) => row.lessCareful?.startsWith("turning it up") && row.value === "off");
  const [looseKey, looseField] = [loose.setting.slice(0, loose.setting.indexOf(".")), loose.setting.slice(loose.setting.indexOf(".") + 1)];
  savePins(app.store, app.runtime.owner, [
    { key: "fly-core", field: "mode", value: "off", initial: "off", name: "The learning core", label: "Switch" },
    { key: looseKey, field: looseField, value: "off", initial: "off", name: loose.name, label: loose.label },
  ]);
  const plain = await run("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] });
  assert.deepEqual(plain.changed, []);
  assert.equal(plain.skipped.length, 1);
  assert.match(plain.skipped[0].why, /pinned|fixed/i);
  assert.equal(app.learningCore.settings().mode, "off");
  const risky = await run("settings.loosen", { changes: [{ setting: loose.setting, value: "on" }] });
  assert.deepEqual(risky.changed, []);
  assert.equal(risky.skipped.length, 1);
  assert.equal((await run("settings.list", { search: loose.setting })).shown[0].value, "off");
});

test("outside work through the runtime's own path gets none of it, the look-only list included", async (t) => {
  const { app } = await fixture(t);
  for (const source of ["schedule", "trigger", "mcp", "a2a", "channel"]) {
    for (const [tool, args] of [["settings.list", {}], ["settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }]]) {
      let result;
      try { result = await app.runtime.executeTool(tool, args, { mode: "policy", source }); } catch (error) { result = { threw: String(error?.message ?? error) }; }
      assert.ok(!JSON.stringify(result).includes("fly-core.mode\""), `${source} got the settings through ${tool}`);
    }
  }
  assert.equal(app.learningCore.settings().mode, "off");
});

test("a change that loosens only from how the owner set things by hand is not made by settings.change (NAS b86e65a)", async (t) => {
  const { app, owner, run } = await fixture(t);
  const { readPolicy } = await import("../dist/policy.js");
  const { mayLoosen } = await import("../dist/settings-kit/tools.js");
  // The owner's own hand-made rules, saved as the approval card saves them.
  // In the train with Q200: a refusal of the owner's own stays through a preset move, so that move is not looser at all.
  // An "ask" of the owner's own does not stay, so moving to Read only (which lets web lookups through) loosens by hand.
  savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "web.fetch", match: "*", decision: "ask", remember: "always" }] });
  assert.equal(readPolicy(app.store, owner).preset, "custom", "control: the owner's own rule makes it custom");
  const input = { changes: [{ setting: "policy.preset", value: "read-only" }] };
  assert.equal(mayLoosen(input), false, "control: the catalogue alone sees no loosening, so the question was not once-only");
  await assert.rejects(run("settings.change", input), /settings\.loosen/);
  assert.ok(readPolicy(app.store, owner).rules.some((rule) => rule.tool === "web.fetch" && rule.decision === "ask"), "the owner's rule is still there");
  const loosened = await run("settings.loosen", input);
  assert.equal(loosened.changed.length, 1, "settings.loosen, which asks every time, can make it");
});
