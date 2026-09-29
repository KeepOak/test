import type { EngineAccess } from "./engine-gate.js";

/** Retry a canceled first navigation too: the gate need not have been ready before that cancellation. */
export class EnginePage {
  private retry = false;
  constructor(private readonly access: EngineAccess, private readonly missing: () => boolean, private readonly load: () => void) {
    access.onLost(() => { this.retry = true; });
    access.onReady(() => this.recover());
  }

  failed(): void { this.retry = true; this.recover(); }

  private recover(): void {
    if (!this.retry || !this.access.ready()) return;
    this.retry = false;
    if (this.missing()) this.load();
  }
}
