import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { settingsCatalogue, specFor } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor, currentValue } from "../dist/settings-kit/changes.js";
import { settingsKitWriters } from "../dist/settings-kit/writers.js";
import { startServer } from "../dist/server.js";
import { setLockdown } from "../dist/lockdown.js";
import { readPolicy } from "../dist/policy.js";
import { reviewerSettings } from "../dist/approval-reviewer.js";
import { loopGuardMode } from "../dist/loop-guard.js";
import { folderTrustMode } from "../dist/folder-trust.js";
import { securityCheckSettings } from "../dist/security-audit/settings.js";
import { wallSettings } from "../dist/sandbox.js";
import { safetyMode } from "../dist/safety-extras/settings.js";
import { boardMode } from "../dist/flows-boards/settings.js";
import { reachMode, savedReachMode } from "../dist/reach/settings.js";
import { askMode } from "../dist/asks/settings.js";
import { readDesktopSettings } from "../dist/integrations/desktop-config.js";
import { readKeychainSettings } from "../dist/vault-sources.js";
import { readVaultAutofillSettings } from "../dist/vault-autofill.js";
import { mediaProgramsSettings } from "../dist/media-programs.js";
import { speechEngineSettings } from "../dist/speech-engines.js";
import { executionMetricsSettings } from "../dist/execution-metrics.js";
import { usageLimitsSettings } from "../dist/usage-limits.js";
import { listenSettings } from "../dist/listen-address.js";
import { moveInMode } from "../dist/migrate/switch.js";
import { memoryHistorySettings } from "../dist/memory-git.js";
import { pullRequestHookSettings } from "../dist/pr-hook.js";
import { skillInstallMode } from "../dist/skill-installs.js";
import { workspaceEditorSettings } from "../dist/workspace-editor-api.js";
import { readChatPermissionSettings } from "../dist/channels/chat-permissions.js";
import { wakeWordSettings } from "../dist/voice-wake.js";
import { dictationSettings } from "../dist/voice-dictation.js";
import { localModelsMode } from "../dist/local-jobs.js";
import { usageReportSettings } from "../dist/usage-report.js";
import { eventLoopSettings } from "../dist/event-loop-watch.js";
import { recordingSettings } from "../dist/run-recording.js";
import { promptLibrarySettings } from "../dist/prompt-library.js";
import { windowCommands } from "../dist/commands/settings.js";
import { flyCoreSettings } from "../dist/fly-core/settings.js";
import { goalUndoSettings } from "../dist/goal-mode.js";
import { reflectionSettings } from "../dist/reflection/settings.js";
import { contextFileSettings } from "../dist/context-files.js";
import { retentionSettings } from "../dist/retention.js";
import { readComfort } from "../dist/comfort/settings.js";
import { voiceSettings } from "../dist/voice.js";
import { saveReviewerSettings } from "../dist/approval-reviewer.js";
import { saveReflectionSettings } from "../dist/reflection/settings.js";
import { readKnobs } from "../dist/knobs/settings.js";
import { systemVoiceShipsAs } from "../dist/feature-switches.js";

/*
 * Q65: the settings kit reads and writes every setting through the app's own parse. A record the app would
 * not accept is shown as what the app really runs, and a change made from the kit cannot bring an ignored
 * field or mode back to life.
 */

const mode = (reader) => (store, owner) => ({ mode: reader(store, owner) });
const part = (reader, name) => mode((store, owner) => reader(store, owner, name));

/** Every catalogue setting whose module reads it through a strict schema, and that module's own reader. */
const strictReaders = {
  policy: readPolicy,
  approval_reviewer: reviewerSettings,
  loop_guard: mode(loopGuardMode),
  folder_trust_mode: mode(folderTrustMode),
  "security-check": securityCheckSettings,
  "os-sandbox": wallSettings,
  "desktop-control": readDesktopSettings,
  "keychain-entries": readKeychainSettings,
  "vault-autofill": readVaultAutofillSettings,
  "media-programs": mediaProgramsSettings,
  "speech-engines": speechEngineSettings,
  "execution-metrics": executionMetricsSettings,
  "usage-limits": usageLimitsSettings,
  "listen-address": listenSettings,
  "move-in-switch": mode(moveInMode),
  "memory-history": memoryHistorySettings,
  "pull-request-hook": pullRequestHookSettings,
  "skill-installs": mode((store, owner) => skillInstallMode({ store, runtime: { owner } })),
  "workspace-editor": workspaceEditorSettings,
  "chat-permissions": readChatPermissionSettings,
  "wake-word": wakeWordSettings,
  "live-dictation": dictationSettings,
  "local-models": mode(localModelsMode),
  "usage-report": usageReportSettings,
  "event-loop-watch": eventLoopSettings,
  "run-recording": recordingSettings,
  "prompt-library": promptLibrarySettings,
  "command-catalog": windowCommands, // Settings › General's switch is this computer's window's (batch A)
  "fly-core": flyCoreSettings,
  "goal-undo": goalUndoSettings,
  reflection: reflectionSettings,
  "context-files": contextFileSettings,
  retention: retentionSettings,
  "round-limit": (store, owner) => readKnobs(store, owner, "limits"),
  "task-tokens": (store, owner) => ({ taskAllowance: readKnobs(store, owner, "limits").maxTaskTokens }), // selfdev: the limits card
  "step-limit": (store, owner) => ({ maxSteps: readKnobs(store, owner, "limits").maxSteps }), // the limits card too
  ...Object.fromEntries(["command-scan", "progress-judge", "activity-chain", "tool-scripts", "wasm-add-ons", "history-repair"]
    .map((name) => [`safety-${name}`, part(safetyMode, name)])),
  ...Object.fromEntries(["recipe-checks", "widgets", "install-requests", "time-travel", "kanban", "waiting-line", "focus"]
    .map((name) => [`flowboards-${name}`, part(boardMode, name)])),
  ...Object.fromEntries(["machines", "remote-trunks", "background-screen", "video", "relay", "send", "platform-pause",
    "agent-git", "skill-bundles", "usb", "notes", "arena"].map((name) => [`reach-${name}`, part(savedReachMode, name)])),
  ...Object.fromEntries(["analytics", "answer-engine", "runtimes", "nodes", "project-board"]
    .map((name) => [`asks-${name}`, part(askMode, name)])),
  ...Object.fromEntries(["keys", "display", "notify", "files", "mcp"]
    .map((card) => [`comfort-${card}`, (store, owner) => readComfort(store, owner, card)])),
};

/**
 * Strict settings whose module stops on a record it cannot read rather than starting again from its first
 * values. The kit shows the starting values and refuses a change, so nothing in the record comes back.
 */
const refusingReaders = { voice: voiceSettings };

/** The settings whose module does not throw a whole record away, so the kit's own field-by-field reading already matches it. */
const notStrict = {
  "sdk-kit": "read field by field (src/sdk-kit.ts, sdkKitMode)",
  "gitlab-connection": "read field by field (src/gitlab-switch.ts, gitlabMode)",
  "local-runner-install": "a loose record, read field by field (src/local-one-button.ts)",
  "local-runner-place": "a loose record, read field by field (src/local-one-button.ts)",
  adapt: "a loose record, read field by field (src/adapt/settings.ts)",
};

/** Records that do not refuse an unknown field are made unreadable another way. */
const unreadableExtra = { "local-models": { enabled: "yes" } };

/** Settings kept inside another record than their own key: the round limit is a field of the owner's limits knob. */
const recordKeys = { "round-limit": "knobs-limits", "step-limit": "knobs-limits", "task-tokens": "knobs-limits" };
const recordOf = (spec) => recordKeys[spec.key] ?? spec.key;
/** Fields kept under another name in their record: Settings › General's commands switch is the record's `window`
    (this computer's window alone; `mode` is the switch for every surface, src/commands/settings.ts). */
const savedAs = { "command-catalog": { mode: "window" }, "task-tokens": { taskAllowance: "maxTaskTokens" } };
const savedPath = (spec, field) => savedAs[spec.key]?.[field.field] ?? field.field;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-kit-parse-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store, owner: app.runtime.owner };
}

const readPath = (data, field) => field.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), data);
function setPath(data, field, value) {
  const [head, ...rest] = field.split(".");
  return { ...data, [head]: rest.length ? setPath(data[head] ?? {}, rest.join("."), value) : value };
}

/** A value the field can hold that is not `from` (its starting value unless said): the less careful end, where there is one. */
function raised(field, from = field.initial) {
  const kind = field.kind;
  if (kind.type === "switch") return ["on", "when-needed", "off"].find((position) => position !== from);
  if (kind.type === "yes-no") return !from;
  if (kind.type === "choice") return [...kind.options].reverse().find((option) => option !== from);
  return from === kind.max ? kind.min : kind.max;
}

/**
 * A record the app would not accept. With several fields, the first holds the wrong kind of value and the
 * others are raised, so a raw write of the first would make the record readable and bring the others back.
 * With one field, it is raised and the record carries something the schema refuses.
 */
function unreadable(spec) {
  const [first, ...others] = spec.fields;
  if (!others.length) return { ...setPath({}, first.field, raised(first)), ...(unreadableExtra[spec.key] ?? { q65Unknown: 1 }) };
  return others.reduce((data, field) => setPath(data, field.field, raised(field)), setPath({}, first.field, { wrong: "kind" }));
}

const inForce = (reader, store, owner, field) => readPath(reader(store, owner), field.field) ?? field.initial;
const strictSpecs = () => settingsCatalogue.filter((spec) => strictReaders[spec.key]);

test("every catalogue setting is either read through its module's strict reader or named as read field by field", async (t) => {
  const { app } = await fixture(t);
  const writers = settingsKitWriters(app);
  for (const spec of settingsCatalogue)
    assert.ok(strictReaders[spec.key] || refusingReaders[spec.key] || notStrict[spec.key], `${spec.key}: say which reader the app uses, and whether it is strict`);
  for (const key of [...Object.keys(strictReaders), ...Object.keys(refusingReaders)]) {
    const spec = specFor(key);
    assert.ok(spec, `${key} is in the catalogue`);
    assert.equal(typeof spec.read, "function", `${key}: a strict setting must be read through its module (a read hook)`);
    assert.ok(typeof spec.write === "function" || writers[key], `${key}: a strict setting must be written through its module, not merged raw`);
  }
});

test("an unreadable record shows what the app has in force, not what lies in the record", async (t) => {
  const { store, owner } = await fixture(t);
  for (const spec of strictSpecs()) {
    store.save("settings", owner, recordOf(spec), unreadable(spec));
    for (const field of spec.fields)
      assert.deepEqual(currentValue(store, owner, spec, field), inForce(strictReaders[spec.key], store, owner, field),
        `${spec.key}.${field.field} should show what the app reads`);
  }
});

test("a kit write of one field cannot bring back another field or mode the app was ignoring", async (t) => {
  const { app, store, owner } = await fixture(t);
  const writers = settingsKitWriters(app);
  for (const spec of strictSpecs()) {
    const reader = strictReaders[spec.key];
    store.save("settings", owner, recordOf(spec), unreadable(spec));
    const before = Object.fromEntries(spec.fields.map((field) => [field.field, inForce(reader, store, owner, field)]));
    const [first, ...others] = spec.fields;
    // Moved away from what is in force (the wall reads a damaged record as "on", not as where it starts).
    const to = raised(first, before[first.field]);
    const { changes } = changesFor(store, owner, [{ key: spec.key, field: first.field, value: to }]);
    applyChanges(store, owner, changes, { accept: changes.map((change) => change.id), confirmLoosening: true, why: "test", writers });
    const raw = store.get("settings", owner, recordOf(spec))?.data ?? {};
    assert.deepEqual(inForce(reader, store, owner, first), to, `${spec.key}.${first.field}: the change is in force`);
    assert.deepEqual(readPath(raw, savedPath(spec, first)), to, `${spec.key}.${first.field}: the change is what is saved`);
    for (const field of others) {
      const ignored = readPath(unreadable(spec), field.field);
      assert.notDeepEqual(inForce(reader, store, owner, field), ignored, `${spec.key}.${field.field}: the ignored value does not come back`);
      // The ship-on rule (src/ship-on.ts savedFields): a field shown off over an unreadable record is written down off and
      // stays off, even one that ships on: the change list never showed it moving.
      assert.deepEqual(inForce(reader, store, owner, field), before[field.field], `${spec.key}.${field.field}: an ignored value stays ignored`);
      assert.deepEqual(readPath(raw, savedPath(spec, field)) ?? field.initial, before[field.field], `${spec.key}.${field.field}: the saved record agrees with the app`);
    }
  }
});

test("while Lockdown is on, the kit shows the owner's own saved switch, not Lockdown's view of it", async (t) => {
  const { store, owner } = await fixture(t);
  store.save("settings", owner, "reach-machines", { mode: "on" });
  store.save("settings", owner, "listen-address", { where: "private-network" });
  store.save("settings", owner, "wake-word", { mode: "on" });
  setLockdown(store, owner, { on: true });
  // Lockdown really is on: the app itself reads each as off while it lasts.
  assert.equal(reachMode(store, owner, "machines"), "off");
  assert.equal(listenSettings(store, owner).where, "this-computer");
  assert.equal(wakeWordSettings(store, owner).mode, "off");
  const shown = (key, field) => currentValue(store, owner, specFor(key), specFor(key).fields.find((entry) => entry.field === field));
  assert.equal(shown("reach-machines", "mode"), "on");
  assert.equal(shown("listen-address", "where"), "private-network");
  assert.equal(shown("wake-word", "mode"), "on");
});

const all = (changes) => ({ accept: changes.map((change) => change.id), confirmLoosening: true, why: "test" });
const voiceField = (field) => specFor("voice").fields.find((entry) => entry.field === field);
const brokenVoice = { systemVoice: "on", autoReadAloud: "yes", keepAudioOnThisComputer: true, replyWithVoiceOnChannels: true };

test("voice: an unreadable record shows the starting values, and reading it does not stop the kit", async (t) => {
  const { store, owner } = await fixture(t);
  store.save("settings", owner, "voice", brokenVoice);
  assert.throws(() => voiceSettings(store, owner), "the app itself cannot read this record");
  for (const field of specFor("voice").fields)
    assert.equal(currentValue(store, owner, specFor("voice"), field), field.initial, `voice.${field.field} shows its starting value`);
});

test("voice: a kit write to an unreadable record is refused, and the record is left exactly as it was", async (t) => {
  const { app, store, owner } = await fixture(t);
  store.save("settings", owner, "voice", brokenVoice);
  // Refused when the changes are worked out, before anything is written, with the way out named.
  const { changes, refused } = changesFor(store, owner, [{ key: "voice", field: "autoReadAloud", value: true }]);
  assert.equal(changes.length, 0);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /^voice\.autoReadAloud: The voice settings saved on this computer cannot be read/);
  assert.match(refused[0], /Put voice settings back as shipped/);
  // The write itself is the last lock: reached another way, it still refuses rather than repairing the record.
  assert.throws(() => specFor("voice").write(store, owner, { autoReadAloud: true }), /cannot be read/);
  assert.deepEqual(store.get("settings", owner, "voice").data, brokenVoice);
  // A readable record is still changed through the voice card's own save.
  store.save("settings", owner, "voice", {});
  const again = changesFor(store, owner, [{ key: "voice", field: "autoReadAloud", value: true }]).changes;
  applyChanges(store, owner, again, all(again));
  assert.equal(voiceSettings(store, owner).autoReadAloud, true);
  assert.equal(currentValue(store, owner, specFor("voice"), voiceField("autoReadAloud")), true);
});

test("a kit write of one field keeps every other field of a readable record, catalogued or not", async (t) => {
  const { app, store, owner } = await fixture(t);
  const writers = settingsKitWriters(app);
  // The fields the kit does not show, saved through each card's own save so any copy kept in memory agrees.
  saveReviewerSettings(store, owner, { mode: "off", rules: "x", preset: "strict", maxTokens: 3000 });
  saveReflectionSettings(store, owner, { reflection: "off", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  const write = (key, field, value) => {
    const { changes } = changesFor(store, owner, [{ key, field, value }]);
    applyChanges(store, owner, changes, { ...all(changes), writers });
  };
  write("approval_reviewer", "mode", "on");
  assert.deepEqual(reviewerSettings(store, owner), { mode: "on", rules: "x", preset: "strict", maxTokens: 3000 });
  assert.deepEqual(store.get("settings", owner, "approval_reviewer").data, { mode: "on", rules: "x", preset: "strict", maxTokens: 3000 });
  write("reflection", "reflection", "on");
  assert.deepEqual(reflectionSettings(store, owner), { reflection: "on", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  assert.deepEqual(store.get("settings", owner, "reflection").data, { reflection: "on", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  // Every strict setting with more than one field: the others, raised away from where they start, stay put.
  const readers = { ...strictReaders, voice: voiceSettings };
  for (const spec of settingsCatalogue.filter((entry) => readers[entry.key] && entry.fields.length > 1)) {
    const reader = readers[spec.key];
    store.save("settings", owner, recordOf(spec), spec.fields.reduce((data, field) => setPath(data, field.field, raised(field)), {}));
    const before = Object.fromEntries(spec.fields.map((field) => [field.field, inForce(reader, store, owner, field)]));
    const [first, ...others] = spec.fields;
    write(spec.key, first.field, raised(first, before[first.field]));
    for (const field of others)
      assert.deepEqual(inForce(reader, store, owner, field), before[field.field], `${spec.key}.${field.field}: kept when ${first.field} was written`);
  }
});

/** The window, over a real server, as the owner. */
async function serve(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (path, body) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-kit-parse-http-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store, owner: app.runtime.owner, call: await serve(t, app, root) };
}
const kitAudits = (store, owner, why) => store.audit.list(owner, { limit: 500 })
  .filter((row) => row.action === "policy.changed" && row.subject.endsWith(`settings changed (${why})`));

test("a preset with an unreadable voice record makes every other change, writes it down once, and lists voice as refused", async (t) => {
  const { store, owner, call } = await served(t);
  store.save("settings", owner, "voice", brokenVoice);
  const plan = { source: "preset", preset: "private" };
  const preview = await call("/api/settings-kit/preview", plan);
  assert.ok(preview.body.refused.some((line) => line.startsWith("voice.keepAudioOnThisComputer: The voice settings")), JSON.stringify(preview.body.refused));
  assert.ok(!preview.body.changes.some((change) => change.key === "voice"));
  const accept = preview.body.changes.map((change) => change.id);
  const applied = await call("/api/settings-kit/apply", { plan, accept, confirmLoosening: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.applied.map((change) => change.id).sort(), [...accept].sort());
  assert.ok(applied.body.refused.some((line) => line.startsWith("voice.keepAudioOnThisComputer:")));
  // Before the fix: folder trust and the wall were written, local models were not, and nothing was written down.
  assert.equal(folderTrustMode(store, owner), "on");
  assert.equal(wallSettings(store, owner).mode, "on");
  assert.equal(localModelsMode(store, owner), "on");
  assert.equal(kitAudits(store, owner, "preset: Private and local").length, 1);
  assert.deepEqual(store.get("settings", owner, "voice").data, brokenVoice, "the unreadable record is left alone");
});

test("put-back: a loosening change asks for confirmLoosening and is refused without it", async (t) => {
  const { store, owner, call } = await served(t);
  // Unreadable voice record with keepAudioOnThisComputer:true (a guard field turned "up")
  const unreadableWithGuardUp = { systemVoice: "on", autoReadAloud: "yes", keepAudioOnThisComputer: true, replyWithVoiceOnChannels: true };
  store.save("settings", owner, "voice", unreadableWithGuardUp);
  // Put-back without confirmLoosening: should be refused because keeping audio is a protection (guard)
  const withoutConfirm = await call("/api/settings-kit/put-back", { key: "voice" });
  assert.equal(withoutConfirm.status, 409, `Expected 409 but got ${withoutConfirm.status}: ${JSON.stringify(withoutConfirm.body)}`);
  const errorMsg = withoutConfirm.body.error || withoutConfirm.body.message || String(withoutConfirm.body);
  assert.match(errorMsg, /less careful/i);
  // Record should not change
  assert.deepEqual(store.get("settings", owner, "voice").data, unreadableWithGuardUp);
  // Put-back with confirmLoosening: should succeed
  const withConfirm = await call("/api/settings-kit/put-back", { key: "voice", confirmLoosening: true });
  assert.equal(withConfirm.status, 200, JSON.stringify(withConfirm.body));
  assert.deepEqual(voiceSettings(store, owner), { ...(await import("../dist/voice.js")).VoiceSettingsSchema.parse({}), systemVoice: systemVoiceShipsAs });
});

test("the way out: an unreadable voice record is put back as shipped, then voice reads and its own card saves again", async (t) => {
  const { store, owner, call } = await served(t);
  store.save("settings", owner, "voice", brokenVoice);
  assert.equal((await call("/api/voice/settings", { autoReadAloud: true })).status >= 400, true, "the voice card cannot save onto it either");
  const before = (await call("/api/settings-kit")).body.settings.find((spec) => spec.key === "voice");
  assert.match(before.refused, /Put voice settings back as shipped/);
  assert.equal(before.canPutBack, true);
  assert.equal((await call("/api/settings-kit/put-back", { key: "loop_guard" })).status, 404, "only a setting with a way back");
  // brokenVoice has keepAudioOnThisComputer:true, which is looser than the shipped false, so confirmLoosening is required
  const back = await call("/api/settings-kit/put-back", { key: "voice", confirmLoosening: true });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.overview.settings.find((spec) => spec.key === "voice").refused, null);
  assert.deepEqual(voiceSettings(store, owner), { ...(await import("../dist/voice.js")).VoiceSettingsSchema.parse({}), systemVoice: systemVoiceShipsAs });
  assert.ok(store.audit.list(owner, { limit: 100 }).some((row) => row.subject === "Voice: put back as shipped"));
  const saved = await call("/api/voice/settings", { autoReadAloud: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(voiceSettings(store, owner).autoReadAloud, true);
  // Not on a record that reads fine: a stale button in another window must not wipe what the owner set and pinned.
  const kept = { ...voiceSettings(store, owner), keepAudioOnThisComputer: true };
  store.save("settings", owner, "voice", kept);
  const stale = await call("/api/settings-kit/put-back", { key: "voice" });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.deepEqual(store.get("settings", owner, "voice").data, kept, "a readable record is left as the owner set it");
  // Not while Lockdown holds the settings.
  store.save("settings", owner, "voice", brokenVoice);
  setLockdown(store, owner, { on: true });
  assert.equal((await call("/api/settings-kit/put-back", { key: "voice", confirmLoosening: true })).status, 409);
  assert.deepEqual(store.get("settings", owner, "voice").data, brokenVoice);
});

test("settings.change and settings.loosen are refused while Lockdown is on, as the window is", async (t) => {
  const { app, store, owner } = await fixture(t);
  const as = () => {
    const run = store.createRun(owner, "change a setting");
    store.event(run.id, "run.started", { source: "owner" });
    return app.runtime.context({ runId: run.id, source: "owner" });
  };
  setLockdown(store, owner, { on: true });
  const desktopBefore = store.get("settings", owner, "desktop-control")?.data;
  await assert.rejects(app.registry.execute("settings.loosen", { changes: [{ setting: "desktop-control.mode", value: "on" }] }, as()), /Lockdown is on/);
  // A change that only tightens (a second look, which ships off; the loop guard already ships on) is refused too.
  await assert.rejects(app.registry.execute("settings.change", { changes: [{ setting: "approval_reviewer.mode", value: "on" }] }, as()), /Lockdown is on/);
  assert.deepEqual(store.get("settings", owner, "desktop-control")?.data, desktopBefore);
  assert.equal(reviewerSettings(store, owner).mode, "off");
  setLockdown(store, owner, { on: false });
  await app.registry.execute("settings.change", { changes: [{ setting: "approval_reviewer.mode", value: "on" }] }, as());
  assert.equal(reviewerSettings(store, owner).mode, "on");
});

test("put-back: a guarding field whose saved value cannot be read counts as less careful, so it asks", async (t) => {
  const { store, owner, call } = await served(t);
  // "yes" is not a value the switch can hold: the voice module fails closed on it, as if audio were kept.
  const garbled = { systemVoice: "on", keepAudioOnThisComputer: "yes" };
  store.save("settings", owner, "voice", garbled);
  const refused = await call("/api/settings-kit/put-back", { key: "voice" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /less careful/, "refused as loosening, not as a record that reads fine");
  assert.deepEqual(store.get("settings", owner, "voice").data, garbled, "nothing was put back");
  assert.equal((await call("/api/settings-kit/put-back", { key: "voice", confirmLoosening: true })).status, 200);
});


test("put-back always asks for a record it cannot read, whatever it holds, and puts back as shipped with the yes", async (t) => {
  const { store, owner, call } = await served(t);
  const { VoiceSettingsSchema } = await import("../dist/voice.js");
  const careful = { systemVoice: "on", keepAudioOnThisComputer: true };
  let deep = { keepAudioOnThisComputer: true };
  for (let level = 0; level < 12; level++) deep = { inner: deep };
  const records = [
    { systemVoice: "bogus" }, // unreadable, and nothing careful in sight: still asks, the record cannot vouch for itself
    { systemVoice: "invalid", autoReadAloud: "maybe", keepAudioOnThisComputer: false, replyWithVoiceOnChannels: false },
    JSON.stringify(careful), [careful], 1, true, false, 0, "",
    { __proto__: null, ["__proto__"]: careful }, { constructor: { prototype: careful } }, { voice: careful },
    { systemVoice: careful }, { systemVoice: JSON.stringify(careful) }, { systemVoice: { KeepAudioOnThisComputer: true } },
    { autoReadAloud: { keep_audio_on_this_computer: true } }, { systemVoice: deep },
  ];
  for (const record of records) {
    const saved = JSON.parse(JSON.stringify(record));
    store.save("settings", owner, "voice", saved);
    const asked = await call("/api/settings-kit/put-back", { key: "voice" });
    assert.equal(asked.status, 409, `${JSON.stringify(saved).slice(0, 80)}: ${JSON.stringify(asked.body)}`);
    // The ship-on rule: put-back moves the computer's own voice (a reach switch) from off to when needed, so it is named too.
    assert.match(asked.body.error, /less careful \(Your computer's own voice, Keep audio on this computer[,)]/, "the ask names the guard put-back turns off");
    assert.deepEqual(store.get("settings", owner, "voice").data, saved, "nothing written without the yes");
    const back = await call("/api/settings-kit/put-back", { key: "voice", confirmLoosening: true });
    if (back.status === 200) assert.deepEqual(voiceSettings(store, owner), { ...VoiceSettingsSchema.parse({}), systemVoice: systemVoiceShipsAs });
    else assert.match(JSON.stringify(back.body), /reads as it should/, `${JSON.stringify(saved).slice(0, 80)}: a record voice reads is not put back`);
  }
});

test("Q99: put-back asks when a saved value the kit does not weigh differs from shipped; an unknown key is not one of those values", async (t) => {
  const { store, owner, call } = await served(t);
  const { VoiceSettingsSchema } = await import("../dist/voice.js");
  // Unreadable (systemVoice), every weighed field as shipped or more careful, but a spending cap and the speech route set.
  const record = { systemVoice: "bogus", liveMaxDollars: 0.2, liveMaxMinutes: 2, sttRoute: "local" };
  store.save("settings", owner, "voice", record);
  const refused = await call("/api/settings-kit/put-back", { key: "voice" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /liveMaxDollars/);
  assert.deepEqual(store.get("settings", owner, "voice").data, record, "nothing written without the yes");
  assert.equal((await call("/api/settings-kit/put-back", { key: "voice", confirmLoosening: true })).status, 200);
  assert.deepEqual(voiceSettings(store, owner), { ...VoiceSettingsSchema.parse({}), systemVoice: systemVoiceShipsAs });
  // A key the voice record does not have is not one of the values weighed here (Q83 asks for it instead,
  // because a guard may have gone there): the refusal names the guard, not "other saved values".
  store.save("settings", owner, "voice", { systemVoice: "bogus", somethingElse: 5 });
  const stray = await call("/api/settings-kit/put-back", { key: "voice" });
  assert.equal(stray.status, 409, JSON.stringify(stray.body));
  assert.doesNotMatch(stray.body.error, /other saved values/);
  // Every unweighed value as shipped: none is named, only the guard.
  store.save("settings", owner, "voice", { ...VoiceSettingsSchema.parse({}), systemVoice: "bogus" });
  const same = await call("/api/settings-kit/put-back", { key: "voice" });
  assert.equal(same.status, 409, JSON.stringify(same.body));
  assert.doesNotMatch(same.body.error, /other saved values/, "a value as shipped is not named");
});
