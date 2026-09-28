import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";
import { fillFrom, templateNames } from "./json-template.js";

/**
 * Outbound webhooks: the assistant notifies external endpoints when events occur.
 * Each webhook specifies a URL and optional secret. Delivery is JSON with an HMAC signature.
 * Failing deliveries are retried with exponential backoff, then auto-disabled.
 */
const shape: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().max(600), z.number(), z.boolean(), z.null(), z.array(shape).max(20), z.record(z.string().max(60), shape)]));
export const WebhookSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url().max(2000),
    secret: z.string().min(1).max(100).optional(),
    /**
     * The name of a secret in the default project's locker holding the signing key, so the key
     * lives with the other secrets rather than in this row. Tried before `secret`.
     */
    secretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
    /**
     * What to send for each event, as a JSON shape with `{{name}}` inside its strings. A name may
     * reach inside what is being announced (`{{run.id}}`). Absent means the whole event is sent.
     */
    templates: z.record(z.string().min(1).max(50), z.record(z.string().max(60), shape)).optional(),
    events: z.array(z.string().min(1).max(50)).min(1).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    for (const event of Object.keys(value.templates ?? {}))
      if (!value.events.includes(event))
        context.addIssue({ code: "custom", message: `This webhook has a shape for "${event}" but does not listen for it`, path: ["templates", event] });
  });
export type WebhookConfig = z.infer<typeof WebhookSchema>;
export interface WebhookState {
  id: string;
  name: string;
  url: string;
  secret?: string | undefined;
  secretName?: string | undefined;
  templates?: Record<string, Record<string, unknown>> | undefined;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
}

/** Pauses between delivery attempts, so three tries in all; overridable so tests wait no real seconds. */
export const defaultRetryDelays = [5000, 10000];
const maxConsecutiveFailures = 5;
const deliveryTimeoutMs = 10000;

export const webhookEvents = [
  "run.completed",
  "run.failed",
  "schedule.fired", "schedule.day_off",
  "delivery.failed",
  "trigger.fired",
  "approval.needed",
  /** A test that used to pass has started failing. */
  "evaluation.regression",
  /** One step of a saved flow has finished, failed, or stopped to wait for something. */
  "flow.node",
  /** A check-in decided the owner should hear something (the news itself is not sent along). */
  "heartbeat.notify",
  /** A scheduled job's check script failed; `paused` says whether the job has been stopped for it. */
  "schedule.script_failed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
/** What the rest of the runtime calls to announce an event; a no-op when nothing is listening. */
export type WebhookNotifier = (event: WebhookEvent, payload: Record<string, unknown>) => void;

export class Webhooks {
  constructor(
    readonly store: Store,
    private readonly policy: NetworkPolicy,
    /** Pauses between attempts; one more attempt is made than there are pauses. */
    public retryDelays: number[] = defaultRetryDelays,
  ) {}
  /**
   * Deliveries to one webhook can overlap, and each takes a while. Each is numbered as it starts, and the newest one to
   * give up is remembered, so an older delivery finishing late never clears a newer failure; and the counts are always
   * written onto the webhook as it is now, never onto the copy read before sending (which would undo a switch-off, or
   * an edit the owner made meanwhile).
   */
  private started = 0;
  private readonly lastFailure = new Map<string, number>();

  /**
   * Notify every webhook listening for an event. Deliveries run in the background and their
   * failures are swallowed: announcing an event must never disturb the work that caused it.
   */
  notify(owner: string, event: WebhookEvent, payload: Record<string, unknown>): void {
    try {
      for (const webhook of this.list(owner))
        void this.deliver(owner, webhook.id, event, payload).catch(() => undefined);
    } catch {
      /* a webhook problem never affects the run that triggered it */
    }
  }

  /** A notifier bound to one owner, for the runtime and the delivery ledger to call. */
  notifier(owner: string): WebhookNotifier {
    return (event, payload) => this.notify(owner, event, payload);
  }

  /**
   * Create a new outbound webhook.
   */
  create(context: ToolContext, input: unknown): WebhookState {
    // Owner-only setting: the gate is the local session token, as for channels and teams.
    const definition = WebhookSchema.parse(input);
    const id = randomUUID();
    this.store.save("webhooks", context.owner, id, {
      name: definition.name,
      url: definition.url,
      events: definition.events,
      ...(definition.secret ? { secret: definition.secret } : {}),
      ...(definition.secretName ? { secretName: definition.secretName } : {}),
      ...(definition.templates ? { templates: definition.templates } : {}),
      enabled: true,
      failureCount: 0,
      disabledAt: null,
      disabledReason: null,
    });
    return this.get(context.owner, id)!;
  }

  /**
   * Get a webhook by ID (owner-scoped).
   */
  get(owner: string, id: string): WebhookState | undefined {
    const record = this.store.get("webhooks", owner, id);
    return record ? hydrate(record) : undefined;
  }

  /**
   * List all webhooks for the owner.
   */
  list(owner: string): WebhookState[] {
    return this.store.list("webhooks", owner).map(hydrate);
  }

  /**
   * Remove a webhook.
   */
  remove(owner: string, id: string): void {
    if (!this.get(owner, id)) throw new Error("Webhook not found");
    this.store.delete("webhooks", owner, id);
  }

  /**
   * Test a webhook by sending a test payload straight away, without retries.
   */
  async test(owner: string, id: string): Promise<{ ok: boolean; message: string }> {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");
    const result = await this.send(webhook, { event: "webhook.test", timestamp: new Date().toISOString(), test: true });
    this.store.logWebhookDelivery(id, owner, "webhook.test", result.ok ? "success" : "failed", 1, null);
    return result;
  }

  /**
   * Get the webhook delivery log.
   */
  getLog(webhookId: string, owner: string): ReturnType<Store["getWebhookLog"]> {
    return this.store.getWebhookLog(webhookId, owner);
  }

  /**
   * The `traceparent` of the task behind a delivery, so the service on the other end can join the
   * same trace. `createBranch` connects this; on its own no such header is sent.
   */
  traceparentFor: (runId: string) => string | null = () => null;

  /**
   * Finds the signing key a webhook names, out of the default project's locker. `createBranch`
   * connects the real locker; on its own a named key cannot be found, and the delivery goes out
   * unsigned rather than failing, exactly as a webhook with no key at all does today.
   */
  secretFor: (name: string) => Promise<string> = async (name) => {
    throw new Error(`No secret called ${name} is available on this copy`);
  };

  /** The key to sign with: the named one out of the locker first, then one written into the row. */
  private async signingKey(webhook: WebhookState): Promise<string | undefined> {
    if (webhook.secretName) {
      const found = await this.secretFor(webhook.secretName).catch(() => undefined);
      if (found) return found;
    }
    return webhook.secret;
  }

  /**
   * What one event would actually be sent as, for the shape editor in Settings. Nothing is sent
   * and no address is reached; this only fills the owner's shape in with a sample.
   */
  preview(owner: string, id: string, event: string, sample: Record<string, unknown> = {}): { body: unknown; unfilled: string[] } {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");
    const full: Record<string, unknown> = { event, timestamp: new Date().toISOString(), ...sample };
    const template = webhook.templates?.[event];
    if (!template) return { body: full, unfilled: [] };
    const filled = fillFrom(template, full);
    const unfilled = [...templateNames(template)].filter((name) => readValue(full, name) === undefined);
    return { body: filled, unfilled };
  }

  /**
   * Send one request. Never throws: a refused address or a dead endpoint is a failed result.
   */
  private async send(webhook: WebhookState, payload: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
    try {
      await this.policy.assertAllowed(new URL(webhook.url), "webhook address");
      // The owner's own shape for this event, when they made one; otherwise the whole event.
      const template = webhook.templates?.[String(payload.event ?? "")];
      const body = JSON.stringify(template ? fillFrom(template, payload) : payload);
      const headers: Record<string, string> = { "content-type": "application/json" };
      // When the task that caused this has a trace open, the receiving service joins that trace.
      const traceparent = this.traceparentFor(String(payload.runId ?? ""));
      if (traceparent) headers["traceparent"] = traceparent;
      const key = await this.signingKey(webhook);
      if (key)
        headers["x-branch-signature"] = `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
      const response = await fetch(webhook.url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" });
      return { ok: response.ok, message: `HTTP ${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: controller.signal.aborted ? "Timed out" : message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Deliver one event to one endpoint, retrying with growing pauses. When every attempt fails the
   * failure count grows, and a webhook that fails five times in a row switches itself off.
   */
  async deliver(owner: string, webhookId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const webhook = this.get(owner, webhookId);
    if (!webhook || !webhook.enabled || !webhook.events.includes(event)) return;
    const body = { event, timestamp: new Date().toISOString(), ...payload };
    const turn = ++this.started;

    for (let attempt = 1; attempt <= this.retryDelays.length + 1; attempt++) {
      const result = await this.send(webhook, body);
      if (result.ok) {
        this.store.logWebhookDelivery(webhookId, owner, event, "success", attempt, null);
        this.recordSuccess(owner, webhookId, turn);
        return;
      }
      const pause = this.retryDelays[attempt - 1];
      const nextRetryAt = pause === undefined ? null : new Date(Date.now() + pause).toISOString();
      this.store.logWebhookDelivery(webhookId, owner, event, "failed", attempt, nextRetryAt);
      if (pause !== undefined) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    this.recordFailure(owner, webhookId, turn);
  }
  /** A delivery got through: the count starts again, unless a delivery started after this one has since given up. */
  private recordSuccess(owner: string, webhookId: string, turn: number): void {
    if ((this.lastFailure.get(webhookId) ?? 0) > turn) return;
    const current = this.get(owner, webhookId);
    if (current?.failureCount) this.saveState(owner, webhookId, { ...current, failureCount: 0 });
  }

  /** Counts one giving-up delivery and switches the webhook off once failures pile up. */
  private recordFailure(owner: string, webhookId: string, turn: number): void {
    this.lastFailure.set(webhookId, Math.max(turn, this.lastFailure.get(webhookId) ?? 0));
    const current = this.get(owner, webhookId);
    if (!current) return;
    const failureCount = current.failureCount + 1;
    const off = failureCount >= maxConsecutiveFailures;
    this.saveState(owner, webhookId, {
      ...current,
      failureCount,
      enabled: !off,
      disabledAt: off ? new Date().toISOString() : current.disabledAt,
      disabledReason: off ? `Switched off after ${maxConsecutiveFailures} consecutive delivery failures` : current.disabledReason,
    });
  }

  /**
   * Turn a webhook back on after it switched itself off.
   */
  enable(owner: string, id: string): WebhookState {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");
    this.saveState(owner, id, { ...webhook, enabled: true, failureCount: 0, disabledAt: null, disabledReason: null });
    return this.get(owner, id)!;
  }

  /** Writes only the stored fields; the row's own id and timestamps never go into the blob. */
  private saveState(owner: string, id: string, state: WebhookState): void {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = state;
    this.store.save("webhooks", owner, id, data);
  }
}

/** Reads a dotted name out of a sample, so a shape asking for something absent can be pointed out. */
function readValue(source: Record<string, unknown>, name: string): unknown {
  let current: unknown = source;
  for (const part of name.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Row columns win over the stored blob, so a stale copy inside the blob can never leak out. */
function hydrate(record: SavedRecord): WebhookState {
  const data = record.data as Partial<WebhookState>;
  return {
    name: String(data.name ?? ""),
    url: String(data.url ?? ""),
    ...(data.secret ? { secret: data.secret } : {}),
    ...(data.secretName ? { secretName: data.secretName } : {}),
    ...(data.templates ? { templates: data.templates } : {}),
    events: data.events ?? [],
    enabled: data.enabled !== false,
    failureCount: data.failureCount ?? 0,
    disabledAt: data.disabledAt ?? null,
    disabledReason: data.disabledReason ?? null,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
