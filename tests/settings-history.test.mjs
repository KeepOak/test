/**
 * Q48 and Q49: every change the settings kit makes is written down as a structured record (which
 * setting, before, after, who, which way, when); an undo puts back exactly the recorded before-values
 * through the same pins and rules, or refuses as a whole; and "why is this on?" answers from those
 * records only. Everything runs on its own data folder; the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { settingsKitApi, SettingsKitError } from "../dist/settings-kit/api.js";
import { settingsHistory } from "../dist/settings-kit/history.js";
import { exportSettings } from "../dist/settings-kit/transfer.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { startServer } from "../dist/server.js";
import { choosePreset } from "../dist/terminal-commands.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-history-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const deps = { store: app.store, owner, workspace: join(root, "workspace"), appVersion: "test" };
  const ask = (method, path, body) => settingsKitApi(deps, method, path, async () => body);
  const values = async () => Object.fromEntries((await ask("GET", "/api/settings-kit")).settings
    .flatMap((spec) => spec.fields.map((field) => [`${spec.key}.${field.field}`, field.value])));
  /** Applies a preset, every change ticked, and returns the result. */
  const preset = async (name) => {
    const plan = { source: "preset", preset: name };
    const { changes } = await ask("POST", "/api/settings-kit/preview", plan);
    return ask("POST", "/api/settings-kit/apply", { plan, accept: changes.map((change) => change.id), confirmLoosening: true });
  };
  const refused = (status, pattern) => (error) => error instanceof SettingsKitError && error.status === status && pattern.test(error.message);
  return { root, app, owner, ask, values, preset, refused };
}

test("a preset's many changes are recorded, and undo puts back exactly the before-values", async (t) => {
  const { app, owner, ask, values, preset, refused } = await fixture(t);
  const before = await values();
  const done = await preset("private");
  assert.ok(done.applied.length > 2, `the preset changed only ${done.applied.length} settings`);
  const [record] = (await ask("GET", "/api/settings-kit/history")).records;
  assert.equal(record.id, done.record);
  assert.equal(record.writer, "owner-in-window");
  assert.equal(record.source, "preset");
  assert.equal(record.detail, "Private and local");
  assert.ok(!Number.isNaN(Date.parse(record.at)));
  assert.deepEqual(record.changes.map((entry) => entry.setting).sort(), done.applied.map((change) => change.id).sort());
  for (const entry of record.changes) assert.equal(entry.before, before[entry.setting], `${entry.setting} before`);
  const after = await values();
  for (const entry of record.changes) assert.equal(entry.after, after[entry.setting], `${entry.setting} after`);

  const undone = await ask("POST", "/api/settings-kit/undo", { record: record.id, confirmLoosening: true });
  assert.equal(undone.applied.length, record.changes.length);
  assert.deepEqual(await values(), before, "every setting is back exactly as it was");
  const records = settingsHistory(app.store, owner);
  const undoRecord = records.at(-1);
  assert.equal(undoRecord.source, "undo");
  assert.equal(undoRecord.undoes, record.id);
  assert.equal(records.find((entry) => entry.id === record.id).undoneBy, undoRecord.id);
  assert.ok(app.store.audit.list(owner, { limit: 5 }).some((entry) => /undo of a change/.test(entry.subject)), "the undo is audited like any change");
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: record.id, confirmLoosening: true }), refused(409, /already undone/));
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: "nope", confirmLoosening: true }), refused(404, /no such change/));
});

test("an undo that would make Branch less careful is refused without the separate yes, and writes nothing", async (t) => {
  const { ask, values, preset, refused } = await fixture(t);
  const done = await preset("private");
  const changed = await values();
  // The private preset turns things off; turning them back on is the less careful direction.
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: done.record, confirmLoosening: false }), refused(409, /less careful/));
  assert.deepEqual(await values(), changed, "a refused undo changed something");
});

test("an undo is refused as a whole while one of its settings is pinned, or changed again since", async (t) => {
  const { ask, values, preset, refused } = await fixture(t);
  const done = await preset("private");
  const changed = await values();
  const [first] = done.applied;
  await ask("POST", "/api/settings-kit/pins", { key: first.key, field: first.field, pinned: true });
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: done.record, confirmLoosening: true }), refused(409, /pinned/));
  assert.deepEqual(await values(), changed, "a refused undo put back the settings that were not pinned");
  await ask("POST", "/api/settings-kit/pins", { key: first.key, field: first.field, pinned: false });

  // One of its settings moved again by one switch: the record no longer describes what is there.
  await ask("POST", "/api/settings-kit/apply", { plan: { source: "set", key: first.key, field: first.field, value: first.from },
    accept: [first.id], confirmLoosening: true });
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: done.record, confirmLoosening: true }),
    refused(409, new RegExp(`${first.id.replace(/[.]/g, "\\.")} was changed again later`)));
});

test("why is this on: a default, a talked change, an import, and a change nothing recorded", async (t) => {
  const { app, owner, ask } = await fixture(t);
  const why = (setting) => ask("GET", `/api/settings-kit/why/${setting}`);

  const untouched = await why("fly-core.mode");
  assert.equal(untouched.kind, "starting-value");
  assert.equal(untouched.record, null);
  assert.match(untouched.words, /how it starts\. No change to it was recorded/);

  const run = app.store.createRun(owner, "turn on the learning core");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  await app.registry.execute("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }, context);
  const talked = await why("fly-core.mode");
  assert.equal(talked.kind, "recorded");
  assert.equal(talked.value, "on");
  assert.equal(talked.record.writer, "conversation");
  assert.equal(talked.record.source, "talk");
  assert.equal(talked.record.runId, run.id);
  assert.equal(talked.record.sessionId, run.sessionId);
  assert.deepEqual([talked.record.before, talked.record.after], ["off", "on"]);
  assert.match(talked.words, /a conversation/);

  const file = exportSettings(app.store, owner, "test");
  file.settings.voice.autoReadAloud = !file.settings.voice.autoReadAloud;
  const plan = { source: "import", file: JSON.stringify(file) };
  const { changes } = await ask("POST", "/api/settings-kit/preview", plan);
  assert.deepEqual(changes.map((change) => change.id), ["voice.autoReadAloud"]);
  await ask("POST", "/api/settings-kit/apply", { plan, accept: ["voice.autoReadAloud"], confirmLoosening: false });
  const imported = await why("voice.autoReadAloud");
  assert.equal(imported.kind, "recorded");
  assert.equal(imported.record.source, "import");
  assert.equal(imported.record.writer, "owner-in-window");
  assert.match(imported.words, /a settings file you brought in/);

  // The voice card saves around the kit and keeps no record: the answer says so rather than
  // naming the import as the one who set it.
  saveVoiceSettings(app.store, owner, { autoReadAloud: !imported.value });
  const since = await why("voice.autoReadAloud");
  assert.equal(since.kind, "changed-since");
  assert.match(since.words, /changed again since by something that keeps no record/);

  await assert.rejects(() => why("not-a-setting.mode"), (error) => error instanceof SettingsKitError && error.status === 404);
});

test("a setting changed only by something that keeps no record says nothing was recorded", async (t) => {
  const { app, owner, ask } = await fixture(t);
  const { value } = await ask("GET", "/api/settings-kit/why/voice.autoReadAloud");
  saveVoiceSettings(app.store, owner, { autoReadAloud: !value });
  const answer = await ask("GET", "/api/settings-kit/why/voice.autoReadAloud");
  assert.equal(answer.kind, "not-recorded");
  assert.equal(answer.record, null);
  assert.match(answer.words, /Nothing was recorded about who or what set it/);
});

test("undoing a change is refused when a later recorded change touched the same setting, even back to the same value", async (t) => {
  const { ask, values, refused } = await fixture(t);
  const flip = async (value) => (await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "fly-core", field: "mode", value }, accept: ["fly-core.mode"], confirmLoosening: true })).record;
  const r1 = await flip("on"), r2 = await flip("off"), r3 = await flip("on");
  // The value is what r1 made it, but only because r3 made it so: undoing r1 would silently undo r3.
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: r1, confirmLoosening: true }),
    refused(409, /fly-core[.]mode was changed again later .*Undo the later change first/));
  assert.equal((await values())["fly-core.mode"], "on", "a refused undo changed something");
  // Newest first still works, one step at a time, because each undone change cancels with its undo.
  for (const id of [r3, r2, r1]) await ask("POST", "/api/settings-kit/undo", { record: id, confirmLoosening: true });
  assert.equal((await values())["fly-core.mode"], "off");
});

test("undoing a change to a setting Branch no longer has says so, not that it changed again", async (t) => {
  const { app, owner, ask, refused } = await fixture(t);
  app.store.save("settings", owner, "settings-history", { records: [{ id: "old-one", at: new Date().toISOString(),
    writer: "owner-in-window", source: "switch", detail: "gone-setting.mode", changes: [{ setting: "gone-setting.mode", before: "off", after: "on" }] }] });
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: "old-one", confirmLoosening: true }),
    refused(409, /gone-setting[.]mode is no longer a setting Branch has/));
});

test("the cards that save around the kit, and /preset, are recorded, so why names the right source", async (t) => {
  const { root, app, ask } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
  };
  const why = (setting) => ask("GET", `/api/settings-kit/why/${setting}`);
  const byCard = async (setting, detail) => {
    const answer = await why(setting);
    assert.equal(answer.kind, "recorded", `${setting}: ${answer.words}`);
    assert.equal(answer.record.writer, "owner-in-window", setting);
    assert.equal(answer.record.source, "card", setting);
    assert.equal(answer.record.detail, detail, setting);
    assert.match(answer.words, /its own card in Settings/);
  };
  await post("/api/policy", { preset: "read-only" });
  await byCard("policy.preset", "policy");
  await post("/api/voice/wake", { mode: "on" });
  await byCard("wake-word.mode", "wake-word");
  const { value: aloud } = await why("voice.autoReadAloud");
  await post("/api/voice/settings", { autoReadAloud: !aloud });
  await byCard("voice.autoReadAloud", "voice");
  await post("/api/os-sandbox", { mode: "on", network: "limited", keySites: {}, unreadable: [] });
  await byCard("os-sandbox.network", "os-sandbox");
  await post("/api/retention", { enabled: true, keepDays: 30, megabytes: 1, exportBeforeDeleting: true });
  await byCard("retention.keepDays", "retention");

  choosePreset(app.runtime, "workspace confirm"); // Q258: workspace loosens, so the typed yes
  const typed = await why("policy.preset");
  assert.equal(typed.kind, "recorded");
  assert.equal(typed.value, "workspace");
  assert.equal(typed.record.writer, "owner-by-command");
  assert.equal(typed.record.source, "command");
  assert.equal(typed.record.detail, "/preset workspace");
  assert.deepEqual([typed.record.before, typed.record.after], ["read-only", "workspace"]);
  // A recorded card change is an ordinary change: it can be undone like any other.
  await ask("POST", "/api/settings-kit/undo", { record: typed.record.id, confirmLoosening: true });
  assert.equal((await why("policy.preset")).value, "read-only");
});

test("a change whose record cannot be written is not made at all, from the kit or from a card", async (t) => {
  const { app, ask, values } = await fixture(t);
  const before = await values();
  const auditBefore = app.store.audit.list(app.runtime.owner, { limit: 50 }).length;
  const real = app.store.save.bind(app.store);
  app.store.save = (table, owner, id, data) => {
    if (table === "settings" && id === "settings-history") throw new Error("the disk is full");
    return real(table, owner, id, data);
  };
  t.after(() => { delete app.store.save; });
  await assert.rejects(() => ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "fly-core", field: "mode", value: "on" }, accept: ["fly-core.mode"], confirmLoosening: true }), /the disk is full/);
  assert.throws(() => choosePreset(app.runtime, "workspace"), /the disk is full/);
  delete app.store.save;
  assert.deepEqual(await values(), before, "a setting changed although its record was never written");
  assert.equal(app.store.audit.list(app.runtime.owner, { limit: 50 }).length, auditBefore, "the audit entry of a change that was not made stayed");
});

test("an assistant file and --save-preset are recorded; a --preset for one task is not", async (t) => {
  const { app, owner, ask } = await fixture(t);
  const { exportAgent, openAgent, importAgent } = await import("../dist/agent-export.js");
  const { usePreset } = await import("../dist/cli-run.js");
  const why = (setting) => ask("GET", `/api/settings-kit/why/${setting}`);
  // The file carries "read-only"; this Branch starts elsewhere.
  const { savePolicy } = await import("../dist/policy.js");
  savePolicy(app.store, owner, { preset: "read-only" });
  const file = openAgent(exportAgent(app.store, owner, "test").bytes);
  savePolicy(app.store, owner, { preset: "workspace" });
  importAgent(app.store, owner, file, ["permissions"], { writer: "owner-by-command", source: "import", detail: "branch import-agent mine.branch" });
  const imported = await why("policy.preset");
  assert.equal(imported.kind, "recorded", imported.words);
  assert.equal(imported.value, "read-only");
  assert.deepEqual([imported.record.writer, imported.record.source, imported.record.detail],
    ["owner-by-command", "import", "branch import-agent mine.branch"]);
  assert.deepEqual([imported.record.before, imported.record.after], ["workspace", "read-only"]);

  const once = usePreset(app.store, owner, "off", false);
  once.restore();
  assert.equal((await why("policy.preset")).record.id, imported.record.id, "a preset for one task was recorded as a change");
  usePreset(app.store, owner, "ask-before-changes", true, { confirm: true, tools: app.registry }); // Q259: from read-only this loosens, so --confirm
  const kept = await why("policy.preset");
  assert.equal(kept.kind, "recorded", kept.words);
  assert.deepEqual([kept.record.writer, kept.record.source, kept.record.detail], ["owner-by-command", "command", "--save-preset ask-before-changes"]);

  // /switch in the terminal, for a comfort setting that is in Settings.
  const { switchComfort } = await import("../dist/comfort/terminal.js");
  const { value: vim } = await why("comfort-keys.vim");
  switchComfort(app.store, owner, "vim", "", { t: (_key, english) => english });
  const typed = await why("comfort-keys.vim");
  assert.notEqual(typed.value, vim);
  assert.equal(typed.kind, "recorded", typed.words);
  assert.deepEqual([typed.record.writer, typed.record.source, typed.record.detail], ["owner-by-command", "command", "/switch vim"]);
});

test("in a conversation, settings.why says who set a setting and settings.undo puts one change back, never a loosening one", async (t) => {
  const { app, owner, ask, values, preset } = await fixture(t);
  const { settingsHold } = await import("../dist/settings-kit/tools.js");
  const { setLockdown } = await import("../dist/lockdown.js");
  const as = (start = { source: "owner" }) => {
    const run = app.store.createRun(owner, "about a setting");
    app.store.event(run.id, "run.started", start);
    return app.runtime.context({ runId: run.id, source: start.source ?? "owner" });
  };
  const run = (name, args, context = as()) => app.registry.execute(name, args, context);
  assert.equal(settingsHold("settings.why"), null, "asking why is free");
  assert.deepEqual(settingsHold("settings.undo"), { reason: "Branch asks before it undoes a change to its own settings", onceOnly: false });

  const talked = as();
  await run("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }, talked);
  const answer = await run("settings.why", { setting: "fly-core.mode" });
  assert.equal(answer.kind, "recorded");
  assert.equal(answer.record.writer, "conversation");
  assert.equal(answer.record.runId, talked.runId);
  await assert.rejects(run("settings.why", { setting: "secrets.value" }), /not a setting/);
  await assert.rejects(run("settings.undo", { record: answer.record.id }, as({ source: "channel" })), /chat app/);
  assert.deepEqual(await run("settings.undo", { record: answer.record.id }, { ...as(), dryRun: true }), { wouldPutBack: ["What Branch learns from experience, Switch: on → off"] });
  assert.equal((await values())["fly-core.mode"], "on", "a dry run wrote something");

  setLockdown(app.store, owner, { on: true });
  await assert.rejects(run("settings.undo", { record: answer.record.id }), /Lockdown is on/);
  setLockdown(app.store, owner, { on: false });

  const undoing = as();
  const done = await run("settings.undo", { record: answer.record.id }, undoing);
  assert.deepEqual(done.putBack, ["What Branch learns from experience, Switch: on → off"]);
  assert.equal((await values())["fly-core.mode"], "off");
  const undo = (await ask("GET", "/api/settings-kit/history")).records[0];
  assert.deepEqual([undo.id, undo.writer, undo.source, undo.undoes, undo.runId], [done.record, "conversation", "undo", answer.record.id, undoing.runId]);

  // Undoing a preset that made Branch more careful would loosen it again: that is the owner's, at the card.
  const careful = await preset("private");
  const before = await values();
  await assert.rejects(run("settings.undo", { record: careful.record }), /less careful.*Recent changes card/);
  assert.deepEqual(await values(), before, "a refused undo changed something");
});

test("every card that saves a Settings setting around the kit writes a change record naming its card", async (t) => {
  const { root, app, ask } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const cards = [
    ["/api/listen", { where: "private-network" }, "listen-address.where"],
    ["/api/voice/dictation", { mode: "on" }, "live-dictation.mode"],
    ["/api/approval-reviewer", { mode: "on" }, "approval_reviewer.mode"],
    ["/api/learning-core/settings", { mode: "on" }, "fly-core.mode"],
    ["/api/context-files", { files: { soul: "on" } }, "context-files.files.soul"],
    ["/api/vault-autofill/settings", { mode: "on" }, "vault-autofill.mode"],
    ["/api/desktop/settings", { mode: "on" }, "desktop-control.mode"],
    ["/api/developer/pull-requests", { mode: "on" }, "pull-request-hook.mode"],
    ["/api/memory/history", { mode: "on" }, "memory-history.mode"],
    ["/api/channels/permissions", { extras: true }, "chat-permissions.extras"],
    ["/api/loop-guard", { mode: "on" }, "loop_guard.mode"],
    ["/api/folder-trust", { mode: "on" }, "folder_trust_mode.mode"],
    ["/api/keychain/settings", { mode: "on" }, "keychain-entries.mode"],
    ["/api/recordings", { mode: "on" }, "run-recording.mode"],
    ["/api/event-loop", { mode: "on" }, "event-loop-watch.mode"],
    ["/api/usage/limits/settings", { mode: "on" }, "usage-limits.mode"],
    ["/api/media/programs", { mode: "on" }, "media-programs.mode"],
    ["/api/usage/counters", { mode: "on" }, "execution-metrics.mode"],
    ["/api/usage/report/settings", { mode: "on" }, "usage-report.mode"],
    ["/api/move-in/switch", { mode: "on" }, "move-in-switch.mode"],
    ["/api/sdk-kit", { mode: "on" }, "sdk-kit.mode"],
    ["/api/local-models/switch", { mode: "on" }, "local-models.mode"],
    ["/api/local-models/install/switch", { mode: "on" }, "local-runner-install.mode"],
    ["/api/adapt/switch", { mode: "on" }, "adapt.mode"],
    ["/api/prompts/settings", { mode: "on" }, "prompt-library.mode"],
    ["/api/commands/settings", { mode: "on" }, "command-catalog.mode"],
    ["/api/reflection/settings", { reflection: "on" }, "reflection.reflection"],
    ["/api/skill-installs/settings", { mode: "on" }, "skill-installs.mode"],
    ["/api/workspace-editor/settings", { mode: "on" }, "workspace-editor.mode"],
    ["/api/security-check/settings", { audit: "on" }, "security-check.audit"],
    ["/api/goal-undo/settings", { goal: "on" }, "goal-undo.goal"],
    ["/api/voice/engines", { mode: "on" }, "speech-engines.mode"],
    ["/api/rules/add", { tool: "file.read", match: "*", decision: "allow" }, "policy.preset"],
    ["/api/comfort", { card: "keys", values: { vim: true } }, "comfort-keys.vim"],
    ["/api/safety-extras/switch", { part: "command-scan", mode: "on" }, "safety-command-scan.mode"],
    ["/api/flows-boards/switch", { part: "kanban", mode: "on" }, "flowboards-kanban.mode"],
    ["/api/reach/switch", { part: "notes", mode: "on" }, "reach-notes.mode"],
    ["/api/asks/switch", { part: "nodes", mode: "on" }, "asks-nodes.mode"],
  ];
  const wrong = [];
  for (const [path, body, setting] of cards) {
    const before = await ask("GET", `/api/settings-kit/why/${setting}`);
    const answer = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
    if (answer.status !== 200) { wrong.push(`${path}: ${answer.status} ${(await answer.text()).slice(0, 200)}`); continue; }
    const why = await ask("GET", `/api/settings-kit/why/${setting}`);
    const key = setting.slice(0, setting.indexOf("."));
    if (why.value === before.value) wrong.push(`${path}: ${setting} did not move from ${before.value}`);
    else if (why.kind !== "recorded" || why.record.source !== "card" || why.record.writer !== "owner-in-window" || why.record.detail !== key)
      wrong.push(`${path}: ${why.kind} ${why.record?.source ?? ""} ${why.record?.detail ?? ""}: ${why.words}`);
  }
  assert.deepEqual(wrong, []);
});

test("a switch /adapt turns on after the owner's yes is recorded as that yes", async (t) => {
  const { root, app, ask } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
    return answer.json();
  };
  await post("/api/adapt/switch", { mode: "on" });
  await post("/api/adapt/stopped", { what: "Write out the call", nextStep: "write out the call",
    said: "Models on this computer are switched off. Turn them on in Settings." });
  const plan = await post("/api/adapt/plan", {});
  assert.ok(plan.fix?.fingerprint, JSON.stringify(plan));
  await post("/api/adapt/go", { agreed: plan.fix.fingerprint });
  const why = await ask("GET", "/api/settings-kit/why/local-models.mode");
  assert.equal(why.value, "when-needed");
  assert.equal(why.kind, "recorded", why.words);
  assert.deepEqual([why.record.writer, why.record.source, why.record.detail], ["owner-in-window", "card", "adapt"]);
});

test("an undo that was undone again puts its change back, so an older change it covers cannot be undone", async (t) => {
  const { ask, values, refused } = await fixture(t);
  const flip = async (value) => (await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "fly-core", field: "mode", value }, accept: ["fly-core.mode"], confirmLoosening: true })).record;
  const undo = async (id) => (await ask("POST", "/api/settings-kit/undo", { record: id, confirmLoosening: true })).record;
  const x = await flip("on");
  const r1 = await flip("off");
  await undo(await undo(r1)); // U1 undoes R1, U2 undoes U1: R1 is back in force
  const r2 = await flip("on");
  await undo(await undo(r2)); // V1 undoes R2, V2 undoes V1: R2 is back in force
  // The value is what X made it, but only because R2 (redone by V2) made it so: undoing X would undo R2.
  assert.equal((await values())["fly-core.mode"], "on");
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: x, confirmLoosening: true }),
    refused(409, /fly-core[.]mode was changed again later/));
  assert.equal((await values())["fly-core.mode"], "on", "a refused undo changed something");
});

test("an undo asked for while Lockdown is on is refused on the route and writes nothing", async (t) => {
  const { app, owner, ask, values, refused } = await fixture(t);
  const { setLockdown } = await import("../dist/lockdown.js");
  // fly-core is not one of the settings Lockdown itself changes, so only the Lockdown check can refuse this.
  const { record } = await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "fly-core", field: "mode", value: "on" }, accept: ["fly-core.mode"], confirmLoosening: true });
  setLockdown(app.store, owner, { on: true });
  const history = settingsHistory(app.store, owner).length;
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record, confirmLoosening: true }),
    refused(409, /^Lockdown is on, so settings cannot be changed from here[.] Turn it off first[.]$/));
  assert.equal((await values())["fly-core.mode"], "on", "a refused undo changed something");
  assert.equal(settingsHistory(app.store, owner).length, history, "a refused undo left a record");
  setLockdown(app.store, owner, { on: false });
  await ask("POST", "/api/settings-kit/undo", { record, confirmLoosening: true });
  assert.equal((await values())["fly-core.mode"], "off", "once Lockdown is off the same undo goes through");
});

test("a card or kit write of one field keeps the others, and its record compares what was in force", async (t) => {
  const { root, app, owner, ask } = await fixture(t);
  const { saveReviewerSettings, reviewerSettings } = await import("../dist/approval-reviewer.js");
  const { saveReflectionSettings, reflectionSettings } = await import("../dist/reflection/settings.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
    return answer.json();
  };
  const kept = { rules: "Never approve deleting a folder.", preset: "strict", maxTokens: 3000 };
  saveReviewerSettings(app.store, owner, { mode: "off", ...kept });
  await post("/api/approval-reviewer", { mode: "on" });
  assert.deepEqual(reviewerSettings(app.store, owner), { mode: "on", ...kept }, "the card's save reset the fields it was not sent");
  assert.deepEqual(app.store.get("settings", owner, "approval_reviewer").data, { mode: "on", ...kept });
  await ask("POST", "/api/settings-kit/apply", { plan: { source: "set", key: "approval_reviewer", field: "mode", value: "off" },
    accept: ["approval_reviewer.mode"], confirmLoosening: true });
  assert.deepEqual(app.store.get("settings", owner, "approval_reviewer").data, { mode: "off", ...kept }, "the kit's save reset the fields it was not sent");

  saveReflectionSettings(app.store, owner, { reflection: "off", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  await post("/api/reflection/settings", { reflection: "on" });
  assert.deepEqual(reflectionSettings(app.store, owner), { reflection: "on", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });

  // A record the app cannot read runs as its starting values, so the second look is off whatever the
  // record says. Turning it on at its card is a real change, and the record says so: off, then on.
  app.store.save("settings", owner, "approval_reviewer", { mode: "on", rules: "", preset: null, maxTokens: 999_999 });
  const before = settingsHistory(app.store, owner).length;
  await post("/api/approval-reviewer", { mode: "on" });
  const records = settingsHistory(app.store, owner);
  assert.equal(records.length, before + 1, "turning on a second look that was not in force left no record");
  assert.deepEqual(records.at(-1).changes, [{ setting: "approval_reviewer.mode", before: "off", after: "on" }]);
});

test("Lockdown's own changes are recorded, cancel out when it is turned off, and are not undone here", async (t) => {
  const { app, owner, ask, values, refused } = await fixture(t);
  const { setLockdown } = await import("../dist/lockdown.js");
  const { record: x } = await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "policy", field: "preset", value: "workspace" }, accept: ["policy.preset"], confirmLoosening: true });
  setLockdown(app.store, owner, { on: true });
  const on = settingsHistory(app.store, owner).at(-1);
  assert.deepEqual([on.writer, on.source, on.detail], ["owner-in-window", "lockdown", "on"], "turning Lockdown on left no record of its own");
  assert.ok(on.changes.some((entry) => entry.setting === "policy.preset" && entry.before === "workspace" && entry.after === "custom"),
    JSON.stringify(on.changes));
  const why = await ask("GET", "/api/settings-kit/why/policy.preset");
  assert.equal(why.kind, "recorded", why.words);
  assert.match(why.words, /set by Lockdown on /);

  setLockdown(app.store, owner, { on: false }, "owner-by-command");
  const records = settingsHistory(app.store, owner);
  const off = records.at(-1);
  assert.deepEqual([off.writer, off.source, off.detail, off.undoes], ["owner-by-command", "lockdown", "off", on.id]);
  assert.equal(records.find((entry) => entry.id === on.id).undoneBy, off.id);
  assert.equal((await values())["policy.preset"], "workspace");
  for (const id of [on.id, off.id])
    await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: id, confirmLoosening: true }),
      refused(409, /Lockdown made that change/));

  // Turning Lockdown on and off again cancels out, so the change made before it can still be undone.
  await ask("POST", "/api/settings-kit/undo", { record: x, confirmLoosening: true });
  assert.equal((await values())["policy.preset"], "off");
});
