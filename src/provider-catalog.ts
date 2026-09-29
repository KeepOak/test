import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ModelPrice } from "./pricing.js";
import { catalogWithLocalUpdates } from "./provider-catalog-updates.js";

/**
 * Every model service Branch knows how to talk to, kept as data in `data/providers.json` rather
 * than as code. A person can read that file, correct it, and hand it to someone else; adding a
 * service that speaks a shape Branch already knows needs no new code at all.
 */
export const providerShapes = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini",
  "azure-openai",
  "bedrock-converse",
  "cohere-chat-v2",
  "ollama",
  "perplexity-agent",
  "anthropic-vertex",
] as const;
export type ProviderShape = (typeof providerShapes)[number];

/** How a service wants to be shown a key. `none` is for services on this computer that want none. */
export const authStyles = ["bearer", "x-api-key", "api-key", "google-key", "query-key", "aws-sigv4", "none"] as const;
export type AuthStyle = (typeof authStyles)[number];

/** The things a service can do. Planning refuses to send work to a model that lacks what it needs. */
export const capabilities = ["chat", "vision", "tools", "json-mode", "streaming", "embeddings", "audio", "images", "realtime"] as const;
export type Capability = (typeof capabilities)[number];

const ExtraSchema = z.object({
  key: z.string().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  example: z.string().max(200).optional(),
  default: z.string().max(200).optional(),
  /** When set, the answer must be one of these, so a region choice cannot become any address at all. */
  choices: z.array(z.string().min(1).max(100)).max(12).optional(),
}).strict();
export type ProviderExtra = z.infer<typeof ExtraSchema>;

const PriceSchema = z.object({
  input: z.number().min(0).max(10000),
  output: z.number().min(0).max(10000),
  cached: z.number().min(0).max(10000).optional(),
}).strict();

/**
 * Under what terms Branch reaches a service: the route it uses, where the service's own terms are,
 * and whether the route is one the service offers for use like this. Shown as the Terms line on
 * each provider in Settings, so nobody signs in to something that could cost them their account
 * without being told first.
 */
export const routeStandings = ["official", "unofficial", "retired", "not-offered"] as const;
export type RouteStanding = (typeof routeStandings)[number];
const TermsSchema = z.object({
  route: z.string().min(1).max(200),
  url: z.string().regex(/^https:\/\//).max(2048),
  standing: z.enum(routeStandings),
  warning: z.string().min(1).max(400).optional(),
}).strict();
export type ProviderTerms = z.infer<typeof TermsSchema>;

export const CatalogEntrySchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/),
  name: z.string().min(1).max(100),
  shape: z.enum(providerShapes),
  kind: z.enum(["cloud", "local"]),
  /** The address, with `{name}` standing in for anything the person has to fill in. */
  baseUrl: z.string().min(1).max(2048).regex(/^https?:\/\//, "A service address starts with http:// or https://"),
  auth: z.enum(authStyles),
  /** Where the service lists its models, relative to the address, or null when it offers no list. */
  modelsPath: z.string().max(200).nullable(),
  capabilities: z.array(z.enum(capabilities)).max(9),
  defaultModel: z.string().min(1).max(256),
  recommendedModels: z.array(z.string().min(1).max(256)).max(20),
  /** Where the service publishes what it charges, so a person can check Branch's figures. */
  pricingUrl: z.string().max(2048),
  /** Prices Branch has on file for this service's models, in US dollars per million tokens. */
  prices: z.record(z.string().min(1).max(256), PriceSchema).optional(),
  extras: z.array(ExtraSchema).max(6).optional(),
  note: z.string().min(1).max(500),
  signUp: z.string().max(2048),
  terms: TermsSchema,
}).strict();
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSchema = z.object({
  version: z.literal(1),
  pricedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().min(1).max(1000),
  services: z.array(CatalogEntrySchema).min(25).max(200),
}).strict();
export type Catalog = z.infer<typeof CatalogSchema>;

/** Next to the built program first, then the repository's copy, exactly as the holiday list works. */
const bundled = [new URL("./providers.json", import.meta.url), new URL("../data/providers.json", import.meta.url)];

let loaded: Catalog | undefined;
/** The catalog, read once and checked against the schema. A damaged file fails loudly, not quietly. */
export function providerCatalog(): Catalog {
  if (loaded) return loaded;
  for (const source of bundled) {
    let text: string;
    try { text = readFileSync(source, "utf8"); } catch { continue; }
    return (loaded = catalogWithLocalUpdates(CatalogSchema.parse(JSON.parse(text) as unknown)));
  }
  throw new Error("The list of model services (providers.json) is missing from this installation");
}
/** Replaces the loaded catalog; tests use this to try a catalog that is not the shipped one. */
export function useCatalog(catalog: Catalog | undefined): void {
  loaded = catalog;
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return providerCatalog().services.find((entry) => entry.id === id);
}
export function catalogEntries(): CatalogEntry[] {
  return providerCatalog().services;
}
export function supportsCapability(entry: CatalogEntry, capability: Capability): boolean {
  return entry.capabilities.includes(capability);
}

/** What each thing a model can do is called in ordinary words, for anything a person reads. */
const plainWords: Record<Capability, string> = {
  chat: "hold a conversation",
  vision: "be shown a picture",
  tools: "use your tools",
  "json-mode": "reply in a fixed format",
  streaming: "reply as it goes",
  embeddings: "compare passages",
  audio: "handle speech",
  images: "make pictures",
  realtime: "hold a spoken conversation as it happens",
};
export function plainCapability(capability: Capability): string {
  return plainWords[capability];
}

/** The two plain sentences a person reads on a connection's card: what it can and cannot do. */
export function capabilitySentences(can: Record<Capability, boolean>): string[] {
  const yes = capabilities.filter((name) => can[name]).map(plainCapability);
  const no = capabilities.filter((name) => !can[name]).map(plainCapability);
  return [
    yes.length ? `It can ${yes.join(", ")}.` : "It is not known to do anything on this list.",
    ...(no.length ? [`It cannot ${no.join(", ")}.`] : []),
  ];
}

/** Which of the filled-in boxes a service still needs, in words a person can act on. */
export function missingExtras(entry: CatalogEntry, extras: Record<string, string>): string[] {
  return (entry.extras ?? [])
    .filter((extra) => extra.required && !(extras[extra.key] ?? extra.default ?? "").trim())
    .map((extra) => extra.label);
}

/** Every `{name}` the address needs filled in. */
export function placeholders(baseUrl: string): string[] {
  return [...baseUrl.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]!);
}

/**
 * The service's real address once the person's answers are put in. An unanswered `{name}` is an
 * error rather than a half-built address, so nothing ever reaches the network with a brace in it.
 */
export function resolveBaseUrl(entry: CatalogEntry, extras: Record<string, string> = {}): string {
  const answers: Record<string, string> = {};
  for (const extra of entry.extras ?? []) answers[extra.key] = (extras[extra.key] ?? extra.default ?? "").trim();
  // A "custom" style entry may replace the address outright rather than fill a gap in it.
  const template = answers.baseUrl && placeholders(entry.baseUrl).length === 0 ? answers.baseUrl : entry.baseUrl;
  const filled = template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_all, name: string) => {
    const value = answers[name];
    if (!value) throw new Error(`${entry.name} needs ${labelFor(entry, name)} before it can be reached`);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error(`${labelFor(entry, name)} may only contain letters, digits, dots, dashes and underscores`);
    const allowed = choicesFor(entry, name);
    if (allowed && !allowed.includes(value)) throw new Error(`${labelFor(entry, name)} must be one of: ${allowed.join(", ")}`);
    return value;
  });
  return filled.replace(/\/$/, "");
}
function choicesFor(entry: CatalogEntry, key: string): string[] | undefined {
  return (entry.extras ?? []).find((extra) => extra.key === key)?.choices;
}
/** True when the service has ended the route Branch used for it; such a line is kept only to explain why. */
export function isRetired(entry: CatalogEntry): boolean {
  return entry.terms.standing === "retired" || entry.terms.standing === "not-offered";
}
function labelFor(entry: CatalogEntry, key: string): string {
  return (entry.extras ?? []).find((extra) => extra.key === key)?.label ?? key;
}

/** The address a service lists its models at, or null when it does not offer one. */
export function modelsAddress(entry: CatalogEntry, baseUrl: string): string | null {
  return entry.modelsPath ? baseUrl.replace(/\/$/, "") + entry.modelsPath : null;
}

/** Prices the catalog carries, flattened into the one table pricing.ts looks things up in. */
export function catalogPrices(): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = {};
  for (const entry of catalogEntries())
    for (const [model, price] of Object.entries(entry.prices ?? {})) table[model] = price;
  return table;
}
