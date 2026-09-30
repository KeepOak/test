/**
 * A failure nobody caught, in the desktop engine's own process. One such failure (a tool's callback that threw, a
 * promise nobody waited for) is written down and the engine carries on: the tasks that are working keep working. Only
 * an engine that can no longer do its work ends, so the app starts a fresh one: when, just after the failure, its
 * database or its server no longer answers, or when failures keep coming (more than `burst` within a minute), which
 * means something is failing over and over.
 *
 * The record itself (a span in the engine's record of failures) is made by src/tracing.ts, which watches without
 * taking the failure over; this decides only whether the process lives on.
 */
export interface ErrorPolicyOptions {
  /** Whether the engine can still do its work: its database answers and its server answers. */
  healthy: () => Promise<boolean>;
  /** Ends the process so the app starts a fresh engine. */
  end: (why: string) => void;
  log: (line: string) => void;
  burst?: number;
  windowMs?: number;
  now?: () => number;
}

export function keepRunningThroughErrors(target: Pick<NodeJS.Process, "on">, options: ErrorPolicyOptions): (error: unknown) => void {
  const burst = options.burst ?? 5;
  const windowMs = options.windowMs ?? 60000;
  const now = options.now ?? Date.now;
  const recent: number[] = [];
  let checking = false;
  const failed = (error: unknown): void => {
    const at = now();
    recent.push(at);
    while (recent.length && recent[0]! < at - windowMs) recent.shift();
    const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    options.log(`The engine caught a failure nobody else did and carries on: ${what}`.slice(0, 500));
    if (recent.length > burst) { options.end(`more than ${burst} failures within ${Math.round(windowMs / 1000)} s`); return; }
    if (checking) return;
    checking = true;
    void options.healthy().then((ok) => ok, () => false).then((ok) => {
      checking = false;
      if (!ok) options.end("its database or its server stopped answering after a failure");
    });
  };
  target.on("uncaughtException", failed);
  return failed;
}
