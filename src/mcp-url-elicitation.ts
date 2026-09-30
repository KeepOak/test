import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ElicitationOrigin = z.string().max(300).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }
  catch { return false; }
}, 'Use an exact HTTPS origin without a path, credentials or query.');
type Action = { action: 'accept' | 'decline' | 'cancel' };
export interface UrlFlow { mode: 'push' | 'modern' | 'error'; runId?: string; tool?: string; args?: Record<string, unknown>; continuation?: boolean }
interface Waiting {
  id: string; server: string; connection: string; elicitationId: string; origin: string;
  url: string; owner: string; message: string; stage: 'approval' | 'opening' | 'completion' | 'resume'; flow: UrlFlow;
  valid: () => boolean; accept: () => void; finish: (result: Action) => void;
}
interface Ticket { id: string; proof: string; expires: number; consumed: boolean }

/** URLs and handoff proofs remain process-local; the MCP response contains only an action. */
export class McpUrlElicitation {
  private readonly pending = new Map<string, Waiting>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly used = new Map<string, Set<string>>();
  private readonly completed = new Map<string, { id: string; server: string; origin: string; owner: string; until: number }>();
  constructor(private readonly owner: () => string, private readonly ready: () => boolean,
    private readonly vet: (url: URL) => Promise<void>) {}

  list() {
    for (const [id, value] of this.completed) if (value.until <= Date.now()) this.completed.delete(id);
    return [...this.pending.values()].filter(item => item.owner === this.owner())
      .map(({ id, server, message, origin, stage, flow }) => ({ id, server, message, origin, stage: stage as string, flow }))
      .concat([...this.completed.values()].filter(item => item.owner === this.owner())
        .map(({ id, server, origin }) => ({ id, server, origin, stage: 'completed', flow: { mode: 'push' as const }, message: 'This server reported that the browser step completed.' })));
  }
  cancel(server?: string, connection?: string): void {
    for (const item of this.pending.values()) if ((!server || item.server === server)
      && (!connection || item.connection === connection)) item.finish({ action: 'cancel' });
    if (connection) this.used.delete(connection);
    for (const [id, value] of this.completed) if (!server || value.server === server) this.completed.delete(id);
  }
  private current(id: string): Waiting {
    const item = this.pending.get(id);
    if (!item || item.owner !== this.owner() || !this.ready() || !item.valid())
      throw new Error('This browser question is no longer available.');
    return item;
  }
  decline(input: unknown): void {
    const value = z.object({ id: z.string().uuid(), action: z.enum(['decline', 'cancel']) }).strict().parse(input);
    this.current(value.id).finish({ action: value.action });
  }
  resume(input: unknown): void {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
    const item = this.current(id);
    if (!(item.flow.mode === 'modern' && item.stage === 'resume'
      || item.flow.mode === 'error' && item.stage === 'completion')) throw new Error('Open the browser step before continuing.');
    item.finish({ action: 'accept' });
  }
  prepare(input: unknown): { ticket: string } {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
    const item = this.current(id);
    if (item.stage !== 'approval') throw new Error('This browser question was already opened.');
    const ticket = randomUUID(); item.stage = 'opening';
    this.tickets.set(ticket, { id, proof: randomUUID(), expires: Date.now() + 30_000, consumed: false });
    return { ticket };
  }
  /** Only the main-process IPC sees the URL and the separate one-use handoff proof. */
  async consume(input: unknown) {
    const { ticket } = z.object({ ticket: z.string().uuid() }).strict().parse(input);
    const handoff = this.tickets.get(ticket);
    if (!handoff || handoff.consumed || handoff.expires <= Date.now()) throw new Error('Browser handoff expired.');
    handoff.consumed = true;
    const item = this.current(handoff.id);
    await this.vetAddress(new URL(item.url));
    this.current(item.id);
    if (handoff.expires <= Date.now() || !this.tickets.has(ticket)) throw new Error('Browser handoff expired.');
    return { url: item.url, proof: handoff.proof };
  }
  opened(input: unknown): void {
    const value = z.object({ ticket: z.string().uuid(), proof: z.string().uuid(), opened: z.boolean() }).strict().parse(input);
    const handoff = this.tickets.get(value.ticket);
    if (!handoff || !handoff.consumed || handoff.proof !== value.proof || handoff.expires <= Date.now())
      throw new Error('Browser handoff expired.');
    this.tickets.delete(value.ticket);
    const item = this.current(handoff.id);
    if (!value.opened) item.finish({ action: 'cancel' });
    else {
      item.stage = item.flow.mode === 'modern' ? 'resume' : 'completion';
      if (item.flow.mode === 'push') item.accept();
    }
  }
  complete(connection: string, elicitationId: string): void {
    for (const item of this.pending.values()) if (item.connection === connection
      && item.elicitationId === elicitationId && item.stage === 'completion') {
      try {
        this.current(item.id);
        this.completed.set(item.id, { id: item.id, server: item.server, origin: item.origin,
          owner: item.owner, until: Date.now() + 30_000 });
        if (this.completed.size > 32) this.completed.delete(this.completed.keys().next().value!);
        item.finish({ action: 'accept' });
      }
      catch { item.finish({ action: 'cancel' }); }
    }
  }
  async ask(server: string, connection: string, input: unknown, origins: string[], valid: () => boolean,
    signal: AbortSignal, flow: UrlFlow = { mode: 'push' }): Promise<Action> {
    const params = z.object({ mode: z.literal('url'), message: z.string().max(4000),
      url: z.string().url().max(8192), elicitationId: z.string().min(1).max(200), task: z.never().optional() }).passthrough().parse(input);
    const url = new URL(params.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !origins.includes(url.origin))
      throw new Error('The browser question does not match an approved HTTPS origin.');
    if (!this.ready() || !valid() || this.pending.size >= 8) throw new Error('Browser questions are unavailable.');
    const used = this.used.get(connection) ?? new Set<string>();
    if (used.has(params.elicitationId) || used.size >= 256) throw new Error('Browser question identifier was reused or the connection limit was reached.');
    used.add(params.elicitationId); this.used.set(connection, used);
    await this.vetAddress(url); signal.throwIfAborted();
    if (!this.ready() || !valid() || this.pending.size >= 8) throw new Error('Browser questions are unavailable.');
    if (Buffer.byteLength(JSON.stringify(flow)) > 32768) throw new Error('Original request exceeds the review limit.');
    return this.wait(server, connection, params, valid, signal, flow);
  }
  private async vetAddress(url: URL): Promise<void> {
    try { await this.vet(url); }
    catch { throw new Error('The browser question address was refused by network policy.'); }
  }
  private wait(server: string, connection: string, params: { url: string; message: string; elicitationId: string },
    valid: () => boolean, signal: AbortSignal, flow: UrlFlow): Promise<Action> {
    return new Promise(resolve => {
      const id = randomUUID(), expires = Date.now() + 300_000;
      const finish = (answer: Action) => {
        clearInterval(timer); signal.removeEventListener('abort', cancel); this.pending.delete(id);
        for (const [key, value] of this.tickets) if (value.id === id) this.tickets.delete(key);
        resolve(answer);
      };
      const cancel = () => finish({ action: 'cancel' });
      const timer = setInterval(() => {
        const abandoned = [...this.tickets.values()].some(t => t.id === id && t.expires <= Date.now());
        if (!this.ready() || !valid() || Date.now() >= expires || abandoned) cancel();
      }, 500);
      timer.unref?.(); signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { id, server, connection, elicitationId: params.elicitationId,
        url: params.url, origin: new URL(params.url).origin, message: params.message, owner: this.owner(),
        stage: 'approval', flow, valid, accept: () => resolve({ action: 'accept' }), finish });
      if (signal.aborted) cancel();
    });
  }
}
