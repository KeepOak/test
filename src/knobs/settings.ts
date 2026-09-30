import { z } from "zod";
import type { Store } from "../store.js";
import { chosenFields, forgetChosen, markChosen, sentKeys, shippedUnlessChosen } from "../ship-on.js";

/**
 * R17-S08 … R17-S14: the knobs that used to be constants, written down as settings the owner can
 * change. Every default below is exactly what Branch did before the knob existed, so a fresh install
 * behaves as it always has. `null` means "as it was" wherever the old figure came from somewhere else
 * (the launch settings file, the connection itself, or a figure worked out each round).
 *
 * Each card has its own record, so saving one card never touches another.
 */
const presetId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);

/** R17-S08: when a long conversation is folded into a summary, and how much room a model has. */
export const KnobCompactionSettingsSchema = z.object({
  /** Fold older messages into a summary when the conversation gets long. */
  autoCompact: z.boolean().default(true),
  /** Fold once the conversation fills this share of the room; null works it out each round. */
  compactAtPercent: z.number().int().min(20).max(95).nullable().default(null),
  /** How many recent messages always stay word for word. */
  keepRecentMessages: z.number().int().min(2).max(40).default(6),
  /** How many tokens one request may hold; null keeps the built-in 20,000. */
  contextWindowTokens: z.number().int().min(8000).max(2_000_000).nullable().default(null),
}).strict();

/** The value a task limit holds for "No limit": the task is stopped by the loop guard and the spending caps only. */
export const noLimit = "none";
/** A task limit: a figure, "none" (no limit), or null (auto: no limit on a sign-in or a model on this computer, a figure on a key). */
const taskLimit = (min: number, max: number) => z.union([z.number().int().min(min).max(max), z.literal(noLimit)]).nullable().default(null);

/** R17-S09: how far one task may go before it stops. */
export const KnobTaskLimitsSettingsSchema = z.object({
  /** Model rounds and tool steps one task may take; null is auto (60 on a key, see src/knobs/apply.ts autoTaskLimits). */
  maxSteps: taskLimit(1, 500),
  /** Stop a task once it has cost about this much, in dollars; null means no cap. */
  spendCapDollars: z.number().min(0.01).max(10000).nullable().default(null),
  /** How many times a failed request to the model service is tried again; null keeps the launch setting. */
  apiRetries: z.number().int().min(0).max(5).nullable().default(null),
  /**
   * mac7/coding-next: longest a model on this computer may take to start its reply, in seconds (it may
   * be loading into memory); null keeps the launch setting (300).
   */
  localFirstReplySeconds: z.number().int().min(5).max(1800).nullable().default(null),
  /**
   * mac7/speed: how many times one task may go back to the model before it stops and gives the best
   * answer it has; null keeps the launch setting (12), or `codingModelRounds` for a task that works on
   * the project's files. A planned task is given more room on top. Auto is no limit on a sign-in or a model on this computer.
   */
  maxModelRounds: taskLimit(2, 500),
  /**
   * selfdev: how many tokens one task may use in all, counting every request it sends to the model; null keeps the
   * built-in 200,000 on a key, and no limit on a sign-in or a model on this computer. Long coding work on Branch itself
   * (edit, test, push, wait for checks, merge) needs more.
   */
  maxTaskTokens: taskLimit(20_000, 20_000_000),
  /**
   * Settings › Permissions › Messages per conversation per hour: the most tasks one conversation may start in an hour.
   * It stops a runaway loop (a schedule, a trigger, a chat app or two Trunks answering each other): such a task past it is
   * refused in words and nothing is lost. The owner's own messages count but are never refused. 60 as shipped.
   */
  messagesPerConversationHour: z.number().int().min(1).max(1000).default(60),
}).strict();

/** The rounds a task working on the project's files gets while the owner has set no figure of their own. */
export const codingModelRounds = 40;

/**
 * R17-S10: what tools and commands may do. `passEnvironment` is security-relevant: only the owner
 * may change it, and a name that looks like it holds a secret is refused whatever the owner says.
 */
export const KnobCommandSettingsSchema = z.object({
  /** Longest tool answer the model reads, in characters; null keeps the launch setting. */
  toolAnswerChars: z.number().int().min(1000).max(60000).nullable().default(null),
  /** Longest one tool call may run, in seconds; null keeps the launch setting. */
  toolTimeoutSeconds: z.number().int().min(5).max(1800).nullable().default(null),
  /** Longest one command may run, in seconds; null keeps the launch settings file's figure. */
  commandTimeoutSeconds: z.number().int().min(1).max(1800).nullable().default(null),
  /** Whether a task may keep a command line open between commands. */
  keptOpenShell: z.boolean().default(true),
  /** Extra environment variable names handed to commands, beyond the built-in safe list. */
  passEnvironment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).max(16).default([]),
}).strict();

/** R17-S11: work a task hands on, and the small jobs Branch does on the side. */
export const KnobSubtaskSettingsSchema = z.object({
  /** Which connection answers sub-tasks; null uses the conversation's own. */
  subtaskModel: presetId.nullable().default(null),
  /** Which connection writes summaries and after-task reviews; null uses the conversation's own. */
  sideJobModel: presetId.nullable().default(null),
  /** How many sub-tasks one task may run at the same time. */
  parallelSubtasks: z.number().int().min(1).max(8).default(4),
  /** Longest a sub-task may run, in seconds. */
  subtaskTimeoutSeconds: z.number().int().min(1).max(120).default(120),
}).strict();

/** R17-S12: how hard each model thinks, whether its thinking is shown, and which service tier is asked for. */
export const KnobReasoningSettingsSchema = z.object({
  /** A default thinking effort for particular connections, by connection id. */
  effortByModel: z.record(presetId, z.enum(["low", "medium", "high"])).default({}),
  /** Show a model's written-out thinking (the part between think marks) in answers. */
  showReasoning: z.boolean().default(true),
  /** standard sends nothing extra; priority and flex ask services that offer them. */
  serviceTier: z.enum(["standard", "priority", "flex"]).default("standard"),
}).strict();

/** R17-S13: how much remembered text a conversation starts with, and the owner's own "about you" note. */
export const KnobMemorySettingsSchema = z.object({
  /** Most remembered facts put in front of a new conversation. */
  snapshotFacts: z.number().int().min(0).max(200).default(20),
  /** Most characters of remembered facts put in front of a new conversation. */
  snapshotChars: z.number().int().min(0).max(40000).default(2000),
  /** Put the owner's "about you" note in front of every conversation. */
  aboutYouOn: z.boolean().default(false),
  /** The owner's own words about themselves. */
  aboutYou: z.string().max(8000).default(""),
  /** Most characters of the note that are used. */
  aboutYouChars: z.number().int().min(100).max(8000).default(1500),
}).strict();

/** R17-S14: how eagerly key-like values are hidden, and which kinds the owner lets through. Owner only. */
export const KnobLeakGuardSettingsSchema = z.object({
  /** standard is today's list; strict also hides long random-looking strings. */
  sensitivity: z.enum(["standard", "strict"]).default("standard"),
  /** Kinds of value that are not hidden. A private key can never be let through. */
  exceptions: z.array(z.string().min(1).max(40)).max(20).default([]),
}).strict();

export const knobCards = {
  compaction: KnobCompactionSettingsSchema,
  limits: KnobTaskLimitsSettingsSchema,
  commands: KnobCommandSettingsSchema,
  subtasks: KnobSubtaskSettingsSchema,
  reasoning: KnobReasoningSettingsSchema,
  memory: KnobMemorySettingsSchema,
  leakGuard: KnobLeakGuardSettingsSchema,
} as const;
export type KnobCard = keyof typeof knobCards;
export type KnobValues = { [K in KnobCard]: z.infer<(typeof knobCards)[K]> };
export const knobCardNames = Object.keys(knobCards) as KnobCard[];

const keyOf = (card: KnobCard): string => `knobs-${card}`;
type Reader = Pick<Store, "get">;

/**
 * The owner's ship-on rule (defaults audit, 2026-09-28): the "about you" note goes in front of every conversation once the
 * owner writes one; with no note nothing is added (src/knobs/apply.ts). None of (a)–(f), so it ships on. A card is written
 * whole, so a saved false that the owner never set reads as it ships (src/ship-on.ts); one they set is kept.
 */
export const knobShipsOn: Partial<Record<KnobCard, Record<string, unknown>>> = { memory: { aboutYouOn: true } };

/** One card's settings, with today's behaviour for anything never saved or saved wrongly. */
export function readKnobs<K extends KnobCard>(store: Reader, owner: string, card: K): KnobValues[K] {
  const schema = knobCards[card] as unknown as z.ZodType<KnobValues[K]>;
  const saved = schema.safeParse(store.get("settings", owner, keyOf(card))?.data ?? {});
  if (!saved.success) return schema.parse({ ...(knobShipsOn[card] ?? {}) });
  const ships = knobShipsOn[card];
  const read = ships ? shippedUnlessChosen(store, owner, keyOf(card), saved.data as Record<string, unknown>, ships) as KnobValues[K] : saved.data;
  return card === "limits" ? stepsAsShipped(store, owner, read as KnobValues["limits"]) as KnobValues[K] : read;
}

/**
 * The step limit used to ship as 60, and the card is written whole, so a record saved for any other limit holds a 60
 * nobody chose. Such a 60 reads as auto; one the owner set (it is in the ship-on book) is kept.
 */
function stepsAsShipped(store: Reader, owner: string, limits: KnobValues["limits"]): KnobValues["limits"] {
  if (limits.maxSteps !== 60 || chosenFields(store, owner, keyOf("limits")).includes("maxSteps")) return limits;
  return { ...limits, maxSteps: null };
}

/** Saves one card; fields left out keep what was there. Returns what is now in force. */
export function saveKnobs<K extends KnobCard>(store: Store, owner: string, card: K, input: unknown): KnobValues[K] {
  const schema = knobCards[card] as unknown as z.ZodType<KnobValues[K]>;
  const next = schema.parse({ ...readKnobs(store, owner, card), ...(input && typeof input === "object" ? input : {}) });
  store.save("settings", owner, keyOf(card), next as Record<string, unknown>);
  markChosen(store, owner, keyOf(card), sentKeys(input));
  return next;
}

/** Every card, for the screen. */
export function allKnobs(store: Reader, owner: string): KnobValues {
  return Object.fromEntries(knobCardNames.map((card) => [card, readKnobs(store, owner, card)])) as KnobValues;
}

/** Puts one card back to how Branch ships. */
export function resetKnobs(store: Store, owner: string, card: KnobCard): void {
  store.save("settings", owner, keyOf(card), {});
  forgetChosen(store, owner, keyOf(card));
}
