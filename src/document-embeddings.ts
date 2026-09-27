import { z } from "zod";
import { assertProviderEndpoint } from "./providers.js";

/**
 * Optional meaning-based search for the document library. When the connected model provider speaks
 * the OpenAI shape it also answers `/embeddings`, so passages can be compared by meaning and not
 * only by the words they contain. Without a key nothing here runs and word search stands alone.
 */
export const defaultEmbeddingModel = "text-embedding-3-small";
export const embeddingBatch = 64;
const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative().optional(), embedding: z.array(z.number()).min(1).max(8192) })).min(1),
});

/**
 * Anything that can turn passages into vectors: the provider's own embeddings route, or the model
 * running on this computer (see src/local-models.ts).
 */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
}

export class EmbeddingClient implements Embedder {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    readonly model: string = defaultEmbeddingModel,
    private readonly call: typeof fetch = globalThis.fetch,
  ) {
    assertProviderEndpoint(endpoint);
    if (!apiKey) throw new Error("An API key is required to compare passages by meaning");
  }
  /** Vectors for every passage, sent in batches so one request never carries more than 64. */
  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += embeddingBatch)
      vectors.push(...(await this.batch(texts.slice(start, start + embeddingBatch), signal)));
    return vectors;
  }
  private async batch(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const response = await this.send(texts, signal);
    if (!response.ok) throw new Error(`The provider refused to read these passages (${response.status})`);
    const body = await response.text();
    if (body.length > 33_554_432) throw new Error("The provider returned too much data");
    const parsed = responseSchema.parse(JSON.parse(body) as unknown);
    const ordered = [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (ordered.length !== texts.length) throw new Error("The provider returned the wrong number of passages");
    return ordered.map((item) => Float32Array.from(item.embedding));
  }
  /**
   * Q208: a request that fails on the way out, before any answer (the provider closed a kept-open connection just as it
   * was reused, which fetch does not retry for a POST), is sent once more. A refusal or a stop is never repeated.
   */
  private async send(texts: string[], signal: AbortSignal): Promise<Response> {
    const request = () => this.call(this.endpoint.replace(/\/$/, "") + "/embeddings", {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    try { return await request(); } catch (error) {
      if (signal.aborted || !(error instanceof TypeError)) throw error;
      return await request();
    }
  }
}

export const packVector = (vector: Float32Array): Buffer => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
export function unpackVector(blob: Uint8Array): Float32Array {
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; left += a[i]! * a[i]!; right += b[i]! * b[i]!; }
  const size = Math.sqrt(left) * Math.sqrt(right);
  return size ? dot / size : 0;
}

/**
 * Reciprocal rank fusion: a passage that both searches rank highly beats one that only a single
 * search liked, without either search's scores needing a common scale.
 */
export function fuseRanks(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  return scores;
}
