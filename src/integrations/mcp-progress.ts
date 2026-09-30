import type { ToolContext } from '../contracts.js';
import { mcpToolName } from './mcp.js';

/** A bounded observation, never a completion claim or permission to continue. */
export function mcpProgress(context: ToolContext, server: string, tool: string) {
  const permission = mcpToolName(server, tool);
  let previous = -1, count = 0;
  return (update: { progress: number; total?: number }) => {
    if (context.signal.aborted || !context.runId || !context.permissions.has(permission) || count >= 256
      || !Number.isFinite(update.progress) || update.progress <= previous || update.progress < 0
      || update.total !== undefined && (!Number.isFinite(update.total) || update.total < update.progress)) return;
    previous = update.progress; count++;
    // Server-authored messages are deliberately excluded from the durable record.
    context.reportMcpProgress?.(permission, update.progress, update.total);
  };
}
