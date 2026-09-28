import { z } from 'zod';

export const CaptureBoundsSchema = z.object({
  x: z.number().int().min(-100000).max(100000), y: z.number().int().min(-100000).max(100000),
  w: z.number().int().positive().max(16384), h: z.number().int().positive().max(16384),
}).strict();
const handle = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const NativeCaptureTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monitor'), deviceName: z.string().min(1).max(256), bounds: CaptureBoundsSchema }).strict(),
  z.object({ kind: z.literal('window'), handle, processId: z.number().int().positive(), bounds: CaptureBoundsSchema }).strict(),
]);
export type NativeCaptureTarget = z.infer<typeof NativeCaptureTargetSchema>;
export const CaptureExclusionSchema = z.object({ processId: z.number().int().positive(), handles: z.array(handle).max(256) }).strict();
export type CaptureExclusion = z.infer<typeof CaptureExclusionSchema>;
export const CaptureLeaseArgsSchema = z.object({ leaseId: z.string().regex(/^[a-f0-9]{32}$/) }).strict();

export interface CaptureWindow {
  isDestroyed(): boolean;
  isContentProtected(): boolean;
  setContentProtection(enabled: boolean): void;
  getNativeWindowHandle(): Buffer;
}
interface CaptureHost {
  platform: string; release: string; processId: number;
  windows(): CaptureWindow[];
  onCreated(listener: (window: CaptureWindow) => void): () => void;
}

/** Only Electron's own process can exclude its own windows. No caller supplies a window to hide. */
export class CaptureLease {
  private readonly leases = new Set<string>();
  private readonly previous = new Map<CaptureWindow, boolean>();
  private unsubscribe: (() => void) | undefined;
  private starting = false;
  private closed = false;
  private fault: unknown;
  constructor(private readonly options: CaptureHost) {}

  acquire(args: unknown): CaptureExclusion {
    const { leaseId } = CaptureLeaseArgsSchema.parse(args);
    if (this.closed) throw new Error('The capture host is closed.');
    const [major, minor, build] = this.options.release.split('.').map(Number);
    if (this.options.platform !== 'win32' || major !== 10 || minor !== 0 || (build ?? 0) < 19041)
      throw new Error('Excluding Branch from this view needs Windows 10 version 2004 or newer. Choose another target.');
    if (!this.leases.size) this.start();
    try {
      if (this.fault) throw this.fault;
      const proof = this.snapshot();
      this.leases.add(leaseId);
      return proof;
    } catch (error) {
      if (!this.leases.size) this.restore();
      throw error;
    }
  }

  private start(): void {
    this.starting = true;
    try {
      this.unsubscribe = this.options.onCreated((window) => {
        if (!this.starting && !this.leases.size) return;
        try { this.protect(window); } catch (error) { this.fault = error; }
      });
      for (const window of this.options.windows()) this.protect(window);
    } catch (error) { this.restore(); throw error; }
    finally { this.starting = false; }
  }

  private protect(window: CaptureWindow): void {
    if (window.isDestroyed() || this.previous.has(window)) return;
    this.previous.set(window, window.isContentProtected());
    window.setContentProtection(true);
    if (!window.isContentProtected()) throw new Error('Branch could not exclude its viewer from this capture.');
  }

  private snapshot(): CaptureExclusion {
    const handles = [];
    for (const window of this.options.windows()) {
      if (window.isDestroyed()) continue;
      this.protect(window);
      const bytes = window.getNativeWindowHandle();
      if (bytes.length !== 4 && bytes.length !== 8) throw new Error('Branch could not identify its capture windows.');
      handles.push((bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString());
    }
    return CaptureExclusionSchema.parse({ processId: this.options.processId, handles });
  }

  release(args: unknown): boolean {
    const { leaseId } = CaptureLeaseArgsSchema.parse(args);
    if (!this.leases.delete(leaseId)) return false;
    if (!this.leases.size) this.restore();
    return true;
  }

  private restore(): void {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const [window, value] of this.previous) {
      if (!window.isDestroyed()) {
        try { window.setContentProtection(value); } catch { /* a disappearing window cannot hold another lease */ }
      }
    }
    this.previous.clear(); this.fault = undefined;
  }

  close(): void {
    this.closed = true; this.leases.clear(); this.restore();
  }
}
