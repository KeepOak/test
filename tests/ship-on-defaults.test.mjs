/**
 * The owner's ship-on rule (2026-09-26): every feature ships on unless it (a) spends money, (b) sends something out
 * of this computer on its own, (c) deletes something, (d) uses the microphone or camera, (e) uses heavy CPU or disk,
 * or (f) loosens approvals or safety. For a three-way switch "when needed" is the ship-on position: the feature works
 * and its tools load when the work calls for them.
 *
 * Four things are held here, for every flipped feature:
 *   - a fresh install has it on;
 *   - an explicit off the owner chose survives;
 *   - an "off" written as the old default into a record that also holds other fields reads as on (src/ship-on.ts);
 *   - every (a)–(f) feature is still off on a fresh install.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { boardMode, saveBoardMode } from "../dist/flows-boards/settings.js";
import { learningMode, saveLearningMode } from "../dist/learning-more/settings.js";
import { safetyMode, saveSafetyMode } from "../dist/safety-extras/settings.js";
import { learnMode, saveLearnSettings } from "../dist/learn/settings.js";
import { addOnMode, saveAddOnSettings } from "../dist/add-ons/settings.js";
import { autonomyMode, saveAutonomyMode } from "../dist/autonomy/settings.js";
import { askMode, saveAskMode } from "../dist/asks/settings.js";
import { interopMode } from "../dist/interop/settings.js";
import { savedReachMode } from "../dist/reach/settings.js";
import { codingMode, saveCodingMode } from "../dist/coding/settings.js";
import { trunkMode } from "../dist/trunks/settings.js";
import { promptLibrarySettings, savePromptLibrarySettings } from "../dist/prompt-library.js";
import { recordingSettings, saveRecordingSettings } from "../dist/run-recording.js";
import { eventLoopSettings, saveEventLoopSettings } from "../dist/event-loop-watch.js";
import { loopGuardMode, saveLoopGuardSettings } from "../dist/loop-guard.js";
import { readComfort, saveComfort } from "../dist/comfort/settings.js";
import { goalUndoSettings, saveGoalUndoSettings } from "../dist/goal-mode.js";
import { voiceSettings, saveVoiceSettings } from "../dist/voice.js";
import { chatLiveSwitches, saveChatLiveSwitches } from "../dist/channels/chat-live-settings.js";
import { terminalSwitches, saveTerminalSwitch } from "../dist/terminal-theme.js";
import { contextFileSettings, saveContextFileSettings, switchFor } from "../dist/context-files.js";
import { reflectionSettings, saveReflectionSettings } from "../dist/reflection/settings.js";
import { securityCheckSettings, saveSecurityCheckSettings } from "../dist/security-audit/settings.js";
import { readWebPagesSettings, saveWebPagesSettings } from "../dist/web-pages-settings.js";
import { usageReportSettings, saveUsageReportSettings } from "../dist/usage-report.js";
import { readSavings, saveSavings } from "../dist/model-savings/settings.js";
import { wakeWordSettings } from "../dist/voice-wake.js";
import { settingsCatalogue, shipOnInitials } from "../dist/settings-kit/catalogue.js";
import { currentValue } from "../dist/settings-kit/changes.js";

const owner = "owner";
/** Just enough of the store for the settings readers: records kept in memory, by kind, owner and id. */
function memoryStore() {
  const rows = new Map();
  const id = (kind, who, key) => `${kind}\u0000${who}\u0000${key}`;
  return {
    get: (kind, who, key) => (rows.has(id(kind, who, key)) ? { data: structuredClone(rows.get(id(kind, who, key))) } : undefined),
    save: (kind, who, key, data) => { rows.set(id(kind, who, key), structuredClone(data)); },
    raw: (key, data) => rows.set(id("settings", owner, key), data),
  };
}

/**
 * Each flipped feature: how it reads, what it ships as, how the owner switches it off, and (for a record that holds
 * more than its switch) an old record whose "off" nobody chose.
 */
const flipped = [
  { name: "the shared board", read: (s) => boardMode(s, owner, "kanban"), ships: "when-needed", off: (s) => saveBoardMode(s, owner, "kanban", { mode: "off" }) },
  { name: "going back in a flow", read: (s) => boardMode(s, owner, "time-travel"), ships: "when-needed", off: (s) => saveBoardMode(s, owner, "time-travel", { mode: "off" }) },
  { name: "memory blocks", read: (s) => learningMode(s, owner, "blocks"), ships: "when-needed", off: (s) => saveLearningMode(s, owner, "blocks", { mode: "off" }) },
  { name: "command scan", read: (s) => safetyMode(s, owner, "command-scan"), ships: "when-needed", off: (s) => saveSafetyMode(s, owner, "command-scan", { mode: "off" }) },
  { name: "understanding something", read: (s) => learnMode(s, owner), ships: "when-needed", off: (s) => saveLearnSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("learn", { mode: "off", steps: 10 }) },
  { name: "add-on drafts", read: (s) => addOnMode(s, owner, "drafts"), ships: "when-needed", off: (s) => saveAddOnSettings(s, owner, { modes: { drafts: "off" } }),
    old: (s) => s.raw("add-ons", { modes: { packages: "off", lists: "off", filters: "off", pipelines: "off", drafts: "off", search: "off", export: "off" }, wallEveryPlugin: true, windowsWithoutWall: false }) },
  { name: "sub-goals and background tasks", read: (s) => autonomyMode(s, owner, "session-commands"), ships: "when-needed", off: (s) => saveAutonomyMode(s, owner, "session-commands", { mode: "off" }) },
  { name: "forecasts", read: (s) => askMode(s, owner, "forecasts"), ships: "when-needed", off: (s) => saveAskMode(s, owner, "forecasts", { mode: "off" }) },
  { name: "sharing assistants", read: (s) => interopMode(s, owner, "agent-market"), ships: "when-needed" },
  { name: "skill bundles", read: (s) => savedReachMode(s, owner, "skill-bundles"), ships: "when-needed" },
  { name: "worktrees", read: (s) => codingMode(s, owner, "worktrees"), ships: "when-needed", off: (s) => saveCodingMode(s, owner, "worktrees", "off"),
    old: (s) => s.raw("coding-worktrees", { mode: "off", perHelper: false }) },
  { name: "a Trunk in any conversation", read: (s) => trunkMode(s, owner, "conversations"), ships: "when-needed" },
  { name: "saved prompts", read: (s) => promptLibrarySettings(s, owner).mode, ships: "on", off: (s) => savePromptLibrarySettings(s, owner, { mode: "off" }) },
  { name: "recordings", read: (s) => recordingSettings(s, owner).mode, ships: "when-needed", off: (s) => saveRecordingSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("run-recording", { mode: "off", pictures: false, keepPictures: 5 }) },
  { name: "whether Branch is keeping up", read: (s) => eventLoopSettings(s, owner).mode, ships: "when-needed", off: (s) => saveEventLoopSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("event-loop-watch", { mode: "off", stallMs: 400 }) },
  { name: "stopping repeated steps", read: (s) => loopGuardMode(s, owner), ships: "when-needed", off: (s) => saveLoopGuardSettings(s, owner, { mode: "off" }) },
  { name: "a chime when Branch needs you", read: (s) => readComfort(s, owner, "notify").sound, ships: "chime", off: (s) => saveComfort(s, owner, "notify", { sound: "off" }),
    old: (s) => s.raw("comfort-notify", { ...readComfort(memoryStore(), owner, "notify"), sound: "off", method: "window" }) },
  { name: "goal mode", read: (s) => goalUndoSettings(s, owner).goal, ships: "on", off: (s) => saveGoalUndoSettings(s, owner, { goal: "off" }),
    old: (s) => s.raw("goal-undo", { goal: "off", snapshots: "on" }) },
  { name: "your computer's own voice", read: (s) => voiceSettings(s, owner).systemVoice, ships: "when-needed", off: (s) => saveVoiceSettings(s, owner, { systemVoice: "off" }),
    old: (s) => s.raw("voice", { ...voiceSettings(memoryStore(), owner), systemVoice: "off", autoReadAloud: true }) },
  { name: "live status in chat apps", read: (s) => chatLiveSwitches(s, owner).liveStatus, ships: "when-needed", off: (s) => saveChatLiveSwitches(s, owner, { liveStatus: "off" }),
    old: (s) => s.raw("chat-live-switches", { liveStatus: "off", commands: "on", steering: "off", splitting: "off" }) },
  { name: "the terminal's mouse", read: (s) => terminalSwitches(s, owner).mouse, ships: "when-needed", off: (s) => saveTerminalSwitch(s, owner, "mouse", "off"),
    old: (s) => s.raw("terminal-switches", { mouse: "off", sidePane: "on", oak: "off" }) },
  { name: "AGENTS.md", read: (s) => switchFor(contextFileSettings(s, owner), "agents"), ships: "when-needed", off: (s) => saveContextFileSettings(s, owner, { files: { agents: "off" } }) },
  { name: "writing new skills when asked", read: (s) => reflectionSettings(s, owner).newSkills, ships: "when-needed", off: (s) => saveReflectionSettings(s, owner, { newSkills: "off" }),
    old: (s) => s.raw("reflection", { reflection: "on", everyTurns: 25, newSkills: "off", retireAfterDays: 60 }) },
  { name: "the security self-check", read: (s) => securityCheckSettings(s, owner).audit, ships: "when-needed", off: (s) => saveSecurityCheckSettings(s, owner, { audit: "off" }),
    old: (s) => s.raw("security-check", { audit: "off", malware: "on" }) },
  { name: "reading whole web pages", read: (s) => readWebPagesSettings(s, owner).mode, ships: "when-needed", off: (s) => saveWebPagesSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("web-pages", { mode: "off", crawlDelayMs: 2000 }) },
  { name: "the usage report", read: (s) => usageReportSettings(s, owner).mode, ships: "when-needed", off: (s) => saveUsageReportSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("usage-report", { mode: "off", enabled: false, range: "7d" }) },
  { name: "the per-round chart", read: (s) => readSavings(s, owner, "roundChart").mode, ships: "on", off: (s) => saveSavings(s, owner, "roundChart", { mode: "off" }) },
];

test("a fresh install has every flipped feature on", () => {
  const store = memoryStore();
  for (const row of flipped) assert.equal(row.read(store), row.ships, `${row.name} ships ${row.ships}`);
});

test("an off the owner chose survives, and so does every other choice beside it", () => {
  for (const row of flipped.filter((entry) => entry.off)) {
    const store = memoryStore();
    row.off(store);
    assert.equal(row.read(store), "off", `${row.name}: the owner's off is kept`);
  }
});

test("an off written as the old default beside other fields reads as on; the fields beside it keep their values", () => {
  for (const row of flipped.filter((entry) => entry.old)) {
    const store = memoryStore();
    row.old(store);
    assert.equal(row.read(store), row.ships, `${row.name}: an off nobody chose reads as shipped`);
  }
  const store = memoryStore();
  store.raw("goal-undo", { goal: "off", snapshots: "on" });
  assert.equal(goalUndoSettings(store, owner).snapshots, "on", "the snapshots the owner switched on stay on");
  store.raw("chat-live-switches", { liveStatus: "off", commands: "on", steering: "off", splitting: "off" });
  assert.equal(chatLiveSwitches(store, owner).commands, "on");
  // Saving a neighbouring field later does not turn the old default into a choice.
  saveEventLoopSettings(store, owner, { stallMs: 900 });
  assert.equal(eventLoopSettings(store, owner).mode, "when-needed");
  assert.equal(eventLoopSettings(store, owner).stallMs, 900);
});

test("a record holding only its switch was written by the owner moving it, so its off stays off", () => {
  const store = memoryStore();
  store.raw("flowboards-kanban", { mode: "off" });
  store.raw("prompt-library", { mode: "off" });
  store.raw("loop_guard", { mode: "off" });
  assert.equal(boardMode(store, owner, "kanban"), "off");
  assert.equal(promptLibrarySettings(store, owner).mode, "off");
  assert.equal(loopGuardMode(store, owner), "off");
});

test("what spends, sends, deletes, listens, is heavy or loosens approvals is still off on a fresh install", () => {
  const store = memoryStore();
  const kept = {
    "procedures that start themselves (f)": autonomyMode(store, owner, "procedures"),
    "asking whether a long task is getting anywhere (a)": safetyMode(store, owner, "progress-judge"),
    // Not (a)–(f), but on it drops the real result of an approved call from a model that reuses call ids.
    "tidying a conversation before it is sent (breaks ordinary use)": safetyMode(store, owner, "history-repair"),
    "finding conversations by meaning (a, b)": learningMode(store, owner, "meaning-search"),
    "outside memory services (b)": learningMode(store, owner, "providers"),
    "install requests (b)": boardMode(store, owner, "install-requests"),
    "add-on packages (b, f)": addOnMode(store, owner, "packages"),
    "quick answers from the web (b)": askMode(store, owner, "answer-engine"),
    "counting how Branch is used (b)": askMode(store, owner, "analytics"),
    "long articles (a)": askMode(store, owner, "article-writer"),
    "other computers (b)": askMode(store, owner, "nodes"),
    "the app server (f)": askMode(store, owner, "app-server"),
    "clearing leads (c)": askMode(store, owner, "leads"),
    "several assistants (b, f)": interopMode(store, owner, "fleet"),
    "handing a conversation on (b, f)": interopMode(store, owner, "handoff"),
    "a plugged USB device starting tasks (a)": savedReachMode(store, owner, "usb"),
    "branch send (b)": savedReachMode(store, owner, "send"),
    "looking back over conversations (a)": reflectionSettings(store, owner).reflection,
    "snapshots of the workspace (e)": goalUndoSettings(store, owner).snapshots,
    "the malware lookup (b)": securityCheckSettings(store, owner).malware,
    "updating by itself (b)": readComfort(store, owner, "notify").autoUpdate,
    "commands typed in a chat app (f)": chatLiveSwitches(store, owner).commands,
    "keeping the prompt cache warm (a)": readSavings(store, owner, "keepAlive").mode,
    "the wake word (d)": wakeWordSettings(store, owner).mode,
  };
  for (const [name, mode] of Object.entries(kept)) assert.equal(mode, "off", `${name} stays off`);
  const { hidden } = switchedToolTiers(store, owner, ["procedures.auto.list", "board.cards", "memory.outside_recall", "learn.map", "addon.draft"]);
  assert.deepEqual(hidden.sort(), ["memory.outside_recall", "procedures.auto.list"], "only the tools of what stays off are hidden");
});

test("the settings kit starts each flipped field where its module ships it, so a fresh install has nothing to put back", () => {
  const store = memoryStore();
  for (const [key, fields] of Object.entries(shipOnInitials)) {
    const spec = settingsCatalogue.find((entry) => entry.key === key);
    assert.ok(spec, `${key} is in the catalogue`);
    for (const [field, value] of Object.entries(fields)) {
      const entry = spec.fields.find((one) => one.field === field);
      assert.ok(entry, `${key}.${field} is a catalogue field`);
      assert.equal(entry.initial, value, `${key}.${field} starts at ${value}`);
      assert.equal(currentValue(store, owner, spec, entry), value, `${key}.${field} reads ${value} on a fresh install`);
    }
  }
  for (const key of ["flowboards-kanban", "safety-command-scan"]) {
    const spec = settingsCatalogue.find((entry) => entry.key === key);
    assert.equal(spec.fields[0].initial, "when-needed", `${key} starts when needed`);
  }
});
