export interface EnginePowerWork {
  checkpoint(): void;
  due(): Promise<unknown>;
  flush(): Promise<void>;
  /** The chat apps' look after waking (src/channels/router.ts `wake`): stale connections are started again. */
  reconnect?(): Promise<void>;
  log?(line: string): void;
}

/**
 * Saved receipts remain authoritative; resume wakes due schedules and queued delivery, and has every chat app looked at
 * so a connection that died in the sleep is started again (UP-PLATFORM-003).
 */
export class EnginePowerRecovery {
  private closed = false;
  private waking: Promise<boolean> | null = null;
  constructor(private readonly work: EnginePowerWork) {}
  suspend(): boolean {
    if (this.closed) return false;
    this.work.checkpoint();
    return true;
  }
  resume(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.waking ??= this.wake().finally(() => { this.waking = null; });
  }
  private async wake(): Promise<boolean> {
    this.work.checkpoint();
    // Never awaited here: the look waits up to a minute for each app's service, while the caller's resume call has ten
    // seconds and due work must not wait on it. The router merges this with the watchdog's own late-beat wake.
    void this.work.reconnect?.().catch((error: unknown) =>
      this.work.log?.(`Chat apps after waking: ${error instanceof Error ? error.message : String(error)}`));
    await this.work.due();
    if (this.closed) return false;
    await this.work.flush();
    return !this.closed;
  }
  close(): void { this.closed = true; }
}

export interface PowerSignals { on(event: "suspend" | "resume", listener: () => void): unknown }
export interface PoweredEngine {
  readonly running: boolean;
  readonly handingOver: boolean;
  call(method: string, args: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * A window's own engine (no detached gateway) is told when the computer sleeps and wakes, as the gateway's engine is:
 * saved work is checkpointed before sleep, and due schedules and queued deliveries carry on after it.
 */
export function followPower(signals: PowerSignals, engine: PoweredEngine, log: (line: string) => void): void {
  const tell = (method: string, ms: number) => {
    if (!engine.running || engine.handingOver) return;
    void engine.call(method, {}, ms).catch((error: unknown) => log(`Engine ${method}: ${error instanceof Error ? error.message : String(error)}`));
  };
  signals.on("suspend", () => tell("power-suspend", 5000));
  signals.on("resume", () => tell("power-resume", 10000));
}
