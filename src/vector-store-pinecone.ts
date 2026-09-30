import { z } from "zod";
import type { VectorMatch, VectorRecord } from "./vector-store.js";
import { RemoteVectors, branchVectorNamespace, vectorOwnerPrefix, vectorGenerationPrefix, vectorNamespace,
  vectorPointId, vectorPayloadSchema, vectorPayload, validateVectorRecords, vectorGroups } from "./vector-store-remote.js";

const statsSchema = z.object({ dimension: z.number().int().min(1).max(8192), metric: z.literal("cosine"),
  namespaces: z.record(z.string(), z.object({ vectorCount: z.number().int().nonnegative() })).default({}) });
const listSchema = z.object({ namespace: z.string(), vectors: z.array(z.object({ id: z.string().min(1).max(100) })).max(100).default([]),
  pagination: z.object({ next: z.string().min(1).max(5000).optional() }).optional() });
const fetchedVector = z.object({ id: z.string(), metadata: vectorPayloadSchema });
const fetchSchema = z.object({ namespace: z.string(), vectors: z.record(z.string(), fetchedVector).default({}) });
const querySchema = z.object({ namespace: z.string(), matches: z.array(z.object({ id: z.string(), score: z.number(), metadata: vectorPayloadSchema })).max(100).default([]) });
type Passage = z.infer<typeof fetchedVector>;
const filter = (owner: string, collection: string) => ({ $and: [{ owner: { $eq: owner } }, { collection: { $eq: collection } }] });

/** Actual pinecone-ts-client Apache-2.0 native data-plane helpers, adapted without an SDK.
 * Existing dense cosine serverless index only. No index/control-plane creation or deletion. */
export class PineconeVectors extends RemoteVectors {
  readonly name = "Pinecone";
  private async stats() {
    const result = statsSchema.parse(await this.request("POST", "/describe_index_stats", {}));
    if (Object.keys(result.namespaces).length > 2048) throw new Error("Pinecone's index exceeds the namespace inventory limit");
    return result;
  }
  private async namespaces(owner: string, model?: string): Promise<string[]> {
    const stats = await this.stats(), prefix = model === undefined ? vectorOwnerPrefix(owner) : vectorGenerationPrefix(owner, model);
    return Object.keys(stats.namespaces).filter((name) => name.startsWith(prefix) && branchVectorNamespace.test(name));
  }
  private scoped(name: string, owner: string, row: Passage, collection?: string): void {
    const p = row.metadata, dimensions = Number(name.split("_").at(-1));
    if (p.owner !== owner || (collection !== undefined && p.collection !== collection)
      || vectorNamespace(owner, p.model, dimensions) !== name || row.id !== vectorPointId(owner, p.collection, p.chunkId))
      throw new Error("Pinecone returned a passage outside the requested owner, namespace or collection");
  }
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    validateVectorRecords(records);
    if (!records.length) return 0;
    const stats = await this.stats();
    if (records.some((row) => row.vector.length !== stats.dimension)) throw new Error("The chosen Pinecone index has a different embedding dimension");
    for (const [namespace, rows] of vectorGroups(owner, records)) {
      for (let at = 0; at < rows.length; at += 64)
        await this.request("POST", "/vectors/upsert", { namespace, vectors: rows.slice(at, at + 64).map((row) => ({
          id: vectorPointId(owner, row.collection, row.chunkId), values: Array.from(row.vector), metadata: vectorPayload(owner, row),
        })) });
    }
    return records.length;
  }
  private async rows(name: string, owner: string, collection?: string): Promise<Passage[]> {
    const rows: Passage[] = [], seen = new Set<string>(), idsSeen = new Set<string>();
    let token: string | undefined, listed = 0;
    do {
      const query = new URLSearchParams({ namespace: name, limit: "100", ...(token ? { paginationToken: token } : {}) });
      const page = listSchema.parse(await this.request("GET", `/vectors/list?${query}`));
      if (page.namespace !== name) throw new Error("Pinecone returned a different namespace from the one listed");
      for (const row of page.vectors) {
        if (idsSeen.has(row.id)) throw new Error("Pinecone repeated a passage in its namespace inventory");
        idsSeen.add(row.id);
      }
      listed += page.vectors.length;
      if (listed > 50_000) throw new Error("This Pinecone namespace exceeds the 50,000-passage reading limit");
      for (let at = 0; at < page.vectors.length; at += 32) {
        const batch = page.vectors.slice(at, at + 32);
        const params = new URLSearchParams({ namespace: name });
        for (const row of batch) params.append("ids", row.id);
        const found = fetchSchema.parse(await this.request("GET", `/vectors/fetch?${params}`));
        if (found.namespace !== name) throw new Error("Pinecone fetched a different namespace");
        const wanted = new Set(batch.map((row) => row.id));
        for (const [id, row] of Object.entries(found.vectors)) {
          if (row.id !== id || !wanted.has(id)) throw new Error("Pinecone returned an unrequested passage");
          this.scoped(name, owner, row);
          if (collection === undefined || row.metadata.collection === collection) rows.push(row);
        }
        if (Object.keys(found.vectors).length !== wanted.size) throw new Error("Pinecone's passage inventory changed; retry after its index settles");
      }
      token = page.pagination?.next;
      if (token) { if (seen.has(token)) throw new Error("Pinecone repeated its namespace cursor"); seen.add(token); }
    } while (token);
    return rows;
  }
  async search(owner: string, collection: string, query: Float32Array, limit: number, _scan?: number, model?: string): Promise<VectorMatch[]> {
    if (!model || !query.length) return [];
    const stats = await this.stats();
    if (query.length !== stats.dimension) throw new Error("The chosen Pinecone index has a different question dimension");
    const namespace = vectorNamespace(owner, model, query.length);
    if (!stats.namespaces[namespace]?.vectorCount) return [];
    const result = querySchema.parse(await this.request("POST", "/query", { namespace, vector: Array.from(query),
      topK: Math.max(1, Math.min(limit, 100)), includeMetadata: true, includeValues: false, filter: filter(owner, collection) }));
    if (result.namespace !== namespace) throw new Error("Pinecone searched a different namespace");
    return result.matches.map((hit) => {
      this.scoped(namespace, owner, { id: hit.id, metadata: hit.metadata }, collection);
      if (hit.metadata.model !== model) throw new Error("Pinecone returned a different embedding generation");
      return { docId: hit.metadata.docId, chunkId: hit.metadata.chunkId, score: hit.score };
    }).filter((hit) => Number.isFinite(hit.score) && hit.score > 0);
  }
  private async remove(owner: string, collection: string, docId?: string): Promise<number> {
    let removed = 0;
    for (const namespace of await this.namespaces(owner)) {
      const rows = (await this.rows(namespace, owner, collection)).filter((row) => docId === undefined || row.metadata.docId === docId);
      for (let at = 0; at < rows.length; at += 100)
        await this.request("POST", "/vectors/delete", { namespace, ids: rows.slice(at, at + 100).map((row) => row.id) });
      removed += rows.length;
    }
    return removed;
  }
  removeDocument(owner: string, collection: string, docId: string): Promise<number> { return this.remove(owner, collection, docId); }
  removeCollection(owner: string, collection: string): Promise<number> { return this.remove(owner, collection); }
  async count(owner: string, collection?: string): Promise<number> {
    if (collection !== undefined) {
      let count = 0;
      for (const name of await this.namespaces(owner)) count += (await this.rows(name, owner, collection)).length;
      return count;
    }
    const stats = await this.stats();
    return Object.entries(stats.namespaces).filter(([name]) => name.startsWith(vectorOwnerPrefix(owner)) && branchVectorNamespace.test(name))
      .reduce((sum, [, value]) => sum + value.vectorCount, 0);
  }
  async clearOwner(owner: string): Promise<number> {
    let removed = 0;
    for (const namespace of await this.namespaces(owner)) {
      const rows = await this.rows(namespace, owner); // Verify all metadata ownership before namespace-only deletion.
      removed += rows.length;
      await this.request("POST", "/vectors/delete", { namespace, deleteAll: true });
    }
    if (await this.count(owner)) throw new Error("Pinecone still reports this person's Branch vectors; cleanup stays pending until its index settles");
    return removed;
  }
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const name of await this.namespaces(owner, model))
      for (const row of await this.rows(name, owner, collection)) result.set(row.metadata.chunkId, row.metadata.textHash);
    return result;
  }
}
