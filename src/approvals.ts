import { errorText } from "./contracts.js";
import { argumentFingerprint } from "./question-fingerprint.js";
import type { PolicyRemember, RunSource } from "./policy.js";
import type { SandboxChoice } from "./sandbox.js";

/**
 * The runtime side of the approval policy: the questions a paused task is waiting on, the answers
 * remembered for the rest of a conversation, the per-conversation pace limits, and the two small
 * guardrails that go with them (a dry run's simulated results, and a warning when a file the
 * assistant just wrote is not valid JSON after all).
 */
export interface PendingApproval {
  runId: string;
  sessionId: string;
  tool: string;
  target: string;
  /** What is about to happen, in plain language. */
  label: string;
  question: string;
  source: RunSource;
  /** What the rule suggests remembering if the person says yes. */
  remember: PolicyRemember;
  /** How tightly the rule wants the program held, when it said; shown on the card before the yes. */
  sandbox?: SandboxChoice;
  askedAt: string;
  /**
   * The exact bytes of the request, with saved passwords and keys taken out, as shown on screen.
   */
  bytes?: string;
  /**
   * The fingerprint of the tool and the exact bytes it asked for (src/question-fingerprint.ts). Every question has
   * one, and a yes is bound to it: change the command and the assistant has to ask again.
   */
  fingerprint: string;
  /**
   * Wave mac3 (tool-safety): the safety check advised against this exact request, so the owner may
   * overrule it only this once ("Yes, just now"), never for the conversation or for good.
   */
  onceOnly?: boolean;
  /**
   * Q59: asked in an Ask first or Plan conversation. Those drop every yes the owner's rules hold, so
   * a "Yes, always" would write a rule they never read: only "just now" and "for this conversation"
   * are offered, and `approve` refuses "always" for it.
   */
  noStanding?: boolean;
  /**
   * FQ-execution.browser: the call names nothing a standing rule could be kept for (a `browser.flow` on
   * no website), so "Yes, always" is not offered; it would be a rule on every call of the tool.
   */
  noAlways?: boolean;
  /**
   * mac7/coding-next: a question with answers of its own. "project-tests" is "Let Branch run this
   * project's tests?", answered Always for this folder / Once / No (src/coding/project-tests.ts).
   */
  kind?: "project-tests";
  /**
   * mac7/multi-target: every file the call touches, and whether it reads, changes or deletes each,
   * when it touches more than one; the card lists them (the first few, the rest folded away).
   */
  files?: { kind: "read" | "write" | "delete"; path: string }[];
  /** Redesign: the Trunk whose work stopped on this question, so "Always allow for <Trunk>" can be kept for it alone. */
  trunk?: string;
}

/** Wave mac3 (tool-safety): what the owner is told when they try to keep a yes the safety check advised against. */
export const onceOnlyRefusal =
  "The safety check advised against this, so it can only be allowed this once. Choose \"Yes, just now\" to go ahead.";

/** A yes kept for the rest of a conversation, and when it stops counting. */
export interface SessionGrant {
  tool: string;
  target: string;
  decision: "allow" | "deny";
  /** The request this answer was given for; null when it was given without one. */
  fingerprint: string | null;
  grantedAt: string;
  expiresAt: string;
  /** Plain words for the "What is allowed right now" list. */
  label: string;
}

/** How long a "yes, for this conversation" lasts unless the conversation ends or Branch locks first. */
export const sessionGrantMs = 60 * 60 * 1000;

const answerKey = (tool: string, target: string): string => `${tool}\u0000${target}`;

/**
 * Whether two questions are the same one: the fingerprint of the tool and its exact bytes says so, so the same bytes
 * asked of another tool are another question.
 */
const sameQuestion = (a: PendingApproval, b: PendingApproval): boolean => a.fingerprint === b.fingerprint;

/** The refusal a "deny" rule gives back, in the one wording the whole app uses. */
export const refusedByPolicy = (label: string): string =>
  `Your settings do not allow this: ${label}. Tell the person what you wanted to do, and why.`;
/** The question a tool call that needs a yes is put as, in the one wording the whole app uses. */
export const approvalQuestion = (label: string, target: string): string =>
  `Before I go ahead: ${label}${target ? " (" + target + ")" : ""}. Is that all right?`;

/**
 * Raised when something that is not a model's turn — a saved workflow's tool step, a step of a
 * procedure being replayed — reaches a tool the approval policy says to ask about first. Whoever
 * called decides how the question is put: a conversation pauses, a workflow stops where it is.
 */
/** Raised in the same places when the settings refuse the tool outright: trying again cannot help. */
export class PolicyRefusedError extends Error {
  override name = "PolicyRefusedError";
  constructor(readonly tool: string, readonly label: string) {
    super(refusedByPolicy(label));
  }
}

export class ApprovalRequiredError extends Error {
  override name = "ApprovalRequiredError";
  /**
   * The fingerprint of the exact bytes the step asked for. A yes given later is bound to it, so a
   * saved step whose arguments changed in between is asked about again rather than let past. A
   * raiser that has no bytes of its own to give is asking about its target, so the fingerprint is
   * made from the tool and that.
   */
  readonly fingerprint: string;
  constructor(
    readonly tool: string,
    readonly target: string,
    readonly label: string,
    readonly remember: PolicyRemember = "session",
    fingerprint?: string,
    /** mac7/coding-next: the question in words of its own, and which kind of question it is. */
    readonly asked: { question?: string; kind?: "project-tests"; onceOnly?: boolean } = {},
  ) {
    super(asked.question ?? approvalQuestion(label, target));
    this.fingerprint = fingerprint ?? argumentFingerprint(tool, JSON.stringify({ target }));
  }
}

/**
 * How many questions one conversation may have waiting at once. A conversation that has stopped on
 * eight things the person has not looked at yet is not one more question away from being useful, so
 * the ninth is refused outright rather than quietly pushing the oldest out of the list.
 */
export const maximumPendingPerSession = 8;
/** What the task whose question was let go is told, in one sentence and no jargon. */
export const droppedPendingMessage = (label: string): string =>
  `This conversation had ${maximumPendingPerSession} questions waiting for an answer, so the one that `
  + `had been waiting longest was let go rather than kept for ever: ${label}. Nothing was done. `
  + "Ask again if you still want it.";

export class ApprovalGate {
  private readonly answers = new Map<string, Map<string, SessionGrant>>();
  /**
   * The questions each conversation is waiting on, oldest first. It is a list rather than a single
   * question because two things can genuinely be asked at once — a conversation running two tools
   * side by side, or one AI-tool connection making two calls — and the second must not silently
   * take the place of the first, leaving the first waiting on an answer that can never arrive.
   * Within one conversation a question is known by its fingerprint: the same exact request asked
   * twice is the same question, so it replaces rather than piles up.
   */
  private readonly pending = new Map<string, PendingApproval[]>();
  /** Wave mac3 (tool-safety): requests the safety check advised against, by fingerprint, with its reason. */
  private readonly advisedAgainst = new Map<string, string>();
  /** R17-C integration review: requests that are always once-only for another reason (a lock, a door), with the words for it. */
  private readonly heldOnce = new Map<string, string>();
  /** Wave mac3 (tool-safety): one-time overrules the owner gave, as conversation and fingerprint. */
  private readonly overrules = new Set<string>();
  /**
   * Dogfood A6: a "Yes, just now" to an ordinary question, as conversation, tool and fingerprint, with when it
   * lapses. The tool is part of the key: the fingerprint covers only the argument bytes, and the same bytes can
   * go to another tool (NAS 618407c). An unused one lapses as a "for this conversation" yes does.
   */
  private readonly justNow = new Map<string, { lapses: number; asker: string }>();
  /** mac7/coding-next: a "Once" given to a question that is used by the next attempt and then gone. */
  private readonly passes = new Set<string>();
  /** Keeps one pass for this conversation's next attempt at `tool` on `target`. */
  grantOnce(sessionId: string, tool: string, target: string): void {
    if (this.passes.size >= 500) this.passes.delete(this.passes.values().next().value!);
    this.passes.add(`${sessionId}\u0000${answerKey(tool, target)}`);
  }
  /** Uses up that pass, if there is one. */
  takeOnce(sessionId: string, tool: string, target: string): boolean {
    return this.passes.delete(`${sessionId}\u0000${answerKey(tool, target)}`);
  }
  /**
   * The answer already given in this conversation for the same tool and target. When a fingerprint
   * is supplied and the kept answer was given for a different one, there is no answer: the exact
   * bytes changed, so the person is asked again.
   */
  answer(sessionId: string, tool: string, target: string, fingerprint?: string, exact = false): "allow" | "deny" | undefined {
    const key = answerKey(tool, target);
    const grant = this.answers.get(sessionId)?.get(key);
    if (!grant) return undefined;
    if (Date.parse(grant.expiresAt) <= Date.now()) { this.answers.get(sessionId)?.delete(key); return undefined; }
    // `exact`: only a yes given for these very bytes counts (an address carrying a key or password).
    if (exact && (!grant.fingerprint || grant.fingerprint !== fingerprint)) return undefined;
    if (grant.fingerprint && fingerprint !== undefined && grant.fingerprint !== fingerprint) return undefined;
    return grant.decision;
  }
  /** Keeps an answer for the rest of the conversation, bound to the request it was given for. */
  remember(
    sessionId: string, tool: string, target: string, decision: "allow" | "deny",
    about: { fingerprint?: string | undefined; label?: string | undefined } = {},
  ): void {
    const forSession = this.answers.get(sessionId) ?? new Map<string, SessionGrant>();
    const now = Date.now();
    forSession.set(answerKey(tool, target), {
      tool, target, decision, fingerprint: about.fingerprint ?? null,
      grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + sessionGrantMs).toISOString(),
      label: about.label ?? `${tool}${target ? ` on ${target}` : ""}`,
    });
    this.answers.set(sessionId, forSession);
  }
  /**
   * Puts a kept answer back exactly as it was, after the app has been closed and opened again. The
   * moment it runs out is the one it was given, never a fresh hour: a restart must not quietly
   * lengthen a permission. One already out of date is refused here and named to the owner instead.
   */
  restoreGrant(sessionId: string, grant: SessionGrant): boolean {
    if (Date.parse(grant.expiresAt) <= Date.now()) return false;
    const forSession = this.answers.get(sessionId) ?? new Map<string, SessionGrant>();
    forSession.set(answerKey(grant.tool, grant.target), { ...grant });
    this.answers.set(sessionId, forSession);
    return true;
  }
  /** What this conversation is allowed to do right now, for the "What is allowed" list. */
  grants(sessionId: string): SessionGrant[] {
    const forSession = this.answers.get(sessionId);
    if (!forSession) return [];
    const now = Date.now();
    for (const [key, grant] of forSession) if (Date.parse(grant.expiresAt) <= now) forSession.delete(key);
    return [...forSession.values()].sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  }
  /**
   * Takes one remembered yes back. The conversation asks again the next time that tool wants that
   * thing, which is what the "Take this back" button beside it does.
   */
  revoke(sessionId: string, tool: string, target: string): boolean {
    return this.answers.get(sessionId)?.delete(answerKey(tool, target)) === true;
  }
  /** Ends every standing yes, in every conversation: what "Lock" does. */
  forgetAll(): number {
    const count = [...this.answers.values()].reduce((total, forSession) => total + forSession.size, 0);
    this.answers.clear();
    this.overrules.clear();
    this.justNow.clear();
    this.passes.clear();
    return count;
  }
  /**
   * Records a question a task stopped on. Asking the same exact request again replaces the question
   * already there rather than adding a second copy of it; anything else joins the end of the list.
   * When the list is already as long as it may be, the one that has been waiting longest is let go
   * and handed back, so whoever called can tell that task plainly rather than leave it waiting on
   * an answer that will never come.
   */
  ask(request: PendingApproval): PendingApproval | null {
    if (request.fingerprint && (this.advisedAgainst.has(request.fingerprint) || this.heldOnce.has(request.fingerprint)))
      request = { ...request, onceOnly: true };
    const forSession = this.pending.get(request.sessionId) ?? [];
    this.pending.set(request.sessionId, forSession);
    const same = forSession.findIndex((entry) => sameQuestion(entry, request));
    if (same >= 0) { forSession[same] = request; return null; }
    const dropped = forSession.length >= maximumPendingPerSession ? forSession.shift() ?? null : null;
    forSession.push(request);
    return dropped;
  }
  /** How many more questions this conversation may be asked before it is full. */
  roomToAsk(sessionId: string): number {
    return Math.max(0, maximumPendingPerSession - (this.pending.get(sessionId)?.length ?? 0));
  }
  /** Questions still waiting for an answer, oldest first. */
  waiting(sessionId?: string): PendingApproval[] {
    if (sessionId) return [...(this.pending.get(sessionId) ?? [])];
    return [...this.pending.values()].flat();
  }
  /**
   * Takes one question off a conversation's list, so it can be answered once. With a fingerprint it
   * is that exact request; without one, and with only a single question waiting, it is that one —
   * which is every older caller, and is why they all still work. Without one and with several
   * waiting it is the oldest, because that is the one that has been kept waiting longest.
   */
  /** Q222: takes every question one task left waiting, by the task, so a question with no fingerprint never takes another's place. */
  dropFor(sessionId: string, runId: string): void {
    const forSession = this.pending.get(sessionId);
    if (!forSession) return;
    const kept = forSession.filter((entry) => entry.runId !== runId);
    if (kept.length) this.pending.set(sessionId, kept); else this.pending.delete(sessionId);
  }
  resolve(sessionId: string, fingerprint?: string): PendingApproval | undefined {
    const forSession = this.pending.get(sessionId);
    if (!forSession?.length) return undefined;
    const at = fingerprint === undefined ? 0 : forSession.findIndex((entry) => entry.fingerprint === fingerprint);
    if (at < 0) return undefined;
    const [taken] = forSession.splice(at, 1);
    if (!forSession.length) this.pending.delete(sessionId);
    if (taken) for (const watch of this.resolvedWatchers) watch(taken);
    return taken;
  }
  /** eng-connectors: whoever must know who answered a question is told as it is answered, in the answer's own request. */
  private readonly resolvedWatchers: Array<(taken: PendingApproval) => void> = [];
  onResolved(watch: (taken: PendingApproval) => void): void {
    this.resolvedWatchers.push(watch);
  }
  /**
   * The question an answer is for: the one with that fingerprint, or — when none was given — the
   * oldest one still waiting. Looked at without taking it off the list, so whoever is answering can
   * check it over before saying yes.
   */
  questionFor(sessionId: string, fingerprint?: string): PendingApproval | undefined {
    const forSession = this.pending.get(sessionId) ?? [];
    return fingerprint === undefined ? forSession[0] : forSession.find((entry) => entry.fingerprint === fingerprint);
  }
  /** Forgets everything remembered for a conversation. */
  forget(sessionId: string): void {
    this.answers.delete(sessionId);
    this.pending.delete(sessionId);
    for (const key of this.overrules) if (key.startsWith(sessionId + "\u0000")) this.overrules.delete(key);
    for (const key of this.justNow.keys()) if (key.startsWith(sessionId + "\u0000")) this.justNow.delete(key);
    for (const key of this.passes) if (key.startsWith(sessionId + "\u0000")) this.passes.delete(key);
  }

  /* ------------------------------------------ wave mac3 (tool-safety): overruling the safety check once */

  /** Notes that the safety check advised against this exact request, so its question is once-only. */
  adviseAgainst(fingerprint: string, reason: string): void {
    if (this.advisedAgainst.size >= 500) this.advisedAgainst.delete(this.advisedAgainst.keys().next().value!);
    this.advisedAgainst.set(fingerprint, reason);
  }
  /** R17-C integration review: marks a request as once-only for its own reason, apart from the safety check's list. */
  holdOnce(fingerprint: string, reason: string): void {
    if (this.heldOnce.size >= 500) this.heldOnce.delete(this.heldOnce.keys().next().value!);
    this.heldOnce.set(fingerprint, reason);
  }
  /**
   * Checks an answer to a question before it is recorded. A request the safety check advised against
   * may be allowed only "just now": that yes is kept as a single pass for this very request in this
   * conversation, and anything longer-lasting is refused. Other questions are not touched.
   */
  settleOverrule(sessionId: string, question: PendingApproval, decision: "allow" | "deny", remember: PolicyRemember, asker = ""): void {
    // The question itself carries the mark, so two conversations stopped on the same request are
    // each held to it, however many other requests were advised against since.
    const fingerprint = question.fingerprint;
    if (!fingerprint) return;
    if (!question.onceOnly) {
      // Dogfood A6: "Yes, just now" to an ordinary question kept nothing, and a task stops on its question, so the
      // yes was lost when it carried on. It is now one pass for these exact bytes in this conversation, used by the
      // next attempt (reviewCall), as a once-only question's yes already is.
      if (decision === "allow" && remember === "never") {
        if (this.justNow.size >= 500) this.justNow.delete(this.justNow.keys().next().value!);
        this.justNow.set(`${sessionId}\u0000${question.tool}\u0000${fingerprint}`, { lapses: Date.now() + sessionGrantMs, asker });
      }
      return;
    }
    if (decision === "allow" && remember !== "never") {
      const held = this.heldOnce.get(fingerprint);
      throw new Error(held && !this.advisedAgainst.has(fingerprint) ? `${held}. Choose "Yes, just now" to go ahead.` : onceOnlyRefusal);
    }
    if (decision === "allow") this.overrules.add(`${sessionId}\u0000${fingerprint}`);
  }
  /** Uses up a "Yes, just now" for this tool and these exact bytes in this conversation, if one is still good. */
  takeJustNow(sessionId: string, tool: string, fingerprint: string | undefined, asker = ""): boolean {
    if (fingerprint === undefined) return false;
    const key = `${sessionId}\u0000${tool}\u0000${fingerprint}`, pass = this.justNow.get(key);
    // Another asker's task (the owner's turn after a person's yes in a shared room) neither uses it nor spends it.
    if (pass === undefined || pass.asker !== asker) return false;
    this.justNow.delete(key);
    return pass.lapses > Date.now();
  }
  /** Uses up the owner's one-time overrule for this request, if there is one. */
  takeOverrule(sessionId: string, fingerprint: string | undefined): boolean {
    return fingerprint !== undefined && this.overrules.delete(`${sessionId}\u0000${fingerprint}`);
  }
  /** Checks whether the owner's one-time overrule for this request exists, without consuming it. */
  hasOverrule(sessionId: string, fingerprint: string | undefined): boolean {
    return fingerprint !== undefined && this.overrules.has(`${sessionId}\u0000${fingerprint}`);
  }
}

/** A sliding window counter: how many events a key may have inside the window. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(readonly windowMs = 60000) {}
  private recent(key: string, now: number): number[] {
    const times = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    this.hits.set(key, times);
    return times;
  }
  /** How long to wait before one more event fits inside the window; 0 when it fits right now. */
  waitMs(key: string, limit: number, now = Date.now()): number {
    if (limit <= 0) return 0;
    const times = this.recent(key, now);
    if (times.length < limit) return 0;
    return Math.max(1, times[times.length - limit]! + this.windowMs - now);
  }
  record(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }
}

/** Waits, unless the task is stopped first. */
export function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** What a tool returns in a dry run: nothing happened, and this is what would have. */
export function simulatedResult(label: string): { ok: true; simulated: true; result: string } {
  return { ok: true, simulated: true, result: `Nothing was done: this is a practice run. For real, this would have: ${label}.` };
}

/** After writing a .json file, the problem with it if it is not valid JSON after all, otherwise null. */
export async function jsonWriteProblem(
  read: (path: string) => Promise<{ content: string }>,
  path: string,
): Promise<string | null> {
  if (!/\.json$/i.test(path)) return null;
  let content: string;
  try { content = (await read(path)).content; } catch { return null; }
  try { JSON.parse(content); return null; } catch (error) { return errorText(error); }
}
