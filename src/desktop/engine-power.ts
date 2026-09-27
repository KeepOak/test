export interface EnginePowerWork {
  checkpoint(): void;
  due(): Promise<unknown>;
  flush(): Promise<void>;
}

/** Saved receipts remain authoritative; resume wakes due schedules and queued delivery without reattaching adapters. */
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
    await this.work.due();
    if (this.closed) return false;
    await this.work.flush();
    return !this.closed;
  }
  close(): void { this.closed = true; }
}
