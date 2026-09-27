import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FeatureMode } from "../feature-switches.js";
import { needsAgreementNote, planChangedNote, type PressContext } from "../local-one-button.js";
import type { InstallPlan } from "../local-install.js";
import { readBlocker, type Blocker } from "./blockers.js";
import { fixFor, switchBehind, type AdaptFix } from "./fixes.js";
import { adaptGuard, adaptMode } from "./settings.js";
import { AdaptStops, StopRequestSchema, type AdaptStop } from "./stops.js";
import type { Store } from "../store.js";

/**
 * mac7/adapt (`/adapt`): a task that cannot go on says what is missing, what would fix it and what
 * that costs; and on the owner's yes — never before it — Branch gets it and the task carries on
 * from where it stopped.
 *
 * The three things this file is careful about:
 *
 *   1. It asks first, every time. `go` without the fingerprint of the offer that was shown installs
 *      nothing and says so; an offer that has changed since it was read installs nothing either.
 *   2. It installs nothing itself. Where the fix is a program that runs models, the work is the one
 *      button's (`oneClick.press`), which asks its own switch and its own guard again — so `/adapt`
 *      can never install a runner the install switch forbids.
 *   3. It carries on rather than starts again. The task is handed back its own stop record, whose
 *      `done` steps are never run a second time.
 */

export interface OneButtonLike {
  /** `OneClick.buttonPlan`: what installing the program would mean, with nothing done. */
  plan(input: { runner?: string } | Record<string, never>, context: PressContext): Promise<{ install: InstallPlan | null; alreadyInstalled: boolean }>;
  /**
   * `OneClick.buttonGo`: the one button, which checks the install switch and the guard again.
   * It answers `needsAgreement` rather than throwing when the plan moved between being read and
   * being pressed, so that answer has to come back here or a stale plan would look like a success.
   */
  press(input: { agreedPlan?: string }, context: PressContext): Promise<{ message: string; needsAgreement?: unknown }>;
}

export interface AdaptDeps {
  store: Pick<Store, "get" | "save">;
  owner: string;
  /** The one button. Absent in a launch that did not set up models on this computer. */
  oneButton?: OneButtonLike | undefined;
  /** Turns one named setting on, for a blocker that is only a switch left off. */
  turnOn?: (setting: string) => void;
  /** Hands a task back its own stop record so it goes on from `nextStep`. */
  carryOn?: (stop: AdaptStop) => Promise<{ gained: string }>;
  now?: () => Date;
}

export interface AdaptView {
  mode: FeatureMode;
  /** Why this caller may not use `/adapt`, or null. A view is only ever a description. */
  refusal: string | null;
  blocker: Blocker | null;
  fix: AdaptFix | null;
  stop: AdaptStop | null;
  /** What the owner reads, in plain words. */
  message: string;
}
export interface AdaptAnswer {
  done: boolean;
  message: string;
  /** Set when Branch is waiting for the owner to agree to exactly this offer. */
  needsAgreement?: AdaptFix;
  stop: AdaptStop | null;
  /** What the task can now do that it could not before; empty when nothing changed. */
  gained: string;
}

export const AdaptLookSchema = z.object({
  said: z.string().trim().max(400).optional(),
  stopId: z.string().max(80).optional(),
}).strict();
/** "Leave it stopped": which stop. Nothing is fetched, changed or deleted; the stop is only no longer offered. */
export const AdaptLeaveSchema = z.object({ stopId: z.string().min(1).max(80) }).strict();
export const AdaptGoSchema = z.object({
  said: z.string().trim().max(400).optional(),
  stopId: z.string().max(80).optional(),
  /** The offer the owner said yes to, word for word. Without it nothing is fetched or changed. */
  agreed: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict();

const nothingStuck = "Nothing has stopped for want of something missing, so there is nothing to get.";
const cannotPlace = "Branch cannot tell what is missing from that, so it will not go looking. Say what it said, word for word.";

export class Adapt {
  readonly stops: AdaptStops;
  constructor(private readonly deps: AdaptDeps) { this.stops = new AdaptStops(deps.store, deps.owner); }
  private now(): string { return (this.deps.now ?? (() => new Date()))().toISOString(); }

  /** A task writes down where it stopped. This describes; it fetches and changes nothing. */
  record(input: unknown): AdaptStop {
    const wanted = StopRequestSchema.parse(input);
    const blocker = readBlocker(wanted.said);
    return this.stops.put({
      id: randomUUID(), runId: wanted.runId, sessionId: wanted.sessionId ?? null, what: wanted.what,
      done: wanted.done, nextStep: wanted.nextStep, at: this.now(), carriedOnAt: null, gained: "",
      blocker: blocker ?? { kind: "program", what: wanted.said.slice(0, 200), modelKind: "", said: wanted.said },
    });
  }

  /**
   * The owner's "Leave it stopped". The record is kept, still stopped, with the time it was left; it is only no longer
   * offered in the waiting list. Nothing is fetched, changed or deleted.
   */
  leave(input: unknown): AdaptStop {
    const { stopId } = AdaptLeaveSchema.parse(input);
    const stop = this.stops.get(stopId);
    if (!stop) throw new Error("There is no stopped task with that id.");
    if (stop.carriedOnAt) throw new Error("That task has already carried on.");
    return this.stops.update(stop.id, { leftAt: this.now() }) ?? stop;
  }

  /** What is missing, what would fix it and what that costs. Nothing is done here, ever. */
  async look(input: unknown, context: PressContext = {}): Promise<AdaptView> {
    const wanted = AdaptLookSchema.parse(input ?? {});
    const mode = adaptMode(this.deps.store, this.deps.owner);
    const refusal = adaptGuard(this.deps.store, this.deps.owner, context);
    const stop = this.pick(wanted);
    // "When needed" speaks only about a task that really stopped; "on" also answers a bare ask.
    const blocker = wanted.said ? readBlocker(wanted.said) : stop?.blocker ?? null;
    const base = { mode, refusal, stop: stop ?? null };
    if (refusal) return { ...base, blocker: null, fix: null, message: refusal };
    if (!blocker) return { ...base, blocker: null, fix: null, message: wanted.said ? cannotPlace : nothingStuck };
    if (mode === "when-needed" && !stop && !wanted.said) return { ...base, blocker: null, fix: null, message: nothingStuck };
    const fix = await this.offer(blocker, context);
    return { ...base, blocker, fix, message: sentenceFor(fix, stop ?? null) };
  }

  /** The offer for one blocker, with the one button's own install plan when a program is missing. */
  private async offer(blocker: Blocker, context: PressContext): Promise<AdaptFix> {
    const wantsProgram = blocker.kind === "runner" || blocker.kind === "model";
    if (!wantsProgram || !this.deps.oneButton) return fixFor(blocker, null);
    const view = await this.deps.oneButton.plan({}, context).catch(() => null);
    return fixFor(blocker, view && !view.alreadyInstalled ? view.install : null);
  }

  /**
   * The owner's yes. Gets what is missing — through the one button, which asks its own switch
   * again — then hands the task back its stop record so it goes on from where it stopped.
   */
  async go(input: unknown, context: PressContext = {}): Promise<AdaptAnswer> {
    const wanted = AdaptGoSchema.parse(input ?? {});
    const refusal = adaptGuard(this.deps.store, this.deps.owner, context);
    if (refusal) throw new Error(refusal);
    const stop = this.pick(wanted);
    const blocker = wanted.said ? readBlocker(wanted.said) : stop?.blocker ?? null;
    if (!blocker) return { done: false, message: wanted.said ? cannotPlace : nothingStuck, stop: stop ?? null, gained: "" };
    const fix = await this.offer(blocker, context);
    if (fix.instead) return { done: false, message: fix.instead, stop: stop ?? null, gained: "" };
    if (wanted.agreed !== fix.fingerprint)
      return { done: false, stop: stop ?? null, gained: "", needsAgreement: fix,
        message: wanted.agreed ? planChangedNote : needsAgreementNote(shortName(fix)) };
    const got = await this.carryOut(fix, context);
    return stop ? { ...(await this.resume(stop, got)), done: true } : { done: true, message: got, stop: null, gained: "" };
  }

  /** Doing the one thing the offer described, and nothing else. */
  private async carryOut(fix: AdaptFix, context: PressContext): Promise<string> {
    if (fix.blocker.kind === "switch") {
      const known = switchBehind(fix.blocker.said);
      if (!known || !this.deps.turnOn) throw new Error(`Branch cannot switch "${fix.blocker.what}" on from here.`);
      this.deps.turnOn(known.setting);
      return `"${known.label}" is switched on.`;
    }
    if (!this.deps.oneButton) throw new Error("Models on this computer are not set up in this launch of Branch, so there is nothing for /adapt to use.");
    const answer = await this.deps.oneButton.press(fix.install ? { agreedPlan: fix.install.fingerprint } : {}, context);
    // The button installs nothing when the plan moved between being read and being pressed. Saying
    // that plainly is the whole point: nothing here may report a success it did not have.
    if (answer.needsAgreement) throw new Error(`${planChangedNote} ${answer.message}`);
    return answer.message;
  }

  /** Hands the task its own stop record. What it already did is never done a second time. */
  private async resume(stop: AdaptStop, got: string): Promise<AdaptAnswer> {
    if (!this.deps.carryOn) {
      this.stops.update(stop.id, { carriedOnAt: this.now(), gained: got });
      return { done: true, message: `${got} ${stop.what} is ready to carry on from "${stop.nextStep}".`, stop: this.stops.get(stop.id) ?? stop, gained: got };
    }
    const { gained } = await this.deps.carryOn(stop);
    const saved = this.stops.update(stop.id, { carriedOnAt: this.now(), gained: gained || got }) ?? stop;
    const already = stop.done.length ? ` The ${stop.done.length} step${stop.done.length === 1 ? "" : "s"} it had already done were not done again.` : "";
    return { done: true, stop: saved, gained: gained || got,
      message: `${got} ${stop.what} carried on from "${stop.nextStep}".${already} It can now ${gained || got}` };
  }

  private pick(wanted: { stopId?: string | undefined }): AdaptStop | undefined {
    return wanted.stopId ? this.stops.get(wanted.stopId) : this.stops.waiting()[0];
  }
}

const shortName = (fix: AdaptFix): string => fix.install?.name ?? fix.blocker.what;

function sentenceFor(fix: AdaptFix, stop: AdaptStop | null): string {
  const where = stop ? `${stop.what} stopped at "${stop.nextStep}". ` : "";
  if (fix.instead) return `${where}${fix.blocker.said} ${fix.instead}`;
  const cost = [fix.from ? `from ${fix.from}` : "", fix.size].filter(Boolean).join(", ");
  const key = fix.needsOwnerKey ? " It needs a key of yours." : "";
  return `${where}${fix.blocker.said} ${fix.what}${cost ? ` (${cost})` : ""}.${key} Nothing has been fetched or changed yet.`;
}
