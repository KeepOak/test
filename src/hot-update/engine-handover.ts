import { z } from "zod";

/**
 * Live updates (hot-update), the old engine's side of handing over to a newer one:
 *
 * 1. Nothing new is started by the engine itself (its schedule stops ticking); tasks already working go on.
 * 2. They drain: each is given up to `drainMs` to finish here, as it would have anyway.
 * 3. Whatever is still working then is checkpointed: it stops after the step it is on (never half-way through one, so no
 *    step is cut off and none is done again) and is written down as handed over (`run.handed_over`). A task started
 *    while this goes on stops before its first step the same way.
 * 4. Main then closes this engine, which lets go of the database; the next engine to open it carries each handed-over
 *    task on exactly once (src/never-break/resume.ts resumeHandedOver).
 *
 * A step that does not end within `settleMs` more is left to the ordinary stop: it is cut off, and the journal decides
 * afterwards whether it took effect, asking the owner when it may have reached outside (src/never-break/resume.ts).
 */
export const HandOverArgsSchema = z.object({
  drainMs: z.number().int().min(0).max(30 * 60_000).default(120_000),
  settleMs: z.number().int().min(0).max(10 * 60_000).default(60_000),
}).strict();
export type HandOverArgs = z.infer<typeof HandOverArgsSchema>;

export interface HandOverResult {
  /** True when every task finished here within the drain. */
  drained: boolean;
  /** The tasks stopped after a whole step, to carry on in the new engine. */
  handedOver: string[];
  /** Tasks still in a step when the settle time ran out (the ordinary stop cuts them off). */
  stillWorking: string[];
  ms: number;
}

interface HandingOver {
  scheduler: { stop(): Promise<void> };
  runtime: { workingRuns(): string[]; idle(ms: number): Promise<boolean>; handOver(): string[]; beginHandOver(): void };
  /** Chat apps' turns: each one's answer is sent (or, handed over, left to the new engine) before this engine goes. */
  channels?: { settle(ms: number): Promise<boolean> };
}

export async function handOverWork(branch: HandingOver, args: HandOverArgs, now = Date.now): Promise<HandOverResult> {
  const started = now();
  // Its timer stops at once; the jobs it has running are tasks like any other, below.
  void branch.scheduler.stop().catch(() => undefined);
  branch.runtime.beginHandOver();
  const drained = await branch.runtime.idle(args.drainMs);
  const handedOver = drained ? [] : branch.runtime.handOver();
  if (!drained) await branch.runtime.idle(args.settleMs);
  // A chat's answer sent from here is written down as sent before this engine lets go, so the new one never sends it
  // again (src/channels/deliveries.ts), and the chat app's own request is answered, not cut off.
  await branch.channels?.settle(Math.min(Math.max(args.settleMs, 1000), 15_000));
  // A task that began meanwhile stopped before its first step; it was asked as it began (beginHandOver).
  const stillWorking = branch.runtime.workingRuns();
  return { drained, handedOver, stillWorking, ms: now() - started };
}
