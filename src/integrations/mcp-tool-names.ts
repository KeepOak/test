import { createHash } from 'node:crypto';

// Adapted from NousResearch/hermes-agent a9a54245, tools/mcp_tool_schema.py.
// Copyright (c) 2025 Nous Research; MIT (see THIRD_PARTY_NOTICES.md).
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const identities = new Map<string, string>();
const callable = new Map<string, string>();

/** Permissions remain stable: saved grants, schedules and resumed tasks keep their exact reach. */
export const legacyMcpToolName = (server: string, tool: string): string =>
  `mcp.${server}.${digest(tool).slice(0, 16)}`;

/** Readable, provider-safe names; lossy sanitization also gets a suffix to avoid aliases. */
export function mcpToolName(server: string, tool: string): string {
  const component = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const natural = `mcp__${component(server)}__${component(tool)}`;
  const lossy = component(server) !== server || component(tool) !== tool;
  const suffix = `_${digest(JSON.stringify([server, tool])).slice(0, 16)}`;
  const name = natural.length > 64 || lossy ? natural.slice(0, 64 - suffix.length) + suffix : natural;
  const legacy = legacyMcpToolName(server, tool);
  const previous = identities.get(name);
  if (previous && previous !== legacy) throw new Error('MCP tool name collision');
  identities.set(name, legacy);
  callable.set(legacy, name);
  return name;
}

/**
 * Existing patterns match only the original identity, so readable words cannot
 * expand an old wildcard's scope. New rules opt in with the explicit mcp__ prefix.
 */
export function mcpPolicyName(pattern: string, name: string): string {
  if (pattern.startsWith('mcp__')) return callable.get(name) ?? name;
  return identities.get(name) ?? name;
}

/** Old stored tool calls remain callable, without listing a duplicate to the model. */
export const canonicalMcpToolName = (name: string): string => callable.get(name) ?? name;
