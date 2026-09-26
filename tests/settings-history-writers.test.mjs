/**
 * Q48 review: every way a Settings setting is changed writes a change record, through the one choke
 * point (recordedWrite, or the kit's own applyWithPins). Two guards hold that:
 *
 * 1. Every setting in the catalogue has a writer below that is run for real, or is named as changed
 *    only through the settings kit, with the reason. Each writer is checked the same way: every
 *    catalogue value that moved while it ran must be in the change records it left, before and after.
 * 2. Every file in src/ that saves or deletes a catalogue setting's record is listed here with what
 *    covers it or why it needs no record, so a new writer fails until it is looked at. Keys worked out
 *    some other way than a string, a constant or a small key builder cannot be read by the scan; the
 *    files with such keys are listed too, with what they save.
 *
 * Everything runs on its own data folder; the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { settingsWrites, catalogueKeysOf } from "./settings-writers-scan.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsKitApi } from "../dist/settings-kit/api.js";
import { settingsCatalogue } from "../dist/settings-kit/catalogue.js";
import { settingsHistory } from "../dist/settings-kit/history.js";

const catalogueKeys = settingsCatalogue.map((spec) => spec.key);

/** Settings with no card or command of their own: only the settings kit, which records every change, writes them. */
const kitOnly = {
  "local-runner-place": "no card saves it; its switch lives on the kit's list in Settings only",
};

/** Files that define how settings are saved (through specs) but don't save directly with recordedWrite. */
const specFiles = {
  "src/settings-kit/catalogue.ts": "defines write hooks for specs, which the kit calls and records; no direct save",
};

/** A card's route, the body that moves one setting, and that setting. */
const cards = [
  ["/api/policy", { preset: "read-only" }, "policy.preset"],
  ["/api/approval-reviewer", { mode: "on" }, "approval_reviewer.mode"],
  ["/api/loop-guard", { mode: "on" }, "loop_guard.mode"],
  ["/api/folder-trust", { mode: "on" }, "folder_trust_mode.mode"],
  ["/api/security-check/settings", { audit: "on" }, "security-check.audit"],
  ["/api/os-sandbox", { mode: "on", network: "limited", keySites: {}, unreadable: [] }, "os-sandbox.network"],
  ["/api/desktop/settings", { mode: "on" }, "desktop-control.mode"],
  ["/api/keychain/settings", { mode: "on" }, "keychain-entries.mode"],
  ["/api/vault-autofill/settings", { mode: "on" }, "vault-autofill.mode"],
  ["/api/voice/settings", { autoReadAloud: true }, "voice.autoReadAloud"],
  ["/api/media/programs", { mode: "on" }, "media-programs.mode"],
  ["/api/voice/engines", { mode: "on" }, "speech-engines.mode"],
  ["/api/usage/counters", { mode: "on" }, "execution-metrics.mode"],
  ["/api/usage/limits/settings", { mode: "on" }, "usage-limits.mode"],
  ["/api/listen", { where: "private-network" }, "listen-address.where"],
  ["/api/move-in/switch", { mode: "on" }, "move-in-switch.mode"],
  ["/api/memory/history", { mode: "on" }, "memory-history.mode"],
  ["/api/developer/pull-requests", { mode: "on" }, "pull-request-hook.mode"],
  ["/api/skill-installs/settings", { mode: "on" }, "skill-installs.mode"],
  ["/api/workspace-editor/settings", { mode: "on" }, "workspace-editor.mode"],
  ["/api/channels/permissions", { extras: true }, "chat-permissions.extras"],
  ["/api/voice/wake", { mode: "on" }, "wake-word.mode"],
  ["/api/voice/dictation", { mode: "on" }, "live-dictation.mode"],
  ["/api/sdk-kit", { mode: "on" }, "sdk-kit.mode"],
  ["/api/local-models/switch", { mode: "on" }, "local-models.mode"],
  ["/api/local-models/install/switch", { mode: "on" }, "local-runner-install.mode"],
  ["/api/adapt/switch", { mode: "on" }, "adapt.mode"],
  ["/api/usage/report/settings", { mode: "on" }, "usage-report.mode"],
  ["/api/event-loop", { mode: "on" }, "event-loop-watch.mode"],
  ["/api/recordings", { mode: "on" }, "run-recording.mode"],
  ["/api/prompts/settings", { mode: "on" }, "prompt-library.mode"],
  ["/api/commands/settings", { mode: "on" }, "command-catalog.mode"],
  ["/api/learning-core/settings", { mode: "on" }, "fly-core.mode"],
  ["/api/goal-undo/settings", { goal: "on" }, "goal-undo.goal"],
  ["/api/reflection/settings", { reflection: "on" }, "reflection.reflection"],
  ["/api/context-files", { files: { soul: "on" } }, "context-files.files.soul"],
  ["/api/retention", { enabled: true, keepDays: 30, megabytes: 1, exportBeforeDeleting: true }, "retention.keepDays"],
  ["/api/comfort", { card: "keys", values: { vim: true } }, "comfort-keys.vim"],
  ["/api/comfort", { card: "display", values: { timestamps: true } }, "comfort-display.timestamps"],
  ["/api/comfort", { card: "notify", values: { method: "window", sound: "chime" } }, "comfort-notify.method"],
  ["/api/comfort", { card: "files", values: { respectGitignore: false } }, "comfort-files.respectGitignore"],
  ["/api/comfort", { card: "mcp", values: { startupTimeoutSeconds: 20 } }, "comfort-mcp.startupTimeoutSeconds"],
  ["/api/knobs", { card: "limits", values: { maxModelRounds: 20 } }, "round-limit.maxModelRounds"],
  ["/api/knobs", { card: "limits", reset: true }, "round-limit.maxModelRounds"],
  // The switch families: every part that is a Settings setting, through its family's one route.
  ...catalogueKeys.filter((key) => key.startsWith("reach-")).map((key) => ["/api/reach/switch", { part: key.slice(6), mode: "on" }, `${key}.mode`]),
  ...catalogueKeys.filter((key) => key.startsWith("asks-")).map((key) => ["/api/asks/switch", { part: key.slice(5), mode: "on" }, `${key}.mode`]),
  ...catalogueKeys.filter((key) => key.startsWith("safety-")).map((key) => ["/api/safety-extras/switch", { part: key.slice(7), mode: "on" }, `${key}.mode`]),
  ...catalogueKeys.filter((key) => key.startsWith("flowboards-")).map((key) => ["/api/flows-boards/switch", { part: key.slice(11), mode: "on" }, `${key}.mode`]),
];

/**
 * Every file that saves a catalogue setting's record, and what covers it. "card", "kit" and the
 * rest name writers the runtime guard below runs; an entry with no record says why it needs none.
 */
const savingFiles = {
  "src/adapt/settings.ts": "card /api/adapt/switch",
  "src/approval-reviewer.ts": "card /api/approval-reviewer; the kit",
  "src/asks/settings.ts": "card /api/asks/switch; the kit",
  "src/channels/chat-permissions.ts": "card /api/channels/permissions; the kit",
  "src/comfort/settings.ts": "card /api/comfort; /switch in the terminal; the kit",
  "src/commands/settings.ts": "card /api/commands/settings",
  "src/context-files.ts": "card /api/context-files",
  "src/event-loop-watch.ts": "card /api/event-loop; the kit",
  "src/execution-metrics.ts": "card /api/usage/counters; also notes when the counters were last sent, copying the switch as it is",
  "src/feature-switch-migration.ts": "not recorded: a one-time step at start-up that writes down the voice and screen switches an existing install already ran with",
  "src/flows-boards/settings.ts": "card /api/flows-boards/switch; the kit",
  "src/fly-core/settings.ts": "card /api/learning-core/settings; the kit",
  "src/folder-trust.ts": "card /api/folder-trust; the kit",
  "src/goal-mode.ts": "card /api/goal-undo/settings",
  "src/listen-address.ts": "card /api/listen; the kit",
  "src/local-jobs.ts": "card /api/local-models/switch; /adapt's yes",
  "src/local-one-button.ts": "card /api/local-models/install/switch; /adapt's yes",
  "src/loop-guard.ts": "card /api/loop-guard; the kit",
  "src/media-programs.ts": "card /api/media/programs",
  "src/memory-git.ts": "card /api/memory/history",
  "src/migrate/switch.ts": "card /api/move-in/switch",
  "src/policy.ts": "card /api/policy and the rule routes; /preset; --save-preset; an assistant file; the kit. A remembered answer adds a rule only, which is not a catalogue field; --preset for one task is put back when the task ends",
  "src/pr-hook.ts": "card /api/developer/pull-requests",
  "src/prompt-library.ts": "card /api/prompts/settings",
  "src/reach/settings.ts": "card /api/reach/switch; the kit",
  "src/reflection/settings.ts": "card /api/reflection/settings; the kit",
  "src/retention.ts": "card /api/retention; the kit",
  "src/run-recording.ts": "card /api/recordings",
  "src/safety-extras/settings.ts": "card /api/safety-extras/switch; the kit",
  "src/sandbox.ts": "card /api/os-sandbox; the kit",
  "src/sdk-kit.ts": "card /api/sdk-kit",
  "src/security-audit/settings.ts": "card /api/security-check/settings; the kit",
  "src/skill-installs.ts": "card /api/skill-installs/settings",
  "src/speech-engine-service.ts": "card /api/voice/engines",
  "src/usage-limits.ts": "card /api/usage/limits/settings; the kit",
  "src/usage-report.ts": "card /api/usage/report/settings",
  "src/vault-autofill.ts": "card /api/vault-autofill/settings; the kit",
  "src/vault-sources.ts": "card /api/keychain/settings; the kit",
  "src/voice-dictation.ts": "card /api/voice/dictation; the kit",
  "src/voice-wake.ts": "card /api/voice/wake; the kit",
  "src/voice.ts": "card /api/voice/settings; the kit",
  "src/workspace-editor-api.ts": "card /api/workspace-editor/settings",
};

/** Files whose settings key the scan cannot read, and what they save. */
const unreadKeys = {
  "src/add-ons/export.ts": "one record per add-on folder",
  "src/add-ons/lists.ts": "one record per add-on list address",
  "src/agent-export.ts": "an assistant file's approval rules, including policy: recorded (runtime guard below)",
  "src/restore-held.ts": "rows a restore held for the owner's yes, including policy and chat-permissions: recorded",
  "src/autonomy/orders.ts": "standing orders, one record each",
  "src/autonomy/procedures.ts": "procedures, one record each",
  "src/deferred.ts": "deferred work, one record each",
  "src/delight.ts": "the delight progress record",
  "src/feature-switch-migration.ts": "the ticked screen and Keychain switches at start-up (see above)",
  "src/learning-more/settings.ts": "the learning-more parts, none of them in the catalogue",
  "src/lockdown.ts": "the settings Lockdown takes over, including policy and the screen: recorded (runtime guard below)",
  "src/memory-git.ts": "the memory history's own status record",
  "src/migrate/apply.ts": "what an assistant moved in from brought with it, none of it in the catalogue",
  "src/never-break/resume.ts": "messages waiting to be answered again",
  "src/orchestration-modes.ts": "one record per orchestration hand-off",
  "src/people/groups.ts": "who may do what, per group",
  "src/personal/settings.ts": "the personal connector parts, none of them in the catalogue",
  "src/plugin-catalog.ts": "one record per plugin offer",
  "src/plugins.ts": "one record per plugin",
  "src/profile-roles.ts": "one record per profile",
  "src/prompt-library.ts": "the saved prompts themselves",
  "src/reach/notes.ts": "notes, one record each",
  "src/reflection/new-skills.ts": "skills written from experience, one record each",
  "src/reflection/pass.ts": "looking-back batches, one record each",
  "src/request-cache.ts": "cached answers, one record each",
  "src/settings-kit/changes.ts": "the settings kit itself, which records every change it makes",
  "src/skill-installs.ts": "the log of skills installed from a file",
  "src/skill-packages.ts": "one record per skill package",
  "src/skill-revisions.ts": "one record per skill version",
};

test("every file that saves a Settings setting is listed with what records it, and no listed file is stale", () => {
  const writes = settingsWrites();
  const saving = [...new Set(writes.filter((write) => catalogueKeysOf(write.key, catalogueKeys).length).map((write) => write.file))].sort();
  const savingFiltered = saving.filter((file) => !Object.hasOwn(specFiles, file)).sort();
  assert.deepEqual(savingFiltered, Object.keys(savingFiles).sort(),
    "a file started or stopped saving a Settings setting: record its writes through recordedWrite and list it here");
  const unread = [...new Set(writes.filter((write) => write.key === undefined).map((write) => write.file))].sort();
  const unreadFiltered = unread.filter((file) => !Object.hasOwn(specFiles, file)).sort();
  assert.deepEqual(unreadFiltered, Object.keys(unreadKeys).sort(),
    "a settings key the scan cannot read appeared or went: if it can be a Settings setting, record it and say so here");
});

test("every Settings setting has a writer the guard runs, or is changed only through the kit", () => {
  const covered = new Set(cards.map(([, , setting]) => setting.slice(0, setting.indexOf("."))));
  const missing = catalogueKeys.filter((key) => !covered.has(key) && !Object.hasOwn(kitOnly, key));
  assert.deepEqual(missing, [], "a Settings setting has no writer in this guard");
  for (const key of Object.keys(kitOnly)) assert.ok(catalogueKeys.includes(key), `${key} is not a Settings setting any more`);
});

test("every writer of a Settings setting leaves a change record for each value it moved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-writers-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const deps = { store: app.store, owner, workspace: join(root, "workspace"), appVersion: "test" };
  const values = async () => Object.fromEntries((await settingsKitApi(deps, "GET", "/api/settings-kit", async () => undefined)).settings
    .flatMap((spec) => spec.fields.map((field) => [`${spec.key}.${field.field}`, field.value])));
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
    if (answer.status !== 200) throw new Error(`${answer.status} ${(await answer.text()).slice(0, 200)}`);
    return answer.json();
  };
  const wrong = [];
  /** Runs one writer and checks that everything it moved in the catalogue was recorded as it moved. */
  const check = async (name, setting, run) => {
    const before = await values();
    const kept = settingsHistory(app.store, owner).length;
    try { await run(); } catch (error) { wrong.push(`${name}: ${error.message}`); return; }
    const after = await values();
    const recorded = new Map(settingsHistory(app.store, owner).slice(kept).flatMap((record) => record.changes.map((entry) => [entry.setting, entry])));
    if (setting && after[setting] === before[setting]) wrong.push(`${name}: ${setting} did not move from ${before[setting]}`);
    for (const [field, now] of Object.entries(after)) {
      if (now === before[field]) continue;
      const entry = recorded.get(field);
      if (!entry) wrong.push(`${name}: ${field} moved ${before[field]} → ${now} with no change record`);
      else if (entry.before !== before[field] || entry.after !== now)
        wrong.push(`${name}: ${field} moved ${before[field]} → ${now} but was recorded as ${entry.before} → ${entry.after}`);
    }
  };

  for (const [path, body, setting] of cards) await check(`${path} ${JSON.stringify(body)}`, setting, () => post(path, body));

  // Lockdown, from the window and by a command; turning it off puts back what it changed.
  await check("Lockdown on", "policy.preset", () => post("/api/lockdown", { on: true }));
  await check("Lockdown off", "policy.preset", () => post("/api/lockdown", { on: false }));
  const { setLockdown } = await import("../dist/lockdown.js");
  await check("/lockdown on", "policy.preset", () => setLockdown(app.store, owner, { on: true }, "owner-by-command"));
  await check("/lockdown off", "policy.preset", () => setLockdown(app.store, owner, { on: false }, "owner-by-command"));

  // An assistant file's approval rules, typed commands, and a remembered answer.
  const { savePolicy, addPolicyRule } = await import("../dist/policy.js");
  const { exportAgent, openAgent, importAgent } = await import("../dist/agent-export.js");
  const { choosePreset } = await import("../dist/terminal-commands.js");
  const { usePreset } = await import("../dist/cli-run.js");
  const { switchComfort } = await import("../dist/comfort/terminal.js");
  await check("/preset workspace", "policy.preset", () => choosePreset(app.runtime, "workspace confirm")); // Q258: workspace loosens, so the typed yes
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  const file = openAgent(exportAgent(app.store, owner, "test").bytes);
  await check("/preset workspace again", "policy.preset", () => choosePreset(app.runtime, "workspace confirm")); // Q258: workspace loosens, so the typed yes
  await check("an assistant file's approval rules", "policy.preset", () => importAgent(app.store, owner, file, ["permissions"]));
  await check("--save-preset", "policy.preset", () => usePreset(app.store, owner, "read-only", true, { tools: app.registry })); // Q259: weighed on the tools, as branch run does
  await check("--preset for one task, put back after", null, () => usePreset(app.store, owner, "off", false).restore());
  await check("a remembered answer", null, () => addPolicyRule(app.store, owner, { tool: "file.read", match: "*", decision: "allow" }));
  await check("/switch vim", "comfort-keys.vim", () => switchComfort(app.store, owner, "vim", "", { t: (_key, english) => english }));
  await check("a folder's own trust", null, () => post("/api/folder-trust", { folder: "", decision: "trust" }));

  // A path made from a conversation (src/conversation-paths-api.ts) copies that conversation's own choices. None of
  // them is in the catalogue, so check() holds it to moving nothing there unrecorded; the copies themselves still land.
  const parent = app.store.createRun(owner, "a conversation to branch").sessionId;
  app.store.message(parent, { role: "user", content: "a question" });
  app.runtime.models.configureSession(owner, parent, { reasoning: "high" });
  app.store.save("settings", owner, `pinned-skill:${parent}`, { skillId: "a-skill" });
  const point = app.store.sessionView(owner, parent).messages.find((message) => message.role === "user");
  let path;
  await check("a path from a conversation", null, async () => {
    path = await post(`/api/sessions/${parent}/branch`, { messageId: point.messageId, name: "Try 2" });
  });
  assert.ok(path?.sessionId, "the path was made");
  assert.equal(app.runtime.models.session(owner, path.sessionId).reasoning, "high", "the conversation's model choice came along");
  assert.deepEqual(app.store.get("settings", owner, `pinned-skill:${path.sessionId}`)?.data, { skillId: "a-skill" }, "and its pinned skill");

  // And the kit itself, which writes its own record, for the settings only it changes.
  for (const key of Object.keys(kitOnly)) {
    const spec = settingsCatalogue.find((entry) => entry.key === key);
    for (const field of spec.fields) {
      const value = field.kind.type === "yes-no" ? !field.initial : field.kind.type === "switch" ? "on" : undefined;
      await check(`the kit, ${key}.${field.field}`, `${key}.${field.field}`, () => settingsKitApi(deps, "POST", "/api/settings-kit/apply", async () => ({
        plan: { source: "set", key, field: field.field, value }, accept: [`${key}.${field.field}`], confirmLoosening: true })));
    }
  }
  assert.deepEqual(wrong, []);
});
