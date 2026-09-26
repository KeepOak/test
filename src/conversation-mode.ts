import { z } from "zod";
import { optionalFields } from "./feature-switches.js"; // Q65
import type { Store } from "./store.js";
import { presetRules, type Policy, type PolicyPresetName, type PolicyRule } from "./policy.js";

/**
 * Redesign phase 1: how much the assistant may do in one conversation, picked from the message box.
 *
 *   ask   Ask first     reading is free; any change, command or web action waits for a yes
 *   plan  Plan          reads and proposes; changes nothing (a change is refused, not asked about;
 *                       a web action is asked about, so Plan is never looser than Ask first)
 *   auto  Auto          changes inside the workspace go ahead; commands and the web ask
 *
 * Q59: a web action is any tool that reaches beyond the workspace (src/tool-reach.ts): it sends a
 * request over the network, or acts on a web page or another program's window. The registry says
 * which tools those are, and Ask first, Plan and Auto each ask before every one of them.
 *   full  Full access   nothing is checked with you (commands no rule covers still ask, as always)
 *
 * The rule that decides what a conversation may do:
 *
 * 1. A conversation with no mode of its own follows the owner's setting, exactly as before. Only a
 *    conversation started in the window after this change is given one (Ask first), so every older
 *    conversation behaves as it did.
 * 2. A mode replaces the preset part of the owner's setting for that conversation. The owner's own
 *    rules that name something (a folder, a website, a remembered command) and every refusal they
 *    wrote still apply; "Ask first" and "Plan" also drop every yes, so they are never looser than
 *    they say.
 * 3. The owner may pick a mode looser than their setting: it is their computer and their choice.
 *    Somebody else in the house never can; their tasks keep the owner's setting when theirs is looser.
 * 4. It sits under everything that was already stronger: Lockdown (only Plan can tighten it further),
 *    the hold on tasks started from outside (a chat app, a trigger, a schedule: never more than Ask
 *    first), roles, the protected areas and the other guards in src/runtime.ts `checkPolicy`.
 */
export const conversationModes = ["ask", "plan", "auto", "full"] as const;
export type ConversationMode = (typeof conversationModes)[number];
export const ConversationModeSchema = z.enum(conversationModes);
/** What a conversation started in the window gets until somebody picks another. */
export const newConversationMode: ConversationMode = "ask";

const modePreset: Record<ConversationMode, Exclude<PolicyPresetName, "custom">> = {
  ask: "ask-before-changes", plan: "read-only", auto: "workspace", full: "off",
};
/** How loose each mode and each of the owner's presets is, strictest first. */
const modeRank: Record<ConversationMode, number> = { plan: 0, ask: 1, auto: 2, full: 3 };
const presetRank: Record<PolicyPresetName, number> = { "read-only": 0, "ask-before-changes": 1, custom: 1, workspace: 2, off: 3 };
/** True when the mode would let through more than the owner's own setting does. */
export const looserThan = (mode: ConversationMode, preset: PolicyPresetName): boolean => modeRank[mode] > presetRank[preset];

const sameRule = (a: PolicyRule, b: PolicyRule): boolean => JSON.stringify(a) === JSON.stringify(b);
/** The owner's rules that are theirs, not the lines their preset expanded to. */
function ownRules(policy: Policy): PolicyRule[] {
  const expanded = presetRules(policy.preset);
  return policy.rules.filter((rule) => !expanded.some((line) => sameRule(line, rule)));
}
/** A yes that covers everything of a kind, rather than one named thing. */
const broadYes = (rule: PolicyRule): boolean => rule.decision === "allow" && !rule.resource && rule.match === "*";

/**
 * Q59: a question before each tool that reaches beyond the workspace. The tools come from the
 * registry (`outboundTools`), so a tool added later is covered by what it does, not by a list here.
 * Auto remembers a standing yes per website, as its preset does for the web; Ask first and Plan keep
 * no standing yes at all (src/runtime.ts `approve`), so their lines only suggest the conversation.
 */
function outboundLines(outbound: readonly string[], mode: ConversationMode): PolicyRule[] {
  const remember = mode === "auto" ? "always" : "session";
  return outbound.map((tool) => ({ tool, match: "*", applies: "any", decision: "ask", remember }));
}
/**
 * Q59: the owner's own questions, as Plan keeps them. Plan refuses every change, so an owner's
 * question can only ever be about a read there: one that could also cover a change becomes one that
 * covers reads only, so a folder rule that asks before writing can never turn Plan's refusal into a
 * question (a rule naming a folder is weighed before Plan's own broad refusal, src/policy.ts).
 */
const planQuestions = (own: PolicyRule[]): PolicyRule[] =>
  own.filter((rule) => rule.decision === "ask" && rule.applies !== "changes").map((rule) => ({ ...rule, applies: "reads" as const }));

/**
 * The policy one conversation is held to, before the outside hold and Lockdown's own checks.
 * `outbound` is every registered tool that reaches beyond the workspace (src/registry.ts).
 *
 *   plan  Plan's refusal of every change, then the owner's refusals and questions, then a question
 *         before each outbound tool; anything else only looks, and goes ahead
 *   ask   the owner's refusals and questions, then a question before every change and every outbound tool
 *   auto  the owner's rules except a broad yes, the workspace preset, then a question before every outbound tool
 *   full  the owner's rules except a broad yes
 */
export function policyForMode(policy: Policy, mode: ConversationMode, locked = false, outbound: readonly string[] = []): Policy {
  const lines = [...presetRules(modePreset[mode]), ...(mode === "full" ? [] : outboundLines(outbound, mode))];
  if (locked) return mode === "plan" ? { ...policy, rules: [...lines, ...policy.rules] } : policy;
  const own = ownRules(policy);
  if (mode === "plan") {
    const [refusal, ...questions] = lines;
    return { ...policy, rules: [refusal!, ...own.filter((rule) => rule.decision === "deny"), ...planQuestions(own), ...questions] };
  }
  if (mode === "ask") return { ...policy, rules: [...own.filter((rule) => rule.decision !== "allow"), ...lines] };
  return { ...policy, rules: [...own.filter((rule) => !broadYes(rule)), ...lines] };
}

/* ---------- what a new conversation starts on ---------- */

/**
 * The owner's one switch for the default: a conversation begun in the window starts on one of the four
 * modes (Ask first unless the owner picks another), or follows their setting the way every conversation
 * used to. The mode picked here goes through `policyForMode` and every guard, exactly like the chip.
 */
export const newConversationChoices = [...conversationModes, "follow"] as const;
export const ConversationModeSettingsSchema = z.object({
  newConversation: z.enum(newConversationChoices).default(newConversationMode),
}).strict();
export type ConversationModeSettings = z.infer<typeof ConversationModeSettingsSchema>;
const settingsKey = "conversation-mode-settings";
export function conversationModeSettings(store: Pick<Store, "get">, owner: string): ConversationModeSettings {
  const saved = ConversationModeSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : ConversationModeSettingsSchema.parse({});
}
/** What saving `input` would leave, without saving it: a field left out keeps its value (Q65). */
export function nextConversationModeSettings(store: Pick<Store, "get">, owner: string, input: unknown): ConversationModeSettings {
  return ConversationModeSettingsSchema.parse({ ...conversationModeSettings(store, owner), ...optionalFields(ConversationModeSettingsSchema).parse(input ?? {}) });
}
export function saveConversationModeSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): ConversationModeSettings {
  const next = nextConversationModeSettings(store, owner, input);
  store.save("settings", owner, settingsKey, next);
  return next;
}

/**
 * How loose a new conversation's start is, weighed so that "follow" can never loosen unasked. A conversation
 * that follows the owner's setting keeps every yes the owner wrote or remembered, which each mode drops some of
 * (`policyForMode`: Ask first and Plan drop them all, Auto and No approvals drop a broad yes). So moving TO
 * "follow" counts as looser than any mode, and moving AWAY from it is weighed against the owner's preset alone
 * (their own rules as Ask before changes), so a mode looser than that preset still asks.
 */
type NewConversationChoice = (typeof newConversationChoices)[number];
const followAfterRank = modeRank.full + 1;
const startRank = (choice: NewConversationChoice, preset: PolicyPresetName, after: boolean): number =>
  choice !== "follow" ? modeRank[choice] : after ? followAfterRank : presetRank[preset];
/** True when starting new conversations on `after` instead of `before` lets them do more. */
export const newConversationLooser = (before: NewConversationChoice, after: NewConversationChoice, preset: PolicyPresetName): boolean =>
  startRank(after, preset, true) > startRank(before, preset, false);
const startNames: Record<NewConversationChoice, string> = { ask: "Ask first", plan: "Plan", auto: "Auto", full: "No approvals", follow: "the owner's own setting" };
/** The start named in the words the mode picker uses. */
export const newConversationName = (choice: NewConversationChoice): string => startNames[choice];

/* ---------- what each conversation picked ---------- */

const RecordSchema = z.object({
  mode: ConversationModeSchema,
  /** True when picking Plan also switched the conversation to "Show me the plan first". */
  planSet: z.boolean().default(false),
}).strict();
export type ConversationModeRecord = z.infer<typeof RecordSchema>;
const key = (sessionId: string): string => `conversation-mode:${sessionId}`;

/** This conversation's own mode, or null when it follows the owner's setting. */
export function readConversationMode(store: Pick<Store, "get">, owner: string, sessionId: string | null | undefined): ConversationModeRecord | null {
  if (!sessionId) return null;
  const saved = RecordSchema.safeParse(store.get("settings", owner, key(sessionId))?.data);
  return saved.success ? saved.data : null;
}
export function saveConversationMode(store: Pick<Store, "save">, owner: string, sessionId: string, record: z.input<typeof RecordSchema>): ConversationModeRecord {
  const value = RecordSchema.parse(record);
  store.save("settings", owner, key(sessionId), { ...value });
  return value;
}
export function clearConversationMode(store: Pick<Store, "delete">, owner: string, sessionId: string): void {
  store.delete("settings", owner, key(sessionId));
}

/**
 * The mode a task in this conversation is held to, or null for the owner's setting. A person other
 * than the owner never gets a mode looser than the owner's setting.
 */
export function heldMode(record: ConversationModeRecord | null, preset: PolicyPresetName, byOwner: boolean): ConversationMode | null {
  if (!record) return null;
  if (!byOwner && looserThan(record.mode, preset)) return null;
  return record.mode;
}

/* ---------- what the picker may offer ---------- */

export interface ModeChoice { mode: ConversationMode; available: boolean; why: string }
/** Every mode, with the reason one cannot be picked right now; nothing is hidden. */
export function modeChoices(preset: PolicyPresetName, options: { locked: boolean; owner: boolean }): ModeChoice[] {
  return conversationModes.map((mode) => {
    const looser = modeRank[mode] > modeRank.ask;
    if (options.locked && looser)
      return { mode, available: false, why: "Lockdown is on. It asks before everything until the owner turns it off." };
    if (!options.owner && looserThan(mode, preset))
      return { mode, available: false, why: "Only the owner can allow more than the owner's own setting does." };
    return { mode, available: true, why: "" };
  });
}
