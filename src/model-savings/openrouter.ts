import { z } from "zod";
import type { Store } from "../store.js";
import { readSavings } from "./settings.js";

/**
 * R17-046: OpenRouter lets a request say which companies should serve a model, and in what order
 * (its documented `provider` object). Branch reaches OpenRouter through the ordinary OpenAI-shaped
 * connection, so the preference travels on the request and the connection itself only sends it
 * when its address really is openrouter.ai; no other service ever sees it.
 */
export interface OpenRouterRouting {
  sort?: "price" | "throughput" | "latency";
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  data_collection?: "deny";
  require_parameters?: boolean;
  max_price?: { prompt: number; completion: number; request?: number };
}

/** True only for OpenRouter's own address (or a subdomain of it). */
export function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch { return false; }
}

/** The `provider` object to send, or null when the card is off or says nothing beyond the defaults. */
export function openRouterRouting(store: Pick<Store, "get">, owner: string): OpenRouterRouting | null {
  const saved = readSavings(store, owner, "openrouter");
  if (saved.mode !== "on") return null;
  const routing: OpenRouterRouting = {
    ...(saved.sort ? { sort: saved.sort } : {}),
    ...(saved.order.length ? { order: saved.order } : {}),
    ...(saved.only.length ? { only: saved.only } : {}),
    ...(saved.ignore.length ? { ignore: saved.ignore } : {}),
    ...(saved.allowFallbacks ? {} : { allow_fallbacks: false }),
    ...(saved.dataCollection === "deny" ? { data_collection: "deny" as const } : {}),
  };
  return Object.keys(routing).length ? routing : null;
}

/** OpenRouter company preferences, plus the free router's required capabilities and zero-price ceiling. */
export function openRouterBodyPart(endpoint: string, routing: OpenRouterRouting | undefined, model?: string): { provider?: OpenRouterRouting } {
  if (!isOpenRouterEndpoint(endpoint)) return {};
  // The free router filters for tools itself; also require every requested parameter and zero-priced endpoints.
  // https://openrouter.ai/docs/guides/routing/routers/free-router
  // https://openrouter.ai/docs/guides/routing/provider-selection
  if (model === "openrouter/free") return { provider: { ...routing, require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0 } } };
  return routing ? { provider: routing } : {};
}

/** A company OpenRouter can send a request to: its slug (what `only` names) and its name. */
export interface OpenRouterCompany { slug: string; name: string }
const CompaniesSchema = z.object({ data: z.array(z.object({ slug: z.string(), name: z.string() }).passthrough()) });
const companySlug = /^[a-z0-9][a-z0-9._/-]{0,79}$/i;
const keptCompanies = new Map<string, { at: number; companies: OpenRouterCompany[] }>();
const keepCompaniesFor = 24 * 60 * 60_000;

/** The address of the first OpenRouter connection in the model picker, or null when there is none. */
export function openRouterAddress(presets: Iterable<{ provider: object }>): string | null {
  for (const preset of presets) {
    try {
      const sharing = preset.provider as { audio?: () => { endpoint: string } | null; embeddings?: () => { endpoint: string } | null };
      const endpoint = sharing.audio?.()?.endpoint ?? sharing.embeddings?.()?.endpoint;
      if (endpoint && isOpenRouterEndpoint(endpoint)) return endpoint;
    } catch { continue; } // a connection Branch did not write may throw from its accessors: not OpenRouter
  }
  return null;
}

/**
 * Settings › Models › OpenRouter picks › Only ones I list: the companies to choose from, as OpenRouter lists them
 * (its documented `GET /api/v1/providers`, which needs no key, so none is sent). Asked only when the owner opens the
 * list, only of OpenRouter's own address, and kept for a day; a company whose slug is not plain is left out.
 */
export async function openRouterCompanies(endpoint: string, fetchImpl: typeof fetch = globalThis.fetch, now = Date.now()): Promise<OpenRouterCompany[]> {
  if (!isOpenRouterEndpoint(endpoint)) throw new Error("That is not OpenRouter's address, so Branch did not ask it.");
  const url = new URL("/api/v1/providers", endpoint).toString(), kept = keptCompanies.get(url);
  if (kept && now - kept.at < keepCompaniesFor) return kept.companies;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenRouter did not list its companies (it answered ${response.status}).`);
  const parsed = CompaniesSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("OpenRouter's list of companies was not in the shape it documents.");
  const companies = parsed.data.data.filter((c) => companySlug.test(c.slug) && c.name.trim())
    .map((c) => ({ slug: c.slug, name: c.name.trim().slice(0, 80) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400);
  keptCompanies.set(url, { at: now, companies });
  return companies;
}
