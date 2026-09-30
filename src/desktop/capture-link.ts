import { CaptureExclusionSchema, CaptureLeaseArgsSchema, type CaptureExclusion } from "./capture-lease.js";

interface CaptureLink { call(method: string, args: unknown): Promise<unknown> }
/** The engine uses only its launcher's authenticated IPC; callers supply no exclusion or host identity. */
export function trustedCaptureLease(link: CaptureLink, allowed: boolean): {
  acquire(leaseId: string): Promise<CaptureExclusion>; release(leaseId: string): Promise<void>;
} {
  const refuse = () => new Error("This engine has no proved host for the Branch viewer. Choose another target.");
  return {
    acquire: async (leaseId) => {
      if (!allowed) throw refuse();
      return CaptureExclusionSchema.parse(await link.call("capture-acquire", CaptureLeaseArgsSchema.parse({ leaseId })));
    },
    release: async (leaseId) => {
      if (!allowed) throw refuse();
      if (await link.call("capture-release", CaptureLeaseArgsSchema.parse({ leaseId })) !== true) throw new Error("The capture lease is no longer owned by this engine.");
    },
  };
}
