import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { Runtime } from "./runtime.js";
import { substitute } from "./recipes.js";

/**
 * Inbound triggers: external apps fire webhooks to POST /api/triggers/:id/fire to start runs.
 * Each trigger has a name, a prompt template with {{payload}} and {{field.path}} placeholders,
 * and a rate limit. Verification is by bearer secret or HMAC-SHA256 signature.
 */
export const TriggerSchema = z
  .object({
    name: z.string().min(1).max(100),
    prompt: z.string().min(1).max(8000),
    sessionId: z.string().uuid().optional(),
    enabled: z.boolean().default(true),
    rateLimitPerMinute: z.number().int().min(1).max(100).default(30),
    /**
     * Refuses a request that does not carry a fresh `x-branch-timestamp` and an
     * `x-branch-nonce` nobody has used before, so a request somebody copied off the wire cannot
     * be sent again later. Off by default, because the sending service has to add both headers.
     */
    replayProtection: z.boolean().default(false),
    /** How old a timestamp may be, and how long a nonce is remembered for. */
    replayWindowSeconds: z.number().int().min(30).max(3600).default(300),
  })
  .strict();
export type TriggerConfig = z.infer<typeof TriggerSchema>;
export interface TriggerState {
  id: string;
  name: string;
  prompt: string;
  sessionId?: string | undefined;
  enabled: boolean;
  rateLimitPerMinute: number;
  replayProtection: boolean;
  replayWindowSeconds: number;
  secret: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * ReadBody result: raw buffer for HMAC verification + parsed JSON.
 */
export interface BodyWithRaw {
  raw: Buffer;
  parsed: unknown;
}

/**
 * Reads a request body, keeping the exact bytes so a signature can be checked against them,
 * and refusing anything over the size limit.
 */
export async function readBodyWithRaw(
  request: AsyncIterable<Buffer | string>,
  maximumBytes = 256 * 1024,
): Promise<BodyWithRaw> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const tooLarge = () => new Error(`Request exceeds ${maximumBytes / 1024} KiB`);

  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maximumBytes) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("Invalid JSON");
  }

  return { raw, parsed };
}

/**
 * Extract value from payload using dot notation (e.g., "event.action" from nested objects).
 */
function extractField(payload: unknown, path: string): unknown {
  let current = payload;
  for (const part of path.split(".")) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export class Triggers {
  private readonly rateLimitWindowMs = 60000;
  private readonly requestCounts = new Map<string, number[]>(); // trigger ID -> timestamps of recent fires
  /** Nonces already used, with the moment they stop mattering, so one is never accepted twice. */
  private readonly usedNonces = new Map<string, number>();
  /** The clock, so a test can prove a stale timestamp is refused without waiting five minutes. */
  now: () => number = Date.now;
  /**
   * eng-trunk-controls: why nothing may start in this conversation now (the Trunk it belongs to is paused),
   * in words, or null. `createBranch` connects it; on its own every trigger fires.
   */
  held: (sessionId: string) => string | null = () => null;

  /**
   * Refuses a request whose timestamp is outside the window or whose nonce has been seen before.
   * Only runs for a trigger the owner switched replay protection on for, so a service that cannot
   * add the two headers keeps working exactly as it did.
   */
  checkFreshness(trigger: TriggerState, headers: Record<string, string | string[] | undefined>): { valid: boolean; error?: string } {
    if (!trigger.replayProtection) return { valid: true };
    const read = (name: string) => { const value = headers[name]; return String((Array.isArray(value) ? value[0] : value) ?? ""); };
    const stamp = read("x-branch-timestamp"), nonce = read("x-branch-nonce");
    if (!stamp || !nonce) return { valid: false, error: "Missing timestamp or nonce" };
    if (nonce.length > 200) return { valid: false, error: "Nonce is too long" };
    const sent = Number(stamp);
    const seconds = !Number.isFinite(sent) ? NaN : sent > 1e11 ? sent / 1000 : sent;
    const now = this.now();
    if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > trigger.replayWindowSeconds)
      return { valid: false, error: "Timestamp is outside the allowed window" };
    for (const [key, expires] of this.usedNonces) if (expires <= now) this.usedNonces.delete(key);
    const key = `${trigger.id}:${nonce}`;
    if (this.usedNonces.has(key)) return { valid: false, error: "That request has already been received" };
    this.usedNonces.set(key, now + trigger.replayWindowSeconds * 1000);
    return { valid: true };
  }

  constructor(readonly store: Store, readonly runtime: Runtime) {}

  /**
   * Create a new inbound trigger. The owner specifies a name, prompt template, and optional
   * session ID. A random secret is generated and returned. The trigger starts enabled.
   */
  create(context: ToolContext, input: unknown): TriggerState {
    // Owner-only setting: the gate is the local session token, as for channels and teams.
    const definition = TriggerSchema.parse(input);
    const id = randomUUID();
    this.store.save("triggers", context.owner, id, {
      name: definition.name,
      prompt: definition.prompt,
      ...(definition.sessionId ? { sessionId: definition.sessionId } : {}),
      enabled: true,
      rateLimitPerMinute: definition.rateLimitPerMinute,
      replayProtection: definition.replayProtection,
      replayWindowSeconds: definition.replayWindowSeconds,
      secret: randomBytes(24).toString("hex"),
    });
    return this.get(context.owner, id)!;
  }

  /**
   * Get a trigger by ID (owner-scoped).
   */
  get(owner: string, id: string): TriggerState | undefined {
    const record = this.store.get("triggers", owner, id);
    return record ? hydrate(record) : undefined;
  }

  /**
   * List all triggers for the owner.
   */
  list(owner: string): TriggerState[] {
    return this.store.list("triggers", owner).map(hydrate);
  }

  /**
   * Rotate (regenerate) a trigger's secret.
   */
  rotateSecret(owner: string, id: string): string {
    const trigger = this.get(owner, id);
    if (!trigger) throw new Error("Trigger not found");

    const secret = randomBytes(24).toString("hex");
    this.saveState(owner, id, { ...trigger, secret });
    return secret;
  }

  /**
   * Turn a trigger on or off. A trigger that is off refuses every incoming request.
   */
  setEnabled(owner: string, id: string, enabled: boolean): TriggerState {
    const trigger = this.get(owner, id);
    if (!trigger) throw new Error("Trigger not found");
    this.saveState(owner, id, { ...trigger, enabled });
    return this.get(owner, id)!;
  }

  /** Writes only the stored fields; the row's own id and timestamps never go into the blob. */
  private saveState(owner: string, id: string, state: TriggerState): void {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = state;
    this.store.save("triggers", owner, id, data);
  }

  /**
   * Remove a trigger.
   */
  remove(owner: string, id: string): void {
    const trigger = this.get(owner, id);
    if (!trigger) throw new Error("Trigger not found");
    this.store.delete("triggers", owner, id);
  }

  /**
   * Verify incoming fire request using bearer secret or HMAC-SHA256 signature.
   * Returns { valid: boolean, error?: string }
   */
  verify(trigger: TriggerState, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): { valid: boolean; error?: string } {
    // Check for bearer token
    const authHeader = headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token.length === trigger.secret.length) {
        try {
          if (timingSafeEqual(Buffer.from(token), Buffer.from(trigger.secret))) {
            return { valid: true };
          }
        } catch {
          return { valid: false, error: "Invalid secret" };
        }
      }
      return { valid: false, error: "Invalid secret" };
    }

    // Check for HMAC signature
    const sigHeader = headers["x-branch-signature"];
    if (sigHeader) {
      const sig = typeof sigHeader === "string" ? sigHeader : sigHeader[0];
      if (!sig) return { valid: false, error: "Missing signature" };

      const parts = sig.split("=");
      const algo = parts[0];
      const hex = parts[1];
      if (!hex || algo !== "sha256") return { valid: false, error: "Invalid signature algorithm" };

      const computed = createHmac("sha256", trigger.secret)
        .update(rawBody)
        .digest("hex");

      if (hex && hex.length === computed.length) {
        try {
          if (timingSafeEqual(Buffer.from(hex), Buffer.from(computed))) {
            return { valid: true };
          }
        } catch {
          return { valid: false, error: "Invalid signature" };
        }
      }
      return { valid: false, error: "Invalid signature" };
    }

    return { valid: false, error: "No credentials provided" };
  }

  /**
   * Check if a trigger can fire (rate limit and enabled status).
   */
  canFire(triggerId: string, trigger: TriggerState): { allowed: boolean; reason?: string } {
    if (!trigger.enabled) {
      return { allowed: false, reason: "Trigger is disabled" };
    }

    const now = Date.now();
    const window = this.requestCounts.get(triggerId) ?? [];

    // Remove timestamps older than the window
    const recentCounts = window.filter((ts) => now - ts < this.rateLimitWindowMs);
    this.requestCounts.set(triggerId, recentCounts);

    if (recentCounts.length >= trigger.rateLimitPerMinute) {
      return { allowed: false, reason: "Rate limit exceeded" };
    }

    return { allowed: true };
  }

  /**
   * Record a fire event in the trigger log.
   */
  logFire(triggerId: string, owner: string, runId: string | null, payloadSummary: string, status: string): void {
    this.store.logTriggerFire(triggerId, owner, runId, payloadSummary, status);
  }

  /**
   * Get the trigger log (limited to last 50 entries).
   */
  getLog(triggerId: string, owner: string): ReturnType<Store["getTriggerLog"]> {
    return this.store.getTriggerLog(triggerId, owner);
  }

  /**
   * Fire a trigger: substitute placeholders in the prompt and run the assistant.
   */
  async fire(
    owner: string,
    triggerId: string,
    payload: unknown,
  ): Promise<{ runId: string; status: string }> {
    const trigger = this.get(owner, triggerId);
    if (!trigger) throw new Error("Trigger not found");

    const canFireResult = this.canFire(triggerId, trigger);
    if (!canFireResult.allowed) {
      this.logFire(triggerId, owner, null, JSON.stringify(payload).slice(0, 100), canFireResult.reason!);
      throw new Error(canFireResult.reason);
    }

    const held = trigger.sessionId ? this.held(trigger.sessionId) : null; // eng-trunk-controls
    if (held) {
      this.logFire(triggerId, owner, null, JSON.stringify(payload).slice(0, 100), held);
      throw new Error(held);
    }

    // Prepare inputs for substitution: {{payload}} and {{field.path}}
    const inputs: Record<string, string | number | boolean> = {
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    };

    // Add field.path substitutions from payload
    if (payload && typeof payload === "object") {
      const flatPaths = (obj: unknown, prefix = ""): void => {
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          for (const [key, value] of Object.entries(obj)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
              inputs[path] = value;
            } else if (typeof value === "object" && value !== null) {
              flatPaths(value, path);
            }
          }
        }
      };
      flatPaths(payload);
    }

    // Substitute placeholders in the prompt
    let finalPrompt = trigger.prompt;
    try {
      finalPrompt = substitute(trigger.prompt, inputs);
    } catch (e) {
      const error = (e as Error).message;
      this.logFire(triggerId, owner, null, JSON.stringify(payload).slice(0, 100), `substitution_error: ${error}`);
      throw new Error(`Prompt substitution failed: ${error}`);
    }

    // Record the fire attempt
    this.requestCounts.set(triggerId, [Date.now(), ...(this.requestCounts.get(triggerId) ?? [])]);

    // Run the assistant
    const run = await this.runtime.run({
      prompt: finalPrompt,
      source: "trigger",
      ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
    });

    this.logFire(triggerId, owner, run.id, JSON.stringify(payload).slice(0, 256), run.status);
    this.store.event(run.id, "trigger.fired", { triggerId, trigger: trigger.name });
    this.runtime.notifyEvent("trigger.fired", { triggerId, name: trigger.name, runId: run.id, status: run.status });

    return { runId: run.id, status: run.status };
  }
}

/** Row columns win over the stored blob, so a stale copy inside the blob can never leak out. */
function hydrate(record: SavedRecord): TriggerState {
  const data = record.data as Partial<TriggerState>;
  return {
    name: String(data.name ?? ""),
    prompt: String(data.prompt ?? ""),
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    enabled: data.enabled !== false,
    rateLimitPerMinute: data.rateLimitPerMinute ?? 30,
    replayProtection: data.replayProtection === true,
    replayWindowSeconds: data.replayWindowSeconds ?? 300,
    secret: String(data.secret ?? ""),
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
