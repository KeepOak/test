import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { runOrigin } from './key-context.js';
import { lockdownActive } from './lockdown.js';
import { mcpToolName } from './integrations/mcp.js';
import { scriptedProxyPage } from './scripted-mcp-proxy.js';

interface Held {
  owner: string; server: string; runId: string; within: readonly string[]; until: number;
  calls: number[]; pending: Map<string, { name: string; args: unknown; until: number }>;
  nonce: string; proxyUsed: boolean;
  active: Set<AbortController>;
}

/** A capability is bound to one app from one saved run; it never supplies new permissions. */
export class ScriptedMcpApps {
  private readonly held = new Map<string, Held>();
  constructor(private readonly runtime: Runtime) {}
  support(server: string): boolean {
    return (this.runtime.store.get('settings', this.runtime.owner, `mcp-apps:${server}`)?.data as { enabled?: unknown } | undefined)?.enabled === true;
  }
  enable(input: unknown): void {
    this.guard();
    const value = z.object({ server: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/), enabled: z.boolean(), confirmed: z.literal(true) }).strict().parse(input);
    this.runtime.store.save('settings', this.runtime.owner, `mcp-apps:${value.server}`, { enabled: value.enabled });
    if (!value.enabled) for (const [id, held] of this.held) if (held.server === value.server) this.close(id);
  }
  private guard(): void {
    this.runtime.store.profiles.requireOwner('Interactive server pages');
    if (lockdownActive(this.runtime.store, this.runtime.owner)) throw new Error('Unlock the owner window to use an interactive server page.');
  }
  open(input: unknown) {
    this.guard();
    const value = z.object({ runId: z.string().uuid(), uri: z.string().startsWith('ui://').max(500),
      tool: z.string().min(1).max(100), confirmed: z.literal(true) }).strict().parse(input);
    const run = this.runtime.store.run(value.runId), origin = runOrigin(this.runtime.store, value.runId);
    if (!run || run.owner !== this.runtime.owner || !origin.permissions || origin.shortLivedKey) throw new Error('This page has no eligible original run permissions.');
    const event = this.runtime.store.events(value.runId).find(e => e.kind === 'mcp.app' && e.data.uri === value.uri && e.data.tool === value.tool);
    const source = this.runtime.registry.sourceOf(value.tool);
    if (!event || !source?.startsWith('mcp:')) throw new Error('This page is unavailable from its original server.');
    if (!this.support(source.slice(4))) throw new Error('Enable interactive pages for this server first.');
    const html = String(event.data.html ?? '');
    if (!html || Buffer.byteLength(html) > 200000) throw new Error('The interactive page is empty or too large.');
    const argumentsValue = typeof event.data.input === 'string' ? JSON.parse(event.data.input) : event.data.input ?? {};
    for (const [id, item] of this.held) if (item.until <= Date.now()) this.close(id);
    if (this.held.size >= 8) throw new Error('Close an interactive page before opening another.');
    const capability = randomUUID(), nonce = randomUUID();
    this.held.set(capability, { owner: this.runtime.owner, server: source.slice(4), runId: run.id,
      within: origin.permissions, until: Date.now() + 300000, calls: [], pending: new Map(), nonce, proxyUsed: false, active: new Set() });
    this.runtime.store.event(run.id, 'mcp.app.opened', { server: source.slice(4), uri: value.uri, scripts: true });
    return { capability, nonce, proxyUrl: `/mcp-app-sandbox/${nonce}`, html, input: argumentsValue, result: event.data.result ?? { content: [] } };
  }
  proxy(nonce: string): string | null {
    const held = [...this.held.values()].find(item => item.nonce === nonce);
    if (!held || held.proxyUsed || held.until <= Date.now() || held.owner !== this.runtime.owner) return null;
    held.proxyUsed = true; return scriptedProxyPage(nonce);
  }
  close(capability: string): void {
    for (const controller of this.held.get(capability)?.active ?? []) controller.abort();
    this.held.delete(capability);
  }
  private take(capability: string): Held {
    this.guard();
    const held = this.held.get(capability);
    if (!held || held.owner !== this.runtime.owner || held.until <= Date.now() || !this.support(held.server)) throw new Error('This interactive page has expired.');
    const run = this.runtime.store.run(held.runId);
    if (!run || run.owner !== held.owner) throw new Error('The page conversation is unavailable.');
    held.calls = held.calls.filter(time => time > Date.now() - 60000);
    if (held.calls.length >= 20) throw new Error('This interactive page reached its request limit.');
    held.calls.push(Date.now()); return held;
  }
  propose(input: unknown) {
    const value = z.object({ capability: z.string().uuid(), name: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()) }).strict().parse(input);
    const held = this.take(value.capability);
    for (const [id, request] of held.pending) if (request.until <= Date.now()) held.pending.delete(id);
    if (Buffer.byteLength(JSON.stringify(value.arguments)) > 16000 || held.pending.size >= 4) throw new Error('This page request is too large or too many are waiting.');
    const name = mcpToolName(held.server, value.name), tool = this.runtime.registry.registered(name);
    if (!tool || this.runtime.registry.sourceOf(name) !== `mcp:${held.server}` || !tool.appCallable
      || !held.within.includes(tool.permission)) throw new Error('This tool is outside the page server, app visibility or original permissions.');
    const ticket = randomUUID();
    held.pending.set(ticket, { name, args: structuredClone(value.arguments), until: Date.now() + 30000 });
    return { ticket, name, arguments: value.arguments };
  }
  async call(input: unknown): Promise<unknown> {
    const value = z.object({ capability: z.string().uuid(), ticket: z.string().uuid(), confirmed: z.literal(true) }).strict().parse(input);
    const held = this.take(value.capability), request = held.pending.get(value.ticket);
    held.pending.delete(value.ticket);
    if (!request || request.until <= Date.now()) throw new Error('This owner confirmation has expired.');
    const tool = this.runtime.registry.registered(request.name);
    if (!tool?.appCallable || this.runtime.registry.sourceOf(request.name) !== `mcp:${held.server}`
      || !held.within.includes(tool.permission)) throw new Error('This page tool is no longer available.');
    const controller = new AbortController();
    held.active.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(30000, held.until - Date.now()))]);
    try {
      return await this.runtime.executeTool(request.name, request.args, { mode: 'owner', source: 'owner', within: held.within, appCaller: true, signal });
    } finally { held.active.delete(controller); }
  }
  decline(input: unknown): void {
    const value = z.object({ capability: z.string().uuid(), ticket: z.string().uuid() }).strict().parse(input);
    this.take(value.capability).pending.delete(value.ticket);
  }
}
