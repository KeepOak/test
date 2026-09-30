import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Budget, type ToolContext } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import { wallSettings } from "../sandbox.js";
import { interopMode } from "./settings.js";
import type { RedisQueue } from "./redis-queue.js";

const OperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("submit"), id: z.string().uuid(), prompt: z.string().min(1).max(8000) }).strict(),
  z.object({ operation: z.literal("claim"), leaseSeconds: z.number().int().min(15).max(300) }).strict(),
  z.object({ operation: z.literal("release"), handle: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("complete"), handle: z.string().uuid(), verified: z.literal(true) }).strict(),
]);
const ClaimSchema = z.object({ status: z.literal("claimed"), id: z.string().uuid(), token: z.string(),
  expiresAt: z.number(), job: z.object({ prompt: z.string().max(8000) }), authority: z.string() });
type HeldLease = { id: string; token: string; prompt: string; expiresAt: number; forgetAt: number; runId: string; config: string };

/** Direct, explicit local-owner controls. No task is created and no job is executed.
 * Lease tokens stay here; renderer handles select only leases this control process acquired. */
export class RedisQueueControls {
  private readonly leases = new Map<string, HeldLease>();
  private revision = 0;
  private claiming = 0;
  constructor(private readonly runtime: Runtime, private readonly queue: RedisQueue) {}

  invalidate(): void { this.revision++; this.leases.clear(); this.queue.cancel(); }

  view(): unknown {
    this.queue.assertOwner(); this.prune();
    const settings = this.queue.settings(), project = this.runtime.store.projects.active(this.runtime.owner).id;
    const tokenConfigured = settings.mode === "on" && settings.project === project
      && this.runtime.store.secrets.list(this.runtime.owner, project).some((entry) => entry.name === settings.tokenName);
    const wall = wallSettings(this.runtime.store, this.runtime.owner);
    const heldReason = settings.mode !== "on" ? "Save enabled Redis settings first."
      : interopMode(this.runtime.store, this.runtime.owner, "fleet") === "off" ? "Enable Fleet in Customize first."
      : settings.project !== project ? "Switch to the configured project before using its locker token."
      : !tokenConfigured ? "Save the named token in the current project's locker first."
      : wall.mode !== "off" && wall.network !== "open" ? "The OS network wall is narrower than this integration allows." : "";
    return { settings, activeProject: project, tokenConfigured, heldReason, leases: [...this.leases].map(([handle, lease]) => ({
      handle, id: lease.id, prompt: this.runtime.hideSecrets(lease.prompt), expiresAt: lease.expiresAt,
    })) };
  }

  async operate(input: unknown, signal: AbortSignal): Promise<unknown> {
    this.queue.assertOwner(); this.prune();
    const args = OperationSchema.parse(input);
    const wall = wallSettings(this.runtime.store, this.runtime.owner);
    if (wall.mode !== "off" && wall.network !== "open") throw new Error("The OS network wall refuses Redis controls");
    const held = "handle" in args ? this.leases.get(args.handle) : undefined;
    if ("handle" in args && !held) throw new Error("This window's Redis lease is no longer held; refresh or claim again");
    if (args.operation === "claim" && this.leases.size + this.claiming >= 8) throw new Error("Release a held lease before claiming another");
    const revision = this.revision;
    const runId = held?.runId ?? `redis-owner-control:${randomUUID()}`;
    // This route's local authenticated owner deliberately requested this single outbound operation.
    // These permissions apply only to this queue call, never to execution of the returned prompt.
    const context: ToolContext = { owner: this.runtime.owner, workspace: this.runtime.workspace, runId, signal,
      budget: new Budget({ maxSteps: 1, maxTokens: 16000 }), depth: 0, source: "owner",
      permissions: new Set(["specialists.use"]) };
    if (args.operation === "claim") this.claiming++;
    let result: unknown;
    try { result = await this.queue.call(args.operation, context, held ? { id: held.id, token: held.token }
      : args.operation === "submit" ? { id: args.id, prompt: args.prompt }
      : args.operation === "claim" ? { leaseSeconds: args.leaseSeconds } : {}); }
    finally { if (args.operation === "claim") this.claiming--; }
    this.queue.assertOwner();
    if (revision !== this.revision) throw new Error("Redis controls changed; the result cannot be retained");
    if (args.operation === "claim") return this.keepClaim(result, runId, args.leaseSeconds);
    if ("handle" in args && held && typeof result === "object" && result !== null && "status" in result
      && ["complete", "release", "stale"].includes(String(result.status))) this.leases.delete(args.handle);
    return result;
  }

  private keepClaim(result: unknown, runId: string, seconds: number): unknown {
    const claim = ClaimSchema.safeParse(result);
    if (!claim.success) {
      if (typeof result === "object" && result !== null && "token" in result) throw new Error("Invalid Redis lease reply");
      return result;
    }
    const handle = randomUUID(), config = JSON.stringify(this.queue.settings());
    this.leases.set(handle, { ...claim.data.job, id: claim.data.id, token: claim.data.token, expiresAt: claim.data.expiresAt,
      forgetAt: Date.now() + seconds * 1000 + 15000, runId, config });
    return { status: "claimed", handle, id: claim.data.id, prompt: claim.data.job.prompt, expiresAt: claim.data.expiresAt,
      authority: claim.data.authority };
  }

  private prune(): void {
    const config = JSON.stringify(this.queue.settings());
    for (const [handle, lease] of this.leases)
      if (lease.forgetAt <= Date.now() || lease.config !== config) this.leases.delete(handle);
  }
}
