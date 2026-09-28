/**
 * "Try a server": the owner points Branch at somebody else's MCP server — a program on this
 * computer, or a web address — and sees what it offers before deciding to keep it. The tool list
 * comes back with the shape of each form to fill in, one tool can be run by hand, and the raw
 * answer is shown exactly as it arrived. Every call made from here is written into the record of
 * what the assistant was allowed to do.
 *
 * Nothing here registers anything permanently: the connection is opened for the try and closed
 * again. A server the owner decides to keep is added to the connections file as before.
 */
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpClient } from "./integrations/mcp-sdk.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";
import { makeTransport, McpTransportSchema, type McpTransportConfig } from "./integrations/mcp-config.js";

export const TrySchema = z.object({
  server: McpTransportSchema,
  /** Leave out to only list what the server offers. */
  call: z.object({
    name: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }).strict().optional(),
}).strict();

export interface WorkbenchTool {
  name: string;
  description: string;
  /** The shape of the form the screen draws, exactly as the server describes it. */
  schema: Record<string, unknown>;
}
export interface WorkbenchResult {
  server: string;
  serverName: string;
  serverVersion: string;
  tools: WorkbenchTool[];
  /** The raw answer, when a tool was called. */
  called: { name: string; milliseconds: number; result: unknown } | null;
}

const label = (config: McpTransportConfig): string =>
  config.transport === "stdio" ? `${config.command} ${config.args.join(" ")}`.trim().slice(0, 200) : config.url;

/** How long the whole try may take before Branch stops waiting. */
const timeout = 20000;

/**
 * Opens the server, lists what it offers, optionally runs one of its tools, and closes again.
 * Only the tool names and the raw answer come back; nothing is registered and nothing is kept.
 */
export async function tryServer(
  store: Store, owner: string, input: unknown, env: NodeJS.ProcessEnv = process.env, policy?: NetworkPolicy,
): Promise<WorkbenchResult> {
  const parsed = TrySchema.parse(input);
  const where = label(parsed.server);
  const { transport, secrets } = await makeTransport(parsed.server, env, policy);
  const client = new (await mcpClient())({ name: "branch-workbench", version: "1.0.0" });
  try {
    // SDK 1.x transport declarations disagree on optional sessionId under exact optional types.
    await client.connect(transport as Transport, { timeout });
    const listed = await client.listTools({}, { timeout });
    const tools = listed.tools.slice(0, 200).map((tool) => ({
      name: tool.name, description: (tool.description ?? tool.name).slice(0, 2000),
      schema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
    const info = client.getServerVersion();
    const called = parsed.call ? await callOne(client, store, owner, where, parsed.call, secrets) : null;
    if (!parsed.call) record(store, owner, where, "listed", `${tools.length} tools offered`);
    return {
      server: where, serverName: info?.name ?? "unknown", serverVersion: info?.version ?? "unknown", tools, called,
    };
  } catch (error) {
    const reason = scrub(error instanceof Error ? error.message : "no answer", secrets);
    record(store, owner, where, "failed", reason);
    throw new Error(`Branch could not use that server: ${reason}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callOne(
  client: Client, store: Store, owner: string, where: string,
  call: { name: string; arguments: Record<string, unknown> }, secrets: string[],
): Promise<{ name: string; milliseconds: number; result: unknown }> {
  const started = Date.now();
  try {
    const result = await client.callTool({ name: call.name, arguments: call.arguments }, undefined, { timeout });
    record(store, owner, where, "ran", `${call.name} answered`);
    return { name: call.name, milliseconds: Date.now() - started, result: scrubDeep(result, secrets) };
  } catch (error) {
    record(store, owner, where, "failed", `${call.name}: ${scrub(error instanceof Error ? error.message : "", secrets)}`);
    throw error;
  }
}

const scrub = (text: string, secrets: string[]): string =>
  secrets.reduce((value, secret) => value.split(secret).join("[credential redacted]"), text).slice(0, 300);

/** A configured key must never come back out in an answer the screen shows. */
function scrubDeep(value: unknown, secrets: string[]): unknown {
  if (!secrets.length) return value;
  const text = JSON.stringify(value);
  if (!secrets.some((secret) => text.includes(secret))) return value;
  return { hidden: "That server's answer contained one of your saved keys, so it is not shown." };
}

/** Every try is a moment worth keeping: who ran what, against which server, and how it ended. */
function record(store: Store, owner: string, where: string, outcome: string, detail: string): void {
  audit(store, owner, {
    action: "mcp.tried", actor: owner, subject: `${where} — ${detail}`.slice(0, 300),
    reason: "You tried a server from Settings → Connections", source: "owner", outcome,
  });
}
