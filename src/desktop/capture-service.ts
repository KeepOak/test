import { CaptureLease, type CaptureExclusion } from "./capture-lease.js";

/** Reset only after the old authenticated engine's Link closes, before a successor is started. */
export function captureService(host: ConstructorParameters<typeof CaptureLease>[0]): {
  acquire(args: unknown): CaptureExclusion; release(args: unknown): boolean; close(): void;
} {
  let lease: CaptureLease | null = null;
  return {
    acquire: (args) => (lease ??= new CaptureLease(host)).acquire(args),
    release: (args) => lease?.release(args) ?? false,
    close: () => { const old = lease; lease = null; old?.close(); },
  };
}
