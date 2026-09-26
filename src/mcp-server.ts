import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Store } from './store.js';
import type { Runtime } from './runtime.js';
import type { Knowledge } from './knowledge.js';
import type { WorkspaceFiles } from './files.js';
import { Budget, errorText, type Message, type ToolContext } from './contracts.js';
import { describeToolCall } from './activity.js';
import { cappedPolicy, evaluatePolicy, isReadOnlyPermission, readPolicy } from './policy.js';
import {
  DryRunSchema, dryRunPlan, hiddenToolsText, hiddenToolsUri, preflight, type DryRunPlan,
} from './mcp-policy.js';
import { compareSnapshot, listSnapshots, recordSnapshot, type SnapshotTool } from './mcp-snapshots.js';
import { argumentFingerprint } from './runtime.js';
import { approvalQuestion, maximumPendingPerSession } from './approvals.js';

/**
 * Protocol versions Branch understands, newest first. A client that asks for something else is told
 * plainly which ones work rather than being left to guess.
 */
export const supportedProtocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const PREFERRED_PROTOCOL_VERSION = supportedProtocolVersions[0];
const CONVERSATION_LIMIT = 20;
const RUN_LIMIT = 20;
const TRANSCRIPT_BYTES = 64 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The list of recently finished tasks; a client watches this to hear when work is done. */
export const recentRunsUri = 'runs://recent';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A message with no reply expected, pushed down an open stream. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}
export type StreamListener = (notification: JsonRpcNotification) => void;

/** What the owner has chosen to share with other AI tools. */
export const McpSharingSchema = z
  .object({
    enabled: z.boolean().default(false),
    exposedTools: z.array(z.string().min(1).max(100)).max(200).default([]),
    /** Also answer assistants elsewhere over the agent-to-agent protocol, from the same shared list. */
    a2a: z.boolean().default(false),
  })
  .strict();
export type McpSharing = z.infer<typeof McpSharingSchema>;

/**
 * How Branch serves other AI tools, as opposed to what it shares with them. Two numbers: how long
 * a quiet connection is kept, and how long a call that needs the owner's yes waits for one.
 */
export const McpServingSchema = z
  .object({
    /** A connection nobody has said anything on for this long is dropped, as well as at the cap. */
    idleMinutes: z.number().int().min(1).max(1440).default(30),
    /** How long a call needing the owner's yes waits in the app before the client is told to retry. */
    askWaitSeconds: z.number().int().min(0).max(600).default(120),
  })
  .strict();
export type McpServing = z.infer<typeof McpServingSchema>;
/** The serving settings, read fresh so a change in Settings takes effect on the very next call. */
export function readServingSettings(store: Store, owner: string): McpServing {
  const saved = McpServingSchema.safeParse(store.get('settings', owner, 'mcp-serving')?.data ?? {});
  return saved.success ? saved.data : McpServingSchema.parse({});
}
export function saveServingSettings(store: Store, owner: string, input: unknown): McpServing {
  const value = McpServingSchema.parse({ ...readServingSettings(store, owner), ...(input as object ?? {}) });
  store.save('settings', owner, 'mcp-serving', value);
  return value;
}

/** A tool only reads when its permission ends in `.read`; anything else can change things. */
export const toolChangesThings = (permission: string): boolean => !/\.read$/.test(permission);

/** Every tool the owner could offer, with whether picking it lets another tool change things. */
export function shareableTools(registry: ToolRegistry): {
  name: string; description: string; permission: string; changesThings: boolean;
}[] {
  return registry
    .inventory()
    .map((tool) => ({ ...tool, changesThings: toolChangesThings(tool.permission) }))
    .sort((a, b) => Number(a.changesThings) - Number(b.changesThings) || a.name.localeCompare(b.name));
}

/** A conversation transcript as plain `role: text` lines, newest kept, older ones dropped. */
export function transcriptText(messages: Message[]): string {
  const lines: string[] = [];
  let bytes = 0;
  let dropped = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${message.role}: ${text.length > 4000 ? text.slice(0, 3999) + '…' : text}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > TRANSCRIPT_BYTES) { dropped = true; break; }
    lines.unshift(line);
  }
  if (dropped) lines.unshift('(earlier messages are not included)');
  return lines.join('\n');
}

/** A short readable name for a conversation, taken from its first message. */
export function conversationTitle(preview: string): string {
  const text = preview.replace(/\s+/g, ' ').trim();
  if (!text) return 'Conversation';
  return text.length > 60 ? text.slice(0, 59) + '…' : text;
}

interface McpServerOptions {
  /** Used only until the owner saves a choice in Settings. */
  enabled: boolean;
  exposedTools: ReadonlySet<string>;
  maxConcurrentCalls: number;
  perClientRateLimit: number;
}

export class McpSession {
  readonly id: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion: string = PREFERRED_PROTOCOL_VERSION;
  initialized = false;
  callCount = 0;
  /** Resources this connection has asked to be told about when they change. */
  readonly subscriptions = new Set<string>();
  /** Open streams for this connection; each gets every notification. */
  readonly listeners = new Set<StreamListener>();
  /** How chatty the client wants the log messages to be. */
  logLevel = 'info';
  /** The tool list written down for this connection, if one was. */
  snapshotId?: string;
  /** When this connection last said anything, so the quietest one is dropped first at the cap. */
  lastSeen = Date.now();

  constructor(id?: string) {
    // Long enough that a name cannot be guessed: 24 random bytes, far past the 128 bits asked for.
    this.id = id ?? randomBytes(24).toString('hex');
  }
}

/** How many conversations are kept at once. At the cap the quietest one is dropped. */
const SESSION_LIMIT = 100;
/**
 * How many calls may sit waiting for the owner's yes at once: in all, and from any one connection.
 * Waiting deliberately does not count as work, so without these two numbers a client could park
 * call after call and leave a question, a task and a timer behind for each one. Past either cap
 * the call is turned away at once, with nothing created and nothing to answer.
 *
 * It used to be one per connection, because the app held one question per conversation and a
 * second would quietly replace the first, leaving the owner never seeing what they were asked. The
 * app now keeps a list of them, so a connection may have as many waiting as a conversation may —
 * and not one more, so the two caps stay the same number and neither can be got round through the
 * other.
 */
const WAITING_LIMIT = 16, WAITING_PER_SESSION = maximumPendingPerSession;

/** What the settings say about one call from outside, and the words for each way it can end. */
interface McpVerdict {
  decision: 'allow' | 'deny' | 'ask';
  name: string;
  target: string;
  label: string;
  /** Where the owner's answer is kept: the client's own connection, so a retry finds it. */
  approvalKey: string;
  /** The exact request, with saved passwords taken out, and the fingerprint a yes is bound to. */
  bytes: string;
  fingerprint: string;
  /** How tightly the matching rule wants a program this call starts held (the sandbox wall). */
  sandbox: Pick<ToolContext, 'sandbox' | 'sandboxBackend' | 'sandboxPaths' | 'osSandbox'>;
  refusal: string;
  waiting: string;
  /** Said when there is no free place to wait in, so nothing was asked and nothing was done. */
  tooMany: string;
}

/** A resource only shows up when the owner's approval settings would allow the matching tool. */
interface ResourceScope { uri: string; name: string; description: string; mimeType: string; tool: string; permission: string }
const scopedResources: readonly ResourceScope[] = [
  { uri: 'memory://facts', name: 'Memory facts', description: 'What Branch remembers', mimeType: 'application/json',
    tool: 'memory.search', permission: 'memory.read' },
  { uri: 'workspace://files', name: 'Workspace files', description: 'Files in the workspace', mimeType: 'application/json',
    tool: 'files.list', permission: 'files.read' },
  { uri: 'documents://library', name: 'Documents', description: 'Documents Branch has read', mimeType: 'application/json',
    tool: 'documents.search', permission: 'documents.read' },
];

export class McpServer {
  private sessions = new Map<string, McpSession>();
  private inFlight = 0;
  /**
   * Calls parked on a question for the owner. Waiting for a person is not work, so it is taken off
   * the busy count: otherwise a couple of unanswered questions would hold every slot the connection
   * has for two minutes and refuse even a read.
   */
  private waiting = 0;
  /** How many of those belong to each connection, so one client cannot take every free place. */
  private readonly waitingPerSession = new Map<string, number>();
  private readonly stopWatching: () => void;
  /** The document library, once the launcher has built it, so documents can be offered too. */
  documents?: { list(owner: string): unknown[] };

  constructor(
    readonly registry: ToolRegistry,
    readonly store: Store,
    readonly runtime: Runtime,
    readonly knowledge: Knowledge,
    readonly files: WorkspaceFiles,
    readonly options: McpServerOptions,
  ) {
    // A skill, a plugin or another MCP server's tools arriving changes what is on offer, and every
    // connected client has to be told or it goes on calling something that is no longer there.
    this.stopWatching = registry.onToolsChanged(() => this.notifyAll('notifications/tools/list_changed', {}));
  }

  /** Stops listening for tool changes; the connections themselves are closed by their transports. */
  close(): void {
    this.stopWatching();
    for (const session of this.sessions.values()) session.listeners.clear();
    this.sessions.clear();
  }

  /** The clock, so a test can step over half an hour without waiting it out. */
  now: () => number = () => Date.now();

  /**
   * Drops every connection nobody has said anything on for a while. A connection with a stream
   * open is left alone however quiet it is: the stream is Branch talking, not the client, and a
   * client that opened one and is waiting to be told something has not gone away.
   */
  dropIdleSessions(): string[] {
    const limit = readServingSettings(this.store, this.runtime.owner).idleMinutes * 60_000;
    const cutoff = this.now() - limit;
    const gone: string[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.listeners.size || session.lastSeen > cutoff) continue;
      this.deleteSession(session.id);
      gone.push(session.id);
    }
    return gone;
  }

  /** Get or create a session for a given session ID. */
  getSession(sessionId?: string): McpSession {
    this.dropIdleSessions();
    const id = sessionId ?? randomBytes(24).toString('hex');
    const found = this.sessions.get(id);
    if (found) { found.lastSeen = this.now(); return found; }
    // A name nobody has used before opens a new conversation, but only so many may be open, or a
    // caller that made one up every time would fill this computer's memory.
    while (this.sessions.size >= SESSION_LIMIT) {
      const quietest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!quietest) break;
      this.deleteSession(quietest.id);
    }
    const created = new McpSession(id);
    created.lastSeen = this.now();
    this.sessions.set(id, created);
    return created;
  }

  /** Whether this is a conversation Branch actually opened, rather than a name somebody made up. */
  hasSession(sessionId: string): boolean {
    this.dropIdleSessions();
    return this.sessions.has(sessionId);
  }

  /** Delete a session and end its state. */
  deleteSession(sessionId: string): boolean {
    this.sessions.get(sessionId)?.listeners.clear();
    return this.sessions.delete(sessionId);
  }

  /** Opens a stream for a connection. Returns the function that closes it again. */
  openStream(sessionId: string, listener: StreamListener): () => void {
    const session = this.getSession(sessionId);
    session.listeners.add(listener);
    return () => void session.listeners.delete(listener);
  }

  /** Sends a message that expects no reply to every open stream. */
  notifyAll(method: string, params: Record<string, unknown>): void {
    for (const session of this.sessions.values()) this.notifySession(session, method, params);
  }

  private notifySession(session: McpSession, method: string, params: Record<string, unknown>): void {
    for (const listener of session.listeners)
      try { listener({ jsonrpc: '2.0', method, params }); } catch { /* a broken stream never breaks a call */ }
  }

  /** Tells whoever asked to be told that a resource has new contents. */
  publishResourceUpdate(uri: string): void {
    for (const session of this.sessions.values())
      if (session.subscriptions.has(uri)) this.notifySession(session, 'notifications/resources/updated', { uri });
  }

  /** What the owner is sharing right now; read fresh so a settings change takes effect at once. */
  sharing(): McpSharing {
    const saved = this.store.get('settings', this.runtime.owner, 'mcp-sharing');
    const parsed = saved ? McpSharingSchema.safeParse(saved.data) : undefined;
    if (parsed?.success) return parsed.data;
    return { enabled: this.options.enabled, exposedTools: [...this.options.exposedTools], a2a: false };
  }

  private exposed(): Set<string> {
    const sharing = this.sharing();
    return new Set(sharing.enabled ? sharing.exposedTools : []);
  }

  /** The shared tools checked against the approval settings before any of them is offered. */
  preflight(): ReturnType<typeof preflight> {
    return preflight(this.registry, this.store, this.runtime.owner, this.exposed());
  }

  /** Handle a JSON-RPC request and return the response to send back. */
  async handle(request: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse> {
    const session = this.getSession(sessionId);
    const respond = (result?: unknown, error?: JsonRpcResponse['error']): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id: request.id,
      ...(error ? { error } : { result: result ?? null }),
    });
    try {
      const params = request.params ?? {};
      if (request.method === 'initialize') return respond(this.initialize(session, params));
      if (request.method === 'ping') return respond({});
      if (!session.initialized) return respond(undefined, { code: -32002, message: 'Not initialized' });
      const result = await this.dispatch(session, request.method, params);
      if (result === undefined) return respond(undefined, { code: -32601, message: 'Method not found' });
      return respond(result);
    } catch (e) {
      const unsupported = e instanceof UnsupportedProtocol;
      return respond(undefined, unsupported
        ? { code: -32602, message: e.message, data: { supported: [...supportedProtocolVersions] } }
        : { code: -32603, message: 'Internal error', data: { details: errorText(e) } });
    }
  }

  /** Methods that need an initialized session; `undefined` means the method is unknown. */
  private async dispatch(session: McpSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'tools/list': return { tools: this.listTools() };
      case 'tools/call': return this.callTool(session, params);
      case 'resources/list': return { resources: this.listResources() };
      case 'resources/read': return this.readResource(params);
      case 'resources/subscribe': return this.subscribe(session, params, true);
      case 'resources/unsubscribe': return this.subscribe(session, params, false);
      case 'prompts/list': return { prompts: this.listPrompts() };
      case 'prompts/get': return this.getPrompt(params);
      case 'logging/setLevel': return this.setLogLevel(session, params);
      default: return undefined;
    }
  }

  private initialize(session: McpSession, params: unknown): unknown {
    const InitializeSchema = z.object({
      protocolVersion: z.string(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }).strict();
    const parsed = InitializeSchema.parse(params);
    if (!(supportedProtocolVersions as readonly string[]).includes(parsed.protocolVersion))
      throw new UnsupportedProtocol(parsed.protocolVersion);
    session.clientName = parsed.clientInfo.name;
    session.clientVersion = parsed.clientInfo.version;
    session.protocolVersion = parsed.protocolVersion;
    session.initialized = true;
    return {
      protocolVersion: parsed.protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      },
      serverInfo: { name: 'branch', version: '1.0.0' },
    };
  }

  private setLogLevel(session: McpSession, params: unknown): unknown {
    const { level } = z.object({ level: z.enum([
      'debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency',
    ]) }).strict().parse(params);
    session.logLevel = level;
    return {};
  }

  /** The tools on offer: asking Branch, the two MCP helpers, and the shared tools preflight allows. */
  listTools(): SnapshotTool[] {
    const tools: SnapshotTool[] = [{
      name: 'branch.ask',
      description: 'Ask Branch to do something and return its answer. Branch uses its own tools, memory and skills.',
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string', description: 'What you want Branch to do' } },
        required: ['prompt'],
      },
    }];
    const exposed = this.exposed();
    if (!exposed.size) return tools;
    tools.push(dryRunToolDescription, snapshotToolDescription);
    const schemas = new Map(
      // Another program's client validates against what it is told, so it gets the full schema, not
      // the shortened one the model is shown to keep the per-round catalog small.
      this.registry.descriptions(new Set(this.registry.permissions()), { diet: false }).map((d) => [d.name, d.parameters]),
    );
    const allowed = new Set(this.preflight().allowed.map((entry) => entry.name));
    // Branch's own `mcp.*` helpers are registered tools as well, so the owner can tick them in the
    // shared list; they are already above, and a list with the same name twice is not a valid one.
    const named = new Set(tools.map((tool) => tool.name));
    for (const tool of this.registry.inventory())
      if (allowed.has(tool.name) && !named.has(tool.name)) {
        named.add(tool.name);
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: schemas.get(tool.name) ?? { type: 'object', properties: {} },
        });
      }
    return tools;
  }

  private async callTool(session: McpSession, params: unknown): Promise<unknown> {
    const parsed = z.object({
      name: z.string().min(1).max(100),
      arguments: z.record(z.string(), z.unknown()).optional(),
      /** Extra instructions from the client; `dryRun` asks what the call would do, without doing it. */
      _meta: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(params);
    session.callCount++;
    if (session.callCount > this.options.perClientRateLimit)
      return failure(`This connection has used its limit of ${this.options.perClientRateLimit} calls.`);
    const args = parsed.arguments ?? {};
    if (parsed._meta?.dryRun === true) return this.dryRun({ name: parsed.name, arguments: args });
    if (parsed.name === 'mcp.dry_run') return this.dryRun(DryRunSchema.parse(args));
    if (parsed.name === 'mcp.snapshot') return this.snapshot(session, args);
    if (this.inFlight - this.waiting >= this.options.maxConcurrentCalls)
      return failure('Branch is already busy with as many shared calls as it allows. Try again shortly.');
    this.inFlight++;
    try {
      if (parsed.name === 'branch.ask') return await this.callAsk(args);
      const exposed = this.exposed();
      if (!exposed.has(parsed.name))
        return failure(`Branch is not sharing "${parsed.name}". Turn it on in Settings, under Sharing with other AI tools.`);
      return await this.callRegistryTool(parsed.name, args, exposed, session);
    } finally {
      this.inFlight--;
    }
  }

  /** What a call would do, without doing any of it. Nothing is written and no address is opened. */
  private dryRun(input: { name: string; arguments: Record<string, unknown> }): unknown {
    try {
      const plan = input.name === 'branch.ask' ? askPlan(input.arguments)
        : dryRunPlan(this.registry, this.store, this.runtime.owner, this.files.base, input);
      return { content: [{ type: 'text', text: JSON.stringify(plan) }], structuredContent: plan, isError: false };
    } catch (e) {
      return failure(errorText(e));
    }
  }

  /** Writes down, or checks against, the exact tool list and schemas this connection was shown. */
  private snapshot(session: McpSession, args: Record<string, unknown>): unknown {
    const parsed = z.object({
      action: z.enum(['record', 'compare', 'list']).default('record'),
      id: z.string().max(80).optional(),
    }).strict().safeParse(args);
    if (!parsed.success) return failure('Use action "record", "compare" or "list".');
    const owner = this.runtime.owner;
    try {
      if (parsed.data.action === 'list') return structured(listSnapshots(this.store, owner).map(withoutTools));
      if (parsed.data.action === 'compare') {
        const id = parsed.data.id ?? session.snapshotId;
        if (!id) return failure('Record a tool list first, or say which record to compare against.');
        return structured(compareSnapshot(this.store, owner, id, this.listTools()));
      }
      const saved = recordSnapshot(this.store, owner, {
        sessionId: session.id, client: session.clientName ?? 'unknown',
        protocolVersion: session.protocolVersion, tools: this.listTools(),
      });
      session.snapshotId = saved.id;
      return structured({ id: saved.id, at: saved.at, digest: saved.digest, tools: saved.tools.length });
    } catch (e) {
      return failure(errorText(e));
    }
  }

  /** Delegate a prompt to Branch itself; the runtime records the run, we add the receipt. */
  private async callAsk(args: Record<string, unknown>): Promise<unknown> {
    const parsed = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict().safeParse(args);
    if (!parsed.success) return failure('Give a "prompt" saying what you want Branch to do.');
    try {
      const run = await this.runtime.run({ prompt: parsed.data.prompt, source: 'mcp' });
      await this.recordCall(run.id, 'branch.ask', parsed.data, run.output, run.status === 'completed');
      this.announceRun(run.id);
      return { content: [{ type: 'text', text: run.output }], isError: run.status !== 'completed' };
    } catch (e) {
      return failure(errorText(e));
    }
  }

  /** Run one shared tool as its own recorded task, so it appears in Activity with a receipt. */
  private async callRegistryTool(
    name: string, args: Record<string, unknown>, exposed: Set<string>, session?: McpSession,
  ): Promise<unknown> {
    const verdict = this.gate(name, args, session);
    if (verdict.decision === 'deny') return failure(verdict.refusal);
    if (verdict.decision === 'ask') {
      const answered = await this.park(verdict, session);
      if (answered === 'full') return failure(verdict.tooMany);
      if (answered !== 'allow') return failure(answered === 'deny' ? verdict.refusal : verdict.waiting);
    }
    const run = this.store.createRun(this.runtime.owner, `Another AI tool used ${name}`);
    this.store.event(run.id, 'run.started', { source: 'mcp', tool: name, provider: this.runtime.provider.name, parentRunId: null });
    try {
      const result = await this.registry.execute(name, args, { ...this.toolContext(run.id, exposed), ...verdict.sandbox });
      await this.recordCall(run.id, name, args, result, true);
      this.store.finish(run.id, 'completed', JSON.stringify(result));
      this.announceRun(run.id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (e) {
      const error = errorText(e);
      await this.recordCall(run.id, name, args, error, false);
      this.store.finish(run.id, 'failed', error);
      this.announceRun(run.id);
      return failure(error);
    }
  }

  /**
   * The owner's approval settings, applied at the moment of the call. A flat refusal is final; a
   * call the settings want asked about becomes a real question in the app, which the owner can
   * answer while the client waits (see `waitForOwner`).
   *
   * The answer is kept against the client's own connection and bound to the exact bytes asked for,
   * so a yes covers this call and a retry of it, and nothing else.
   */
  private gate(name: string, args: Record<string, unknown>, session?: McpSession): McpVerdict {
    const permission = this.registry.permissionOf(name);
    const approvalKey = `mcp:${session?.id ?? 'once'}`;
    const context = { ...this.toolContext('policy-check', new Set([name])), approvalKey };
    const bytes = this.runtime.hideSecrets(JSON.stringify(args));
    // Fingerprinted before hiding: two different keys hide to the same words and must stay two questions.
    const fingerprint = argumentFingerprint(name, JSON.stringify(args));
    // mac5/manual-actions: the runtime's own reckoning — Branch's own files (never-break), the role,
    // the rules capped for another AI tool, folder trust, the leak guard and the yeses already given.
    const check = this.runtime.checkPolicy(name, args, context, fingerprint);
    const where = check.target ? ` on ${check.target}` : '';
    // Whoever is signed in here is held to their role as well, exactly as they are in a
    // conversation; another AI tool's server must not be a way round what the owner said. There is
    // no task behind this call yet, so the role is the window's now (household-followups: a task's
    // own calls are held to the person the task was started for instead).
    const held = this.runtime.roleRefusal(name, permission) ?? check.reason ?? null;
    return {
      decision: check.decision, name, target: check.target, label: check.label, approvalKey,
      bytes: bytes.slice(0, 2000), fingerprint,
      sandbox: { ...this.runtime.wallFor(name, args, context, check.sandbox), ...(check.sandbox ? { sandbox: check.sandbox } : {}), ...(check.backend ? { sandboxBackend: check.backend } : {}),
        ...(check.paths?.length ? { sandboxPaths: check.paths } : {}) },
      refusal: held || `Your approval settings do not allow ${name}${where}.`,
      waiting: `${name}${where} is waiting for your yes in Branch; nothing was done. Answer it there and ask again.`,
      tooMany: 'Branch is already holding as many questions for the owner as it allows. Nothing was asked and nothing was done. Answer the ones waiting in Branch, then try again.',
    };
  }

  /**
   * Holding one call open while the owner is asked, but only if there is a place free. Waiting is
   * not work, so it does not count against how many calls may run at once; these two counts are
   * what stops that becoming a way to make Branch hold an unlimited number of them. A call turned
   * away here has had nothing created for it — no question, no task, nothing to answer.
   */
  private async park(verdict: McpVerdict, session?: McpSession): Promise<'allow' | 'deny' | 'waiting' | 'full'> {
    const key = verdict.approvalKey;
    const mine = this.waitingPerSession.get(key) ?? 0;
    if (this.waiting >= WAITING_LIMIT || mine >= WAITING_PER_SESSION) return 'full';
    this.waiting++;
    this.waitingPerSession.set(key, mine + 1);
    try {
      return await this.waitForOwner(verdict, session);
    } finally {
      this.waiting--;
      const left = (this.waitingPerSession.get(key) ?? 1) - 1;
      if (left > 0) this.waitingPerSession.set(key, left); else this.waitingPerSession.delete(key);
    }
  }

  /**
   * A call the settings want a question about. There used to be nobody at this end of an MCP
   * connection to answer one, so it was simply refused. Now the question goes into the app exactly
   * as a question from the owner's own conversation does — the same pending approval, the same
   * exact bytes, the same fingerprint — and the client's call is held open while the owner looks at
   * it, for as long as the owner's setting allows. If nothing comes, the question stays waiting and
   * the client is told to ask again: the answer is bound to these bytes, so a retry finds it.
   */
  private async waitForOwner(verdict: McpVerdict, session?: McpSession): Promise<'allow' | 'deny' | 'waiting'> {
    const name = verdict.name;
    const asking = this.store.createRun(this.runtime.owner, `Another AI tool asked to use ${name}`);
    const question = approvalQuestion(verdict.label, verdict.target);
    this.runtime.approvals.ask({
      runId: asking.id, sessionId: verdict.approvalKey, tool: name, target: verdict.target,
      label: verdict.label, question, source: 'mcp', remember: 'session',
      askedAt: new Date().toISOString(), bytes: verdict.bytes, fingerprint: verdict.fingerprint,
      ...(this.registry.noStandingTarget(name, verdict.target ?? '') ? { noAlways: true } : {}),
    });
    this.store.event(asking.id, 'policy.ask', { name, label: verdict.label, target: verdict.target,
      remember: 'session', question, bytes: verdict.bytes, fingerprint: verdict.fingerprint, source: 'mcp' });
    const deadline = this.now() + readServingSettings(this.store, this.runtime.owner).askWaitSeconds * 1000;
    do {
      const answer = this.runtime.approvals.answer(verdict.approvalKey, name, verdict.target, verdict.fingerprint);
      if (answer) {
        this.store.finish(asking.id, 'completed', answer === 'allow' ? 'You said yes.' : 'You said no.');
        return answer;
      }
      if (this.now() >= deadline) break;
      // A client holding a call open is not an idle one, so the idle sweep must not take its
      // session away underneath it — the answer is remembered against that session id.
      if (session) session.lastSeen = this.now();
      await new Promise((resolve) => { const timer = setTimeout(resolve, 150); timer.unref?.(); });
    } while (this.now() < deadline);
    // The question is deliberately left waiting: the owner can still answer it, and the answer is
    // bound to these exact bytes, so the client's next try finds it without asking again.
    this.store.finish(asking.id, 'needs_input', question);
    return 'waiting';
  }

  /** Anyone watching the list of finished tasks is told, and so is anyone watching this one. */
  private announceRun(runId: string): void {
    this.publishResourceUpdate(recentRunsUri);
    this.publishResourceUpdate(`run://${runId}`);
  }

  /** The same started/completed pair the runtime records, marked as coming from another AI tool. */
  private async recordCall(runId: string, name: string, args: unknown, result: unknown, ok: boolean): Promise<void> {
    const id = randomUUID();
    const label = name === 'branch.ask' ? 'Answering another AI tool' : describeToolCall(name, args);
    this.store.event(runId, 'tool.started', { name, id, source: 'mcp', label });
    if (!ok) {
      this.store.event(runId, 'tool.failed', { name, id, source: 'mcp', error: String(result) });
      return;
    }
    const receipt = await this.store.receipts.sign(runId, id, name, result);
    this.store.event(runId, 'tool.completed', { name, id, source: 'mcp', result, receipt });
  }

  private toolContext(runId: string, exposed: Set<string>): ToolContext {
    const permissions = new Set(
      this.registry.inventory().filter((tool) => exposed.has(tool.name)).map((tool) => tool.permission),
    );
    return {
      owner: this.runtime.owner,
      workspace: this.files.base,
      runId,
      signal: AbortSignal.timeout(120000),
      budget: new Budget({ maxSteps: 5, maxTokens: 8000 }),
      permissions,
      depth: 0,
      source: 'mcp',
    };
  }

  /** Whether the owner's settings would let this connection read a resource of that kind. */
  private mayRead(scope: { tool: string; permission: string }): boolean {
    const policy = cappedPolicy(readPolicy(this.store, this.runtime.owner), 'mcp');
    const { decision } = evaluatePolicy(policy,
      { tool: scope.tool, target: '', readOnly: isReadOnlyPermission(scope.permission) });
    return decision !== 'deny';
  }

  private listResources(): unknown[] {
    const resources: unknown[] = scopedResources
      .filter((scope) => this.mayRead(scope) && (scope.uri !== 'documents://library' || this.documents))
      .map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
    resources.push({
      uri: hiddenToolsUri, name: 'What is not on offer, and why',
      description: 'The tools your approval settings hold back from this connection', mimeType: 'text/plain',
    });
    if (this.mayRead(historyScope)) {
      resources.push({
        uri: recentRunsUri, name: 'Recently finished tasks',
        description: 'Tasks this connection can watch; subscribe to hear when one finishes', mimeType: 'application/json',
      });
      for (const conversation of this.recentConversations())
        resources.push({
          uri: `conversation://${conversation.sessionId}`,
          name: conversation.title,
          description: `Conversation from ${conversation.date}`,
          mimeType: 'text/plain',
        });
    }
    return resources;
  }

  /** The owner's most recent saved conversations; temporary ones are never listed. */
  private recentConversations(): { sessionId: string; title: string; date: string }[] {
    const found = this.store.searchSessions(this.runtime.owner, { query: '', offset: 0 });
    return found.sessions.slice(0, CONVERSATION_LIMIT).map((session) => ({
      sessionId: session.sessionId,
      title: conversationTitle(session.preview),
      date: session.createdAt.slice(0, 10),
    }));
  }

  private subscribe(session: McpSession, params: unknown, on: boolean): unknown {
    const { uri } = z.object({ uri: z.string().min(1).max(500) }).strict().parse(params);
    if (on) {
      if (session.subscriptions.size >= 50) throw new Error('This connection is already watching as much as it may.');
      session.subscriptions.add(uri);
    } else session.subscriptions.delete(uri);
    return {};
  }

  private async readResource(params: unknown): Promise<unknown> {
    const { uri } = z.object({ uri: z.string().min(1).max(500) }).strict().parse(params);
    const json = (value: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] });
    const text = (value: string) => ({ contents: [{ uri, mimeType: 'text/plain', text: value }] });
    if (uri === hiddenToolsUri) return text(hiddenToolsText(this.preflight()));
    const scope = scopedResources.find((entry) => entry.uri === uri);
    if (scope) {
      if (!this.mayRead(scope)) throw new Error(`Unknown resource: ${uri}`);
      if (uri === 'memory://facts') return json(this.store.list('memory', this.runtime.owner));
      // mac7/walk-rules: another program reading the workspace is held to the owner's rules, entry by entry.
      if (uri === 'workspace://files') return json(await this.files.list(".", undefined, { source: "mcp" }));
      if (!this.documents) throw new Error(`Unknown resource: ${uri}`);
      return json(this.documents.list(this.runtime.owner));
    }
    if (!this.mayRead(historyScope)) throw new Error(`Unknown resource: ${uri}`);
    if (uri === recentRunsUri) return json(this.store.runs(this.runtime.owner).slice(0, RUN_LIMIT));
    const run = new RegExp(`^run://(${UUID})$`).exec(uri);
    if (run) {
      const found = this.store.run(run[1]!);
      if (!found || found.owner !== this.runtime.owner) throw new Error('Task not found');
      return json(found);
    }
    const conversation = new RegExp(`^conversation://(${UUID})$`).exec(uri);
    if (conversation) {
      const sessionId = conversation[1]!;
      if (!this.store.ownsSession(this.runtime.owner, sessionId)) throw new Error('Conversation not found');
      return text(transcriptText(this.store.messages(sessionId)));
    }
    throw new Error(`Unknown resource: ${uri}`);
  }

  /** Saved procedures and recipes, offered as prompts with the blanks they take. */
  private listPrompts(): unknown[] {
    return this.store.list('procedures', this.runtime.owner).slice(0, 10).map((procedure) => {
      const recipe = readRecipe(procedure.data);
      return {
        name: `procedure:${procedure.id}`,
        description: recipe.name ?? procedure.id,
        arguments: promptArguments(recipe.parameters),
      };
    });
  }

  private async getPrompt(params: unknown): Promise<unknown> {
    const parsed = z.object({
      name: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.string().max(2000)).optional(),
    }).strict().parse(params);
    const match = new RegExp(`^procedure:(${UUID})$`).exec(parsed.name);
    if (!match) throw new Error(`Unknown prompt: ${parsed.name}`);
    const procedure = this.store.get('procedures', this.runtime.owner, match[1]!);
    if (!procedure) throw new Error('Procedure not found');
    const recipe = readRecipe(procedure.data);
    const missing = promptArguments(recipe.parameters)
      .filter((argument) => argument.required && !(argument.name in (parsed.arguments ?? {})));
    if (missing.length) throw new Error(`This procedure needs: ${missing.map((a) => a.name).join(', ')}.`);
    const filled = Object.entries(parsed.arguments ?? {})
      .map(([key, value]) => `${key}: ${value}`).join('\n');
    return {
      description: recipe.name ?? 'Saved procedure',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Follow the saved procedure "${recipe.name ?? 'Unnamed'}". Steps: ${JSON.stringify(recipe.steps)}`
            + (filled ? `\nWith these details:\n${filled}` : ''),
        },
      }],
    };
  }
}

/** A saved procedure, whose real shape keeps the recipe under `definition`. */
function readRecipe(data: Record<string, unknown>): { name?: string; steps: unknown[]; parameters: unknown } {
  const definition = (data.definition ?? data) as { name?: unknown; steps?: unknown; parameters?: unknown };
  return {
    ...(typeof definition.name === 'string' ? { name: definition.name } : {}),
    steps: Array.isArray(definition.steps) ? definition.steps : [],
    parameters: definition.parameters,
  };
}

const historyScope = { tool: 'history.search', permission: 'history.read' };

/** The blanks a saved procedure takes, read from the named inputs the recipe declares. */
function promptArguments(parameters: unknown): { name: string; description: string; required: boolean }[] {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return [];
  return Object.entries(parameters as Record<string, unknown>).slice(0, 20).map(([name, spec]) => {
    const shape = (spec ?? {}) as { type?: unknown; required?: unknown; description?: unknown };
    return {
      name,
      description: typeof shape.description === 'string' && shape.description
        ? shape.description
        : `A ${typeof shape.type === 'string' ? shape.type : 'value'} for ${name}`,
      required: shape.required === true,
    };
  });
}

/** Asking Branch in plain words goes through Branch's own approvals, so its plan says just that. */
function askPlan(args: Record<string, unknown>): DryRunPlan {
  return {
    tool: 'branch.ask', description: 'Ask Branch to do something in plain words.',
    target: String(args.prompt ?? '').slice(0, 120), files: [], hosts: [], changesThings: true, decision: 'ask',
    cost: 'Asking Branch in plain words goes to your chosen model, so it costs whatever that model charges for the answer.',
    wouldHappen: 'Branch would work out the steps itself and run them under your approval settings, stopping to ask you about anything that changes something.',
    dryRun: true,
  };
}

class UnsupportedProtocol extends Error {
  constructor(asked: string) {
    super(`Branch does not speak MCP version "${asked}". It speaks ${supportedProtocolVersions.join(', ')}.`);
  }
}

/** A record without the tool list itself, which is far too long for a listing. */
const withoutTools = (snapshot: { tools: unknown[] }) => ({ ...snapshot, tools: snapshot.tools.length });

const structured = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false,
});
const failure = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

const dryRunToolDescription: SnapshotTool = {
  name: 'mcp.dry_run',
  description: 'Say what a tool call would do — what it would touch, whether it changes anything, and what it would cost — without doing it.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The tool you are thinking of calling' },
      arguments: { type: 'object', description: 'The arguments you would send' },
    },
    required: ['name'],
  },
};

const snapshotToolDescription: SnapshotTool = {
  name: 'mcp.snapshot',
  description: 'Write down the exact tool list and schemas you were shown, or check a saved record against what is on offer now.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['record', 'compare', 'list'], description: 'record, compare or list' },
      id: { type: 'string', description: 'Which saved record to compare against' },
    },
  },
};

export async function startMcpServer(
  registry: ToolRegistry,
  store: Store,
  runtime: Runtime,
  knowledge: Knowledge,
  files: WorkspaceFiles,
  options: Partial<McpServerOptions> = {},
): Promise<McpServer> {
  const defaultOptions: McpServerOptions = {
    enabled: false,
    exposedTools: new Set<string>(),
    maxConcurrentCalls: 4,
    perClientRateLimit: 100,
    ...options,
  };
  return new McpServer(registry, store, runtime, knowledge, files, defaultOptions);
}
