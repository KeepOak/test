import { createMcpHandler, Server, ProtocolError, type McpHttpHandler } from '@modelcontextprotocol/server';
import { CallToolResultSchema, ListToolsResultSchema, ListResourcesResultSchema,
  ReadResourceResultSchema, ListPromptsResultSchema, GetPromptResultSchema } from '@modelcontextprotocol/core';
import type { McpServer } from './mcp-server.js';
import { observeMcpRun } from './mcp-run-observer.js';
import { protocolKey, statelessVersion, StatelessError } from './mcp-stateless.js';

/** Official SDK owns negotiation, request envelopes, MRTR and subscription transport. */
export function modernServer(branch: McpServer, principal: string, stdio = false): Server {
  const server = new Server({ name: 'branch', version: '1.0.0' }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
  });
  if (stdio) {
    const stop = branch.watchModern((notice) => {
      try { branch.requireModern(); } catch { return; }
      if (notice.method === 'notifications/tools/list_changed') void server.sendToolListChanged().catch(() => undefined);
      if (notice.method === 'notifications/resources/updated' && typeof notice.params.uri === 'string')
        void server.sendResourceUpdated({ uri: notice.params.uri }).catch(() => undefined);
    });
    server.onclose = stop;
  }
  server.setRequestHandler('tools/list', async () => {
    branch.requireModern();
    return ListToolsResultSchema.parse({ tools: branch.listTools(), ttlMs: 0, cacheScope: 'private' });
  });
  server.setRequestHandler('tools/call', async (request, ctx) => {
    branch.requireModern();
    const stamp = branch.modernAccessStamp(), changed = new AbortController();
    const allowed = () => {
      try { branch.requireModern(); return branch.modernAccessStamp() === stamp; } catch { return false; }
    };
    const timer = setInterval(() => { if (!allowed()) changed.abort(new Error('MCP access changed')); }, 250);
    timer.unref();
    const signal = AbortSignal.any([ctx.mcpReq.signal, changed.signal, AbortSignal.timeout(120000)]);
    const observer = observeMcpRun(branch.store, {
      signal, _meta: ctx.mcpReq._meta,
      notify: (notice) => ctx.mcpReq.notify(notice),
      log: (level, data, logger) => ctx.mcpReq.log(level, data, logger),
    }, allowed);
    try {
      const result = await branch.callModernTool(request.params, principal, signal,
        ctx.mcpReq.requestState(), observer);
      if ('requestState' in result) return result;
      return CallToolResultSchema.parse(result);
    } catch (error) {
      if (error instanceof StatelessError) throw new ProtocolError(error.code, error.message, error.data);
      throw error;
    } finally { clearInterval(timer); changed.abort(new Error('MCP request ended')); }
  });
  const read = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await branch.handleStateless({ jsonrpc: '2.0', id: 'sdk-read', method,
      params: { ...params, _meta: { [protocolKey]: statelessVersion } } });
    if (response.error) throw new ProtocolError(response.error.code, response.error.message);
    return response.result;
  };
  server.setRequestHandler('resources/list', async () => ListResourcesResultSchema.parse(await read('resources/list')));
  server.setRequestHandler('resources/read', async (r) => ReadResourceResultSchema.parse(await read('resources/read', r.params)));
  server.setRequestHandler('prompts/list', async () => ListPromptsResultSchema.parse(await read('prompts/list')));
  server.setRequestHandler('prompts/get', async (r) => GetPromptResultSchema.parse(await read('prompts/get', r.params)));
  return server;
}

export function modernHandler(branch: McpServer): McpHttpHandler {
  return createMcpHandler(({ requestInfo }) => {
    branch.requireModern();
    return modernServer(branch, branch.modernPrincipal(requestInfo?.headers.get('authorization') ?? 'stdio'));
  }, { legacy: 'reject', maxRequestBodySize: 65536, maxSubscriptions: 32 });
}
