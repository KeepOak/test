import { z } from "zod";
import { audit } from "./audit.js";
import type { Provider } from "./contracts.js";
import { runtimeInfo, runtimeIds, type RuntimeId } from "./local-launch.js";
import { localRuntimeFetch } from "./local-policy.js";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import { OpenAIProvider } from "./providers.js";
import { OllamaProvider } from "./providers/ollama.js";
import type { Store } from "./store.js";

/**
 * Wave mac5 (local models): a model that finished its one click becomes a connection by itself,
 * named so the owner can see it "runs on this computer".
 *
 * These are written down in their own settings row, not beside the connections added from the
 * catalog, because those are rebuilt at start with the ordinary network rules — which refuse every
 * address on this computer. A local connection is rebuilt here with `localRuntimeFetch`, which
 * applies the owner's allowed and blocked lists to it and nothing that would stop it outright.
 */
const RecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i).max(64),
  name: z.string().min(1).max(80),
  runtime: z.enum(runtimeIds as [RuntimeId, ...RuntimeId[]]),
  model: z.string().min(1).max(400),
  contextLength: z.number().int().min(0).max(1_048_576).nullable(),
}).strict();
export type LocalConnection = z.infer<typeof RecordSchema>;
const RowSchema = z.object({ connections: z.array(RecordSchema).max(16).default([]) }).strict();
export const localConnectionsSetting = "local-model-connections";

export interface LocalConnectionDeps {
  models: ModelRouter;
  store: Store;
  owner: string;
  policy: Pick<NetworkPolicy, "settings"> | null;
  fetch?: typeof globalThis.fetch;
  /**
   * Where a runtime answers now (`RuntimeLauncher.baseUrl`). Integration review: llama.cpp and MLX
   * get a fresh port each start, so without this their connections send nothing at all.
   */
  endpoint?: (runtime: RuntimeId) => string | null;
}

export function savedLocalConnections(store: Store, owner: string): LocalConnection[] {
  const row = RowSchema.safeParse(store.get("settings", owner, localConnectionsSetting)?.data ?? {});
  return row.success ? row.data.connections : [];
}

/** `local-ollama-qwen3-8b`: short, readable and valid as a connection name. */
export function localConnectionId(runtime: RuntimeId, model: string): string {
  const tail = model.toLowerCase().split("/").pop()!.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `local-${runtime}-${tail}`.slice(0, 64).replace(/-+$/, "");
}

function providerFor(record: LocalConnection, deps: LocalConnectionDeps): Provider {
  const fixed = record.runtime === "ollama" || record.runtime === "lm-studio";
  const where = (): string | null => (fixed ? runtimeInfo[record.runtime].baseUrl : deps.endpoint?.(record.runtime) ?? null);
  const call = deps.models.health.watch(record.id, localRuntimeFetch(deps.policy, deps.fetch ?? globalThis.fetch, where));
  const endpoint = `${where() ?? runtimeInfo[record.runtime].baseUrl}/v1`;
  if (record.runtime === "ollama") return new OllamaProvider({ endpoint, model: record.model, fetchImpl: call });
  return new OpenAIProvider({ endpoint, model: record.model, apiKey: "local", fetchImpl: call });
}
const catalogIds: Record<RuntimeId, string | undefined> = { ollama: "ollama", "lm-studio": "lm-studio", "llama-cpp": "llama-cpp", mlx: undefined };

function install(record: LocalConnection, deps: LocalConnectionDeps): void {
  const catalogId = catalogIds[record.runtime];
  deps.models.register({ id: record.id, name: record.name, provider: providerFor(record, deps), model: record.model, ...(catalogId ? { catalogId } : {}) });
}

/** One very small question, so a connection that cannot answer is never left behind. */
export async function smokeTest(provider: Provider, timeoutMs = 120000): Promise<void> {
  const reply = await provider.complete({
    messages: [{ role: "user", content: "Reply with the single word OK." }], tools: [], maxTokens: 16, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!reply || typeof reply !== "object") throw new Error("The model on this computer did not answer");
}

/**
 * Adds (or replaces) the connection for this model, after it has answered a small question, and
 * writes it down. Returns its id.
 */
export async function registerLocalConnection(deps: LocalConnectionDeps, input: Omit<LocalConnection, "id" | "name"> & { label: string }, test = smokeTest): Promise<LocalConnection> {
  const id = localConnectionId(input.runtime, input.model);
  const record = RecordSchema.parse({
    id, name: `${input.label} (runs on this computer)`.slice(0, 80), runtime: input.runtime, model: input.model, contextLength: input.contextLength,
  });
  await test(providerFor(record, deps));
  install(record, deps);
  const kept = savedLocalConnections(deps.store, deps.owner).filter((saved) => saved.id !== id);
  deps.store.save("settings", deps.owner, localConnectionsSetting, { connections: [...kept, record].slice(-16) });
  audit(deps.store, deps.owner, { action: "connection.changed", actor: deps.owner, subject: `${record.name} (${id})`,
    reason: "A model on this computer was set up with one click", outcome: "added" });
  return record;
}

/** Takes a local connection away: out of the model list and out of the written-down row. */
export function forgetLocalConnection(deps: LocalConnectionDeps, id: string): { removed: boolean } {
  const saved = savedLocalConnections(deps.store, deps.owner);
  const kept = saved.filter((record) => record.id !== id);
  if (kept.length === saved.length) return { removed: false };
  deps.store.save("settings", deps.owner, localConnectionsSetting, { connections: kept });
  deps.models.remove(id);
  audit(deps.store, deps.owner, { action: "connection.changed", actor: deps.owner, subject: id,
    reason: "A model on this computer was removed", outcome: "removed" });
  return { removed: true };
}

/** Builds every written-down local connection again when Branch starts. Nothing is contacted. */
export function restoreLocalConnections(deps: LocalConnectionDeps): string[] {
  const back: string[] = [];
  for (const record of savedLocalConnections(deps.store, deps.owner)) {
    try { install(record, deps); back.push(record.id); } catch { /* one bad row never stops the others */ }
  }
  return back;
}
