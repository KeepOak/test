import type { ModelPreset } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import { catalogEntry } from "./provider-catalog.js";
import { connectionCheck, connectionFetch } from "./local-connection-policy.js";
import { modelsUrl } from "./provider-probe.js";

/**
 * Dogfood follow-up (context limits): a model's context window read from what its service publishes about it, so the
 * room is known before the first request rather than learned from a refusal. The model list is the same free request
 * Settings › Models makes to check a key (src/provider-probe.ts), through the same network rules.
 *
 * Services name the figure differently: OpenRouter `context_length` (and `top_provider.context_length`), LM Studio and
 * vLLM `max_context_length` / `max_model_len`, Gemini `inputTokenLimit`, others `context_window`, `max_input_tokens`
 * or `input_token_limit`. A service that publishes none (OpenAI's list, the ChatGPT sign-in) gives back null, and the
 * room is then learned from a refusal as before.
 */
const fields = ["context_length", "context_window", "max_context_length", "max_model_len", "max_input_tokens",
  "input_token_limit", "inputTokenLimit"] as const;
/** Figures below this or above this are not a context window, whatever the field is called. */
const plausible = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 1024 && value <= 20_000_000;

const bare = (id: string): string => id.replace(/^models\//, "").toLowerCase();

/** The context window one model list says a model has, or null. */
export function publishedWindow(body: unknown, model: string): number | null {
  const shape = body as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(shape?.data) ? shape.data : Array.isArray(shape?.models) ? shape.models : [];
  const wanted = bare(model);
  const entry = (list as Record<string, unknown>[]).find((one) => one && typeof one === "object"
    && [one.id, one.name, one.model, one.key].some((name) => typeof name === "string" && bare(name) === wanted));
  if (!entry) return null;
  for (const field of fields) if (plausible(entry[field])) return Math.floor(entry[field] as number);
  const top = entry.top_provider as Record<string, unknown> | undefined;
  return top && plausible(top.context_length) ? Math.floor(top.context_length) : null;
}

/** Asks a connection's model list for its model's context window. Never throws: anything that fails is null. */
export async function readModelWindow(preset: ModelPreset, policy: NetworkPolicy, fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 3000): Promise<number | null> {
  try {
    const target = modelsUrl(preset.provider);
    if (!target) return null;
    const entry = preset.catalogId ? catalogEntry(preset.catalogId) : undefined;
    await connectionCheck(policy, entry, target.url)(new URL(target.url), "reading the model's context size");
    // Through the same guarded transport the connection's own requests use, so the address checked is the one reached.
    const guarded = entry ? connectionFetch(policy, entry, target.url, fetchImpl) : policy.guard(fetchImpl);
    const response = await guarded(target.url, { headers: target.headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return publishedWindow(await response.json(), preset.model);
  } catch {
    return null;
  }
}
