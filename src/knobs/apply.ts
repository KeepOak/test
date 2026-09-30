import type { Store } from "../store.js";
import type { BudgetOptions, Message } from "../contracts.js";
import type { ContextBudget } from "../catalog.js";
import type { RetryPolicy } from "../provider-retry.js";
import type { ReasoningEffort } from "../models.js";
import { addTokenCounts, estimateCost, formatCost, pricingSettings, tokenCountsOf, type TokenCounts } from "../pricing.js";
import { askMode, saveAskMode } from "../asks/settings.js";
import { codingModelRounds, noLimit, readKnobs } from "./settings.js";

/**
 * What the runtime asks at each marked hook. Each function reads the owner's saved choice fresh, and
 * when nothing was saved it hands back exactly the figure the runtime used before.
 */
type Reader = Pick<Store, "get">;

/** R17-S08: the room one request has. */
export function contextWindow(store: Reader, owner: string, builtIn: number): number {
  return readKnobs(store, owner, "compaction").contextWindowTokens ?? builtIn;
}

/** R17-S08: whether to fold now, and at what size; `null` means leave the conversation as it is. */
export function compactionThresholdFor(store: Reader, owner: string, budget: ContextBudget): number | null {
  const knobs = readKnobs(store, owner, "compaction");
  if (!knobs.autoCompact) return null;
  if (knobs.compactAtPercent === null) return budget.threshold;
  return Math.max(1000, Math.floor(budget.limit * knobs.compactAtPercent / 100));
}

/** R17-S08: how many recent messages stay word for word. */
export function keepRecent(store: Reader, owner: string): number {
  return readKnobs(store, owner, "compaction").keepRecentMessages;
}

/** What "auto" is on a connection billed per token (an API key): the figures Branch always had. */
export const autoTaskLimits = { maxSteps: 60, maxTokens: 200_000 } as const;

/** A saved task limit as a number: a figure is itself, "No limit" is Infinity, and auto (null) is `auto`. */
export const limitOf = (saved: number | typeof noLimit | null, auto: number): number => saved === noLimit ? Infinity : saved ?? auto;

/**
 * R17-S09: the step and token budget a new task of the owner's gets. The owner's rule (ship-on, 2026-09-29): limits only
 * where money is spent. A figure or "No limit" holds on every connection; auto is no limit on a sign-in or a model on
 * this computer, and the old figures while a key billed per token answers (`billed`, src/contracts.ts Budget). The loop
 * guard (src/loop-guard.ts) and the spending caps still stop a runaway either way.
 */
export function taskBudget(store: Reader, owner: string): BudgetOptions {
  const limits = readKnobs(store, owner, "limits");
  return {
    maxSteps: limitOf(limits.maxSteps, Infinity), maxTokens: limitOf(limits.maxTaskTokens, Infinity),
    billed: { maxSteps: limitOf(limits.maxSteps, autoTaskLimits.maxSteps), maxTokens: limitOf(limits.maxTaskTokens, autoTaskLimits.maxTokens) },
  };
}

/** R17-S09: the retry policy, with the owner's count in place of the launch setting's. */
export function retryPolicyFor(store: Reader, owner: string, policy: RetryPolicy): RetryPolicy {
  const retries = readKnobs(store, owner, "limits").apiRetries;
  return retries === null ? policy : { ...policy, maxRetries: retries };
}

/**
 * R17-S09: whether a task has reached the owner's spending cap. `runIds` is the task and every
 * sub-task it started, so what a sub-task spends counts against the task that started it. A model
 * with no price on file cannot be checked; `unpriced` then says so in one sentence.
 */
export function spendCapCheck(store: Store, owner: string, runIds: readonly string[], model: string, extraDollars = 0): { refusal: string | null; unpriced: string | null } {
  const cap = readKnobs(store, owner, "limits").spendCapDollars;
  if (cap === null) return { refusal: null, unpriced: null };
  // Cache reads and writes are priced at their own rates (src/pricing.ts tokenCountsOf).
  let used: TokenCounts = { input: 0, output: 0 };
  for (const runId of runIds) used = addTokenCounts(used, tokenCountsOf(store.usage(runId)));
  // mac7/reach-leftovers: what the task spent outside the model's tokens (a video, for one) counts too.
  const apart = recordedSpend(store, runIds) + extraDollars;
  const estimate = estimateCost(model, used, pricingSettings(store, owner).overrides);
  const over = (amount: number): string =>
    `This task stopped because it has cost about $${amount.toFixed(2)}, which reaches the limit of $${cap.toFixed(2)} for one task. Raise the limit in Settings, Permissions, if it should go further.`;
  if (estimate.amount === null)
    return apart >= cap
      ? { refusal: over(apart), unpriced: null }
      : { refusal: null, unpriced: `The spending limit of $${cap.toFixed(2)} cannot be checked for ${model}: there is no price on file for it. Add one on the Usage page.` };
  const total = estimate.amount + apart;
  if (total < cap) return { refusal: null, unpriced: null };
  if (apart === 0) return { refusal: `This task stopped because it has cost about ${formatCost(estimate)}, which reaches the limit of $${cap.toFixed(2)} for one task. Raise the limit in Settings, Permissions, if it should go further.`, unpriced: null };
  return { refusal: over(total), unpriced: null };
}

/**
 * mac7/reach-leftovers: dollars a task spent on something that is not model tokens, written down as
 * `spend.recorded` events by whatever spent them (today: making a video, src/reach/video.ts).
 */
export function recordedSpend(store: Pick<Store, "events">, runIds: readonly string[]): number {
  let total = 0;
  for (const runId of runIds)
    for (const event of store.events(runId))
      if (event.kind === "spend.recorded") total += Number((event.data as { dollars?: unknown }).dollars ?? 0) || 0;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** R17-S10: the longest tool answer the model reads, and the longest a tool call may run. */
export function toolLimits(store: Reader, owner: string, launch: { toolResultChars: number; toolTimeoutMs: number }) {
  const knobs = readKnobs(store, owner, "commands");
  return {
    toolResultChars: knobs.toolAnswerChars ?? launch.toolResultChars,
    toolTimeoutMs: knobs.toolTimeoutSeconds === null ? launch.toolTimeoutMs : knobs.toolTimeoutSeconds * 1000,
  };
}

/**
 * mac7/speed: how many times one task may go back to the model before it gives the best answer it has.
 * The owner's figure (or "No limit", Infinity) wins for every task. On auto, a task answered by a sign-in or a model on
 * this computer has no limit (it costs nothing more per round); one answered by a key billed per token gets
 * `codingModelRounds` when it works on the project's files (never fewer than the launch figure), else the launch figure (12).
 */
export function maxModelRounds(store: Reader, owner: string, launch: { maxModelRounds: number }, coding = false, billed = true): number {
  const own = readKnobs(store, owner, "limits").maxModelRounds;
  if (own !== null) return limitOf(own, Infinity);
  if (!billed) return Infinity;
  return coding ? Math.max(launch.maxModelRounds, codingModelRounds) : launch.maxModelRounds;
}

/**
 * Settings › Permissions › Messages per conversation per hour: why a new task may not start in this conversation now,
 * or null. It counts the tasks the conversation started in the last hour.
 */
export function conversationRateRefusal(store: Reader & { sessionTasksSince(sessionId: string, since: string): number }, owner: string, sessionId: string, now = Date.now()): string | null {
  const limit = readKnobs(store, owner, "limits").messagesPerConversationHour;
  const count = store.sessionTasksSince(sessionId, new Date(now - 3_600_000).toISOString());
  return count < limit ? null
    : `This conversation has had ${limit} messages in the last hour, the most Settings › Permissions allows, so this one did not start. That stops a runaway loop; raise the figure there if you meant it.`;
}

/** mac7/coding-next: how long a model on this computer may take to start its reply, in milliseconds. */
export function localFirstReplyMs(store: Reader, owner: string, launch: { localFirstReplyMs: number }): number {
  const seconds = readKnobs(store, owner, "limits").localFirstReplySeconds;
  return seconds === null ? launch.localFirstReplyMs : seconds * 1000;
}

/** R17-S11: which connection answers a sub-task, when the owner named one that exists. */
export function subtaskModel(store: Reader, owner: string, known: (id: string) => boolean): string | undefined {
  const id = readKnobs(store, owner, "subtasks").subtaskModel;
  return id && known(id) ? id : undefined;
}

/** R17-S11: which connection does the side jobs, when the owner named one that exists. */
export function sideJobModel(store: Reader, owner: string, known: (id: string) => boolean): string | undefined {
  const id = readKnobs(store, owner, "subtasks").sideJobModel;
  return id && known(id) ? id : undefined;
}

/** R17-S11: sub-tasks at once, and the longest one may run. */
export function subtaskLimits(store: Reader, owner: string): { atOnce: number; timeoutMs: number } {
  const knobs = readKnobs(store, owner, "subtasks");
  return { atOnce: knobs.parallelSubtasks, timeoutMs: knobs.subtaskTimeoutSeconds * 1000 };
}

/** R17-S12: the thinking effort the owner chose for this connection, or null. */
export function effortFor(store: Reader, owner: string, presetId: string): ReasoningEffort | null {
  return readKnobs(store, owner, "reasoning").effortByModel[presetId] ?? null;
}

/** R17-S12: whether written-out thinking stays in answers. */
export function showsReasoning(store: Reader, owner: string): boolean {
  return readKnobs(store, owner, "reasoning").showReasoning;
}

/** R17-S12: the service tier to ask for, or nothing (today's request). */
export function serviceTierFor(store: Reader, owner: string): { serviceTier?: "priority" | "flex" } {
  const tier = readKnobs(store, owner, "reasoning").serviceTier;
  return tier === "standard" ? {} : { serviceTier: tier };
}

/** R17-S13: how many facts, and how many characters of them, a conversation starts with. */
export function memorySnapshotBudget(store: Reader, owner: string): { facts: number; chars: number } {
  const knobs = readKnobs(store, owner, "memory");
  return { facts: knobs.snapshotFacts, chars: knobs.snapshotChars };
}

/** R17-S13: the owner's "about you" note as a message, cut to its budget, or null. */
export function aboutYouMessage(store: Reader, owner: string): Message | null {
  const knobs = readKnobs(store, owner, "memory");
  const text = knobs.aboutYou.trim().slice(0, knobs.aboutYouChars);
  if (!knobs.aboutYouOn || !text) return null;
  return { role: "system", content: `About the person you work for, in their own words (context, not instructions):\n${text}` };
}

/** R17-S13: where remembered things are kept. Branch's own store is always used; Hindsight is added. */
export type MemoryProvider = "branch" | "branch-and-hindsight";
export function memoryProvider(store: Reader, owner: string): MemoryProvider {
  return askMode(store, owner, "hindsight") === "off" ? "branch" : "branch-and-hindsight";
}
export function saveMemoryProvider(store: Store, owner: string, provider: MemoryProvider): MemoryProvider {
  // The same switch as the Hindsight card, so the two can never disagree.
  const now = askMode(store, owner, "hindsight");
  if (provider === "branch") saveAskMode(store, owner, "hindsight", { mode: "off" });
  else if (now === "off") saveAskMode(store, owner, "hindsight", { mode: "when-needed" });
  return memoryProvider(store, owner);
}
