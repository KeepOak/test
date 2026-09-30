import { access } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { Message } from "./contracts.js";
import { checkResult, ResultSchemaSchema } from "./delegation.js";
import { defaultToolBudgetTokens } from "./tool-loading.js";

/**
 * Reliability helpers for ordinary runs: declared completion checks with bounded retries, a stall
 * watchdog for model calls, and the trimming that keeps a long-running task inside the context limit.
 */
export const CompletionCheckSchema = z.object({
  /** Words or phrases the final answer must contain (case-insensitive). */
  mustMention: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  /** A regular expression the final answer must match. */
  mustMatch: z.string().min(1).max(300).optional(),
  /** The answer must be JSON matching this schema. */
  resultSchema: ResultSchemaSchema.optional(),
  /** Workspace files that must exist when the task claims to be done. */
  files: z.array(z.string().min(1).max(500)).max(20).optional(),
  /** How many more attempts the model gets after a failed check (0 to 2). */
  maxRetries: z.number().int().min(0).max(2).default(1),
}).strict();
export type CompletionCheck = z.infer<typeof CompletionCheckSchema>;

export class CheckError extends Error {
  override name = "CheckError";
}
export class StallError extends Error {
  override name = "StallError";
  /** hardening-3: true when nothing at all had been heard, so the reply never started. */
  constructor(readonly afterMs: number, readonly beforeFirstWord = false) { super(`No response for ${Math.round(afterMs / 1000)} seconds`); }
}
/**
 * hardening-3: a model on this computer that never started answering, after its one retry. The task
 * ends with this plain message instead of waiting through two more full windows (~15 minutes).
 */
export class LocalModelSilentError extends Error {
  override name = "LocalModelSilentError";
  constructor(readonly waitedMs: number) {
    super(`The model on this computer didn't start answering after ${waitedSeconds(waitedMs)}. It may still be loading, or it may be too big for this computer's memory. `
      + "Check that the program running it (such as Ollama or LM Studio) is open and the model has finished loading, then try again; "
      + "or choose a smaller model; or give it longer under Settings, Advanced: \"Wait for a model on this computer to start answering\".");
  }
}
const waitedSeconds = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
};
/**
 * hardening-3: the extra time a local model's one retry gets on top of the owner's first-reply wait:
 * a tenth of it, at most 30 seconds (30 s for the shipped 300 s). Enough for a model that finished
 * loading just as the wait ran out; never another full wait.
 */
export const localFirstReplyGraceMs = (firstMs: number): number => Math.min(30_000, Math.round(firstMs / 10));

/** The first reason the answer fails its declared checks, or null when every check passes. */
export async function evaluateChecks(output: string, check: CompletionCheck, workspace: string): Promise<string | null> {
  const lower = output.toLowerCase();
  for (const phrase of check.mustMention ?? [])
    if (!lower.includes(phrase.toLowerCase())) return `The answer does not mention "${phrase}"`;
  if (check.mustMatch) {
    let pattern: RegExp;
    try { pattern = new RegExp(check.mustMatch, "i"); } catch { return "The check's pattern is not a valid regular expression"; }
    if (!pattern.test(output)) return "The answer does not match the expected pattern";
  }
  if (check.resultSchema) {
    const result = checkResult(output, check.resultSchema);
    if (result.status === "unresolved") return result.reason;
  }
  for (const file of check.files ?? []) {
    const path = resolve(workspace, file), rel = relative(workspace, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return `The file ${file} is outside the workspace`;
    try { await access(path); } catch { return `The file ${file} does not exist yet`; }
  }
  return null;
}

/**
 * mac7/coding-next: how the first piece of a reply is waited for. A model on this computer may have
 * to be loaded into memory before it can say anything, which can take minutes, so its first silence
 * gets `firstMs` instead of the ordinary stall time; once anything is heard the ordinary clock runs.
 * `quiet` is told once if nothing at all has been heard after `afterMs`, so the person can be told why.
 */
export interface FirstReplyWait {
  firstMs?: number;
  quiet?: { afterMs: number; notify: () => void };
  /** hardening-3: the first window is exactly this long, even when shorter than the ordinary stall time (a retry's last grace). */
  capMs?: number;
}

/**
 * Runs `work` with a signal that aborts when nothing has been heard for `stallMs`; `touch` resets
 * the clock and is meant to be called on every streamed piece of output.
 */
export async function withStallWatchdog<T>(
  parent: AbortSignal,
  stallMs: number,
  work: (signal: AbortSignal, touch: () => void) => Promise<T>,
  first: FirstReplyWait = {},
): Promise<T> {
  const watchdog = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heard = false;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => watchdog.abort(new StallError(ms, !heard)), ms);
  };
  const touch = () => { heard = true; arm(stallMs); };
  arm(first.capMs ?? Math.max(stallMs, first.firstMs ?? stallMs));
  const quiet = first.quiet ? setTimeout(() => { if (!heard) first.quiet!.notify(); }, first.quiet.afterMs) : undefined;
  try {
    return await work(AbortSignal.any([parent, watchdog.signal]), touch);
  } catch (error) {
    if (watchdog.signal.aborted && !parent.aborted) throw watchdog.signal.reason;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (quiet) clearTimeout(quiet);
  }
}

/**
 * integrate/empty-completion: thinking resets the stall clock, but only within the room the reply
 * was given. A provider cannot legitimately send more thinking than `maxChars` (the reply's token
 * allowance at a generous number of characters per token), nor keep thinking past `forMs`; beyond
 * either, thinking is no longer taken as a sign of life and the ordinary watchdog decides. Without
 * this, a connection that sends thinking for ever with no end would never be called stalled.
 */
export function thinkingKeepsAlive(
  touch: () => void,
  limits: { maxChars: number; forMs: number; now?: () => number },
): (text: string) => void {
  const now = limits.now ?? Date.now, started = now();
  let heard = 0;
  return (text) => {
    heard += text.length;
    if (heard <= limits.maxChars && now() - started < limits.forMs) touch();
  };
}
/** How many characters one token of thinking may be, at most, when bounding a reply's thinking. */
export const thinkingCharsPerToken = 16;
/** How many stall windows thinking alone may keep one model call open. */
export const thinkingStallWindows = 10;

/** Shortens a serialised tool result that would crowd out the conversation; the full result stays in the trace. */
export function clipToolResult(serialised: string, limit: number): { text: string; omitted: number } {
  if (serialised.length <= limit) return { text: serialised, omitted: 0 };
  const head = Math.floor(limit * 0.7), tail = Math.floor(limit * 0.2);
  const omitted = serialised.length - head - tail;
  return { text: `${serialised.slice(0, head)}\n[... ${omitted} characters omitted; the full result is in this task's activity trace ...]\n${serialised.slice(-tail)}`, omitted };
}

/**
 * Replaces the content of older tool results with a short note so the model keeps its own
 * reasoning and the recent exchange. Returns how many results were shrunk.
 */
export function shrinkToolResults(messages: Message[], keepRecent: number): number {
  let shrunk = 0;
  const cutoff = Math.max(0, messages.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    const message = messages[i]!;
    if (message.role !== "tool" || message.content.length <= 200) continue;
    message.content = JSON.stringify({ ok: true, note: `Earlier result of ${message.content.length} characters removed to make room; ask again if you need it.` });
    shrunk++;
  }
  return shrunk;
}

export const ReliabilityOptionsSchema = z.object({
  /** Abort a model call that stays silent this long (5 s to 10 min). */
  modelStallMs: z.number().int().min(5000).max(600000).default(60000),
  /**
   * mac7/coding-next: how long a model on this computer may stay silent before the first piece of
   * its reply, since it may be loading into memory (5 s to 30 min). Hosted models keep `modelStallMs`.
   */
  localFirstReplyMs: z.number().int().min(5000).max(1_800_000).default(300_000),
  /** What to do after a stalled model call. */
  stallRecovery: z.enum(["retry", "fallback", "fail"]).default("retry"),
  /** Stop a single tool call after this long (5 s to 10 min). */
  toolTimeoutMs: z.number().int().min(5000).max(1_800_000).default(90000),
  /** Tool results longer than this are clipped before the model sees them. */
  toolResultChars: z.number().int().min(1000).max(60000).default(12000),
  /** How long the per-conversation pace window is; normally a minute. */
  rateWindowMs: z.number().int().min(100).max(600000).default(60000),
  /**
   * The whole tool section of one request, in estimated tokens. Tools above this ceiling are
   * described by one line each instead of in full, or left out and found by searching.
   */
  toolBudgetTokens: z.number().int().min(400).max(20000).default(defaultToolBudgetTokens),
  /**
   * mac7/speed: how many times a task may go back to the model before it has to stop and give the
   * best answer it has. A planned task is given more room on top of this, step by step.
   */
  maxModelRounds: z.number().int().min(2).max(60).default(12),
}).strict();
export type ReliabilityOptions = z.infer<typeof ReliabilityOptionsSchema>;
export type ReliabilityInput = z.input<typeof ReliabilityOptionsSchema>;
