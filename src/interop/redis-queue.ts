import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { projectIdSchema, secretNameSchema } from "../locker.js";
import { lockdownActive } from "../lockdown.js";
import type { NetworkPolicy } from "../network-policy.js";
import { outsideSourceOf } from "../outside-origin.js";
import { pinnedFetch } from "../pinned-fetch.js";
import type { Runtime } from "../runtime.js";
import type { ToolRegistry } from "../registry.js";
import { wallSettings } from "../sandbox.js";
import { requireInterop } from "./settings.js";
import { queueScript } from "./redis-queue-script.js";

const endpoint = z.string().max(500).refine((text) => {
  try { const url = new URL(text); return url.protocol === "https:" && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/"; } catch { return false; }
}, "Use the HTTPS REST endpoint root without credentials, query or path");
export const RedisQueueSettingsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z.object({ mode: z.literal("on"), endpoint, fleet: z.string().uuid(), project: projectIdSchema, tokenName: secretNameSchema }).strict(),
]);
type Settings = z.infer<typeof RedisQueueSettingsSchema>;
const JobSchema = z.object({ prompt: z.string().min(1).max(8000) }).strict();
const IdSchema = z.string().uuid();
const TokenSchema = z.string().regex(/^[a-f0-9]{32}:[a-f0-9-]{36}$/);
const lease = z.number().int().min(15).max(300).default(60);
const result = z.array(z.union([z.string().max(12000), z.number().finite()])).min(1).max(5);
const key = "redis-fleet-queue";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
type Arguments = { id?: string; prompt?: string; token?: string; leaseSeconds?: number };
type Operation = "submit" | "claim" | "complete" | "release" | "status";

/** Optional coordination only: a claim is data, never permission to run a remote prompt. */
export class RedisQueue {
  private readonly machine = randomUUID();
  private readonly active = new Set<AbortController>();
  private revision = 0;
  constructor(private readonly runtime: Runtime, private readonly policy: NetworkPolicy,
    private readonly locked: () => boolean) {}

  settings(): Settings {
    const found = RedisQueueSettingsSchema.safeParse(this.runtime.store.get("settings", this.runtime.owner, key)?.data);
    return found.success ? found.data : { mode: "off" };
  }

  configure(input: unknown): Settings {
    this.assertOwner();
    const value = RedisQueueSettingsSchema.parse(input);
    this.runtime.store.save("settings", this.runtime.owner, key, { ...value });
    this.cancel();
    return value;
  }

  cancel(): void {
    this.revision++;
    for (const controller of this.active) controller.abort();
  }

  assertOwner(): void {
    this.runtime.store.profiles.requireOwner("Redis fleet coordination");
    if (startedWithShortLivedKey() || this.locked() || lockdownActive(this.runtime.store, this.runtime.owner)
      || this.runtime.store.profiles.scope() !== this.runtime.owner)
      throw new Error("Redis coordination needs the unlocked owner");
  }

  private fence(context: ToolContext, snapshot: Settings, revision: number): void {
    this.assertOwner();
    requireInterop(this.runtime.store, context.owner, "fleet");
    context.signal.throwIfAborted();
    const wall = wallSettings(this.runtime.store, context.owner);
    if (wall.mode !== "off" && wall.network !== "open") throw new Error("The OS network wall refuses Redis coordination");
    if (context.owner !== this.runtime.owner || context.source !== "owner" || outsideSourceOf(this.runtime.store, context.runId)
      || context.isolated || context.dryRun
      || !context.permissions.has("specialists.use") || context.sandbox === "no-internet"
      || (context.osSandbox && context.osSandbox.network !== "open")
      || context.budget.steps > context.budget.limits.maxSteps || context.budget.tokens > context.budget.limits.maxTokens)
      throw new Error("This call has no owner network scope for Redis coordination");
    if (snapshot.mode === "on" && this.runtime.store.projects.active(context.owner).id !== snapshot.project)
      throw new Error("Redis coordination may only use a token in this call's active project");
    if (revision !== this.revision || JSON.stringify(snapshot) !== JSON.stringify(this.settings()))
      throw new Error("Redis coordination settings changed; start a new call");
  }

  private prefix(context: ToolContext): string {
    return digest(`${this.machine}:${context.owner}:${context.runId}`) + ":";
  }

  async call(operation: Operation, context: ToolContext, args: Arguments): Promise<unknown> {
    const config = this.settings(), revision = this.revision;
    this.fence(context, config, revision);
    if (config.mode !== "on") throw new Error("Redis fleet coordination is off; configure it in the owner's window");
    if (this.active.size >= 2) throw new Error("Two Redis coordination calls are already in progress");
    const controller = new AbortController(); this.active.add(controller);
    const signal = AbortSignal.any([context.signal, controller.signal, AbortSignal.timeout(15000)]);
    const policy = JSON.stringify(this.policy.snapshot());
    const still = (): void => {
      this.fence(context, config, revision); signal.throwIfAborted();
      if (policy !== JSON.stringify(this.policy.snapshot())) throw new Error("The network policy changed");
    };
    const watch = setInterval(() => { try { still(); } catch { controller.abort(); } }, 100);
    watch.unref();
    let sent = false;
    try {
      const values = await untilAborted(this.runtime.store.secrets.resolve(context.owner, config.project, [config.tokenName],
        { runId: context.runId, purpose: "Redis fleet coordination" }), signal);
      still();
      const token = values[config.tokenName];
      if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new Error("The configured Redis token is unavailable");
      const command = this.command(operation, context, config, args);
      const send = this.policy.guard((input, init) => {
        still(); sent = true;
        return pinnedFetch(input, init);
      });
      const response = await untilAborted(send(config.endpoint, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(command) }), signal);
      const answer = await boundedResponse(response);
      still();
      return this.decode(answer, operation, context);
    } catch {
      // A write may have committed: no retry, or transport/server text that can echo credentials.
      throw new Error(sent ? `Redis ${operation} did not return a verified result; it may have committed. Do not repeat work blindly.`
        : "Redis coordination was refused before sending a request. Check the owner scope, settings and network policy.");
    } finally { clearInterval(watch); this.active.delete(controller); }
  }

  private command(operation: Operation, context: ToolContext, config: Extract<Settings, { mode: "on" }>,
    args: Arguments): (string | number)[] {
    const prefix = `branch:fleet:{${config.fleet}:${digest(context.owner)}}:`;
    const keys = ["jobs", "ready", "leased", "tokens", "orders", "sequence", "done"].map((suffix) => prefix + suffix);
    let value = "";
    if (operation === "submit") {
      const job = JobSchema.parse({ prompt: this.runtime.hideSecrets(args.prompt ?? "") });
      value = JSON.stringify(job);
      if (Buffer.byteLength(value) > 12000) throw new Error("The queue job exceeds 12 KiB");
    } else if (operation === "claim") value = this.prefix(context) + randomUUID();
    else if (operation === "complete" || operation === "release") {
      value = TokenSchema.parse(args.token);
      if (!value.startsWith(this.prefix(context))) throw new Error("Only the claiming owner turn can finish this lease");
    }
    const id = ["submit", "complete", "release"].includes(operation) ? IdSchema.parse(args.id) : "";
    return ["EVAL", queueScript, keys.length, ...keys, operation, id, value, lease.parse(args.leaseSeconds)];
  }

  private decode(answer: unknown, operation: Operation, context: ToolContext): unknown {
    const fields = result.parse(answer), status = fields[0];
    if (operation === "status" && status === "status" && fields.length === 3)
      return { waiting: z.number().int().min(0).max(100).parse(fields[1]), leased: z.number().int().min(0).max(100).parse(fields[2]) };
    if (operation === "claim" && status === "claimed" && fields.length === 5) {
      const token = TokenSchema.parse(fields[2]);
      if (!token.startsWith(this.prefix(context))) throw new Error("The lease belongs to another turn");
      const job = JobSchema.parse(JSON.parse(z.string().parse(fields[4])));
      return { status, id: IdSchema.parse(fields[1]), token, expiresAt: z.number().int().positive().max(8640000000000000).parse(fields[3]),
        job: { prompt: this.runtime.hideSecrets(job.prompt) }, authority: "data-only; execution requires fresh local approval" };
    }
    const allowed: Record<Operation, string[]> = { submit: ["submitted", "existing", "completed", "conflict", "full", "damaged"],
      claim: ["empty", "damaged"], complete: ["complete", "stale", "receipts-full", "damaged"],
      release: ["release", "stale", "damaged"], status: ["damaged"] };
    if (typeof status !== "string" || !allowed[operation].includes(status)) throw new Error("Unexpected Redis queue result");
    return { status, ...(fields[1] === undefined ? {} : { id: IdSchema.parse(fields[1]) }) };
  }
}

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Redis request refused"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536 || chunks.length >= 1024) throw new Error("Redis response exceeded the limit");
      if (value.byteLength) chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return z.object({ result: z.unknown() }).strict().parse(data).result;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("Redis coordination was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function registerRedisQueueTools(registry: ToolRegistry, queue: RedisQueue): void {
  const tools = [
    { operation: "submit", parameters: z.object({ id: IdSchema, prompt: JobSchema.shape.prompt }).strict(),
      description: "Queue scrubbed prompt data in the owner's configured Redis fleet. Use a stable UUID for retries; this does not run it." },
    { operation: "claim", parameters: z.object({ leaseSeconds: lease }).strict(),
      description: "Lease one Redis fleet job for 15–300 seconds. Data only: no authority or automatic execution. Finish in this owner turn." },
    { operation: "complete", parameters: z.object({ id: IdSchema, token: TokenSchema }).strict(),
      description: "Mark your unexpired Redis lease complete. A stale or another turn's token cannot complete it." },
    { operation: "release", parameters: z.object({ id: IdSchema, token: TokenSchema }).strict(),
      description: "Return your unexpired Redis lease to the queue without executing anything." },
    { operation: "status", parameters: z.object({}).strict(), description: "Read bounded waiting and leased counts in the configured Redis fleet." },
  ] as const;
  for (const tool of tools) registry.register<Arguments>({ name: `fleet.queue.${tool.operation}`, group: "agents",
    permission: "specialists.use", reach: "outbound", description: tool.description, parameters: tool.parameters,
    execute: (args, context) => queue.call(tool.operation, context, args) });
}
