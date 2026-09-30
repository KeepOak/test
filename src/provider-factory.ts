import type { Provider } from "./contracts.js";
import type { NetworkPolicy } from "./network-policy.js";
import {
  type CatalogEntry, type Capability,
  catalogEntry, isRetired, missingExtras, plainCapability, resolveBaseUrl, supportsCapability,
} from "./provider-catalog.js";
import { AnthropicProvider, OpenAIProvider } from "./providers.js";
import { AzureOpenAIProvider } from "./providers/azure-openai.js";
import { BedrockProvider } from "./providers/bedrock.js";
import { CohereProvider } from "./providers/cohere.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { PerplexityAgentProvider } from "./providers/perplexity-agent.js";
import { AnthropicVertexProvider } from "./providers/anthropic-vertex.js";
import { RetiredProvider } from "./providers/retired.js";
import { connectionFetch, ownModelOrigin } from "./local-connection-policy.js";
import { ollamaAddress } from "./local-models.js";
import { onOwnNetwork } from "./network-policy.js";

/**
 * Turning one line of the catalog into a working connection. There is one adapter per wire shape,
 * not one per service, so a new service that speaks a shape Branch already knows is a few lines of
 * data and no code at all.
 */
export interface ConnectionInput {
  /** The catalog id, for example "azure-openai". */
  provider: string;
  /** The key, token or AWS secret the service wants. Local services may leave it empty. */
  key: string;
  /** The answers to whatever else the service asks for, such as a region or a deployment name. */
  extras?: Record<string, string>;
  model?: string;
  /** Every request made through this connection goes through the owner's network rules. */
  policy?: NetworkPolicy;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface BuiltConnection {
  entry: CatalogEntry;
  provider: Provider;
  model: string;
  baseUrl: string;
}

/** The one place a key is turned into a live connection, so every shape is set up the same way. */
export function buildConnection(input: ConnectionInput): BuiltConnection {
  const entry = catalogEntry(input.provider);
  if (!entry) throw new Error(`Branch does not know a model service called "${input.provider}"`);
  // A route the service has ended still builds, so a saved connection shows why instead of vanishing.
  if (isRetired(entry)) return retiredConnection(entry, input.model);
  const extras = input.extras ?? {};
  const missing = missingExtras(entry, extras);
  if (missing.length) throw new Error(`${entry.name} still needs: ${missing.join(", ")}`);
  if (entry.auth !== "none" && !input.key.trim())
    throw new Error(`${entry.name} needs a key before it can be used`);
  const baseUrl = entry.shape === "ollama" ? ollamaBase(entry, extras) : resolveBaseUrl(entry, extras);
  assertAddressAllowed(baseUrl);
  const model = (input.model ?? entry.defaultModel).trim();
  if (!model) throw new Error(`${entry.name} needs the name of a model`);
  // A model server the owner points at may be reached on its own address only; see local-connection-policy.ts.
  const call = input.policy
    ? connectionFetch(input.policy, entry, baseUrl, input.fetchImpl ?? globalThis.fetch) : input.fetchImpl;
  return { entry, model, baseUrl, provider: adapterFor(entry, baseUrl, model, input.key, extras, call, input.now) };
}

/**
 * Where a native Ollama connection talks: the address the connection was given, else BRANCH_OLLAMA_URL (on this
 * computer only; src/local-models.ts), else the catalog's usual one (127.0.0.1:11434). The
 * address must be this computer or the owner's own network, as for any model server the owner points at
 * (src/local-connection-policy.ts); "/v1" is Branch's to add.
 */
export function ollamaBase(entry: CatalogEntry, extras: Record<string, string>): string {
  const given = (extras.baseUrl ?? "").trim();
  const moved = process.env.BRANCH_OLLAMA_URL;
  const root = (given || (moved ? ollamaAddress(moved) : entry.baseUrl)).replace(/\/+$/, "").replace(/\/v1$/i, "");
  let url: URL;
  try { url = new URL(root); } catch { throw new Error(`${given} is not an address`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama's address must start with http:// or https://");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("Ollama's address is only its computer and port, such as http://192.168.1.20:11434");
  if (!ownModelOrigin(entry, url.origin))
    throw new Error(`${url.host} is not this computer or an address on your own network, so Branch does not use it for Ollama`);
  return `${url.origin}/v1`;
}

function retiredConnection(entry: CatalogEntry, model: string | undefined): BuiltConnection {
  const why = entry.terms.warning ?? `${entry.name} can no longer be used.`;
  return { entry, model: (model ?? entry.defaultModel).trim() || entry.defaultModel, baseUrl: entry.baseUrl,
    provider: new RetiredProvider(entry.id, why) };
}

/** The same rule every provider address follows: HTTPS, or plain HTTP only on this computer or the owner's own network. */
export function assertAddressAllowed(address: string): URL {
  const url = new URL(address);
  const nearby = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || onOwnNetwork(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && nearby))
    throw new Error("A model service address must start with https://, or with http:// only on this computer or your own network");
  if (url.username || url.password || url.hash)
    throw new Error("A model service address must not carry a password or a #fragment");
  return url;
}

function adapterFor(
  entry: CatalogEntry, baseUrl: string, model: string, key: string,
  extras: Record<string, string>, fetchImpl: typeof globalThis.fetch | undefined, now?: () => Date,
): Provider {
  switch (entry.shape) {
    case "openai-chat":
      return new OpenAIProvider({ endpoint: baseUrl, model, apiKey: key || "local", ...(fetchImpl ? { fetchImpl } : {}) });
    case "openai-responses":
      return new OpenAIResponsesProvider({ endpoint: baseUrl, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "anthropic-messages":
      return new AnthropicProvider({ endpoint: baseUrl, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "gemini":
      return new GeminiProvider({
        endpoint: baseUrl, model, apiKey: key,
        ...(entry.auth === "bearer" ? { bearer: true } : {}), ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "azure-openai":
      return new AzureOpenAIProvider({
        endpoint: baseUrl, model, apiKey: key,
        apiVersion: extras.apiVersion?.trim() || defaultExtra(entry, "apiVersion") || "2024-10-01-preview",
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "bedrock-converse":
      return new BedrockProvider({
        endpoint: baseUrl, model, region: extras.region!.trim(), accessKeyId: extras.accessKeyId!.trim(),
        secretAccessKey: key, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}),
      });
    case "cohere-chat-v2":
      return new CohereProvider({ endpoint: baseUrl, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "perplexity-agent":
      return new PerplexityAgentProvider({ endpoint: baseUrl, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "anthropic-vertex":
      return new AnthropicVertexProvider({ endpoint: baseUrl, model, token: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "ollama":
      return new OllamaProvider({ endpoint: baseUrl, model, ...(fetchImpl ? { fetchImpl } : {}) });
  }
}
function defaultExtra(entry: CatalogEntry, key: string): string | undefined {
  return (entry.extras ?? []).find((extra) => extra.key === key)?.default;
}

/**
 * Why a connection cannot do a piece of work, and which other one could, in words a person can act
 * on. Returns null when the connection is fine for the job.
 */
export function capabilityRefusal(
  providerId: string, needed: Capability, others: { id: string; providerId: string; name: string }[],
): string | null {
  const entry = catalogEntry(providerId);
  if (!entry || supportsCapability(entry, needed)) return null;
  const able = others.filter((other) => {
    const candidate = catalogEntry(other.providerId);
    return candidate ? supportsCapability(candidate, needed) : false;
  });
  const plain = plainCapability(needed);
  if (!able.length) return `${entry.name} cannot ${plain}, and no other connection you have set up can either.`;
  return `${entry.name} cannot ${plain}. ${able.map((other) => other.name).join(" or ")} can, so use one of those instead.`;
}
export { plainCapability } from "./provider-catalog.js";

/**
 * For Settings → Test this connection, which builds its provider by header style alone: the
 * services whose route that guess would get wrong. Returns null for everything the guess handles.
 * A retired or not-offered service answers with its plain note instead of reaching the network.
 */
export function testRouteFor(presetId: string, endpoint: string, model: string, key: string, fetchImpl?: typeof fetch): Provider | null {
  const entry = catalogEntry(presetId);
  if (!entry) return null;
  if (isRetired(entry)) return new RetiredProvider(entry.id, entry.terms.warning ?? `${entry.name} can no longer be used.`);
  if (entry.shape === "perplexity-agent") return new PerplexityAgentProvider({ endpoint, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
  return null;
}
