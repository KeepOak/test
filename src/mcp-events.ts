import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Runtime } from './runtime.js';
import type { Triggers } from './triggers.js';
import type { OwnMcpServers } from './mcp-own-servers.js';
import type { NetworkPolicy } from './network-policy.js';
import type { Client } from '@modelcontextprotocol/client';
import { lockdownActive } from './lockdown.js';
import { readPolicy } from './policy.js';
import { openEventMcp } from './integrations/mcp-stateless-client.js';
import { EventDefinition, listMcpEvents, SubscriptionResult, validateEventSchema } from './integrations/mcp-events-client.js';
import { singleHeader, verifyStandardWebhook, type WebhookHeaders } from './standard-webhooks.js';

const bucket = 'mcp-event-subscriptions', settingsKey = 'mcp-events-callback';
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = z.record(z.string(), z.unknown());
const Saved = z.object({
  server: z.string(), name: z.string(), arguments: fields, triggerId: z.string().uuid(),
  definition: EventDefinition, sourceStamp: z.string(), triggerStamp: z.string(), url: z.string(), secret: z.string(),
  phase: z.enum(['verifying', 'active', 'stopped']), remoteId: z.string().nullable(),
  expires: z.number(), verificationUntil: z.number(), verified: z.boolean(),
  cursor: z.string().nullable(), truncated: z.boolean(),
  seen: z.record(z.string(), z.number()),
});
type Subscription = z.infer<typeof Saved>;
const Subscribe = z.object({ server: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/), name: z.string().max(100),
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), triggerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: fields, triggerId: z.string().uuid(),
  confirmation: z.literal('Start this automation for these events') }).strict();
const Occurrence = z.object({ eventId: z.string().min(1).max(200), name: z.string().max(100),
  timestamp: z.string().datetime({ offset: true }), data: fields, cursor: z.string().max(2000).nullable().optional() }).strict();

/** Explicit owner-created subscriptions; incoming data never configures automations or grants tool permission. */
export class McpEvents {
  private closed = false;
  private running = 0;
  private connecting = 0;
  private validating = 0;
  private readonly operations = new Set<string>();
  constructor(private readonly store: Store, private readonly runtime: Runtime, private readonly triggers: Triggers,
    private readonly servers: OwnMcpServers, private readonly policy: NetworkPolicy) {}

  close(): void { this.closed = true; }
  private ready(owner = this.runtime.owner): void {
    if (this.closed || owner !== this.runtime.owner || !this.store.profiles.isOwner()
      || this.runtime.fullAccessLocked() || lockdownActive(this.store, owner))
      throw new Error('MCP Events require the unlocked owner profile.');
  }
  private get(id: string): Subscription | undefined {
    const row = this.store.get(bucket, this.runtime.owner, id);
    return row ? Saved.parse(row.data) : undefined;
  }
  private put(id: string, value: Subscription): void { this.store.save(bucket, this.runtime.owner, id, value); }
  private sourceStamp(server: string): string {
    const config = this.servers.eventConfig(server);
    const credential = config.transport === 'http' && config.bearerEnv ? process.env[config.bearerEnv] ?? '' : '';
    return digest([config, digest(credential), this.policy.settings(), readPolicy(this.store, this.runtime.owner)]);
  }

  list(): unknown {
    this.ready();
    return { callbackOrigin: this.callbackOrigin(), servers: this.servers.list(false).servers.filter(server => server.on && server.transport === 'http'),
      triggers: this.triggers.list(this.runtime.owner).map(trigger => ({ id: trigger.id, name: trigger.name,
        enabled: trigger.enabled, fingerprint: digest(trigger) })),
      subscriptions: this.store.list(bucket, this.runtime.owner).map(row => {
        const value = Saved.parse(row.data);
        return { id: row.id, server: value.server, name: value.name, triggerId: value.triggerId,
          phase: value.phase, expires: new Date(value.expires).toISOString(), truncated: value.truncated };
      }) };
  }
  private callbackOrigin(): string {
    return String((this.store.get('settings', this.runtime.owner, settingsKey)?.data as { origin?: string } | undefined)?.origin ?? '');
  }
  configure(input: unknown): void {
    this.ready();
    const value = z.object({ origin: z.string().url().max(2000), confirmation: z.literal('Use this HTTPS callback origin') }).strict().parse(input);
    const url = new URL(value.origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Use an HTTPS origin without credentials, paths, queries or fragments.');
    if (this.store.list(bucket, this.runtime.owner).some(row => Saved.parse(row.data).phase !== 'stopped'))
      throw new Error('Stop existing subscriptions before changing the callback origin.');
    this.store.save('settings', this.runtime.owner, settingsKey, { origin: url.origin });
  }

  private async withClient<T>(server: string, action: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ready();
    if (this.connecting >= 4) throw new Error('MCP Events connection limit reached.');
    const owner = this.runtime.owner, stamp = this.sourceStamp(server), abort = new AbortController();
    const guard = () => { this.ready(owner); if (this.sourceStamp(server) !== stamp) throw new Error('MCP event source changed.'); };
    const timer = setInterval(() => { try { guard(); } catch { abort.abort(); } }, 250);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
    let client: Client | undefined;
    this.connecting++;
    try {
      client = await openEventMcp(this.servers.eventConfig(server), process.env,
        { guard: base => this.policy.guard(base) }, signal);
      guard(); const result = await action(client, signal); guard();
      const config = this.servers.eventConfig(server);
      const credential = config.transport === 'http' && config.bearerEnv ? process.env[config.bearerEnv] : undefined;
      if (credential && (JSON.stringify(result) ?? '').includes(credential)) throw new Error('MCP Events response contains a credential.');
      return result;
    } catch { throw new Error('The MCP Events request failed or its reviewed contract changed.');
    } finally { this.connecting--; clearInterval(timer); await client?.close().catch(() => undefined); }
  }
  async catalog(input: unknown): Promise<unknown> {
    const { server } = z.object({ server: z.string().max(30) }).strict().parse(input);
    return this.withClient(server, async (client, signal) => (await listMcpEvents(client, signal))
      .map(definition => ({ ...definition, fingerprint: digest(canonical(definition)) })));
  }

  async subscribe(input: unknown): Promise<unknown> {
    this.ready(); const value = Subscribe.parse(input), origin = this.callbackOrigin();
    if (!origin) throw new Error('Configure the relay or tunnel HTTPS callback origin first.');
    boundedData(value.arguments, 8192);
    const trigger = this.triggers.get(this.runtime.owner, value.triggerId);
    if (!trigger?.enabled) throw new Error('Choose an enabled owner automation.');
    if (digest(trigger) !== value.triggerFingerprint) throw new Error('Automation changed; reload before confirming.');
    const owner = this.runtime.owner, identity = digest([value.server, value.name, canonical(value.arguments), value.triggerId, origin]);
    const existing = this.store.list(bucket, owner).find(row => row.id.startsWith(`${identity.slice(0, 16)}-`));
    if (existing) throw new Error('Refresh or stop the existing subscription instead of duplicating it.');
    if (this.store.list(bucket, owner).length >= 24) throw new Error('MCP Events subscription limit reached.');
    if (this.operations.has(identity)) throw new Error('This subscription is already being created.');
    const id = `${identity.slice(0, 16)}-${randomUUID()}`;
    this.operations.add(identity);
    return this.withClient(value.server, async (client, signal) => {
      const definition = (await listMcpEvents(client, signal)).find(event => event.name === value.name);
      if (!definition) throw new Error('The server does not offer this webhook event.');
      if (digest(canonical(definition)) !== value.definitionFingerprint) throw new Error('Event definition changed; reload and review it.');
      await validateEventSchema(definition.inputSchema, value.arguments); this.ready(owner);
      if (this.callbackOrigin() !== origin || this.store.list(bucket, owner).length >= 24)
        throw new Error('Callback configuration changed or subscription limit reached.');
      this.put(id, { server: value.server, name: value.name, arguments: value.arguments, triggerId: value.triggerId,
        definition, sourceStamp: this.sourceStamp(value.server), triggerStamp: digest(trigger),
        url: `${origin}/webhooks/mcp-events/${id}`, secret: `whsec_${randomBytes(32).toString('base64')}`,
        phase: 'verifying', remoteId: null, expires: Date.now() + 3600000, verificationUntil: Date.now() + 30000,
        verified: false, cursor: null, truncated: false, seen: {} });
      return this.activate(id, client, signal);
    }).catch(error => {
      if (owner === this.runtime.owner) { const saved = this.get(id); if (saved) this.put(id, { ...saved, phase: 'stopped' }); }
      throw error;
    }).finally(() => this.operations.delete(identity));
  }

  private async activate(id: string, client: Client, signal: AbortSignal): Promise<unknown> {
    const saved = this.get(id)!;
    const response = await client.request({ method: 'events/subscribe', params: {
      name: saved.name, arguments: saved.arguments, delivery: { mode: 'webhook', url: saved.url, secret: saved.secret },
      cursor: saved.cursor, ttlMs: 3600000, maxAgeMs: 300000,
    } }, SubscriptionResult, { signal, timeout: 20000 });
    const current = this.get(id)!;
    this.check(current);
    const expires = response.refreshBefore === null ? NaN : Date.parse(response.refreshBefore);
    if (!current.verified || current.remoteId !== response.id || !Number.isFinite(expires)
      || expires <= Date.now() || expires > Date.now() + 3600000 + 30000)
      throw new Error('The server must verify this callback and grant a bounded subscription lifetime.');
    this.put(id, { ...current, phase: 'active', remoteId: response.id, expires,
      cursor: response.cursor, truncated: response.truncated });
    return { id, expires: response.refreshBefore, truncated: response.truncated };
  }

  async refresh(input: unknown): Promise<unknown> {
    const { id } = z.object({ id: z.string().max(80) }).strict().parse(input);
    this.ready(); if (this.operations.has(id)) throw new Error('A subscription operation is already pending.');
    const saved = this.get(id); if (!saved || saved.phase !== 'active') throw new Error('No active subscription.');
    this.check(saved); this.operations.add(id);
    try {
      return await this.withClient(saved.server, async (client, signal) => {
        const definition = (await listMcpEvents(client, signal)).find(event => event.name === saved.name);
        if (!definition || digest(definition) !== digest(saved.definition)) throw new Error('Event definition changed; stop and review a new subscription.');
        // A server may cache verification or send a new signed challenge on this explicit refresh.
        this.put(id, { ...this.get(id)!, verificationUntil: Date.now() + 30000 });
        return this.activate(id, client, signal);
      });
    } finally { this.operations.delete(id); }
  }

  async stop(input: unknown): Promise<unknown> {
    this.ready(); const { id } = z.object({ id: z.string().max(80) }).strict().parse(input);
    if (this.operations.has(id)) throw new Error('A subscription operation is already pending.');
    const saved = this.get(id); if (!saved) return { stopped: true, upstreamStopped: true };
    this.put(id, { ...saved, phase: 'stopped' }); this.operations.add(id);
    try {
      if (this.sourceStamp(saved.server) !== saved.sourceStamp) throw new Error('Original subscription principal or source policy changed.');
      await this.withClient(saved.server, async (client, signal) => {
        await client.request({ method: 'events/unsubscribe', params: { name: saved.name, arguments: saved.arguments,
          delivery: { mode: 'webhook', url: saved.url } } }, z.object({}).passthrough(), { signal, timeout: 10000 });
      });
      this.store.delete(bucket, this.runtime.owner, id); return { stopped: true, upstreamStopped: true };
    } catch { return { stopped: true, upstreamStopped: false, message: 'Local admission stopped; upstream cleanup failed. It must expire or be retried.' }; }
    finally { this.operations.delete(id); }
  }

  forget(input: unknown): void {
    this.ready();
    const { id } = z.object({ id: z.string().max(80) }).strict().parse(input);
    if (this.operations.has(id)) throw new Error('A subscription operation is already pending.');
    const saved = this.get(id);
    if (saved && saved.phase !== 'stopped') throw new Error('Stop local admission before forgetting a subscription.');
    this.store.delete(bucket, this.runtime.owner, id);
  }

  private check(saved: Subscription): void {
    this.ready();
    const trigger = this.triggers.get(this.runtime.owner, saved.triggerId);
    if (saved.phase === 'stopped' || saved.expires <= Date.now() || saved.sourceStamp !== this.sourceStamp(saved.server)
      || !trigger?.enabled || saved.triggerStamp !== digest(trigger) || !saved.url.startsWith(`${this.callbackOrigin()}/webhooks/mcp-events/`))
      throw new Error('MCP Events subscription admission stopped.');
  }

  async receive(id: string, headers: WebhookHeaders, raw: Buffer, body: unknown): Promise<unknown> {
    if (this.validating >= 8) throw new Error('MCP Events admission is busy.');
    this.validating++;
    try { return await this.admit(id, headers, raw, body); }
    finally { this.validating--; }
  }
  private async admit(id: string, headers: WebhookHeaders, raw: Buffer, body: unknown): Promise<unknown> {
    const saved = this.get(id); if (!saved) throw new Error('Unknown MCP Events subscription.');
    this.check(saved);
    const messageId = verifyStandardWebhook(saved.secret, headers, raw), owner = this.runtime.owner;
    if (body && typeof body === 'object' && 'type' in body) return this.verification(id, saved, headers, messageId, body);
    if (saved.phase !== 'active' || singleHeader(headers, 'x-mcp-subscription-id') !== saved.remoteId)
      throw new Error('MCP Events subscription is not active.');
    const event = Occurrence.parse(body); boundedData(event.data, 16384);
    if (JSON.stringify(event.data).includes(saved.secret)) throw new Error('MCP event contains its signing key.');
    const config = this.servers.eventConfig(saved.server);
    const credential = config.transport === 'http' && config.bearerEnv ? process.env[config.bearerEnv] : undefined;
    if (credential && JSON.stringify(event.data).includes(credential)) throw new Error('MCP event contains a source credential.');
    if (event.eventId !== messageId || event.name !== saved.name) throw new Error('MCP event identity mismatch.');
    await validateEventSchema(saved.definition.payloadSchema, event.data);
    this.ready(owner); const current = this.get(id)!; this.check(current);
    if (current.phase !== 'active' || current.remoteId !== saved.remoteId) throw new Error('Subscription changed.');
    if (current.seen[digest(messageId)]) return { accepted: true, duplicate: true };
    if (this.running >= 4) throw new Error('MCP Events admission is busy.');
    const trigger = this.triggers.get(owner, current.triggerId)!;
    if (!this.triggers.canFire(current.triggerId, trigger).allowed) throw new Error('Automation admission is held.');
    this.claim(id, current, messageId); this.running++;
    // Receipt means durable admission, not successful execution. A retry never repeats an ambiguous attempt.
    void this.start(id, owner, current, event).catch(() => {
      this.triggers.logFire(current.triggerId, owner, null, `MCP event ${event.eventId}`, 'mcp_event_admission_failed');
    }).finally(() => { this.running--; }).catch(() => undefined);
    return { accepted: true };
  }

  private async start(id: string, owner: string, saved: Subscription, event: z.infer<typeof Occurrence>): Promise<void> {
    this.ready(owner); this.check(this.get(id)!);
    await this.triggers.fire(owner, saved.triggerId, { mcpEvent: { server: saved.server, subscription: id,
      eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, untrusted: true } });
    // Out-of-order webhook arrivals cannot safely advance a cumulative upstream cursor.
    // Refresh uses the last server-granted cursor, with bounded replay and the persisted dedup ledger.
  }

  private verification(id: string, saved: Subscription, headers: WebhookHeaders, messageId: string, body: unknown): unknown {
    const value = z.object({ type: z.literal('verification'), challenge: z.string().min(1).max(200) }).strict().parse(body);
    const remoteId = singleHeader(headers, 'x-mcp-subscription-id');
    if (saved.verificationUntil < Date.now() || saved.phase === 'stopped'
      || saved.phase === 'verifying' && saved.verified || saved.remoteId !== null && saved.remoteId !== remoteId)
      throw new Error('Callback verification expired or already used.');
    this.claim(id, saved, messageId); this.put(id, { ...this.get(id)!, verified: true, remoteId, verificationUntil: 0 });
    return { challenge: value.challenge };
  }
  private claim(id: string, saved: Subscription, messageId: string): void {
    const seen = Object.fromEntries(Object.entries(saved.seen).filter(([, expires]) => expires > Date.now()));
    const key = digest(messageId);
    if (seen[key]) throw new Error('Webhook already admitted.');
    if (Object.keys(seen).length >= 2048) throw new Error('MCP Events replay ledger is full.');
    seen[key] = Date.now() + 86400000;
    this.put(id, { ...saved, seen });
  }
}

/** Reject excessive nesting and prototype keys before schema checking or trigger substitution. */
function boundedData(value: unknown, maximum: number): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new Error('MCP Events data exceeds limit.');
  const visit = (item: unknown, depth: number): void => {
    if (depth > 16) throw new Error('MCP Events nesting exceeds limit.');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe MCP Events data key.');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonical(child)]));
  return value;
}
