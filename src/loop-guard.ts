import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { shippedUnlessChosen } from "./ship-on.js";

/**
 * Noticing when a task is going round in circles (audit A1769, A1713).
 *
 * A model that is stuck tends to do one of two things: ask for the same tool with the same
 * arguments again and again, or bounce between two or three calls (read, write, read, write).
 * The guard watches every call a task makes and answers in three steps that get firmer:
 *
 *  1. warn  — the call runs, and a plain sentence is put beside its result;
 *  2. block — the call does not run, and the model is told why in the same words a person would use;
 *  3. stop  — after repeated blocks the task ends with one sentence the owner can read.
 *
 * A call that also keeps giving back exactly the same result is blocked sooner: that is the
 * clearest sign the approach is not working. Tools that are meant to be asked again and again
 * (a program's output, a status, a list) get gentler limits.
 *
 * The owner chooses how it works (see `loopGuardMode`). It ships on (the owner's rule, 2026-09-27: it
 * only tightens what a task may do; none of (a)–(f)), and a saved record that cannot be read is off:
 *  - off: nothing is watched, exactly as before;
 *  - on: every task is watched from its first call;
 *  - when needed: a small task is left alone except for a tight loop (the same call with the same
 *    details a third time), and everything switches on once the task has made
 *    `whenNeededAfterCalls` calls — the size at which a loop is worth looking for, in the same
 *    spirit as tools that are only loaded once a task shows it needs them (src/tool-loading.ts).
 *
 * The shape follows OpenFang's `loop_guard.rs` (MIT or Apache-2.0) and Gemini CLI's
 * `loopDetectionService.ts` (Apache-2.0); see THIRD_PARTY_NOTICES.md. Nothing here reads the
 * argument text to decide whether a call is a poll: that would let the text relax the guard.
 */
export interface LoopLimits {
  /** Identical calls before a warning. */
  warnAt: number;
  /** Identical calls before the call is refused. */
  blockAt: number;
  /** Identical call-and-result pairs before a warning. */
  sameResultWarnAt: number;
  /** Identical call-and-result pairs before the next identical call is refused. */
  sameResultBlockAt: number;
  /** Full A-B (or A-B-C) cycles before a warning, and before refusing. */
  cycleWarnAt: number;
  cycleBlockAt: number;
  /** How much gentler every limit is for a tool meant to be polled. */
  pollMultiplier: number;
  /** Refusals in one task before the task is stopped. */
  stopAfterBlocks: number;
  /**
   * Calls a task makes before back-and-forth and repeated results are looked for. Zero looks from
   * the start; the "when needed" setting uses `whenNeededAfterCalls`.
   */
  quietCalls: number;
}

export const defaultLoopLimits: Readonly<LoopLimits> = Object.freeze({
  warnAt: 3, blockAt: 5, sameResultWarnAt: 2, sameResultBlockAt: 3,
  cycleWarnAt: 2, cycleBlockAt: 3, pollMultiplier: 3, stopAfterBlocks: 3, quietCalls: 0,
});
/** "When needed": the number of calls after which a task is watched in full. */
export const whenNeededAfterCalls = 8;

export const FeatureSwitchSchema = z.enum(["off", "on", "when-needed"]);
export type FeatureSwitch = z.infer<typeof FeatureSwitchSchema>;
export const LoopGuardSettingsSchema = z.object({
  /** off, on, or when-needed; read through `loopGuardMode`, which gives how it ships unless the owner chose. */
  mode: FeatureSwitchSchema.default("off"),
}).strict();
const loopGuardKey = "loop_guard";
// The owner's rule (ships on, 2026-09-27): a stricter guard that only refuses a call repeated past its bound; none of (a)–(f).
export const loopGuardShipsAs: FeatureSwitch = "on";
/** How the owner has set the loop guard. Read fresh each task. */
export function loopGuardMode(store: Store, owner: string): FeatureSwitch {
  const saved = LoopGuardSettingsSchema.safeParse(store.get("settings", owner, loopGuardKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, loopGuardKey, saved.data, { mode: loopGuardShipsAs }).mode : "off";
}
export function saveLoopGuardSettings(store: Store, owner: string, input: unknown): FeatureSwitch {
  const { mode } = LoopGuardSettingsSchema.parse(input ?? {});
  store.save("settings", owner, loopGuardKey, { mode });
  return mode;
}
/** The guard a task gets for a setting, or none when the guard is off. */
export function guardFor(mode: FeatureSwitch): LoopGuard | null {
  if (mode === "off") return null;
  return new LoopGuard(mode === "when-needed" ? { quietCalls: whenNeededAfterCalls } : {});
}

export type LoopVerdict =
  | { kind: "allow" }
  | { kind: "warn"; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "stop"; reason: string };

/** The tail of the history the cycle check looks at. */
const historySize = 30;
/**
 * Tools that are meant to be asked again while something finishes: a running program's output,
 * a status, a list. Judged from the tool's name only, never from its arguments.
 */
const pollNames = /^process\.(read|list)$|\.(status|check|checks|wait|wait_for_checks|poll|progress|list)$/;

export function isPollTool(name: string): boolean {
  return pollNames.test(name);
}

/** Arguments written the same way however the model ordered their keys. */
export function canonicalArguments(argumentText: string): string {
  try { return stableJson(JSON.parse(argumentText)); } catch { return argumentText.trim(); }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const digest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 24);

/** One task's record of what it has asked for. A new task starts a new guard. */
export class LoopGuard {
  private readonly limits: LoopLimits;
  private readonly counts = new Map<string, number>();
  private readonly results = new Map<string, number>();
  private readonly refusedForResults = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly recent: string[] = [];
  private blocks = 0;
  private stopped = false;
  private calls = 0;

  constructor(limits: Partial<LoopLimits> = {}) {
    this.limits = { ...defaultLoopLimits, ...limits };
  }

  /** What to do about a call the model has just asked for, before it runs. */
  check(name: string, argumentText: string): LoopVerdict {
    if (this.stopped) return { kind: "stop", reason: this.stopReason() };
    const key = digest(name, canonicalArguments(argumentText));
    this.names.set(key, name);
    this.remember(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    this.calls += 1;
    // A small task is only held to the plain repeat count until it has made enough calls.
    const quiet = this.calls <= this.limits.quietCalls;
    // The firmest of the three answers wins, so a back-and-forth that has earned a refusal is not
    // let through on the strength of a milder warning about one of its calls.
    const found = [quiet ? null : this.sameResultVerdict(key, name), this.repeatVerdict(name, count), quiet ? null : this.cycleVerdict(name)]
      .filter((verdict): verdict is LoopVerdict => verdict !== null);
    const verdict = found.find((one) => one.kind === "block") ?? found[0];
    return verdict ? this.escalate(verdict) : { kind: "allow" };
  }

  /**
   * What the call gave back. Returns a warning to put beside the result when the same call keeps
   * giving the same answer, and marks it so the next identical call is refused.
   */
  record(name: string, argumentText: string, resultText: string): string | null {
    const key = digest(name, canonicalArguments(argumentText));
    const pair = digest(key, resultText);
    const seen = (this.results.get(pair) ?? 0) + 1;
    this.results.set(pair, seen);
    const scale = this.scale(name);
    if (seen >= this.limits.sameResultBlockAt * scale) this.refusedForResults.add(key);
    if (this.calls <= this.limits.quietCalls) return null;
    if (seen >= this.limits.sameResultWarnAt * scale)
      return `"${name}" has given back exactly the same result ${seen} times. Asking again will not change it; try something different.`;
    return null;
  }

  /** Numbers for the task's record. */
  stats(): { calls: number; distinct: number; blocked: number; stopped: boolean } {
    return { calls: this.calls, distinct: this.counts.size, blocked: this.blocks, stopped: this.stopped };
  }

  private scale(name: string): number {
    return isPollTool(name) ? this.limits.pollMultiplier : 1;
  }
  private remember(key: string): void {
    this.recent.push(key);
    if (this.recent.length > historySize) this.recent.shift();
  }
  private sameResultVerdict(key: string, name: string): LoopVerdict | null {
    if (!this.refusedForResults.has(key)) return null;
    return { kind: "block", reason: `Not run: "${name}" keeps giving back the same result, so asking again will not help. Try a different approach.` };
  }
  private repeatVerdict(name: string, count: number): LoopVerdict | null {
    const scale = this.scale(name);
    if (count >= this.limits.blockAt * scale)
      return { kind: "block", reason: `Not run: "${name}" has been asked for ${count} times with exactly the same details. Change the details or try something else.` };
    if (count >= this.limits.warnAt * scale)
      return { kind: "warn", reason: `"${name}" has now been asked for ${count} times with exactly the same details. If it is not getting anywhere, try something else.` };
    return null;
  }
  private cycleVerdict(name: string): LoopVerdict | null {
    const cycle = repeatingCycle(this.recent);
    if (!cycle) return null;
    const tools = [...new Set(cycle.pattern.map((key) => this.names.get(key) ?? name))].map((tool) => `"${tool}"`).join(" and ");
    const scale = Math.min(...cycle.pattern.map((key) => this.scale(this.names.get(key) ?? name)));
    if (cycle.repeats >= this.limits.cycleBlockAt * scale)
      return { kind: "block", reason: `Not run: ${tools} have been going back and forth ${cycle.repeats} times without getting anywhere. Break the cycle with a different step.` };
    if (cycle.repeats >= this.limits.cycleWarnAt * scale)
      return { kind: "warn", reason: `${tools} are going back and forth (${cycle.repeats} times so far). If nothing is changing, try a different step.` };
    return null;
  }
  private escalate(verdict: LoopVerdict): LoopVerdict {
    if (verdict.kind !== "block") return verdict;
    this.blocks += 1;
    if (this.blocks < this.limits.stopAfterBlocks) return verdict;
    this.stopped = true;
    return { kind: "stop", reason: this.stopReason() };
  }
  /** The sentence a stopped task ends with. */
  stopReason(): string {
    return `Stopped: the assistant kept repeating the same steps without getting anywhere (${this.blocks} repeated steps were refused). Try asking in a different way, or break the task into smaller parts.`;
  }
}

/**
 * The shortest pattern of two or three different calls that the end of the history repeats, and
 * how many whole times it does. A-B-A-B is two repeats of A-B; A-A-A is not a cycle (that is
 * plain repetition, which the per-call count already covers).
 */
export function repeatingCycle(history: readonly string[]): { pattern: string[]; repeats: number } | null {
  for (const period of [2, 3]) {
    if (history.length < period * 2) continue;
    const pattern = history.slice(-period);
    if (new Set(pattern).size < 2) continue;
    let repeats = 0;
    for (let end = history.length; end - period >= 0; end -= period) {
      const chunk = history.slice(end - period, end);
      if (!chunk.every((key, index) => key === pattern[index])) break;
      repeats += 1;
    }
    if (repeats >= 2) return { pattern, repeats };
  }
  return null;
}
