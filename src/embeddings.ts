import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { estimateTokens } from "./contracts.js";
import { EmbeddingClient, defaultEmbeddingModel, packVector, unpackVector, type Embedder } from "./document-embeddings.js";
import { OllamaClient, defaultLocalEmbeddingModel, ollamaHome } from "./local-models.js";
import { presetRunsLocally, type ModelRouter } from "./models.js";
import { assertProviderEndpoint, providerEmbeddings } from "./providers.js";
import { parseRetryPolicy, planRetry, waitForRetry, type RetryPolicy } from "./provider-retry.js";

/**
 * Turning passages into the lists of numbers that let two pieces of writing be compared by what
 * they mean rather than the words they use. Nothing new is connected here: whichever model the
 * owner already chose does the reading, through whichever shape it speaks. Every answer is kept
 * on this computer under a fingerprint of the passage, so reading the same library again costs
 * nothing, and a model that runs on this computer never sends a word anywhere.
 */
export interface Embeddings extends Embedder {
  readonly model: string;
  /** How long each list of numbers is; 0 until the first answer comes back and says. */
  readonly dimensions: number;
  /** True when the reading happens on this computer, so no passage leaves it. */
  readonly local: boolean;
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
}
/** The three shapes a connected provider speaks when asked to read passages. */
export type EmbeddingShape = "openai" | "gemini" | "ollama";
export interface EmbeddingConnection {
  shape: EmbeddingShape; endpoint: string; apiKey: string; model: string; local: boolean; fetchImpl?: typeof fetch;
}
/** Gemini's own default reader, used when the owner has not named one of their own. */
export const defaultGeminiEmbeddingModel = "text-embedding-004";
const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const geminiSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()).min(1).max(8192) })).min(1),
});

/** Whether an address is on this computer, which is what makes a reader a local one. */
export function onThisComputer(endpoint: string): boolean {
  try { return loopback.has(new URL(endpoint).hostname.toLowerCase()); } catch { return false; }
}

/**
 * Which connection would read passages, and how it has to be asked. The owner's model plan decides:
 * a model on this computer is preferred exactly as it already is for answering, and nothing else is
 * contacted. Null means no connected model can read passages at all.
 */
export function embeddingConnection(
  models: ModelRouter | undefined, owner: string, model: string = defaultEmbeddingModel,
): EmbeddingConnection | null {
  const preset = models?.plan(owner, "").candidates[0];
  const provider = preset?.provider;
  if (!preset || !provider) return null;
  const route = providerEmbeddings(provider);
  if (route) {
    // A declared remote forward stays remote even when its transport listens on loopback.
    const local = onThisComputer(route.endpoint) && presetRunsLocally(preset);
    const ollama = local && new URL(route.endpoint).port === new URL(ollamaHome).port;
    const chosen = ollama && model === defaultEmbeddingModel ? defaultLocalEmbeddingModel : model;
    return { shape: ollama ? "ollama" : "openai", endpoint: route.endpoint, apiKey: route.apiKey, model: chosen, local,
      ...(route.fetchImpl ? { fetchImpl: route.fetchImpl } : {}) };
  }
  const pictures = (provider as { images?: () => { kind: string; endpoint: string; apiKey: string } }).images?.();
  if (pictures?.kind !== "gemini") return null;
  const chosen = model === defaultEmbeddingModel ? defaultGeminiEmbeddingModel : model;
  return { shape: "gemini", endpoint: pictures.endpoint, apiKey: pictures.apiKey, model: chosen, local: onThisComputer(pictures.endpoint) };
}

/** The provider's own `/embeddings` route, which every OpenAI-shaped connection offers. */
class OpenAIEmbeddings implements Embeddings {
  private size = 0;
  private readonly client: EmbeddingClient;
  constructor(connection: EmbeddingConnection, readonly local: boolean, call: typeof fetch = globalThis.fetch) {
    this.client = new EmbeddingClient(connection.endpoint, connection.apiKey, connection.model, call);
  }
  get model(): string { return this.client.model; }
  get dimensions(): number { return this.size; }
  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const vectors = await this.client.embed(texts, signal);
    this.size = vectors[0]?.length ?? this.size;
    return vectors;
  }
}

/** Gemini reads passages through `batchEmbedContents`, the batched form of `embedContent`. */
class GeminiEmbeddings implements Embeddings {
  private size = 0;
  readonly model: string;
  private readonly endpoint: string;
  private readonly key: string;
  constructor(connection: EmbeddingConnection, readonly local: boolean, private readonly call: typeof fetch = globalThis.fetch) {
    assertProviderEndpoint(connection.endpoint);
    if (!connection.apiKey) throw new Error("A Gemini key is required to compare passages by meaning");
    this.endpoint = connection.endpoint.replace(/\/$/, "");
    this.model = connection.model;
    this.key = connection.apiKey;
  }
  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += 64)
      vectors.push(...(await this.batch(texts.slice(start, start + 64), signal)));
    this.size = vectors[0]?.length ?? this.size;
    return vectors;
  }
  get dimensions(): number { return this.size; }
  private async batch(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const url = new URL(`${this.endpoint}/models/${this.model}:batchEmbedContents`);
    url.searchParams.set("key", this.key);
    const response = await this.call(url.toString(), {
      method: "POST", redirect: "error", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${this.model}`, content: { parts: [{ text }] } })) }),
    });
    if (!response.ok) throw new Error(`Gemini refused to read these passages (${response.status})`);
    const parsed = geminiSchema.parse(JSON.parse(await response.text()) as unknown);
    if (parsed.embeddings.length !== texts.length) throw new Error("Gemini returned the wrong number of passages");
    return parsed.embeddings.map((entry) => Float32Array.from(entry.values));
  }
}

/** A model on this computer, through Ollama's own route; nothing leaves the machine. */
class OllamaEmbeddings implements Embeddings {
  private size = 0;
  readonly local = true;
  private readonly client: OllamaClient;
  constructor(connection: EmbeddingConnection, readonly model: string, call: typeof fetch = globalThis.fetch) {
    this.client = new OllamaClient(new URL(connection.endpoint).origin, call);
  }
  get dimensions(): number { return this.size; }
  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const vectors = await this.client.embed(texts, this.model, signal);
    this.size = vectors[0]?.length ?? this.size;
    return vectors;
  }
}

/**
 * Which fetch an embedding call is made with. Everything that leaves this computer goes through the
 * owner's network rules, exactly as every other call to a provider does: `call` is the app's
 * guarded fetch. A reader running on this computer is reached with the plain one, because those
 * rules refuse private and local addresses on purpose and a model on this machine is the single
 * case where that would be the wrong answer; its floor is the loopback-or-HTTPS check in
 * `assertProviderEndpoint`, which every one of these adapters already makes.
 */
export const embeddingFetch = (endpoint: string, call: typeof fetch): typeof fetch =>
  onThisComputer(endpoint) ? globalThis.fetch : call;

/**
 * The right adapter for a connection, or nothing when the address or key will not do. `call` is the
 * app's guarded fetch; pass it and every passage sent off this computer is checked against the
 * owner's network rules first.
 */
export function embeddingsFor(connection: EmbeddingConnection, call: typeof fetch = globalThis.fetch): Embeddings | null {
  const reach = connection.fetchImpl ?? embeddingFetch(connection.endpoint, call);
  try {
    if (connection.shape === "gemini") return new GeminiEmbeddings(connection, connection.local, reach);
    if (connection.shape === "ollama") return new OllamaEmbeddings(connection, connection.model, reach);
    return new OpenAIEmbeddings(connection, connection.local, reach);
  } catch { return null; }
}
/** An older-style passage reader seen through the fuller interface, for wrapping it in the cache. */
export const asEmbeddings = (embedder: Embedder, local = false): Embeddings => ({
  model: embedder.model, dimensions: 0, local, embed: (texts, signal) => embedder.embed(texts, signal),
});
/** What to say when nothing connected can read passages. One sentence, no jargon. */
export const noEmbeddingsMessage =
  "None of your connected models can compare writing by meaning yet. Connect one that offers it, or run a model on this computer, and try again.";

/** A fingerprint of one passage read by one model: the same passage never costs twice. */
export const textFingerprint = (text: string, model: string): string =>
  createHash("sha256").update(`${model}\u0000${text}`).digest("hex");

/** Every list of numbers already worked out, kept beside everything else on this computer. */
export class EmbeddingCache {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS embedding_cache(text_hash TEXT NOT NULL, model TEXT NOT NULL,
      dims INTEGER NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(text_hash,model));`);
  }
  get(hash: string, model: string): Float32Array | null {
    const row = this.db.prepare("SELECT vector FROM embedding_cache WHERE text_hash=? AND model=?").get(hash, model);
    return row ? unpackVector(row.vector as Uint8Array) : null;
  }
  put(hash: string, model: string, vector: Float32Array): void {
    this.db.prepare("INSERT OR REPLACE INTO embedding_cache VALUES(?,?,?,?,?)")
      .run(hash, model, vector.length, packVector(vector), new Date().toISOString());
  }
  size(): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM embedding_cache").get()?.n ?? 0); }
  /** Forgets everything read by one model, for when the owner changes which model reads passages. */
  clear(model?: string): number {
    const statement = model
      ? this.db.prepare("DELETE FROM embedding_cache WHERE model=?").run(model)
      : this.db.prepare("DELETE FROM embedding_cache").run();
    return Number(statement.changes ?? 0);
  }
}

/** Where the cost of reading passages is written down, the same place model answers are charged. */
export interface EmbeddingLedger { charge(runId: string, tokens: number): void }

/**
 * The reader the rest of the app uses: it answers from the cache where it can, asks the provider
 * only for what is new, retries the failures worth retrying, and charges what it cost to the task
 * that asked for it.
 */
export class CachedEmbeddings implements Embeddings {
  /** What happened, for the panel and for the tests: passages read, passages already known. */
  readonly stats = { fromCache: 0, fromProvider: 0, requests: 0, tokens: 0 };
  constructor(
    private readonly inner: Embeddings,
    private readonly cache: EmbeddingCache,
    private readonly ledger?: EmbeddingLedger,
    private readonly policy: RetryPolicy = parseRetryPolicy({}),
  ) {}
  get model(): string { return this.inner.model; }
  get local(): boolean { return this.inner.local; }
  get dimensions(): number { return this.inner.dimensions; }
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> { return this.embedFor(undefined, texts, signal); }
  /**
   * The passages that are not already read, worked out without touching the network. Used before a
   * large reading to say what it would actually cost: a folder that is already read costs nothing,
   * however big it is, so only these passages should ever count against a limit.
   */
  missing(texts: string[]): string[] {
    return texts.filter((text) => !this.cache.get(textFingerprint(text, this.inner.model), this.inner.model));
  }
  /** The same, charged to a task when there is one; background indexing has no task to charge. */
  async embedFor(runId: string | undefined, texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const answers = new Array<Float32Array | undefined>(texts.length);
    const missing: { at: number; text: string; hash: string }[] = [];
    texts.forEach((text, at) => {
      const hash = textFingerprint(text, this.inner.model);
      const known = this.cache.get(hash, this.inner.model);
      if (known) { answers[at] = known; this.stats.fromCache++; } else missing.push({ at, text, hash });
    });
    if (missing.length) await this.fetchMissing(runId, missing, answers, signal);
    return answers.map((vector) => vector ?? new Float32Array());
  }
  private async fetchMissing(
    runId: string | undefined, missing: { at: number; text: string; hash: string }[],
    answers: (Float32Array | undefined)[], signal: AbortSignal,
  ): Promise<void> {
    const vectors = await this.withRetry(() => this.inner.embed(missing.map((entry) => entry.text), signal), signal);
    missing.forEach((entry, index) => {
      const vector = vectors[index];
      if (!vector?.length) return;
      this.cache.put(entry.hash, this.inner.model, vector);
      answers[entry.at] = vector;
    });
    this.stats.fromProvider += missing.length;
    const tokens = estimateTokens(missing.map((entry) => entry.text));
    this.stats.tokens += tokens;
    if (runId && this.ledger) this.ledger.charge(runId, tokens);
  }
  /** The same back-off every model call already uses, so a busy provider is waited out, not given up on. */
  private async withRetry(attempt: () => Promise<Float32Array[]>, signal: AbortSignal): Promise<Float32Array[]> {
    for (let used = 0; ; used++) {
      this.stats.requests++;
      try { return await attempt(); } catch (error) {
        const plan = planRetry(error, used, this.policy);
        if (!plan) throw error;
        await waitForRetry(plan.delayMs, signal);
      }
    }
  }
}
