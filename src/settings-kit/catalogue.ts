import { reachKey, reachLabels, reachParts, reachShipsOn, savedReachMode, type ReachPart } from "../reach/settings.js";
import { listenAsked, listenPlaces, ListenSettingsSchema, listenKey, saveListenSettings } from "../listen-address.js"; // mac7/bind
import { readPolicy, savePolicy, type PolicyPresetName } from "../policy.js";
import { presetMoveLooser, type ToolLister } from "../preset-moves.js";
import type { Store } from "../store.js";
import { loopGuardMode, loopGuardShipsAs, saveLoopGuardSettings } from "../loop-guard.js";
import { folderTrustMode, saveFolderTrustSettings } from "../folder-trust.js";
import { reviewerSettings, saveReviewerSettings } from "../approval-reviewer.js";
import { saveSecurityCheckSettings, securityCheckSettings } from "../security-audit/settings.js";
import { saveWallSettings, wallSettings } from "../sandbox.js";
import { readKeychainSettings, saveKeychainSettings } from "../vault-sources.js";
import { readVaultAutofillSettings, saveVaultAutofillSettings } from "../vault-autofill.js"; // mac7/vault-autofill (R17-068)
import { retentionLooser, retentionSettings, saveRetentionSettings } from "../retention.js";
import { WakeWordSettingsSchema, wakeWordKey } from "../voice-wake.js";
import { DictationSettingsSchema, dictationKey } from "../voice-dictation.js";
import { eventLoopSettings, eventLoopWatch, saveEventLoopSettings } from "../event-loop-watch.js";
import { audit } from "../audit.js";
import { safetyMode, safetyShipsOn, saveSafetySwitch, type SafetyPart } from "../safety-extras/settings.js";
import { boardMode, boardShipsOn, writeBoardSwitch, type BoardPart } from "../flows-boards/settings.js"; // r17-h integration review
import { readComfort, saveComfort, type ComfortCard } from "../comfort/settings.js";
import { readChatPermissionSettings, saveChatPermissionSettings } from "../channels/chat-permissions.js"; // mac7/chat-allowlist
import { saveUsageLimitsSettings, usageLimitsSettings } from "../usage-limits.js"; // mac7/usage-bar
// Q65: each setting's own reader and schema, so the kit shows and saves what the app really runs.
import { settleSwitch, type FeatureMode } from "../feature-switches.js";
import { DesktopSettingsSchema } from "../integrations/desktop-config.js";
import { MediaProgramsSchema } from "../media-programs.js";
import { SpeechEngineSettingsSchema } from "../speech-engines.js";
import { executionMetricsSettings, saveExecutionMetricsSettings } from "../execution-metrics.js";
import { askMode, askShipsOn, type AskPart } from "../asks/settings.js";
import { moveInMode, moveInShipsAs, saveMoveInMode } from "../migrate/switch.js";
import { MemoryHistorySettingsSchema } from "../memory-git.js";
import { PullRequestHookSettingsSchema } from "../pr-hook.js";
import { SkillInstallSettingsSchema } from "../skill-installs.js";
import { WorkspaceEditorSettingsSchema } from "../workspace-editor-api.js";
import { localModelsMode, saveLocalModelsMode } from "../local-jobs.js";
import { saveUsageReportSettings, usageReportSettings } from "../usage-report.js";
import { RecordingSettingsSchema } from "../run-recording.js";
import { PromptLibrarySettingsSchema } from "../prompt-library.js";
import { saveWindowCommands, windowCommands, windowShipsAs } from "../commands/settings.js";
import { flyCoreSettings } from "../fly-core/settings.js";
import { GoalUndoSettingsSchema } from "../goal-mode.js";
import { reflectionSettings } from "../reflection/settings.js";
import { contextFileSettings, saveContextFileSettings } from "../context-files.js";
import { saveVoiceSettings, voiceSettings, VoiceSettingsSchema } from "../voice.js";
import { codingModelRounds, noLimit, readKnobs, saveKnobs } from "../knobs/settings.js";
import { forgetChosen, markChosen, savedFields, shippedUnlessChosen } from "../ship-on.js";
import { sdkKitMode, sdkKitShipsAs } from "../sdk-kit-switch.js"; // defaults audit
import { gitlabMode, gitlabShipsAs } from "../gitlab-switch.js"; // RES-719
import { seasonsSettings, saveSeasonsSettings } from "../seasons/settings.js";

/**
 * R17-S-A (understandable settings): the settings that can be put back to how they started, set
 * from a whole-app preset, and saved to or brought in from one file.
 *
 * This is an explicit list, not a sweep of the `settings` table. That table also holds things that
 * are not settings at all — Lockdown, the session lock, model connections, Keychain entries, people
 * and their devices, pairing codes, notes that a migration already ran — and putting any of those
 * "back to how it started" would lock the owner out or throw away their work. So only the fields
 * named here are ever read or written, and every one of them is a switch, a yes/no, a choice from a
 * short list or a bounded number. None of them can hold a secret.
 *
 * Every field also says which way is the less careful one, so a change that loosens safety or
 * reach can be shown apart and has to be confirmed on its own.
 */

/** Off, when needed, on — the three-way switch every feature has. */
export const switchPositions = ["off", "when-needed", "on"] as const;

/**
 * Which direction is the less careful one.
 *   reach    — turning it up lets Branch do or reach more (the screen, the Keychain, sending counts)
 *   guard    — turning it down takes a protection away (loop guard, the wall around programs)
 *   plain    — neither; a comfort or a convenience
 */
export type Guard = "reach" | "guard" | "plain";

type Parser = { safeParse: (value: unknown) => { success: boolean; data?: unknown }; parse: (value: unknown) => unknown };

/**
 * Q46: what a voice setting holds in force, read through the app's own schema: a record the app would not
 * accept counts as the app's starting values, as it does when it runs (src/voice-wake.ts, src/voice-dictation.ts).
 * Lockdown's override of the switch is left out: the kit weighs the owner's own setting.
 */
function inForce(schema: Parser, saved: unknown): Record<string, unknown> {
  const parsed = schema.safeParse(saved ?? {});
  return { ...(parsed.success ? parsed.data : schema.parse({})) as Record<string, unknown> };
}

type Hooks = Pick<SettingSpec, "read" | "write">;

/**
 * Q65: a setting whose module reads its record through a strict schema, and has no save of its own the kit
 * can use, is read and written the way the voice switches are. It shows what the app runs (a record the app
 * would not accept counts as its starting values), and a change is made onto that and checked by the same
 * schema, never onto the record as it lies: writing one field cannot bring back another the app was ignoring.
 * The schema is handed in as a function, so it is only reached once every module has loaded.
 */
function parsedBy(key: string, schema: () => Parser): Hooks {
  // The ship-on rule (src/ship-on.ts): a flipped field the owner never set reads as it ships, as the module reads it;
  // a record the app cannot read is its starting values, as before.
  const read = (store: Store, owner: string): Record<string, unknown> => {
    const saved = store.get("settings", owner, key)?.data;
    const values = inForce(schema(), saved);
    return schema().safeParse(saved ?? {}).success ? shippedUnlessChosen(store, owner, key, values, shipOnInitials[key] ?? {}) : values;
  };
  return {
    read,
    write: (store, owner, patch) => {
      const before = store.get("settings", owner, key)?.data;
      store.save("settings", owner, key, schema().parse({ ...read(store, owner), ...patch }) as Record<string, unknown>);
      // Over a record the app could not read, every shipped field was shown off and is now written off: it stays off.
      markChosen(store, owner, key, savedFields(before, schema().safeParse(before ?? {}).success, patch, shipOnInitials[key] ?? {}));
    },
  };
}

/** Q65: a setting that is only a switch, shown as its module reads it. */
const modeFrom = (reader: (store: Store, owner: string) => string): Hooks => ({ read: (store, owner) => ({ mode: reader(store, owner) }) });
/** A smaller ask's switch (src/asks/settings.ts). It is saved through the app's own asks (src/settings-kit/writers.ts). */
const askHooks = (part: AskPart): Hooks => modeFrom((store, owner) => askMode(store, owner, part));
/**
 * The owner's rule (ships on, 2026-09-26): a switch that ships "when needed" starts there, so putting it
 * back, undoing to its starting value and weighing a change all measure from how Branch really ships.
 */
const shipsAs = (spec: SettingSpec, mode: string): SettingSpec =>
  ({ ...spec, fields: spec.fields.map((field) => (field.field === "mode" ? { ...field, initial: mode } : field)) });
const askShips = (part: AskPart): string => askShipsOn[part] ?? "off";

/**
 * Q65: the screen and keyboard as the owner saved them, parsed as src/integrations/desktop-config.ts parses
 * them, with an older yes/no read as a mode. Lockdown's "off" is left out, as it is for the voice switches.
 */
function ownDesktop(store: Store, owner: string): Record<string, unknown> & { enabled?: boolean; mode?: FeatureMode } {
  const saved = inForce(DesktopSettingsSchema, store.get("settings", owner, "desktop-control")?.data);
  return { ...saved, ...settleSwitch(saved, {}) };
}
const desktopHooks: Hooks = {
  read: ownDesktop,
  write: (store, owner, patch) => {
    const current = ownDesktop(store, owner);
    store.save("settings", owner, "desktop-control", DesktopSettingsSchema.parse({ ...current, ...patch, ...settleSwitch(current, patch as { mode?: FeatureMode }) }));
  },
};

/**
 * Q65: where Branch listens, as the owner saved it or a container asked for it. `listenAsked` reads Lockdown's
 * "this computer" while Lockdown is on, so the owner's own saved choice is added back here.
 */
function ownListen(store: Store, owner: string): Record<string, unknown> {
  const saved = inForce(ListenSettingsSchema, store.get("settings", owner, listenKey)?.data).where;
  return { where: saved === "private-network" || listenAsked(store, owner) === "private-network" ? "private-network" : "this-computer" };
}

/**
 * Q65: voice is read strictly, but src/voice.ts stops on a record it cannot read rather than starting
 * again from its first values. So the kit shows the starting values for such a record without stopping,
 * and a change to it is refused in plain words: fixing one field there would make the whole record
 * readable again and bring every other field in it back, which the owner never saw.
 */
export const putBackVoiceLabel = "Put voice settings back as shipped";
const voiceUnreadable = (store: Store, owner: string): string | null =>
  VoiceSettingsSchema.safeParse(store.get("settings", owner, "voice")?.data ?? {}).success ? null
    : `The voice settings saved on this computer cannot be read, so they are not changed from here: changing one would bring back everything else in that record. "${putBackVoiceLabel}", under Settings, Put settings back, starts them again from how Branch ships.`;
const voiceHooks: Pick<SettingSpec, "read" | "write" | "refuses" | "putBack" | "shipped"> = {
  read: (store, owner) => {
    try { return { ...voiceSettings(store, owner) }; } catch { return {}; }
  },
  refuses: voiceUnreadable,
  // The last lock: a change is refused before it gets here (refuses), and never repairs the record if it does.
  write: (store, owner, patch) => {
    const refusal = voiceUnreadable(store, owner);
    if (refusal) throw new Error(refusal);
    saveVoiceSettings(store, owner, patch);
  },
  // The whole record is replaced, not merged: the voice card's own save cannot read what is there either.
  putBack: (store, owner) => { store.save("settings", owner, "voice", VoiceSettingsSchema.parse({})); forgetChosen(store, owner, "voice"); },
  shipped: () => VoiceSettingsSchema.parse({}),
};

/** Q65: the files you write, saved through their module, which takes one nested record ("files.soul" is `{ files: { soul } }`). */
const contextFilesWrite = (store: Store, owner: string, patch: Record<string, unknown>): void => {
  saveContextFileSettings(store, owner, { files: Object.fromEntries(Object.entries(patch).map(([field, value]) => [field.replace(/^files\./, ""), value])) });
};

export type FieldKind =
  | { type: "switch" }
  | { type: "yes-no" }
  /** Choices written from most careful to least careful. */
  | { type: "choice"; options: readonly string[] }
  /**
   * `fractions`: the app itself keeps values between whole steps (the dictation wait does, at 1.5 seconds).
   * `unset`: a word the field also takes, meaning the owner has set no figure of their own, so Branch uses its own.
   * `unlimited`: a word the field also takes, meaning no limit at all (a task limit's "no limit").
   */
  | { type: "number"; min: number; max: number; fractions?: true; unset?: string; unlimited?: string };

export interface FieldSpec {
  /** The field inside the saved record; a dot reaches one level in ("files.soul"). */
  field: string;
  label: string;
  /** The `data-t` key for the label. */
  t: string;
  kind: FieldKind;
  initial: string | number | boolean;
  guard: Guard;
  /** One sentence the settings tools give with the field, such as what its `unset` word stands for. */
  note?: string;
}

export interface SettingSpec {
  key: string;
  name: string;
  /** The `data-t` key for the name. */
  t: string;
  /** Where the card lives (docs/places.md). */
  home: string;
  fields: FieldSpec[];
  /** Records that keep an older yes/no beside the switch have it kept in step. */
  keepsEnabled?: boolean;
  /**
   * A setting that has its own way of being saved uses it, so a copy kept in memory, a tool that
   * comes and goes, or the record of the change is never skipped (integration review).
   */
  write?: (store: Store, owner: string, patch: Record<string, unknown>) => void;
  /** A setting whose module reads a damaged record in its own way (the wall reads it as "on") is shown that way. */
  read?: (store: Store, owner: string) => Record<string, unknown>;
  /**
   * Q65 review: why this setting cannot be changed from here right now, or null. Asked when the changes are
   * worked out, before anything is written, so a refusal lands in the refused list and every other change
   * in the same plan is still made and written down.
   */
  refuses?: (store: Store, owner: string) => string | null;
  /** Q65 review: puts a record that cannot be read back to how Branch ships, the way out of `refuses`. */
  putBack?: (store: Store, owner: string) => void;
  /** The whole record `putBack` writes, so put-back can name the saved values no field weighs when they differ from it (Q99). */
  shipped?: () => Record<string, unknown>;
  /**
   * A field whose move is weighed by what it lets through rather than by the order of its options (the
   * approval preset): what would get less careful, in plain words, or null when nothing would; undefined
   * leaves the field to the order of its options. It throws, with the reason, for a move that cannot be made.
   */
  weigh?: (store: Store, owner: string, field: string, to: string | number | boolean, tools: ToolLister | undefined) => string | null | undefined;
}

const sw = (field: string, label: string, t: string, guard: Guard): FieldSpec =>
  ({ field, label, t, kind: { type: "switch" }, initial: "off", guard });
const yesNo = (field: string, label: string, t: string, guard: Guard, initial = false): FieldSpec =>
  ({ field, label, t, kind: { type: "yes-no" }, initial, guard });
/** Where each reach card lives (docs/places.md). */
const reachHomes: Record<ReachPart, string> = {
  machines: "settings:computer", "remote-trunks": "customize:specialists", "background-screen": "settings:computer",
  video: "settings:models:media", relay: "customize:channels", send: "customize:channels", "platform-pause": "customize:channels",
  "agent-git": "customize:skills", "skill-bundles": "customize:skills", usb: "settings:computer", notes: "library:documents",
  arena: "settings:models:second",
};
const one = (key: string, name: string, t: string, home: string, guard: Guard, extra: Partial<SettingSpec> = {}): SettingSpec =>
  ({ key, name, t, home, fields: [sw("mode", "Switch", "settings-kit.field.switch", guard)], ...extra });
/** r17-h integration review: a flows-and-boards switch, written through the running copy so its tools follow. */
const board = (part: BoardPart, name: string, home: string, guard: Guard): SettingSpec =>
  shipsAs(one(`flowboards-${part}`, name, `settings-kit.name.flowboards-${part}`, home, guard,
    { write: (store, owner, patch) => { writeBoardSwitch(store, owner, part, patch); }, ...modeFrom((store, owner) => boardMode(store, owner, part)) }),
  boardShipsOn[part] ?? "off");
const saveWall = (store: Store, owner: string, patch: Record<string, unknown>): void => {
  const next = saveWallSettings(store, owner, { ...wallSettings(store, owner), ...patch });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `The wall around programs: ${next.mode}, reach ${next.network}`,
    reason: "Changed from Settings: presets, reset or a settings file", outcome: "saved" });
};

/** mac7/r17-g: a safety extra's switch, saved through the app so its tools come and go with it. */
const safetyPart = (part: SafetyPart, name: string, guard: Guard): SettingSpec =>
  shipsAs(one(`safety-${part}`, name, `settings-kit.name.safety-${part}`, "settings:permissions", guard,
    { write: (store, owner, patch) => { saveSafetySwitch(store, owner, part, patch); }, ...modeFrom((store, owner) => safetyMode(store, owner, part)) }),
  safetyShipsOn[part] ?? "off");

const safety: SettingSpec[] = [
  {
    key: "policy", name: "When to check with me", t: "settings-kit.name.policy", home: "settings:permissions",
    fields: [
      { field: "preset", label: "How careful", t: "settings-kit.field.policy-preset", guard: "guard", initial: "off",
        kind: { type: "choice", options: ["read-only", "careful", "ask-before-changes", "workspace", "off"] } },
      { field: "unmatchedCommands", label: "A command no rule mentions", t: "settings-kit.field.unmatched", guard: "guard", initial: "ask",
        kind: { type: "choice", options: ["ask", "allow"] } },
    ],
    // The approval rules are worked out from the preset, so the preset is saved the way the card saves it.
    write: (store, owner, patch) => { savePolicy(store, owner, patch, "Changed from Settings: presets, reset or a settings file"); },
    read: (store, owner) => ({ ...readPolicy(store, owner) }),
    // A move of the preset is weighed by what the policy answers before and after it, the owner's own
    // rules included; its place in the list of options is only a label (src/preset-moves.ts).
    weigh: (store, owner, field, to, tools) =>
      field === "preset" ? presetMoveLooser(readPolicy(store, owner), to as PolicyPresetName, tools) : undefined,
  },
  one("approval_reviewer", "A second look before approvals", "settings-kit.name.reviewer", "settings:permissions", "guard",
    { write: (store, owner, patch) => { saveReviewerSettings(store, owner, patch); }, read: (store, owner) => ({ ...reviewerSettings(store, owner) }) }),
  shipsAs(one("loop_guard", "Stopping repeated steps", "settings-kit.name.loop-guard", "settings:permissions", "guard",
    { write: (store, owner, patch) => { saveLoopGuardSettings(store, owner, patch); }, ...modeFrom(loopGuardMode) }), loopGuardShipsAs),
  one("folder_trust_mode", "Trusted folders", "settings-kit.name.folder-trust", "settings:permissions", "guard",
    { write: (store, owner, patch) => { saveFolderTrustSettings(store, owner, patch); }, ...modeFrom(folderTrustMode) }),
  {
    key: "security-check", name: "Security self-check", t: "settings-kit.name.security-check", home: "settings:permissions",
    fields: [sw("audit", "Check by itself", "settings-kit.field.audit", "guard"),
      sw("malware", "Check add-ons for malware", "settings-kit.field.malware", "guard")],
    // The window hands in the service's own save, which also adds or takes away the check's tool.
    write: (store, owner, patch) => { saveSecurityCheckSettings(store, owner, patch); },
    read: (store, owner) => ({ ...securityCheckSettings(store, owner) }),
  },
  {
    key: "os-sandbox", name: "The wall around programs", t: "settings-kit.name.os-sandbox", home: "settings:computer",
    fields: [sw("mode", "Switch", "settings-kit.field.switch", "guard"),
      { field: "network", label: "What programs behind the wall may reach", t: "settings-kit.field.wall-network", guard: "guard",
        initial: "none", kind: { type: "choice", options: ["none", "limited", "per-site", "open"] } }],
    write: saveWall,
    read: (store, owner) => ({ ...wallSettings(store, owner) }),
  },
  // mac7/r17-g integration review: the checks that only tighten are guards. Authenticator codes and the
  // emergency stop are never reached from here (see neverTouched): each needs the owner at its own card.
  safetyPart("command-scan", "Checking commands for tricks", "guard"),
  safetyPart("progress-judge", "Asking whether a long task is getting anywhere", "guard"),
  safetyPart("activity-chain", "A tamper-evident record", "guard"),
];

const reach: SettingSpec[] = [
  one("desktop-control", "Your screen and keyboard", "settings-kit.name.desktop", "settings:computer", "reach", { keepsEnabled: true, ...desktopHooks }),
  one("keychain-entries", "Passwords from the Keychain", "settings-kit.name.keychain", "settings:secrets", "reach",
    { keepsEnabled: true, write: (store, owner, patch) => { saveKeychainSettings(store, owner, patch); }, read: (store, owner) => ({ ...readKeychainSettings(store, owner) }) }),
  // mac7/vault-autofill (R17-068): turning this on lets Branch type a saved password into a page, so
  // it reaches further. Only the switch is here: the book of which item goes with which site is the
  // owner's own, written at its card, and nothing brought in from a file or a preset may write one.
  one("vault-autofill", "Filling a saved sign-in", "settings-kit.name.vault-autofill", "settings:secrets", "reach",
    { keepsEnabled: true, write: (store, owner, patch) => { saveVaultAutofillSettings(store, owner, patch); }, read: (store, owner) => ({ ...readVaultAutofillSettings(store, owner) }) }),
  {
    key: "voice", name: "Voice", t: "settings-kit.name.voice", home: "settings:voice",
    fields: [sw("systemVoice", "Your computer's own voice", "settings-kit.field.system-voice", "reach"),
      yesNo("autoReadAloud", "Read replies aloud automatically", "settings-kit.field.read-aloud", "plain"),
      { field: "readAloudWhen", label: "Which replies are read aloud", t: "settings-kit.field.read-aloud-when", guard: "plain", initial: "always", kind: { type: "choice", options: ["always", "spoken"] } },
      yesNo("keepAudioOnThisComputer", "Keep audio on this computer", "settings-kit.field.keep-audio", "guard"),
      yesNo("replyWithVoiceOnChannels", "Answer a voice note with a voice note", "settings-kit.field.voice-reply", "reach")],
    ...voiceHooks,
  },
  one("media-programs", "Watching and saving videos", "settings-kit.name.video", "settings:models:media", "reach",
    parsedBy("media-programs", () => MediaProgramsSchema)),
  one("speech-engines", "Other speech services", "settings-kit.name.speech", "settings:voice", "reach",
    parsedBy("speech-engines", () => SpeechEngineSettingsSchema)),
  one("execution-metrics", "Sending the counters", "settings-kit.name.counters", "settings:advanced", "reach", { keepsEnabled: true,
    read: (store, owner) => ({ ...executionMetricsSettings(store, owner) }), write: (store, owner, patch) => { saveExecutionMetricsSettings(store, owner, patch); } }),
  // mac7/usage-bar: reading an allowance out of the headers on Branch's own answers is always on and
  // costs nothing. This switch is only for the one service Branch may ask outright — OpenRouter's
  // documented key endpoint. It ships "when needed" (the owner's rule): asking the owner's own
  // connection what is left sends nothing of theirs anywhere. No plan account is ever asked, switch or no switch.
  one("usage-limits", "Asking a service what is left", "settings-kit.name.usage-limits", "settings:data", "reach",
    { keepsEnabled: true, write: (store, owner, patch) => { saveUsageLimitsSettings(store, owner, patch); }, read: (store, owner) => ({ ...usageLimitsSettings(store, owner) }) }),
  shipsAs(one("asks-analytics", "Counting how Branch is used", "settings-kit.name.analytics", "settings:data", "reach", askHooks("analytics")), askShips("analytics")),
  shipsAs(one("asks-answer-engine", "Quick answers from the web", "settings-kit.name.answers", "library:made", "reach", askHooks("answer-engine")), askShips("answer-engine")),
  shipsAs(one("asks-runtimes", "Other agents answering a conversation", "settings-kit.name.runtimes", "settings:models:connection", "reach", askHooks("runtimes")), askShips("runtimes")),
  shipsAs(one("asks-nodes", "Other computers running Branch", "settings-kit.name.nodes", "settings:computer", "reach", askHooks("nodes")), askShips("nodes")),
  // mac7/bind: moving Branch's own door off this computer's loopback lets anything on the private
  // network reach it, so raising it reaches further. It is a choice of two and never an address to
  // type: nothing brought in from a file or a preset may name where this computer listens.
  {
    key: "listen-address", name: "Where Branch listens", t: "settings-kit.name.listen-address",
    home: "settings:computer",
    fields: [{ field: "where", label: "Where Branch listens", t: "settings-kit.field.listen-where",
      guard: "reach", initial: "this-computer", kind: { type: "choice", options: [...listenPlaces] } }],
    write: (store, owner, patch) => { saveListenSettings(store, owner, patch); },
    // The kit shows what the door is really doing, the way it does for the wall: a container that was
    // started with BRANCH_LISTEN has asked for the wider door whatever the saved record says, and
    // that is what the owner should see here. Turning it off there is done where the container is
    // started, not on this card.
    read: ownListen,
  },
  one("move-in-switch", "Looking at other assistants' folders", "settings-kit.name.move-in", "settings:data", "reach",
    { fields: [{ ...sw("mode", "Switch", "settings-kit.field.switch", "reach"), initial: moveInShipsAs }], // p17: ships at "when needed"
      ...modeFrom(moveInMode), write: (store, owner, patch) => { saveMoveInMode(store, owner, { mode: moveInMode(store, owner), ...patch }); } }),
  one("memory-history", "Keeping the history of what it remembers", "settings-kit.name.memory-history", "library:memory", "reach",
    parsedBy("memory-history", () => MemoryHistorySettingsSchema)),
  one("pull-request-hook", "Pull requests from changes", "settings-kit.name.pull-requests", "settings:advanced", "reach",
    parsedBy("pull-request-hook", () => PullRequestHookSettingsSchema)),
  one("skill-installs", "Installing skills from a file", "settings-kit.name.skill-installs", "customize:skills", "reach",
    parsedBy("skill-installs", () => SkillInstallSettingsSchema)),
  one("workspace-editor", "Code editor", "settings-kit.name.code-editor", "settings:advanced", "reach",
    parsedBy("workspace-editor", () => WorkspaceEditorSettingsSchema)),
  // mac7/chat-allowlist: a chat's task holds a short read-and-answer list; this switch lets the
  // owner's own lines add to it, so raising it is reaching further. The lines themselves are not a
  // field here on purpose: nothing brought in from a file or a preset can ever write one.
  {
    key: "chat-permissions", name: "What a chat may do beyond talking", t: "settings-kit.name.chat-permissions",
    home: "customize:channels",
    fields: [yesNo("extras", "Use my list of what chats may also do", "settings-kit.field.chat-extras", "reach")],
    write: (store, owner, patch) => { saveChatPermissionSettings(store, owner, patch); },
    read: (store, owner) => ({ ...readChatPermissionSettings(store, owner) }),
  },
  // mac7/wake-pins: listening for a word holds the microphone open by itself, so turning it up
  // reaches further. The word itself is deliberately not a field here: nothing brought in from a
  // file or a preset may ever choose what this computer listens for.
  {
    key: "wake-word", name: "A word that starts a turn", t: "settings-kit.name.wake-word", home: "settings:voice",
    read: (store, owner) => inForce(WakeWordSettingsSchema, store.get("settings", owner, wakeWordKey)?.data),
    // Written onto what is in force, never onto a record the app would not run: a change here cannot bring an
    // unreadable mode back to life (a stored "on" the app ignores stays ignored).
    write: (store, owner, patch) => { store.save("settings", owner, wakeWordKey, WakeWordSettingsSchema.parse({ ...inForce(WakeWordSettingsSchema, store.get("settings", owner, wakeWordKey)?.data), ...patch })); },
    fields: [sw("mode", "Switch", "settings-kit.field.switch", "reach"),
      { field: "sureness", label: "How sure it must be before it answers", t: "settings-kit.field.wake-sureness",
        guard: "guard", initial: 80, kind: { type: "number", min: 50, max: 99 } }],
  },
  // mac7/live-voice: dictation holds the microphone open while it listens, so turning it up reaches
  // further. Waiting through more silence keeps it open longer. Neither field can start listening:
  // nothing brought in from a file or a preset starts it, because only a press at this window can.
  {
    key: "live-dictation", name: "Speak and see the words", t: "settings-kit.name.live-dictation", home: "settings:voice",
    read: (store, owner) => inForce(DictationSettingsSchema, store.get("settings", owner, dictationKey)?.data),
    // Written onto what is in force, never onto a record the app would not run: a change here cannot bring an
    // unreadable mode back to life (a stored "on" the app ignores stays ignored).
    write: (store, owner, patch) => { store.save("settings", owner, dictationKey, DictationSettingsSchema.parse({ ...inForce(DictationSettingsSchema, store.get("settings", owner, dictationKey)?.data), ...patch })); },
    fields: [sw("mode", "Switch", "settings-kit.field.switch", "reach"),
      { field: "silenceSeconds", label: "How long a quiet room ends it", t: "settings-kit.field.dictation-silence",
        guard: "reach", initial: 4, kind: { type: "number", min: 1, max: 30, fractions: true } }],
  },
  // Defaults audit (2026-09-28): ships "when needed" (src/sdk-kit-switch.ts sdkKitShipsAs), read as the module reads it.
  shipsAs(one("sdk-kit", "Tools for building on Branch", "settings-kit.name.sdk-kit", "settings:advanced", "reach", modeFrom(sdkKitMode)), sdkKitShipsAs),
  // RES-719: GitLab ships "when needed" (src/gitlab-switch.ts); it does nothing until a token is saved, and each change on GitLab asks first.
  shipsAs(one("gitlab-connection", "GitLab", "settings-kit.name.gitlab-connection", "settings:advanced", "reach", modeFrom(gitlabMode)), gitlabShipsAs),
  // r17-i integration review: every reach and platform switch reaches further when raised (src/reach/settings.ts).
  // src/server.ts saves them through Reach, so the tools and the relay follow the switch at once.
  // Q65: shown as saved, not as Lockdown reads it (`reachMode`), so a change is weighed against the owner's own switch.
  ...reachParts.map((part) => shipsAs(one(reachKey(part), reachLabels[part], `reach.part.${part}`, reachHomes[part], "reach",
    modeFrom((store, owner) => savedReachMode(store, owner, part))), reachShipsOn[part] ?? "off")),
  safetyPart("tool-scripts", "Scripts that call several tools at once", "reach"),
  safetyPart("wasm-add-ons", "Add-ons in a sealed WebAssembly box", "reach"),
  // r17-h: checks run tools and scripts, widgets ask tools on a timer, and requests reach the package lists.
  board("recipe-checks", "Checks for saved procedures", "automations:procedures", "reach"),
  board("widgets", "Widgets the assistant builds", "library:made", "reach"),
  board("install-requests", "Requests for packages and tool servers", "inbox:needs", "reach"),
];

/** The round limit's word for "no figure of the owner's own": Branch then gives each task its own. */
const roundsUnset = "auto";
/** A task limit's word for no limit at all; the knob keeps it as `noLimit`. */
const unlimitedWord = "no limit";
/** What a task limit's "auto" is, said once for all three (src/knobs/apply.ts taskBudget). */
const autoSplit = "no limit while a sign-in (a ChatGPT or Claude plan) or a model on this computer answers, since those cost nothing more per token";
/** A task limit as the settings tools show it, and back: a figure, "auto" or "no limit". */
const limitShown = (saved: number | typeof noLimit | null): number | string => saved === noLimit ? unlimitedWord : saved ?? roundsUnset;
const limitSaved = (value: unknown): number | typeof noLimit | null => value === roundsUnset ? null : value === unlimitedWord ? noLimit : value as number;

const comfort: SettingSpec[] = [
  {
    key: "seasons", name: "Seasons overnight learning", t: "seasons.settings-title", home: "settings:developer",
    fields: [
      { field: "rings", label: "Rings overnight memory", t: "seasons.settings-rings", guard: "reach", initial: "on",
        kind: { type: "choice", options: ["off", "on"] } },
      { field: "gardener", label: "Gardener skill improvements", t: "seasons.settings-gardener", guard: "reach", initial: "on",
        kind: { type: "choice", options: ["off", "on"] } },
      { field: "nightFrom", label: "Night starts at hour", t: "seasons.settings-from", guard: "plain", initial: 1,
        kind: { type: "number", min: 0, max: 23 } },
      { field: "nightTo", label: "Night ends at hour", t: "seasons.settings-to", guard: "plain", initial: 6,
        kind: { type: "number", min: 0, max: 23 } },
      { field: "idleMinutes", label: "Idle minutes before learning", t: "seasons.settings-idle", guard: "guard", initial: 30,
        kind: { type: "number", min: 5, max: 720 } },
      yesNo("paidModels", "Use paid models overnight", "seasons.settings-paid", "reach"),
      { field: "minGainPercent", label: "Minimum skill gain in percentage points", t: "seasons.settings-gain", guard: "guard", initial: 10,
        kind: { type: "number", min: 1, max: 100, fractions: true } },
    ],
    read: (store, owner) => {
      const value = seasonsSettings(store, owner);
      return { ...value, minGainPercent: value.minGain * 100 };
    },
    write: (store, owner, patch) => {
      // The catalogue uses whole percentage points; the engine keeps gain on its original 0..1 scale.
      const { minGainPercent, ...rest } = patch;
      saveSeasonsSettings(store, owner, { ...rest, ...(typeof minGainPercent === "number" ? { minGain: minGainPercent / 100 } : {}) });
    },
  },
  one("local-models", "Models on this computer", "settings-kit.name.local-models", "settings:models:local", "plain", { keepsEnabled: true,
    ...modeFrom(localModelsMode), write: (store, owner, patch) => { saveLocalModelsMode(store, owner, { mode: localModelsMode(store, owner), ...patch }); } }),
  // mac7/one-click (issue #107): installing a program that runs models is the one thing here that
  // changes the owner's own computer, so it is its own switch and counts as reach.
  one("local-runner-install", "Installing a program that runs models", "settings-kit.name.local-runner-install",
    "settings:models:local", "reach"),
  // mac7/clean-uninstall: what Branch fetches goes inside Branch, so removing Branch removes it.
  // Allowing a system installer puts it outside Branch and leaves it behind, so it reaches further.
  {
    key: "local-runner-place", name: "Where a program that runs models is installed",
    t: "settings-kit.name.local-runner-place", home: "settings:models:local",
    fields: [yesNo("systemWide", "Allow installing outside Branch", "settings-kit.field.system-wide", "reach")],
  },
  // mac7/adapt: getting what a stopped task is missing installs programs and spends the owner's
  // disk, so turning it up reaches further. The install itself still goes through the one button
  // above, which asks its own switch again, so this can never install behind that switch's back.
  one("adapt", "Getting what a stopped task is missing", "settings-kit.name.adapt",
    "settings:models:local", "reach"),
  one("usage-report", "Usage report", "settings-kit.name.usage-report", "settings:data", "plain", { keepsEnabled: true,
    read: (store, owner) => ({ ...usageReportSettings(store, owner) }), write: (store, owner, patch) => { saveUsageReportSettings(store, owner, patch); } }),
  one("event-loop-watch", "Whether Branch is keeping up", "settings-kit.name.event-loop", "settings:advanced", "plain",
    { write: (store, owner, patch) => { eventLoopWatch.follow(saveEventLoopSettings(store, owner, { ...eventLoopSettings(store, owner), ...patch })); },
      read: (store, owner) => ({ ...eventLoopSettings(store, owner) }) }),
  one("run-recording", "Recording each task", "settings-kit.name.recording", "inbox:history", "plain",
    parsedBy("run-recording", () => RecordingSettingsSchema)),
  one("prompt-library", "Saved prompts", "settings-kit.name.prompts", "automations:procedures", "plain",
    parsedBy("prompt-library", () => PromptLibrarySettingsSchema)),
  // Settings › General's switch is this computer's own window's (src/commands/settings.ts windowCommands): read as the
  // window reads it, so a switch never saved shows on, and saved (or put back) for the window alone, never the phone's
  // or the chat apps'.
  shipsAs(one("command-catalog", "The shared commands", "settings-kit.name.commands", "settings:general", "plain", {
    read: (store, owner) => ({ ...windowCommands(store, owner) }),
    write: (store, owner, patch) => { saveWindowCommands(store, owner, { ...windowCommands(store, owner), ...patch }); } }),
  windowShipsAs),
  shipsAs(one("asks-project-board", "Project boards", "settings-kit.name.project-board", "settings:general", "plain", askHooks("project-board")), askShips("project-board")),
  // Saved through the learning core's own switch (src/settings-kit/writers.ts), which also adds or takes away its tool.
  one("fly-core", "What Branch learns from experience", "settings-kit.name.fly-core", "library:memory", "plain",
    { read: (store, owner) => ({ ...flyCoreSettings(store, owner) }) }),
  safetyPart("history-repair", "Tidying a conversation before it is sent", "guard"), // "repair" reads as safety-shaped (pair), so it is a guard
  // r17-h: going back in a flow, the shared board, the waiting line and focus view only rearrange the owner's own work.
  board("time-travel", "Going back in a flow", "automations:procedures", "plain"),
  board("kanban", "The shared board", "automations:scheduled", "plain"),
  board("waiting-line", "Changing the waiting line", "automations:scheduled", "plain"),
  board("focus", "Focus view", "settings:appearance", "plain"),
  {
    key: "goal-undo", name: "Goals and going back", t: "settings-kit.name.goal-undo", home: "settings:data",
    // Working on until a goal is met is the assistant acting on its own; the snapshots are what lets you go back.
    fields: [sw("goal", "Keep working until a goal is met", "settings-kit.field.goal", "reach"),
      sw("snapshots", "Record the files before a task", "settings-kit.field.snapshots", "guard")],
    ...parsedBy("goal-undo", () => GoalUndoSettingsSchema),
  },
  {
    key: "reflection", name: "Looking back over conversations", t: "settings-kit.name.reflection", home: "library:memory",
    fields: [sw("reflection", "Looking back", "settings-kit.field.reflection", "plain"),
      sw("newSkills", "Writing new skills from experience", "settings-kit.field.new-skills", "reach")],
    // Saved through the learning loop (src/settings-kit/writers.ts).
    read: (store, owner) => ({ ...reflectionSettings(store, owner) }),
  },
  {
    key: "context-files", name: "The files you write", t: "settings-kit.name.context-files", home: "settings:general",
    fields: ["soul", "identity", "user", "agents", "tools", "sop", "memory", "heartbeat"].map((slot) =>
      sw(`files.${slot}`, `${slot.toUpperCase()}.md`, `settings-kit.field.file-${slot}`, "plain")),
    read: (store, owner) => ({ ...contextFileSettings(store, owner) }),
    write: contextFilesWrite,
  },
  {
    key: "retention", name: "How long conversations are kept", t: "settings-kit.name.retention", home: "settings:data",
    fields: [yesNo("enabled", "Offer to delete old conversations", "settings-kit.field.retention", "plain"),
      { field: "keepDays", label: "Older than this many days", t: "settings-kit.field.keep-days", guard: "plain",
        initial: 0, kind: { type: "number", min: 0, max: 3650 } }],
    write: (store, owner, patch) => { saveRetentionSettings(store, owner, { ...retentionSettings(store, owner), ...patch }); },
    read: (store, owner) => ({ ...retentionSettings(store, owner) }),
    // Keeping conversations longer is less careful, as POST /api/retention holds it (src/retention.ts retentionLooser).
    weigh: (store, owner, field, to) => {
      const before = retentionSettings(store, owner);
      return retentionLooser(before, { ...before, [field]: to } as typeof before);
    },
  },
  // The round limit is the owner's own knob (src/knobs/settings.ts, limits.maxModelRounds), so Branch's settings tools
  // can find it and change it on the owner's yes. The knob records stay on the never-touched list: this reads and
  // writes that one field and nothing else. More rounds spend only on the connected model, so it is plain; so is
  // "no limit", which the loop guard and the spending caps still watch.
  {
    key: "round-limit", name: "Round limit", t: "settings-kit.name.round-limit", home: "settings:advanced",
    fields: [{ field: "maxModelRounds", label: "Model rounds (steps) per task", t: "settings-kit.field.round-limit", guard: "plain",
      initial: roundsUnset, kind: { type: "number", min: 2, max: 500, unset: roundsUnset, unlimited: unlimitedWord },
      note: `${roundsUnset}: ${autoSplit}; on an API key 12 rounds, or ${codingModelRounds} when the task works on the project's files. "${unlimitedWord}" never stops a task for its rounds.` }],
    // The knob's empty value (null) is "auto", so putting it back, or undoing a change, leaves no figure at all.
    read: (store, owner) => ({ maxModelRounds: limitShown(readKnobs(store, owner, "limits").maxModelRounds) }),
    write: (store, owner, patch) => {
      saveKnobs(store, owner, "limits", { maxModelRounds: limitSaved(patch.maxModelRounds) });
    },
  },
  // The step limit of one task (limits.maxSteps): model rounds and tool steps together.
  {
    key: "step-limit", name: "Step limit", t: "settings-kit.name.step-limit", home: "settings:advanced",
    fields: [{ field: "maxSteps", label: "Most steps in one task", t: "knobs.field.maxSteps", guard: "plain",
      initial: roundsUnset, kind: { type: "number", min: 1, max: 500, unset: roundsUnset, unlimited: unlimitedWord },
      note: `${roundsUnset}: ${autoSplit}; 60 on an API key. "${unlimitedWord}" never stops a task for its steps.` }],
    read: (store, owner) => ({ maxSteps: limitShown(readKnobs(store, owner, "limits").maxSteps) }),
    write: (store, owner, patch) => {
      saveKnobs(store, owner, "limits", { maxSteps: limitSaved(patch.maxSteps) });
    },
  },
  // selfdev: the token allowance of one task, the owner's own knob (limits.maxTaskTokens). More tokens spend only on
  // the connected model, so it is plain, like the round limit; "auto" splits by the kind of connection.
  {
    key: "task-tokens", name: "Tokens per task", t: "settings-kit.name.task-tokens", home: "settings:advanced",
    // The kit's own name for the field: a name with "token" in it reads as a secret (secretShaped) and is never changed here.
    fields: [{ field: "taskAllowance", label: "Tokens one task may use", t: "settings-kit.field.task-tokens", guard: "plain",
      initial: roundsUnset, kind: { type: "number", min: 20_000, max: 20_000_000, unset: roundsUnset, unlimited: unlimitedWord },
      note: `${roundsUnset}: ${autoSplit}; 200,000 on an API key. "${unlimitedWord}" never stops a task for its tokens. Otherwise 20,000 to 20,000,000, counting every request the task sends to the model.` }],
    read: (store, owner) => ({ taskAllowance: limitShown(readKnobs(store, owner, "limits").maxTaskTokens) }),
    write: (store, owner, patch) => {
      saveKnobs(store, owner, "limits", { maxTaskTokens: limitSaved(patch.taskAllowance) });
    },
  },
];

/**
 * R17-S-C integration review: the comfort cards' switches and short lists (src/comfort/settings.ts),
 * saved through the cards' own checks. The proxy, the certificates, the browser's care and automatic
 * installing are not here and are on the never-touched list: no preset or file may set them.
 */
const viaComfort = (card: ComfortCard): Hooks => ({
  write: (store, owner, patch) => { saveComfort(store, owner, card, patch); },
  read: (store, owner) => ({ ...readComfort(store, owner, card) as Record<string, unknown> }),
});
const comfortCards: SettingSpec[] = [
  { key: "comfort-keys", name: "Shortcuts", t: "comfort.keys.title", home: "settings:general", ...viaComfort("keys"),
    fields: [yesNo("vim", "Vim keys in the message box", "comfort.field.vim", "plain")] },
  { key: "comfort-display", name: "Status line and times", t: "comfort.display.title", home: "settings:appearance", ...viaComfort("display"),
    fields: [yesNo("timestamps", "A time on every message", "comfort.field.timestamps", "plain"),
      yesNo("hideTimes", "No time on messages, even on hover", "comfort.field.hideTimes", "plain")] },
  { key: "comfort-notify", name: "Notifications and sound", t: "comfort.notify.title", home: "settings:notifications", ...viaComfort("notify"),
    fields: [
      { field: "method", label: "Where you are told", t: "comfort.field.method", guard: "plain", initial: "system", kind: { type: "choice", options: ["system", "window"] } },
      { field: "sound", label: "Sound", t: "comfort.field.sound", guard: "plain", initial: "off", kind: { type: "choice", options: ["off", "chime", "knock"] } },
      yesNo("needsYes", "A Trunk needs a yes", "comfort.field.needsYes", "plain", true),
      yesNo("taskDone", "A long task finishes", "comfort.field.taskDone", "plain", true),
    ] },
  { key: "comfort-files", name: "Ignore files", t: "comfort.files.title", home: "settings:general", ...viaComfort("files"),
    // Turning .gitignore off lets searches see more of the workspace (never a secret file).
    fields: [yesNo("respectGitignore", "Skip what .gitignore lists", "comfort.field.respectGitignore", "guard", true)] },
  { key: "comfort-mcp", name: "Tool servers' start-up time", t: "comfort.mcp.title", home: "customize:connections", ...viaComfort("mcp"),
    fields: [{ field: "startupTimeoutSeconds", label: "Seconds a server may take to start", t: "comfort.field.startupTimeoutSeconds",
      guard: "plain", initial: 10, kind: { type: "number", min: 1, max: 300 } }] },
];

/**
 * The owner's rule (ships on, 2026-09-26, src/ship-on.ts): what each flipped field starts at, so putting a setting back,
 * undoing to its starting value and weighing a change all measure from how Branch really ships. Each value is the one
 * its own module ships (named there); a test holds the two together.
 */
export const shipOnInitials: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "prompt-library": { mode: "on" }, "run-recording": { mode: "when-needed" }, "event-loop-watch": { mode: "when-needed" },
  "usage-report": { mode: "when-needed" }, "usage-limits": { mode: "when-needed" }, "execution-metrics": { mode: "when-needed" },
  "local-models": { mode: "when-needed" }, "media-programs": { mode: "when-needed" }, "memory-history": { mode: "when-needed" }, "skill-installs": { mode: "when-needed" },
  "workspace-editor": { mode: "when-needed" }, "speech-engines": { mode: "when-needed" }, "fly-core": { mode: "when-needed" },
  "security-check": { audit: "when-needed", malware: "when-needed" }, reflection: { newSkills: "when-needed" },
  "goal-undo": { goal: "on" }, voice: { systemVoice: "when-needed" }, "comfort-notify": { sound: "chime" },
  "context-files": Object.fromEntries(["soul", "identity", "user", "agents", "tools", "sop", "memory", "heartbeat"].map((slot) => [`files.${slot}`, "when-needed"])),
};
const shipped = (spec: SettingSpec): SettingSpec => {
  const initials = shipOnInitials[spec.key];
  return initials ? { ...spec, fields: spec.fields.map((field) => (field.field in initials ? { ...field, initial: initials[field.field]! } : field)) } : spec;
};
export const settingsCatalogue: readonly SettingSpec[] = [...safety, ...reach, ...comfort, ...comfortCards].map(shipped);

/**
 * Records that are never touched from here, whatever a file or a preset names. The catalogue above
 * does not name them either; this list is the second lock, and the one a crafted file meets first.
 */
export const neverTouched: readonly RegExp[] = [
  /^lockdown$/, /^session-lock$/, /^model-connections/, /^local-model-connections$/, /^local-model-setups$/,
  /^secret/, /^credential/, /^people/, /^remote/, /pairing/, /^deferred:/, /^move-in:/,
  /^feature-switches-migration$/, /^webhook-addresses$/, /^sender-allowlist$/, /^telegram-setup$/,
  // mac7/lockout: which chat service is being turned away, as the Connections card shows it.
  // Branch writes it; a file or a preset that could write it could tell the owner a service was
  // fine while it was being refused, or invent one that was not.
  /^webhook-waits$/,
  // Integration review: accounts, add-on lists and their wall, the leak guard, what is passed on to
  // programs, never-break and its gateway, tunnels and the launch file are never reached from here.
  /^accounts?(-|$)/, /^add-?ons?/, /leak/, /^knobs?/, /env/, /^never-break/, /gateway/, /tunnel/, /launch/,
  // mac7/r17-g integration review: authenticator codes (loosening them needs a code) and the emergency stop.
  /^safety-code-approvals/, /^safety-emergency-stop/,
  // R17-S-C integration review: the proxy and certificates, the browser's care, and updating by itself.
  /^comfort-(network|browser|update)/,
  // mac7/lockdown-fix: the limit a task put on a flow run it started is never loosened from here.
  /^flow-run-limit:/,
  // mac7/outside-resume: nor is who set a flow run going from outside.
  /^flow-run-source:/,
  // mac7/wake-pins: the list of settings the owner pinned. Pinning is the owner's alone, and a
  // preset or a settings file that named this record could otherwise unpin everything at once.
  /^settings-pins$/,
];

/** A field name that sounds like it could hold a secret is refused outright, whatever the catalogue says. */
export const secretShaped = /key|token|secret|password|passphrase|credential|cookie|auth/i;

/**
 * A setting whose name sounds like safety or reach. Should one of its fields ever be written down as
 * "plain", any move of it still counts as less careful (src/settings-kit/changes.ts, loosens).
 */
export const securityShaped =
  /sandbox|trust|polic|approv|review|guard|never|wall|add-?on|page-?note|web-?page|autonom|connector|tunnel|knob|env|leak|lock|keychain|desktop|remote|pair|secret|credential|account|people|gateway|launch|security|goal|skill|plan-act|orchestrat|permission/i;

/**
 * What a setting's field is, for anything that has to decide about it. Fails closed: a setting or
 * field that is not in the catalogue, or is on the never-touched list, is "blocked", including every
 * setting added after this was written.
 */
export type Classification = "blocked" | "plain" | "less-careful-when-raised" | "less-careful-when-lowered" | "less-careful-either-way";
export function classify(key: string, field: string): Classification {
  const spec = specFor(key);
  const found = spec?.fields.find((entry) => entry.field === field);
  if (!spec || !found || secretShaped.test(field)) return "blocked";
  if (found.guard === "plain") return securityShaped.test(key) ? "less-careful-either-way" : "plain";
  return found.guard === "reach" || found.kind.type === "choice" ? "less-careful-when-raised" : "less-careful-when-lowered";
}

export function specFor(key: string): SettingSpec | undefined {
  if (neverTouched.some((pattern) => pattern.test(key))) return undefined;
  return settingsCatalogue.find((spec) => spec.key === key);
}
