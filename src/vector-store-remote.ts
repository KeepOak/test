import { createHash } from "node:crypto";
import { z } from "zod";
import { keptOnThisComputer } from "./models.js";
import { onThisComputer } from "./embeddings.js";
import { assertProviderEndpoint } from "./providers.js";
import type { VectorBackend, VectorMatch, VectorRecord } from "./vector-store.js";

export interface VectorServiceConfig {
  url: string;
  /** Origin-bound local runtime fetch, or the ordinary guarded outside fetch. */
  fetch: typeof fetch;
  timeoutMs: number;
  header: string;
  key?: () => Promise<string>;
  active: () => boolean;
  assertAllowed: (target: string) => void;
  tenant: string;
  database: string;
}
const digest = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const ownerPrefix = (owner: string): string => `branch_${digest([owner]).slice(0, 16)}_`;
const generationPrefix = (owner: string, model: string): string => `${ownerPrefix(owner)}${digest([model]).slice(0, 16)}_`;
const namespace = (owner: string, model: string, dimensions: number): string => `${generationPrefix(owner, model)}${dimensions}`;
const branchNamespace = /^branch_[a-f0-9]{16}_[a-f0-9]{16}_[1-9][0-9]{0,3}$/;
const pointId = (owner: string, collection: string, chunkId: string): string => {
  const hex = digest([owner, collection, chunkId]).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const payloadSchema = z.object({ owner: z.string(), collection: z.string(), docId: z.string(), chunkId: z.string(),
  model: z.string(), textHash: z.string() });
type Payload = z.infer<typeof payloadSchema>;
const payload = (owner: string, record: VectorRecord): Payload => ({ owner, collection: record.collection,
  docId: record.docId, chunkId: record.chunkId, model: record.model, textHash: record.textHash });
const validateRecords = (records: VectorRecord[]): void => {
  if (records.some((r) => !r.model || !r.vector.length || r.vector.length > 8192 || r.vector.some((v) => !Number.isFinite(v))))
    throw new Error("The vector store received an invalid embedding generation or vector");
};
function groups(owner: string, records: VectorRecord[]): Map<string, VectorRecord[]> {
  const result = new Map<string, VectorRecord[]>();
  for (const record of records) {
    const name = namespace(owner, record.model, record.vector.length);
    const entries = result.get(name) ?? [];
    entries.push(record); result.set(name, entries);
  }
  return result;
}

/** Common bounded transport. No adapter has an unguarded/default fetch or reads a credential itself. */
abstract class RemoteVectors implements VectorBackend {
  abstract readonly name: string;
  protected readonly base: string;
  constructor(protected readonly config: VectorServiceConfig) {
    const url = assertProviderEndpoint(config.url);
    if (url.search || url.hash || url.username || url.password) throw new Error("A vector service address cannot contain credentials, query or fragment");
    this.base = url.href.replace(/\/+$/, "");
  }
  protected async request(method: string, path: string, body?: unknown, missing = false): Promise<unknown> {
    if (keptOnThisComputer() && !onThisComputer(this.base)) throw new Error("This task stays on this computer, so its vectors were not sent to an outside service");
    if (!this.config.active()) throw new Error("This vector connection was changed or removed, so no request was sent");
    this.config.assertAllowed(this.base + path);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.key) headers[this.config.header] = await this.config.key();
    if (!this.config.active()) throw new Error("This vector connection was changed or removed, so no request was sent");
    this.config.assertAllowed(this.base + path);
    const response = await this.config.fetch(this.base + path, { method, headers, redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (missing && response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`The vector service refused a ${method} request (${response.status})`), { status: response.status }); }
    if (!response.body) return undefined;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 8_388_608) throw new Error("The vector service returned too much data");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const text = Buffer.concat(chunks).toString("utf8");
    return text.trim() ? JSON.parse(text) as unknown : undefined;
  }
  abstract upsert(owner: string, records: VectorRecord[]): Promise<number>;
  abstract removeDocument(owner: string, collection: string, docId: string): Promise<number>;
  abstract removeCollection(owner: string, collection: string): Promise<number>;
  abstract search(owner: string, collection: string, query: Float32Array, limit: number, scanAtMost?: number, model?: string): Promise<VectorMatch[]>;
  abstract count(owner: string, collection?: string): Promise<number>;
  abstract clearOwner(owner: string): Promise<number>;
  abstract fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>>;
}

const qdrantFilter = (owner: string, collection?: string, docId?: string) => ({ must: [
  { key: "owner", match: { value: owner } },
  ...(collection === undefined ? [] : [{ key: "collection", match: { value: collection } }]),
  ...(docId === undefined ? [] : [{ key: "docId", match: { value: docId } }]),
] });
const qdrantCollections = z.object({ result: z.object({ collections: z.array(z.object({ name: z.string() })).max(2048) }) });
const qdrantCount = z.object({ result: z.object({ count: z.number().int().nonnegative() }) });
const qdrantScroll = z.object({ result: z.object({ points: z.array(z.object({ payload: payloadSchema })),
  next_page_offset: z.union([z.string(), z.number()]).nullable().optional() }) });
const qdrantSearch = z.object({ result: z.object({ points: z.array(z.object({ score: z.number(), payload: payloadSchema })) }) });
const qdrantConfiguration = z.object({ result: z.object({ config: z.object({ params: z.object({
  vectors: z.object({ size: z.number().int().positive(), distance: z.string() }),
}) }) }) });

/** Native REST adapter. Request construction and wait/scroll conventions adapt qdrant-js (Apache-2.0);
 * see THIRD_PARTY_NOTICES.md for immutable source references. Every physical collection is one
 * owner, embedding route/model/version and dimension, so equal-size incompatible vectors never mix.
 */
export class QdrantVectors extends RemoteVectors {
  readonly name = "Qdrant";
  private readonly ready = new Set<string>();
  private async collections(owner: string, model?: string): Promise<string[]> {
    const body = qdrantCollections.parse(await this.request("GET", "/collections"));
    const prefix = model === undefined ? ownerPrefix(owner) : generationPrefix(owner, model);
    return body.result.collections.map((c) => c.name).filter((name) => name.startsWith(prefix) && branchNamespace.test(name));
  }
  private async ensure(name: string, dimensions: number): Promise<void> {
    if (this.ready.has(name)) return;
    const path = `/collections/${encodeURIComponent(name)}`;
    let result = await this.request("GET", path, undefined, true);
    if (result === undefined) {
      try { await this.request("PUT", path, { vectors: { size: dimensions, distance: "Cosine" } }); }
      catch (error) { if ((error as { status?: number }).status !== 409) throw error; }
      result = await this.request("GET", path);
    }
    const vectors = qdrantConfiguration.parse(result).result.config.params.vectors;
    if (vectors.size !== dimensions || vectors.distance !== "Cosine") throw new Error("Qdrant's collection uses incompatible dimensions or distance");
    this.ready.add(name);
  }
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    validateRecords(records);
    for (const [name, entries] of groups(owner, records)) {
      await this.ensure(name, entries[0]!.vector.length);
      for (let at = 0; at < entries.length; at += 64)
        await this.request("PUT", `/collections/${name}/points?wait=true`, { points: entries.slice(at, at + 64).map((r) => ({
          id: pointId(owner, r.collection, r.chunkId), vector: Array.from(r.vector), payload: payload(owner, r),
        })) });
    }
    return records.length;
  }
  private async rows(name: string, owner: string, collection?: string): Promise<Payload[]> {
    const result: Payload[] = [];
    const seen = new Set<string | number>();
    let offset: string | number | null | undefined;
    do {
      const page = qdrantScroll.parse(await this.request("POST", `/collections/${name}/points/scroll`, {
        filter: qdrantFilter(owner, collection), limit: 128, with_payload: true, with_vector: false,
        ...(offset === undefined ? {} : { offset }),
      }));
      if (page.result.points.some((p) => p.payload.owner !== owner || (collection !== undefined && p.payload.collection !== collection)))
        throw new Error("The vector service returned passages outside the requested owner or collection");
      result.push(...page.result.points.map((p) => p.payload));
      if (result.length > 50_000) throw new Error("This vector generation exceeds the 50,000-passage reading limit");
      offset = page.result.next_page_offset;
      if (offset !== undefined && offset !== null) {
        if (seen.has(offset)) throw new Error("Qdrant repeated its passage cursor");
        seen.add(offset);
      }
    } while (offset !== undefined && offset !== null);
    return result;
  }
  async search(owner: string, collection: string, query: Float32Array, limit: number, _scan?: number, model?: string): Promise<VectorMatch[]> {
    if (!model || !query.length) return [];
    const name = namespace(owner, model, query.length);
    if (!(await this.collections(owner, model)).includes(name)) return [];
    await this.ensure(name, query.length);
    const body = qdrantSearch.parse(await this.request("POST", `/collections/${name}/points/query`, {
      query: Array.from(query), filter: qdrantFilter(owner, collection), limit: Math.max(1, Math.min(limit, 100)), with_payload: true,
    }));
    return body.result.points.map((p) => {
      if (p.payload.owner !== owner || p.payload.collection !== collection || p.payload.model !== model)
        throw new Error("The vector service returned an incompatible or out-of-scope passage");
      return { docId: p.payload.docId, chunkId: p.payload.chunkId, score: p.score };
    }).filter((hit) => Number.isFinite(hit.score) && hit.score > 0);
  }
  private async remove(owner: string, collection?: string, docId?: string): Promise<number> {
    let removed = 0;
    for (const name of await this.collections(owner)) {
      const filter = qdrantFilter(owner, collection, docId);
      removed += qdrantCount.parse(await this.request("POST", `/collections/${name}/points/count`, { filter, exact: true })).result.count;
      await this.request("POST", `/collections/${name}/points/delete?wait=true`, { filter });
    }
    return removed;
  }
  removeDocument(owner: string, collection: string, docId: string): Promise<number> { return this.remove(owner, collection, docId); }
  removeCollection(owner: string, collection: string): Promise<number> { return this.remove(owner, collection); }
  async clearOwner(owner: string): Promise<number> {
    const removed = await this.remove(owner);
    if (await this.count(owner)) throw new Error("Qdrant still holds some of this person's Branch vectors; cleanup will be retried");
    return removed;
  }
  async count(owner: string, collection?: string): Promise<number> {
    let total = 0;
    for (const name of await this.collections(owner))
      total += qdrantCount.parse(await this.request("POST", `/collections/${name}/points/count`, { filter: qdrantFilter(owner, collection), exact: true })).result.count;
    return total;
  }
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const name of await this.collections(owner, model))
      for (const row of await this.rows(name, owner, collection)) {
        if (row.model !== model) throw new Error("The vector service returned a different embedding generation");
        result.set(row.chunkId, row.textHash);
      }
    return result;
  }
}

const chromaCollection = z.object({ id: z.string().min(1), name: z.string(),
  configuration_json: z.object({ hnsw: z.object({ space: z.string() }).nullable().optional() }).optional() });
const chromaList = z.array(chromaCollection).max(200);
const chromaGet = z.object({ ids: z.array(z.string()), metadatas: z.array(payloadSchema) });
const chromaQuery = z.object({ ids: z.array(z.array(z.string())), distances: z.array(z.array(z.number())),
  metadatas: z.array(z.array(payloadSchema)) });
const chromaFilter = (owner: string, collection?: string, docId?: string) => ({ $and: [
  { owner: { $eq: owner } },
  ...(collection === undefined ? [] : [{ collection: { $eq: collection } }]),
  ...(docId === undefined ? [] : [{ docId: { $eq: docId } }]),
  { model: { $ne: "" } },
] });

/** Chroma v2 native collection/upsert/get/query/delete protocol, adapted from chromadb-core
 * ChromaClient/Collection/generated api.ts (Apache-2.0). No Chroma embedding function is installed
 * or invoked: all embeddings arrive from Branch's explicitly chosen embedding source.
 */
export class ChromaVectors extends RemoteVectors {
  readonly name = "Chroma";
  private readonly scope: string;
  constructor(config: VectorServiceConfig) {
    super(config);
    this.scope = `/api/v2/tenants/${encodeURIComponent(config.tenant)}/databases/${encodeURIComponent(config.database)}/collections`;
  }
  private async collections(owner: string, model?: string): Promise<z.infer<typeof chromaCollection>[]> {
    const result: z.infer<typeof chromaCollection>[] = [];
    const prefix = model === undefined ? ownerPrefix(owner) : generationPrefix(owner, model);
    for (let offset = 0; offset < 2000; offset += 200) {
      const page = chromaList.parse(await this.request("GET", `${this.scope}?limit=200&offset=${offset}`));
      result.push(...page.filter((entry) => entry.name.startsWith(prefix) && branchNamespace.test(entry.name)));
      if (page.length < 200) return result;
    }
    throw new Error("The Chroma database exceeds the 2,000-collection listing limit");
  }
  private async ensure(name: string): Promise<string> {
    const result = chromaCollection.parse(await this.request("POST", this.scope, {
      name, get_or_create: true, configuration: { hnsw: { space: "cosine" } },
    }));
    if (result.name !== name) throw new Error("Chroma returned a different collection from the one requested");
    if (result.configuration_json?.hnsw?.space !== "cosine") throw new Error("Chroma's collection must use cosine distance");
    return result.id;
  }
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    validateRecords(records);
    for (const [name, entries] of groups(owner, records)) {
      const id = await this.ensure(name);
      for (let at = 0; at < entries.length; at += 64) {
        const batch = entries.slice(at, at + 64);
        await this.request("POST", `${this.scope}/${encodeURIComponent(id)}/upsert`, {
          ids: batch.map((r) => pointId(owner, r.collection, r.chunkId)), embeddings: batch.map((r) => Array.from(r.vector)),
          metadatas: batch.map((r) => payload(owner, r)),
        });
      }
    }
    return records.length;
  }
  private async rows(id: string, owner: string, collection?: string, docId?: string): Promise<{ ids: string[]; payloads: Payload[] }> {
    const ids: string[] = [], payloads: Payload[] = [];
    for (let offset = 0; offset <= 50_000; offset += 128) {
      const page = chromaGet.parse(await this.request("POST", `${this.scope}/${encodeURIComponent(id)}/get`, {
        where: chromaFilter(owner, collection, docId), include: ["metadatas"], limit: 128, offset,
      }));
      if (page.ids.length !== page.metadatas.length || page.metadatas.some((p) => p.owner !== owner ||
        (collection !== undefined && p.collection !== collection) || (docId !== undefined && p.docId !== docId)))
        throw new Error("Chroma returned passages outside the requested owner or collection");
      ids.push(...page.ids); payloads.push(...page.metadatas);
      if (ids.length > 50_000) throw new Error("This vector generation exceeds the 50,000-passage reading limit");
      if (page.ids.length < 128) return { ids, payloads };
    }
    throw new Error("Chroma did not finish listing this vector generation");
  }
  async search(owner: string, collection: string, query: Float32Array, limit: number, _scan?: number, model?: string): Promise<VectorMatch[]> {
    if (!model || !query.length) return [];
    const name = namespace(owner, model, query.length);
    const found = (await this.collections(owner, model)).find((entry) => entry.name === name);
    if (!found) return [];
    if (found.configuration_json?.hnsw?.space !== "cosine") throw new Error("Chroma's collection must use cosine distance");
    const body = chromaQuery.parse(await this.request("POST", `${this.scope}/${encodeURIComponent(found.id)}/query`, {
      query_embeddings: [Array.from(query)], n_results: Math.max(1, Math.min(limit, 100)),
      where: chromaFilter(owner, collection), include: ["metadatas", "distances"],
    }));
    const metadata = body.metadatas[0] ?? [], distances = body.distances[0] ?? [];
    if (metadata.length !== distances.length || metadata.length !== body.ids[0]?.length) throw new Error("Chroma returned inconsistent query results");
    return metadata.map((p, at) => {
      if (p.owner !== owner || p.collection !== collection || p.model !== model) throw new Error("Chroma returned an incompatible or out-of-scope passage");
      return { docId: p.docId, chunkId: p.chunkId, score: 1 - distances[at]! };
    }).filter((hit) => Number.isFinite(hit.score) && hit.score > 0);
  }
  private async remove(owner: string, collection?: string, docId?: string): Promise<number> {
    let removed = 0;
    for (const entry of await this.collections(owner)) {
      const rows = await this.rows(entry.id, owner, collection, docId);
      for (let at = 0; at < rows.ids.length; at += 64)
        await this.request("POST", `${this.scope}/${encodeURIComponent(entry.id)}/delete`, { ids: rows.ids.slice(at, at + 64) });
      removed += rows.ids.length;
    }
    return removed;
  }
  removeDocument(owner: string, collection: string, docId: string): Promise<number> { return this.remove(owner, collection, docId); }
  removeCollection(owner: string, collection: string): Promise<number> { return this.remove(owner, collection); }
  async clearOwner(owner: string): Promise<number> {
    const removed = await this.remove(owner);
    if (await this.count(owner)) throw new Error("Chroma still holds some of this person's Branch vectors; cleanup will be retried");
    return removed;
  }
  async count(owner: string, collection?: string): Promise<number> {
    let total = 0;
    for (const entry of await this.collections(owner)) total += (await this.rows(entry.id, owner, collection)).ids.length;
    return total;
  }
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const entry of await this.collections(owner, model))
      for (const row of (await this.rows(entry.id, owner, collection)).payloads) {
        if (row.model !== model) throw new Error("Chroma returned a different embedding generation");
        result.set(row.chunkId, row.textHash);
      }
    return result;
  }
}
