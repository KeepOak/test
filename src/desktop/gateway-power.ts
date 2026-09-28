export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}
export interface PowerEvents {
  on(event: "suspend" | "resume", listener: () => void): unknown;
  off(event: "suspend" | "resume", listener: () => void): unknown;
}
export interface GatewayPowerStatus {
  requested: boolean; active: boolean; suspended: boolean; error: string | null;
}
export interface GatewayPowerOptions {
  blocker: PowerBlocker; events: PowerEvents;
  read(): Promise<{ keepAwake: boolean; gatewayDesired: boolean }>;
  suspended?: () => void | Promise<void>;
  resumed?: () => void | Promise<void>;
  everyMs?: number;
}

/** One retained gateway owns one application-only blocker; it never changes the screen or OS power plan. */
export class GatewayPowerPolicy {
  private id: number | null = null;
  private closed = false;
  private started = false;
  private sleeping = false;
  private requested = false;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private recovery: Promise<void> | null = null;
  private readonly suspend = () => { if (this.closed) return; this.sleeping = true; this.release(); this.run(this.options.suspended); };
  private readonly resume = () => {
    if (this.closed || this.recovery) return;
    this.sleeping = false;
    this.recovery = this.refresh().then(() => { if (!this.closed) return this.options.resumed?.(); }).catch((error: unknown) => { this.error = message(error); })
      .finally(() => { this.recovery = null; });
  };
  constructor(private readonly options: GatewayPowerOptions) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error("This gateway power policy has closed.");
    if (this.started) return this.refresh();
    this.started = true;
    this.options.events.on("suspend", this.suspend); this.options.events.on("resume", this.resume);
    await this.refresh();
    const every = this.options.everyMs ?? 1000;
    if (every > 0 && !this.closed && !this.timer) { this.timer = setInterval(() => { void this.refresh(); }, every); this.timer.unref(); }
  }

  refresh(): Promise<void> {
    return this.refreshing ??= this.update().finally(() => { this.refreshing = null; });
  }

  private async update(): Promise<void> {
    if (this.closed) return;
    try {
      const preference = await this.options.read();
      if (this.closed) return;
      this.requested = preference.keepAwake && preference.gatewayDesired; this.error = null;
      if (!this.requested || this.sleeping) { this.release(); return; }
      if (this.id !== null && this.options.blocker.isStarted(this.id)) return;
      this.id = this.options.blocker.start("prevent-app-suspension");
      if (!this.options.blocker.isStarted(this.id)) { this.release(); this.error = "The operating system did not register the keep-awake request."; }
    } catch (error) { this.error = message(error); this.release(); }
  }

  status(): GatewayPowerStatus {
    let active = false;
    try { active = this.id !== null && this.options.blocker.isStarted(this.id); } catch (error) { this.error = message(error); }
    return { requested: this.requested, active, suspended: this.sleeping, error: this.error };
  }

  private release(): void {
    const id = this.id;
    if (id !== null) try {
      this.options.blocker.stop(id);
      if (!this.options.blocker.isStarted(id)) this.id = null;
      else this.error = "The operating system has not released the keep-awake request.";
    } catch (error) { this.error = message(error); }
  }

  private run(action: (() => void | Promise<void>) | undefined): void {
    if (this.closed || !action) return;
    void Promise.resolve().then(() => { if (!this.closed) return action(); }).catch((error: unknown) => { this.error = message(error); });
  }

  close(): void {
    if (this.closed) { this.release(); return; }
    this.closed = true; this.requested = false;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.options.events.off("suspend", this.suspend); this.options.events.off("resume", this.resume);
    this.release();
  }
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
