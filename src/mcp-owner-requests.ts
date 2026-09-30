import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import type { Store } from './store.js';
import type { ModelRouter } from './models.js';
import type { Message, ToolContext } from './contracts.js';
import { pathToFileURL } from 'node:url';
import { estimateTokens, ProviderStreamError } from './contracts.js';
import { lockdownActive } from './lockdown.js';
import { mcpValidator } from './integrations/mcp-sdk.js';
import { ElicitationOrigin, McpUrlElicitation } from './mcp-url-elicitation.js';

export const McpOwnerRequestSettings = z.object({
  sampling: z.boolean().default(false), elicitation: z.boolean().default(false),
  roots: z.boolean().default(false),
  urlElicitation: z.boolean().default(false), urlOrigins: z.array(ElicitationOrigin).max(10).default([]),
  requestsPerMinute: z.number().int().min(1).max(20).default(3),
  tokenCap: z.number().int().min(128).max(8192).default(2048),
  models: z.array(z.string().min(1).max(64)).max(16).default([]),
}).strict();
const ServerId = z.string().regex(/^[a-z][a-z0-9-]{0,29}$/);
// These adapters transmit request.maxTokens. Subscription/program adapters lack the required bound.
const boundedProviders = new Set(['openai-compatible', 'openai-responses', 'anthropic',
  'anthropic-vertex', 'gemini', 'bedrock', 'cohere', 'azure-openai', 'ollama']);
const bounded = (preset: { provider: { name: string; keepsOwnTime?: boolean } }): boolean =>
  boundedProviders.has(preset.provider.name) && !preset.provider.keepsOwnTime;
type Settings = z.infer<typeof McpOwnerRequestSettings>;
type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
interface Pending {
  id: string; server: string; kind: 'sampling' | 'elicitation' | 'roots' | 'urlRetry'; details: unknown;
  owner: string; settings: string; finish: (answer: Answer) => void;
}

/** Server requests are untrusted; only the active local owner's live form can authorize them. */
export class McpOwnerRequests {
  private windowUntil = 0;
  private windowOwner = '';
  private nativeOpener = false;
  readonly urls: McpUrlElicitation;
  private readonly pending = new Map<string, Pending>();
  private readonly rates = new Map<string, number[]>();
  private readonly calls = new Map<string, { context: ToolContext; permission: string; args: Record<string, unknown> }>();
  constructor(private readonly store: Store, private readonly owner: () => string,
    private readonly models: ModelRouter, private readonly locked: () => boolean = () => false,
    private readonly permitted: (context: ToolContext, permission: string, args: Record<string, unknown>) => boolean = () => false,
    vetUrl: (url: URL) => Promise<void> = async () => { throw new Error('Browser questions are unavailable.'); }) {
    this.urls = new McpUrlElicitation(owner, () => this.ready() && this.nativeOpener, vetUrl);
  }

  settings(server: string): Settings {
    const saved = McpOwnerRequestSettings.safeParse(this.store.get('settings', this.owner(), `mcp-owner-requests:${server}`)?.data ?? {});
    return saved.success ? saved.data : McpOwnerRequestSettings.parse({});
  }
  save(input: unknown): void {
    if (!this.store.profiles.isOwner() || this.locked() || lockdownActive(this.store, this.owner())) throw new Error('Change server choices in the unlocked owner window.');
    const value = z.object({ server: ServerId, settings: McpOwnerRequestSettings }).strict().parse(input);
    if (value.settings.sampling && !value.settings.models.length) throw new Error('Choose at least one allowed model.');
    if (value.settings.urlElicitation && !value.settings.urlOrigins.length) throw new Error('Approve at least one exact HTTPS origin.');
    for (const id of value.settings.models) {
      const preset = this.models.presets.get(id);
      if (!preset || !bounded(preset)) throw new Error('Choose an available model connection that enforces a token limit without program tools.');
    }
    this.store.save('settings', this.owner(), `mcp-owner-requests:${value.server}`, value.settings);
    this.urls.cancel(value.server);
    for (const item of this.pending.values()) if (item.server === value.server) item.finish({ action: 'cancel' });
  }
  /** A visible form polls every five seconds; no window heartbeat means no capability or spending. */
  window(input: unknown = {}): unknown {
    const value = z.object({ nativeUrlOpener: z.boolean().optional() }).strict().parse(input);
    this.nativeOpener = value.nativeUrlOpener === true;
    this.windowOwner = this.owner(); this.windowUntil = Date.now() + 15_000;
    return { requests: [...this.pending.values()].filter(p => p.owner === this.owner())
      .map(({ id, server, kind, details }) => ({ id, server, kind, details })),
      urls: this.urls.list(), models: [...this.models.presets.values()].filter(bounded).map(p => ({ id: p.id, name: p.name })) };
  }
  closeWindow(): void {
    this.windowUntil = 0;
    this.nativeOpener = false; this.urls.cancel();
    for (const item of this.pending.values()) item.finish({ action: 'cancel' });
  }
  private ready(): boolean {
    return Date.now() < this.windowUntil && this.windowOwner === this.owner()
      && this.store.profiles.isOwner() && !this.locked() && !lockdownActive(this.store, this.owner());
  }
  capabilities(server: string, modern = false, urlReady = false): ClientCapabilities {
    if (!this.ready()) return {};
    const settings = this.settings(server);
    return { ...(settings.sampling && settings.models.length ? { sampling: {} } : {}),
      ...(settings.elicitation || (urlReady && this.nativeOpener && settings.urlElicitation)
        ? { elicitation: { ...(settings.elicitation ? { form: {} } : {}),
          ...(urlReady && this.nativeOpener && settings.urlElicitation ? { url: {} } : {}) } } : {}),
      ...(modern && settings.roots ? { roots: {} } : {}) };
  }
  /** Embedded MRTR requests share the initiating task's exact permission and cancellation boundary. */
  async fulfill(server: string, request: unknown, context: ToolContext, permission: string, args: Record<string, unknown>,
    urlSource?: { connection: string; inputId: string; state: string; requestId: string }): Promise<unknown> {
    const input = z.object({ method: z.enum(['elicitation/create', 'sampling/createMessage', 'roots/list']),
      params: z.record(z.string(), z.unknown()).optional() }).strict().parse(request);
    const original = JSON.stringify(args);
    const guard = () => { this.assertCall(context, permission, args);
      if (JSON.stringify(args) !== original) throw new Error('The original tool arguments changed.'); };
    guard();
    const signal = new AbortController();
    const timer = setInterval(() => { try { guard(); } catch { signal.abort(); } }, 250);
    timer.unref();
    const bound = AbortSignal.any([context.signal, signal.signal]);
    try {
      const result = input.method === 'sampling/createMessage' ? await this.sample(server, input.params, bound, context)
        : input.method === 'elicitation/create' ? input.params?.mode === 'url'
          ? await this.modernUrl(server, input.params, context, permission, args, bound, urlSource)
          : await this.elicit(server, input.params, bound)
        : await this.roots(server, context, bound);
      guard(); return result;
    } finally { clearInterval(timer); }
  }
  assertCall(context: ToolContext, permission: string, args: Record<string, unknown>): void {
    context.signal.throwIfAborted();
    const run = this.store.run(context.runId);
    if (!this.ready() || context.owner !== this.owner() || !context.permissions.has(permission) || !this.permitted(context, permission, args)
      || !run || run.owner !== context.owner || run.status !== 'running')
      throw new Error('The initiating task or its permission is no longer available.');
  }
  async withCall<T>(connection: string, context: ToolContext, permission: string, args: Record<string, unknown>,
    invoke: () => Promise<T>): Promise<T> {
    if (this.calls.has(connection)) throw new Error('An interactive call is already using this server connection.');
    this.calls.set(connection, { context, permission, args });
    try { return await invoke(); }
    finally { this.calls.delete(connection); }
  }
  private async modernUrl(server: string, params: Record<string, unknown>, context: ToolContext, permission: string,
    args: Record<string, unknown>, signal: AbortSignal, source?: { connection: string; inputId: string; state: string; requestId: string }) {
    if (!source || !source.requestId || !source.inputId) throw new Error('The server URL question is missing its initiating request.');
    const settings = this.guard(server, 'urlElicitation'), saved = JSON.stringify(settings), original = JSON.stringify(args);
    const valid = () => { try { this.assertCall(context, permission, args);
      return JSON.stringify(args) === original && JSON.stringify(this.settings(server)) === saved; } catch { return false; } };
    // The local identity pins the named embedded request to this exact source/state/run/arguments.
    const elicitationId = createHash('sha256').update(JSON.stringify([source.requestId, source.inputId, source.state, context.runId, permission, original])).digest('hex');
    const value = z.object({ mode: z.literal('url'), url: z.string(), message: z.string() }).strict().parse(params);
    return this.urls.ask(server, source.connection, { ...value, elicitationId }, settings.urlOrigins, valid, signal,
      { mode: 'modern', runId: context.runId, tool: permission, args: JSON.parse(original) as Record<string, unknown>, continuation: !!source.state });
  }
  /** Error-list retries always require a separate review of the exact original call after browser consent. */
  async retryUrls(server: string, connection: string, requests: unknown, context: ToolContext,
    permission: string, args: Record<string, unknown>, modern: boolean): Promise<void> {
    const list = z.array(z.object({ mode: z.literal('url'), message: z.string().max(4000), url: z.string().url().max(8192),
      elicitationId: z.string().min(1).max(200).optional(), task: z.never().optional() }).passthrough()).min(1).max(4).parse(requests);
    const original = JSON.stringify(args), saved = JSON.stringify(this.settings(server));
    const valid = () => { try { this.assertCall(context, permission, args);
      return JSON.stringify(args) === original && JSON.stringify(this.settings(server)) === saved; } catch { return false; } };
    this.assertCall(context, permission, args);
    for (const request of list) {
      if (!modern && !request.elicitationId) throw new Error('The server omitted its browser question identifier.');
      const settings = this.guard(server, 'urlElicitation');
      const answer = await this.urls.ask(server, connection, { ...request, elicitationId: request.elicitationId ?? randomUUID() },
        settings.urlOrigins, valid, context.signal, { mode: modern ? 'modern' : 'error', runId: context.runId, tool: permission });
      if (answer.action !== 'accept' || !valid()) throw new Error('The owner cancelled the browser retry.');
    }
    const answer = await this.ask(server, 'urlRetry', { tool: permission, args: JSON.parse(original), runId: context.runId,
      message: 'Retry this exact original tool once? The server requested a browser step, but this does not prove it made no prior changes. Retrying may repeat effects. Browser consent is not proof of login success.' },
      this.guard(server, 'urlElicitation', false), context.signal);
    if (answer.action !== 'accept' || !valid()) throw new Error('The owner declined the original tool retry.');
  }
  private async roots(server: string, context: ToolContext, signal: AbortSignal) {
    const settings = this.guard(server, 'roots'), uri = pathToFileURL(context.workspace).href;
    const answer = await this.ask(server, 'roots', { message: `Allow ${server} to see this task's workspace root?`,
      uri, runId: context.runId }, settings, signal);
    signal.throwIfAborted(); this.guard(server, 'roots', false);
    if (JSON.stringify(this.settings(server)) !== JSON.stringify(settings)) throw new Error('Root settings changed.');
    return { roots: answer.action === 'accept' ? [{ uri, name: 'Approved task workspace' }] : [] };
  }
  private guard(server: string, kind: Pending['kind'] | 'urlElicitation', spend = true): Settings {
    const settings = this.settings(server);
    if (!this.ready() || !settings[kind === 'urlRetry' ? 'urlElicitation' : kind]) throw new Error('The owner window is unavailable or this server feature is off.');
    if (!spend) return settings;
    const recent = (this.rates.get(server) ?? []).filter(time => time > Date.now() - 60_000);
    if (recent.length >= settings.requestsPerMinute) throw new Error('This server reached its request limit.');
    this.rates.set(server, [...recent, Date.now()]);
    return settings;
  }
  async answer(input: unknown): Promise<void> {
    const answer = z.object({ id: z.string().uuid(), action: z.enum(['accept', 'decline', 'cancel']),
      content: z.record(z.string(), z.unknown()).optional() }).strict().parse(input);
    const item = this.pending.get(answer.id);
    if (!item || item.owner !== this.owner() || !this.ready()) throw new Error('This question is no longer available.');
    if (JSON.stringify(this.guard(item.server, item.kind, false)) !== item.settings) throw new Error('Server settings changed.');
    if (item.kind === 'elicitation' && answer.action === 'accept') {
      const details = item.details as { requestedSchema: Record<string, unknown> };
      const validate = new (await mcpValidator())().getValidator({ ...details.requestedSchema, additionalProperties: false } as JsonSchemaType);
      if (!validate(answer.content ?? {}).valid) throw new Error('Please complete the fields in the requested format.');
      if (!this.ready() || !this.pending.has(item.id)) throw new Error('This question is no longer available.');
    }
    item.finish(answer);
  }
  private ask(server: string, kind: Pending['kind'], details: unknown, settings: Settings, signal: AbortSignal): Promise<Answer> {
    if (this.pending.size >= 8 || Buffer.byteLength(JSON.stringify(details)) > 32768) throw new Error('Server request is too large or too many are waiting.');
    signal.throwIfAborted();
    return new Promise(resolve => {
      const id = randomUUID();
      const finish = (answer: Answer) => {
        clearInterval(timer); signal.removeEventListener('abort', cancel); this.pending.delete(id); resolve(answer);
      };
      const cancel = () => finish({ action: 'cancel' });
      const expires = Date.now() + 120_000;
      const timer = setInterval(() => { if (!this.ready() || Date.now() >= expires) cancel(); }, 1000);
      timer.unref?.(); signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { id, server, kind, details, owner: this.owner(), settings: JSON.stringify(settings), finish });
    });
  }
  async install(client: Client, server: string, negotiated?: ClientCapabilities): Promise<(() => void) & { connection: string; urlReady: boolean; signal: AbortSignal }> {
    const { CreateMessageRequestSchema, ElicitRequestSchema, ElicitationCompleteNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const capabilities = negotiated ?? this.capabilities(server), connection = randomUUID(), closed = new AbortController();
    if (capabilities.elicitation?.url) client.setNotificationHandler(ElicitationCompleteNotificationSchema,
      notification => this.urls.complete(connection, notification.params.elicitationId));
    if (capabilities.sampling) client.setRequestHandler(CreateMessageRequestSchema, (request, extra) => this.sample(server, request.params, extra.signal));
    if (capabilities.elicitation) client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
      if (request.params.mode !== 'url') return this.elicit(server, request.params, extra.signal);
      if (!capabilities.elicitation?.url) throw new Error('Browser questions were not negotiated.');
      const call = this.calls.get(connection);
      if (!call) throw new Error('Browser questions require an initiating tool call.');
      this.assertCall(call.context, call.permission, call.args);
      const settings = this.guard(server, 'urlElicitation'), saved = JSON.stringify(settings), owner = this.owner();
      const original = JSON.stringify(call.args);
      return this.urls.ask(server, connection, request.params, settings.urlOrigins,
        () => { try { this.assertCall(call.context, call.permission, call.args);
          return this.owner() === owner && JSON.stringify(this.settings(server)) === saved && JSON.stringify(call.args) === original;
        } catch { return false; } },
        AbortSignal.any([extra.signal, call.context.signal, closed.signal]));
    });
    return Object.assign(() => { closed.abort(); this.urls.cancel(server, connection); },
      { connection, urlReady: !!capabilities.elicitation?.url, signal: closed.signal });
  }
  private async sample(server: string, input: unknown, signal: AbortSignal, context?: ToolContext) {
    const settings = this.guard(server, 'sampling');
    const params = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']),
      content: z.object({ type: z.literal('text'), text: z.string().max(16000) }).passthrough() }).passthrough()).min(1).max(32),
      maxTokens: z.number().int().positive(), systemPrompt: z.string().max(16000).optional(),
      includeContext: z.literal('none').optional(), modelPreferences: z.object({ hints: z.array(z.object({ name: z.string().optional() }).passthrough()).optional() }).passthrough().optional(),
      tools: z.array(z.unknown()).max(0).optional(), task: z.never().optional() }).passthrough().parse(input);
    const wanted = params.modelPreferences?.hints?.map(h => h.name).filter(Boolean) ?? [];
    const preset = settings.models.map(id => this.models.presets.get(id)).find(p => p && (!wanted.length || wanted.includes(p.model) || wanted.includes(p.id)));
    if (!preset || !bounded(preset)) throw new Error('No bounded requested model is in this server allowlist.');
    const messages: Message[] = params.messages.map(m => ({ role: m.role, content: m.content.text }));
    if (params.systemPrompt) messages.unshift({ role: 'system', content: params.systemPrompt });
    if (Buffer.byteLength(JSON.stringify(messages)) > 32768) throw new Error('This request exceeds the input size limit.');
    const inputTokens = estimateTokens(JSON.stringify(messages));
    const maxTokens = Math.min(params.maxTokens, settings.tokenCap, context ? context.budget.remaining() - inputTokens : settings.tokenCap);
    if (maxTokens < 1) throw new Error('The initiating task has no sampling budget remaining.');
    const details = { model: preset.id, modelName: preset.name, maxTokens, messages,
      ...(context ? { parentRunId: context.runId } : {}),
      notice: 'Allow this server to send this exact text to this model using your subscription or API credit?' };
    const answer = await this.ask(server, 'sampling', details, settings, signal);
    if (answer.action !== 'accept') throw new Error('The owner declined or cancelled sampling.');
    signal.throwIfAborted(); this.guard(server, 'sampling', false);
    if (JSON.stringify(this.settings(server)) !== JSON.stringify(settings) || this.models.presets.get(preset.id) !== preset) throw new Error('Sampling settings or model changed.');
    if (context) { context.budget.step(signal); context.budget.charge(inputTokens + maxTokens); }
    const result = await this.complete(server, preset.id, messages, maxTokens, signal, context?.runId);
    this.guard(server, 'sampling', false); signal.throwIfAborted();
    if (Buffer.byteLength(result.content) > 32768) throw new Error('Sampling response is too large.');
    if (result.toolCalls.length) throw new Error('Sampling may not invoke tools.');
    return { model: preset.model, role: 'assistant' as const, content: { type: 'text' as const, text: result.content }, stopReason: 'endTurn' };
  }
  private async complete(server: string, presetId: string, messages: Message[], maxTokens: number, signal: AbortSignal, parentRunId?: string) {
    const preset = this.models.presets.get(presetId);
    if (!preset || !bounded(preset)) throw new Error('The approved model is unavailable.');
    const run = this.store.createRun(this.owner(), `Approved model request from ${server}`, undefined, false, 'mcp');
    const settings = JSON.stringify(this.settings(server));
    const stop = new AbortController();
    const timer = setInterval(() => {
      if (!this.ready() || this.owner() !== run.owner || settings !== JSON.stringify(this.settings(server))
        || this.models.presets.get(presetId) !== preset) stop.abort();
    }, 250);
    timer.unref?.();
    try {
      this.store.event(run.id, 'mcp.sampling', { server, model: presetId, maxTokens, ...(parentRunId ? { parentRunId } : {}) });
      const result = await preset.provider.complete({ messages, tools: [], maxTokens, programTools: false,
        signal: AbortSignal.any([signal, stop.signal, AbortSignal.timeout(30_000)]) });
      this.store.addUsage(run.id, estimateTokens(JSON.stringify(messages)), estimateTokens(result.content), result.usage);
      this.store.finish(run.id, 'completed', 'The approved server request finished.');
      return result;
    } catch (error) {
      this.store.addUsage(run.id, estimateTokens(JSON.stringify(messages)),
        error instanceof ProviderStreamError ? error.estimatedOutput : 0,
        error instanceof ProviderStreamError ? error.usage : undefined, false);
      this.store.finish(run.id, 'failed', 'The approved server request did not finish.');
      throw new Error('The approved model request failed.');
    } finally { clearInterval(timer); }
  }
  private async elicit(server: string, input: unknown, signal: AbortSignal) {
    const settings = this.guard(server, 'elicitation');
    const params = z.object({ mode: z.literal('form').optional(), message: z.string().max(4000),
      requestedSchema: z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional() }).passthrough(), task: z.never().optional() }).passthrough().parse(input);
    if (Object.keys(params.requestedSchema.properties).length > 20) throw new Error('This server asks for too many fields.');
    const validate = new (await mcpValidator())().getValidator({ ...params.requestedSchema, additionalProperties: false } as JsonSchemaType);
    const answer = await this.ask(server, 'elicitation', params, settings, signal);
    if (answer.action !== 'accept') return { action: answer.action };
    signal.throwIfAborted(); this.guard(server, 'elicitation', false);
    if (JSON.stringify(this.settings(server)) !== JSON.stringify(settings)) throw new Error('Form settings changed.');
    if (!validate(answer.content ?? {}).valid) throw new Error('The answer does not fit the server form.');
    const content = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).parse(answer.content ?? {});
    return { action: 'accept' as const, content };
  }
}
