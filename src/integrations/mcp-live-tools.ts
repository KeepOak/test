import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../contracts.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { mcpValidator } from './mcp-sdk.js';

type Caller = (name: string, args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;

/** A notification hides stale metadata immediately; only a fully checked list replaces it. */
export class McpLiveTools {
  private readonly listeners = new Set<(tools: readonly Tool[]) => void>();
  private readonly validators = new Map<string, (args: unknown) => { valid: boolean }>();
  private pending: Promise<void> | undefined;
  private revision = 0;
  private closed = false;
  private available = true;
  constructor(readonly found: Tool[], private readonly discover: () => Promise<Tool[]>,
    private readonly check: (tools: Tool[]) => Tool[], private readonly save: (tools: Tool[]) => void,
    private readonly through: Caller) {}

  subscribe(listener: (tools: readonly Tool[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private replace(tools: Tool[]): void {
    this.available = false;
    this.found.splice(0, this.found.length, ...tools);
    this.validators.clear();
    for (const listener of this.listeners) listener(this.found);
    this.save(tools);
    this.available = true;
  }

  /** Coalesce concurrent notifications; a server changing continuously stays unavailable. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.revision++;
    this.replace([]);
    if (this.pending) return this.pending;
    this.pending = this.readFresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async readFresh(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = this.revision;
      const tools = this.check(await this.discover());
      if (this.closed) return;
      if (revision !== this.revision) continue;
      this.replace(tools);
      return;
    }
    throw new Error('MCP tool list did not settle; wait for a fresh notification or reconnect');
  }

  async call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    context.signal.throwIfAborted();
    await this.pending;
    context.signal.throwIfAborted();
    const tool = this.found.find(tool => tool.name === name);
    if (this.closed || !this.available || !tool) throw new Error('Configured MCP tool is unavailable');
    const revision = this.revision;
    let validate = this.validators.get(name);
    if (!validate) {
      validate = new (await mcpValidator())().getValidator(tool.inputSchema as JsonSchemaType);
    }
    if (revision !== this.revision || this.closed || !this.available)
      throw new Error('MCP tool metadata changed before the call; retry with the current schema');
    this.validators.set(name, validate);
    if (!validate(args).valid) throw new Error('MCP arguments do not match the current tool schema');
    return this.through(name, args, context);
  }

  close(): void { this.closed = true; this.listeners.clear(); }
}
