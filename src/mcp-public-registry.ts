import { z } from "zod";
import { ServerJsonSchema, publicServerJson } from './mcp-server-json.js';

export const RegistrySearchSchema = z.object({
  networkConfirmed: z.literal(true),
  search: z.string().trim().min(1).max(200),
  cursor: z.string().min(1).max(2000).optional(),
}).strict();
const EntrySchema = z.object({
  server: ServerJsonSchema,
  _meta: z.object({ "io.modelcontextprotocol.registry/official": z.object({ status: z.enum(["active", "deprecated", "deleted"]).optional() }).optional() }).optional(),
});
const PageSchema = z.object({ servers: z.array(z.unknown()).max(40),
  metadata: z.object({ nextCursor: z.string().max(2000).nullable().optional() }).optional() });

/**
 * Adapted from Cline's fetchMarketplaceCatalog/sanitiseEntry (Apache-2.0, Copyright 2026 Cline Bot Inc.):
 * https://github.com/cline/cline/blob/main/apps/vscode/src/core/controller/marketplace/marketplace-helpers.ts
 * Branch uses policy-checked fetch, a capped reply and the official registry's v0.1 response instead of Cline protobufs.
 * Registry API: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md
 */
export async function searchPublicRegistry(input: unknown, fetchImpl: typeof fetch) {
  const value = RegistrySearchSchema.parse(input);
  const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers");
  url.searchParams.set("search", value.search);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", "40");
  if (value.cursor) url.searchParams.set("cursor", value.cursor);
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The public MCP registry could not answer (HTTP ${response.status}).`);
  }
  const page = PageSchema.parse(await registryBody(response));
  const entries = page.servers.map(sanitizeEntry).filter((entry) => entry !== null);
  return { entries, nextCursor: page.metadata?.nextCursor || null, skipped: page.servers.length - entries.length,
    source: "https://registry.modelcontextprotocol.io", checkedAt: new Date().toISOString() };
}

function sanitizeEntry(raw: unknown) {
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const { _meta } = parsed.data;
  const server = publicServerJson(parsed.data.server);
  const status = _meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active";
  if (status === "deleted") return null;
  // Package identifiers describe what exists; browsing never constructs or starts a command.
  return { name: server.name, title: server.title ?? server.name, description: server.description,
    version: server.version, packages: server.packages, status, server };
}

async function registryBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The public MCP registry sent no results.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error("The public MCP registry sent more data than allowed.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}
