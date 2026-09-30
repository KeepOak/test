/**
 * The owner's ship-on rule (2026-09-26): every feature ships on unless it (a) spends money, (b) sends something to other people or publishes
 * on its own, (c) deletes something, (d) uses the microphone or camera, (e) uses heavy CPU or disk,
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
import { codingMode, partSettings, saveCodingMode } from "../dist/coding/settings.js";
import { WorktreeSettingsSchema } from "../dist/coding/worktrees.js";
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
import { usageLimitsSettings, saveUsageLimitsSettings } from "../dist/usage-limits.js";
import { executionMetricsSettings, saveExecutionMetricsSettings } from "../dist/execution-metrics.js";
import { localModelsMode, saveLocalModelsMode } from "../dist/local-jobs.js";
import { mediaProgramsMode, saveMediaProgramsSettings } from "../dist/media-programs.js";
import { languageServerSettings, saveLanguageServerSettings } from "../dist/language-server.js";
import { debugSettings, saveDebugSettings } from "../dist/debug-adapter.js";
import { personalMode, savePersonalMode } from "../dist/personal/settings.js";
import { SpokenBrief } from "../dist/personal/spoken-brief.js";
import { MorningBrief } from "../dist/brief.js";
import { currentValue } from "../dist/settings-kit/changes.js";
import { accountsSettings, saveAccountsSettings } from "../dist/accounts/settings.js";
import { markChosen } from "../dist/ship-on.js";
import { troubleshootSettings, saveTroubleshootSettings } from "../dist/troubleshoot.js";
import { sdkKitMode, saveSdkKitSettings } from "../dist/sdk-kit.js";
import { readKnobs, saveKnobs, resetKnobs } from "../dist/knobs/settings.js";

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
  { name: "fewer rounds", read: (s) => codingMode(s, owner, "fewer-rounds"), ships: "when-needed", off: (s) => saveCodingMode(s, owner, "fewer-rounds", "off") },
  // The owner's ruling (2026-09-30): each coding helper in a Git project gets its own worktree; forks stay off (below).
  { name: "a copy per coding helper", read: (s) => codingMode(s, owner, "worktrees"), ships: "when-needed", off: (s) => saveCodingMode(s, owner, "worktrees", "off") },
  { name: "a Trunk in any conversation", read: (s) => trunkMode(s, owner, "conversations"), ships: "when-needed" },
  { name: "saved prompts", read: (s) => promptLibrarySettings(s, owner).mode, ships: "on", off: (s) => savePromptLibrarySettings(s, owner, { mode: "off" }) },
  { name: "recordings", read: (s) => recordingSettings(s, owner).mode, ships: "when-needed", off: (s) => saveRecordingSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("run-recording", { mode: "off", pictures: false, keepPictures: 5 }) },
  { name: "whether Branch is keeping up", read: (s) => eventLoopSettings(s, owner).mode, ships: "when-needed", off: (s) => saveEventLoopSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("event-loop-watch", { mode: "off", stallMs: 400 }) },
  { name: "stopping repeated steps", read: (s) => loopGuardMode(s, owner), ships: "on", off: (s) => saveLoopGuardSettings(s, owner, { mode: "off" }) },
  { name: "a chime when Branch needs you", read: (s) => readComfort(s, owner, "notify").sound, ships: "chime", off: (s) => saveComfort(s, owner, "notify", { sound: "off" }),
    old: (s) => s.raw("comfort-notify", { ...readComfort(memoryStore(), owner, "notify"), sound: "off", method: "window" }) },
  { name: "goal mode", read: (s) => goalUndoSettings(s, owner).goal, ships: "on", off: (s) => saveGoalUndoSettings(s, owner, { goal: "off" }),
    old: (s) => s.raw("goal-undo", { goal: "off", snapshots: "on" }) },
  { name: "your computer's own voice", read: (s) => voiceSettings(s, owner).systemVoice, ships: "when-needed", off: (s) => saveVoiceSettings(s, owner, { systemVoice: "off" }),
    old: (s) => s.raw("voice", { ...voiceSettings(memoryStore(), owner), systemVoice: "off", autoReadAloud: true }) },
  { name: "live status in chat apps", read: (s) => chatLiveSwitches(s, owner).liveStatus, ships: "when-needed", off: (s) => saveChatLiveSwitches(s, owner, { liveStatus: "off" }),
    old: (s) => s.raw("chat-live-switches", { liveStatus: "off", commands: "on", steering: "off", splitting: "off" }) },
  { name: "steps in chat apps", read: (s) => chatLiveSwitches(s, owner).steps, ships: "on", off: (s) => saveChatLiveSwitches(s, owner, { steps: "off" }),
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
  // Re-judged by the owner (2026-09-27): none of these sends to other people or publishes, spends beyond what the owner
  // connected, or runs heavy work in the background.
  { name: "updating by itself", read: (s) => readComfort(s, owner, "notify").autoUpdate, ships: "install", off: (s) => saveComfort(s, owner, "notify", { autoUpdate: "off" }),
    old: (s) => s.raw("comfort-notify", { method: "window", sound: "off", autoUpdate: "off", releaseChannel: "stable" }) },
  { name: "asking a service what is left", read: (s) => usageLimitsSettings(s, owner).mode, ships: "when-needed", off: (s) => saveUsageLimitsSettings(s, owner, { mode: "off" }) },
  { name: "sending the counters when pressed", read: (s) => executionMetricsSettings(s, owner).mode, ships: "when-needed", off: (s) => saveExecutionMetricsSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("execution-metrics", { mode: "off", enabled: false, minutesBetween: 30 }) },
  { name: "finding conversations by meaning", read: (s) => learningMode(s, owner, "meaning-search"), ships: "when-needed", off: (s) => saveLearningMode(s, owner, "meaning-search", { mode: "off" }) },
  { name: "the spoken briefing", read: (s) => personalMode(s, owner, "spoken-brief"), ships: "when-needed", off: (s) => savePersonalMode(s, owner, "spoken-brief", { mode: "off" }) },
  { name: "the morning brief", read: (s) => (new MorningBrief(s).settings(owner).enabled ? "on" : "off"), ships: "on", off: (s) => new MorningBrief(s).configure(owner, { enabled: false }),
    old: (s) => s.raw("brief", { ...new MorningBrief(memoryStore()).settings(owner), enabled: false, dailyAt: "06:45" }) },
  { name: "models on this computer", read: (s) => localModelsMode(s, owner), ships: "when-needed", off: (s) => saveLocalModelsMode(s, owner, { mode: "off" }) },
  { name: "watching and saving videos", read: (s) => mediaProgramsMode(s, owner), ships: "when-needed", off: (s) => saveMediaProgramsSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("media-programs", { mode: "off", ffmpeg: "", ytDlp: "", frames: 2, maxDownloadMb: 200 }) },
  { name: "language servers", read: (s) => (languageServerSettings(s, owner).enabled ? "on" : "off"), ships: "on", off: (s) => saveLanguageServerSettings(s, owner, { enabled: false }),
    old: (s) => s.raw("language-servers", { enabled: false, servers: {}, maxMemoryMb: 1024, maxCpuSeconds: 1800, timeoutMs: 20000, keepRunning: false }) },
  { name: "debug adapters", read: (s) => (debugSettings(s, owner).enabled ? "on" : "off"), ships: "on", off: (s) => saveDebugSettings(s, owner, { enabled: false }) },
  { name: "the malware lookup", read: (s) => securityCheckSettings(s, owner).malware, ships: "when-needed", off: (s) => saveSecurityCheckSettings(s, owner, { malware: "off" }),
    old: (s) => s.raw("security-check", { audit: "on", malware: "off" }) },
  { name: "install requests", read: (s) => boardMode(s, owner, "install-requests"), ships: "when-needed", off: (s) => saveBoardMode(s, owner, "install-requests", { mode: "off" }) },
  { name: "several accounts per connection", read: (s) => accountsSettings(s, owner).mode, ships: "when-needed",
    off: (s) => { saveAccountsSettings(s, owner, { ...accountsSettings(s, owner), mode: "off" }); markChosen(s, owner, "accounts", ["mode"]); },
    old: (s) => s.raw("accounts", { mode: "off", pools: [], poolingRule: 1, poolingNotices: [] }) },
  { name: "quick answers from the web", read: (s) => askMode(s, owner, "answer-engine"), ships: "when-needed", off: (s) => saveAskMode(s, owner, "answer-engine", { mode: "off" }) },
  // Defaults audit (2026-09-28, DEFAULTS-AUDIT.md): none of (a)–(f).
  { name: "fixing a failed command", read: (s) => troubleshootSettings(s, owner).mode, ships: "when-needed", off: (s) => saveTroubleshootSettings(s, owner, { mode: "off" }),
    old: (s) => s.raw("troubleshoot", { mode: "off", maxTries: 3 }) },
  { name: "tidying the history before it is sent", read: (s) => safetyMode(s, owner, "history-repair"), ships: "when-needed", off: (s) => saveSafetyMode(s, owner, "history-repair", { mode: "off" }) },
  { name: "tools for building on Branch", read: (s) => sdkKitMode(s, owner), ships: "when-needed", off: (s) => saveSdkKitSettings(s, owner, { mode: "off" }) },
  { name: "the about-you note", read: (s) => (readKnobs(s, owner, "memory").aboutYouOn ? "on" : "off"), ships: "on", off: (s) => saveKnobs(s, owner, "memory", { aboutYouOn: false }),
    old: (s) => s.raw("knobs-memory", { snapshotFacts: 30, snapshotChars: 2000, aboutYouOn: false, aboutYou: "", aboutYouChars: 1500 }) },
];

test("defaults audit: a knob card put back reads as it ships again, and an owner's other knobs are untouched", () => {
  const store = memoryStore();
  saveKnobs(store, owner, "memory", { aboutYouOn: false, snapshotFacts: 12 });
  saveKnobs(store, owner, "memory", { aboutYou: "I work nights." });
  assert.equal(readKnobs(store, owner, "memory").aboutYouOn, false, "the owner's off survives a later save of the card");
  assert.equal(readKnobs(store, owner, "memory").snapshotFacts, 12);
  resetKnobs(store, owner, "memory");
  assert.equal(readKnobs(store, owner, "memory").aboutYouOn, true);
});

test("a fresh install has every flipped feature on", () => {
  const store = memoryStore();
  for (const row of flipped) assert.equal(row.read(store), row.ships, `${row.name} ships ${row.ships}`);
});

test("an off the owner chose survives, and so does every other choice beside it", async () => {
  for (const row of flipped.filter((entry) => entry.off)) {
    const store = memoryStore();
    await row.off(store);
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

test("a value the owner chose that was never the old default is kept, whether or not it was written down", () => {
  const store = memoryStore();
  store.raw("comfort-notify", { method: "system", sound: "knock", autoUpdate: "check", releaseChannel: "stable" });
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "check", "checking only is kept, never raised to installing");
  assert.equal(readComfort(store, owner, "notify").sound, "knock");
  store.raw("run-recording", { mode: "on", pictures: false, keepPictures: 5 });
  assert.equal(recordingSettings(store, owner).mode, "on", "an on beside other fields is not lowered to when needed");
  store.raw("media-programs", { mode: "on", ffmpeg: "", ytDlp: "", frames: 4, maxDownloadMb: 200 });
  assert.equal(mediaProgramsMode(store, owner), "on");
});

test("updating by itself: a fresh install installs with no click, and the owner's own off stays off through later saves", () => {
  const store = memoryStore();
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "install");
  saveComfort(store, owner, "notify", { method: "window" });
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "install", "saving a neighbouring field chooses nothing about updates");
  saveComfort(store, owner, "notify", { autoUpdate: "off" });
  saveComfort(store, owner, "notify", { sound: "knock" });
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "off", "the owner's off survives later saves of the card");
});

test("usage limits: a switch-only record the owner wrote keeps its off; nothing saved reads when needed", () => {
  const store = memoryStore();
  assert.deepEqual(usageLimitsSettings(store, owner), { mode: "when-needed", enabled: true });
  store.raw("usage-limits", { mode: "off", enabled: false });
  assert.equal(usageLimitsSettings(store, owner).mode, "off");
});

test("a damaged or foreign switch record reads off (fail closed), never as shipped", () => {
  const store = memoryStore();
  store.raw("safety-tool-scripts", { unexpected: true });
  store.raw("safety-wasm-add-ons", { mode: "sideways" });
  store.raw("flowboards-time-travel", { stray: 1 });
  store.raw("learning-more-blocks", { stray: 1 });
  assert.equal(safetyMode(store, owner, "tool-scripts"), "off");
  assert.equal(safetyMode(store, owner, "wasm-add-ons"), "off");
  assert.equal(boardMode(store, owner, "time-travel"), "off");
  assert.equal(learningMode(store, owner, "blocks"), "off");
  const { hidden } = switchedToolTiers(store, owner, ["tools.script", "wasm.run"]);
  assert.deepEqual(hidden.sort(), ["tools.script", "wasm.run"], "their tools are not offered");
  // The empty record putting a card back writes still reads as shipped.
  store.raw("safety-tool-scripts", {});
  assert.equal(safetyMode(store, owner, "tool-scripts"), "when-needed");
});

test("the spoken briefing plays here, but sending it into a chat still needs sending files into chats (b)", async () => {
  const store = memoryStore();
  const sent = [];
  const brief = new SpokenBrief({ store, owner, speak: async () => ({ bytes: new Uint8Array(1), mediaType: "audio/mpeg" }),
    sources: { morningBrief: () => "Good morning." }, sendVoice: async (...args) => { sent.push(args); } });
  assert.equal((await brief.run({})).sentTo, null);
  await assert.rejects(brief.run({ channel: "telegram", chatId: "42" }), /Sending files into your chats is switched off/);
  assert.equal(sent.length, 0, "nothing went to the chat");
});

test("the morning brief, on as it ships, waits for the next morning rather than sending at once", async () => {
  const store = memoryStore();
  store.createRun = () => { throw new Error("nothing is sent on the first beat"); };
  const brief = new MorningBrief(store);
  assert.equal(await brief.tick(owner, new Date("2026-09-27T12:00:00Z")), false);
  assert.ok(brief.settings(owner).nextAt > "2026-09-27T12:00:00Z", "the next one is set for later");
});

test("a record holding only its switch was written by the owner moving it, so its off stays off", () => {
  const store = memoryStore();
  store.raw("flowboards-time-travel", { mode: "off" });
  store.raw("prompt-library", { mode: "off" });
  store.raw("loop_guard", { mode: "off" });
  assert.equal(boardMode(store, owner, "time-travel"), "off");
  assert.equal(promptLibrarySettings(store, owner).mode, "off");
  assert.equal(loopGuardMode(store, owner), "off");
});

test("what spends, sends, deletes, listens, is heavy or loosens approvals is still off on a fresh install", () => {
  const store = memoryStore();
  const kept = {
    "procedures that start themselves (f)": autonomyMode(store, owner, "procedures"),
    "asking whether a long task is getting anywhere (a)": safetyMode(store, owner, "progress-judge"),
    "outside memory services (b)": learningMode(store, owner, "providers"),
    "add-on packages (b, f)": addOnMode(store, owner, "packages"),
    "counting how Branch is used (b)": askMode(store, owner, "analytics"),
    "remembering with a Hindsight server (b)": askMode(store, owner, "hindsight"),
    "steps for other apps (b)": askMode(store, owner, "app-blocks"),
    "sending files into chats (b)": personalMode(store, owner, "chat-files"),
    "searching X (a)": personalMode(store, owner, "x-search"),
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
    "commands typed in a chat app (f)": chatLiveSwitches(store, owner).commands,
    "keeping the prompt cache warm (a)": readSavings(store, owner, "keepAlive").mode,
    "the wake word (d)": wakeWordSettings(store, owner).mode,
    "a worktree for every forked conversation (e)": partSettings(store, owner, "worktrees", WorktreeSettingsSchema).forks ? "on" : "off",
    "the shared board, until its tools declare what they touch (f)": boardMode(store, owner, "kanban"),
  };
  for (const [name, mode] of Object.entries(kept)) assert.equal(mode, "off", `${name} stays off`);
  assert.equal(localModelsMode(store, owner) === "on", false, "no local runtime is started with Branch (e)");
  assert.equal(languageServerSettings(store, owner).keepRunning, false, "no language server is kept running between tasks (e)");
  assert.equal(debugSettings(store, owner).keepRunning, false);
  const { hidden } = switchedToolTiers(store, owner, ["procedures.auto.list", "board.cards", "memory.outside_recall", "learn.map", "addon.draft"]);
  assert.deepEqual(hidden.sort(), ["board.cards", "memory.outside_recall", "procedures.auto.list"], "only the tools of what stays off are hidden");
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
  for (const key of ["flowboards-time-travel", "safety-command-scan"]) {
    const spec = settingsCatalogue.find((entry) => entry.key === key);
    assert.equal(spec.fields[0].initial, "when-needed", `${key} starts when needed`);
  }
});

/*
 * A save over a record its schema cannot read: every switch in it read off (fail closed) and was shown off, and the save
 * writes those offs down. They must stay off afterwards, not read as shipped, since no change list showed them moving.
 */
const unreadable = [
  { name: "writing new skills", key: "reflection", read: (s) => reflectionSettings(s, owner).newSkills,
    save: (s) => saveReflectionSettings(s, owner, { reflection: "on" }) },
  { name: "the morning brief", key: "brief", read: (s) => (new MorningBrief(s).settings(owner).enabled ? "on" : "off"),
    save: (s) => new MorningBrief(s).configure(owner, { dailyAt: "06:30" }) },
  { name: "live status in chat apps", key: "chat-live-switches", read: (s) => chatLiveSwitches(s, owner).liveStatus,
    save: (s) => saveChatLiveSwitches(s, owner, { commands: "on" }) },
  { name: "goal mode", key: "goal-undo", read: (s) => goalUndoSettings(s, owner).goal,
    save: (s) => saveGoalUndoSettings(s, owner, { snapshots: "on" }) },
  { name: "the security self-check", key: "security-check", read: (s) => securityCheckSettings(s, owner).audit,
    save: (s) => saveSecurityCheckSettings(s, owner, { malware: "on" }) },
  { name: "the terminal's side pane", key: "terminal-switches", read: (s) => terminalSwitches(s, owner).sidePane,
    save: (s) => saveTerminalSwitch(s, owner, "mouse", "on") },
  { name: "updating by itself", key: "comfort-notify", read: (s) => readComfort(s, owner, "notify").autoUpdate,
    save: (s) => saveComfort(s, owner, "notify", { sound: "knock" }) },
];

test("a save over a record that could not be read keeps every switch it showed off, off", () => {
  for (const one of unreadable) {
    const store = memoryStore();
    store.raw(one.key, { stray: true });
    assert.equal(one.read(store), "off", `${one.name}: an unreadable record reads off`);
    one.save(store);
    assert.equal(one.read(store), "off", `${one.name}: saving another field does not turn it on`);
  }
});

test("the settings kit, writing one field over an unreadable record, turns on nothing it did not show", () => {
  const store = memoryStore();
  store.raw("goal-undo", { stray: true });
  const spec = settingsCatalogue.find((entry) => entry.key === "goal-undo");
  const goal = spec.fields.find((field) => field.field === "goal");
  assert.equal(currentValue(store, owner, spec, goal), "off");
  spec.write(store, owner, { snapshots: "on" });
  assert.equal(currentValue(store, owner, spec, goal), "off", "goal mode stays off");
});

test("a morning brief that names a chat keeps its own switch: an off there is never read as on (b)", () => {
  const store = memoryStore();
  store.raw("brief", { ...new MorningBrief(memoryStore()).settings(owner), enabled: false, deliverTo: { channel: "telegram", chatId: "42" } });
  assert.equal(new MorningBrief(store).settings(owner).enabled, false);
});

test("updating by itself ships on for Beta too (the owner never presses Update); an off the owner chose stays off", () => {
  const store = memoryStore();
  store.raw("comfort-notify", { method: "window", sound: "off", autoUpdate: "off", releaseChannel: "beta" });
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "install", "an old default off on Beta reads as shipped");
  store.raw("comfort-notify", { method: "window", sound: "off", autoUpdate: "off", releaseChannel: "dev" });
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "install", "a saved Dev is Beta");
  store.raw("comfort-notify", { method: "window", sound: "off", autoUpdate: "off", releaseChannel: "stable" });
  assert.equal(readComfort(store, owner, "notify").autoUpdate, "install");
  const fresh = memoryStore();
  saveComfort(fresh, owner, "notify", { releaseChannel: "beta" });
  assert.equal(readComfort(fresh, owner, "notify").autoUpdate, "install", "choosing Beta keeps updating by itself");
  saveComfort(fresh, owner, "notify", { autoUpdate: "off" });
  assert.equal(readComfort(fresh, owner, "notify").autoUpdate, "off", "the owner's own off is kept");
});

test("putting voice back as shipped forgets the owner's choices, so the kit has nothing left to put back", () => {
  const store = memoryStore();
  saveVoiceSettings(store, owner, { systemVoice: "off" });
  const spec = settingsCatalogue.find((entry) => entry.key === "voice");
  const field = spec.fields.find((one) => one.field === "systemVoice");
  assert.equal(currentValue(store, owner, spec, field), "off");
  spec.putBack(store, owner);
  assert.equal(currentValue(store, owner, spec, field), field.initial, "it reads as it ships");
});
