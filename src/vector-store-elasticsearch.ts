import { z } from "zod";
import type { VectorMatch, VectorRecord } from "./vector-store.js";
import { RemoteVectors, branchVectorNamespace, vectorOwnerPrefix, vectorGenerationPrefix, vectorNamespace,
  vectorPointId, vectorPayloadSchema, vectorPayload, validateVectorRecords, vectorGroups, type VectorServiceConfig } from "./vector-store-remote.js";

const fields = ["id", "owner", "collection", "docId", "chunkId", "model", "textHash"];
const propertySchema = z.object({ type: z.string(), dims: z.number().int().optional(), similarity: z.string().optional(),
  index: z.boolean().optional(), element_type: z.string().optional(), doc_values: z.boolean().optional() });
const mappingSchema = z.object({ mappings: z.object({ dynamic: z.literal("strict"),
  _source: z.object({ enabled: z.boolean().optional() }).optional(), properties: z.record(z.string(), propertySchema) }) });
const shardsSchema = z.object({ failed: z.literal(0) });
const passageSchema = vectorPayloadSchema.extend({ id: z.string() });
const hitSchema = z.object({ _index: z.string(), _id: z.string(), _source: passageSchema,
  _score: z.number().finite().nullable().optional(), sort: z.array(z.string()).length(1).optional() });
const searchSchema = z.object({ timed_out: z.literal(false), _shards: shardsSchema,
  hits: z.object({ total: z.object({ value: z.number().int().nonnegative(), relation: z.literal("eq") }), hits: z.array(hitSchema).max(128) }) });
const countSchema = z.object({ _shards: shardsSchema, count: z.number().int().nonnegative() });
type Hit = z.infer<typeof hitSchema>;
const scope = (owner: string, collection?: string, docId?: string) => ({ bool: { filter: [
  { term: { owner } }, ...(collection === undefined ? [] : [{ term: { collection } }]),
  ...(docId === undefined ? [] : [{ term: { docId } }]),
] } });

/** Native path/method/body construction adapts Elasticsearch JS generated API helpers
 * (Apache-2.0). See immutable source attribution in THIRD_PARTY_NOTICES.md. */
export class ElasticsearchVectors extends RemoteVectors {
  readonly name = "Elasticsearch";
  constructor(config: VectorServiceConfig) {
    super({ ...config, ...(config.key ? { key: async () => `ApiKey ${await config.key!()}` } : {}) });
  }
  private async mappings(pattern: string): Promise<Record<string, z.infer<typeof mappingSchema>>> {
    const result = z.record(z.string(), mappingSchema).parse((await this.request("GET",
      `/${encodeURIComponent(pattern)}/_mapping?allow_no_indices=true&ignore_unavailable=false&expand_wildcards=all`, undefined, true)) ?? {});
    if (Object.keys(result).length > 2048) throw new Error("Elasticsearch returned too many Branch generation mappings");
    return result;
  }
  private async names(owner: string, model?: string): Promise<string[]> {
    const prefix = model === undefined ? vectorOwnerPrefix(owner) : vectorGenerationPrefix(owner, model);
    const names = Object.keys(await this.mappings(`${prefix}*`));
    if (names.some((name) => !name.startsWith(prefix) || !branchVectorNamespace.test(name)))
      throw new Error("Elasticsearch returned an index outside the requested Branch generation namespace");
    return names;
  }
  private async ensure(name: string, dimensions: number, create: boolean): Promise<void> {
    if (dimensions > 4096) throw new Error("This Elasticsearch adapter supports at most 4,096 vector dimensions");
    let mappings = await this.mappings(name);
    if (!mappings[name]) {
      if (!create) throw new Error("The Elasticsearch embedding generation is unavailable");
      try {
        const result = z.object({ acknowledged: z.literal(true), index: z.literal(name) }).parse(await this.request("PUT", `/${name}`, {
          mappings: { dynamic: "strict", properties: { ...Object.fromEntries(fields.map((field) => [field, { type: "keyword" }])),
            vector: { type: "dense_vector", dims: dimensions, element_type: "float", index: true, similarity: "cosine" } } },
        }));
        if (!result.acknowledged) throw new Error("Elasticsearch did not acknowledge the generated mapping");
      } catch (error) { mappings = await this.mappings(name); if (!mappings[name]) throw error; }
      mappings = await this.mappings(name);
    }
    const mapping = mappings[name]?.mappings, vector = mapping?.properties.vector;
    if (Object.keys(mappings).length !== 1 || !mapping || mapping._source?.enabled === false
      || vector?.type !== "dense_vector" || vector.dims !== dimensions || vector.similarity !== "cosine" || vector.index !== true
      || (vector.element_type !== undefined && vector.element_type !== "float")
      || fields.some((field) => mapping.properties[field]?.type !== "keyword" || mapping.properties[field]?.doc_values === false))
      throw new Error("Elasticsearch uses an incompatible generation mapping, dimensions, distance or metadata field");
  }
  private check(name: string, owner: string, hit: Hit, collection?: string): void {
    const row = hit._source;
    if (hit._index !== name || row.owner !== owner || (collection !== undefined && row.collection !== collection)
      || vectorNamespace(owner, row.model, Number(name.split("_").at(-1))) !== name
      || hit._id !== row.id || row.id !== vectorPointId(owner, row.collection, row.chunkId))
      throw new Error("Elasticsearch returned an incompatible or out-of-scope passage");
  }
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    validateVectorRecords(records);
    for (const [name, rows] of vectorGroups(owner, records)) {
      await this.ensure(name, rows[0]!.vector.length, true);
      for (const row of rows) {
        const id = vectorPointId(owner, row.collection, row.chunkId);
        z.object({ _index: z.literal(name), _id: z.literal(id), result: z.enum(["created", "updated"]), _shards: shardsSchema })
          .parse(await this.request("PUT", `/${name}/_doc/${id}?refresh=true&pipeline=_none`,
            { ...vectorPayload(owner, row), id, vector: Array.from(row.vector) }));
      }
    }
    return records.length;
  }
  private async total(name: string, owner: string, collection?: string, docId?: string): Promise<number> {
    return countSchema.parse(await this.request("POST", `/${name}/_count`, { query: scope(owner, collection, docId) })).count;
  }
  private async rows(name: string, owner: string, collection: string): Promise<Hit[]> {
    const expected = await this.total(name, owner, collection);
    if (expected > 50_000) throw new Error("This Elasticsearch generation exceeds the 50,000-passage reading limit");
    const result: Hit[] = [];
    let after = "";
    for (;;) {
      const page = searchSchema.parse(await this.request("POST", `/${name}/_search?allow_partial_search_results=false`, {
        query: scope(owner, collection), _source: fields, size: 128, sort: [{ id: "asc" }], track_total_hits: true,
        ...(after ? { search_after: [after] } : {}),
      }));
      if (page.hits.total.value !== expected) throw new Error("Elasticsearch's passage inventory changed; retry once it settles");
      for (const hit of page.hits.hits) {
        this.check(name, owner, hit, collection);
        if (hit.sort?.[0] !== hit._source.id || hit._source.id <= after) throw new Error("Elasticsearch repeated or omitted its passage cursor");
        after = hit._source.id; result.push(hit);
      }
      if (result.length > 50_000) throw new Error("This Elasticsearch generation exceeded its reading limit while listed");
      if (page.hits.hits.length < 128) break;
    }
    if (result.length !== expected) throw new Error("Elasticsearch's passage inventory omitted entries; retry once it settles");
    return result;
  }
  async search(owner: string, collection: string, query: Float32Array, limit: number, scan = 50_000, model?: string): Promise<VectorMatch[]> {
    if (!model || !query.length) return [];
    const name = vectorNamespace(owner, model, query.length);
    if (!(await this.names(owner, model)).includes(name)) return [];
    await this.ensure(name, query.length, false);
    if (await this.total(name, owner, collection) > Math.min(scan, 50_000)) throw new Error("This Elasticsearch collection exceeds its exact similarity scan limit");
    const result = searchSchema.parse(await this.request("POST", `/${name}/_search?allow_partial_search_results=false`, {
      size: Math.max(1, Math.min(limit, 100)), _source: fields, track_total_hits: true,
      query: { script_score: { query: scope(owner, collection), script: {
        source: "cosineSimilarity(params.query_vector, 'vector') + 1.0", params: { query_vector: Array.from(query) },
      } } },
    }));
    if (result.hits.total.value > Math.min(scan, 50_000)) throw new Error("Elasticsearch's similarity inventory exceeded its scan limit while queried");
    return result.hits.hits.map((hit) => {
      this.check(name, owner, hit, collection);
      if (hit._source.model !== model || hit._score == null) throw new Error("Elasticsearch omitted its cosine score or returned another generation");
      return { docId: hit._source.docId, chunkId: hit._source.chunkId, score: hit._score - 1 };
    }).filter((hit) => hit.score > 0);
  }
  private async remove(owner: string, collection?: string, docId?: string): Promise<number> {
    let removed = 0;
    for (const name of await this.names(owner)) {
      await this.ensure(name, Number(name.split("_").at(-1)), false);
      const result = z.object({ deleted: z.number().int().nonnegative(), timed_out: z.literal(false), version_conflicts: z.literal(0),
        failures: z.array(z.unknown()).length(0) }).parse(await this.request("POST", `/${name}/_delete_by_query?refresh=true&wait_for_completion=true&conflicts=abort`,
        { query: scope(owner, collection, docId) }));
      removed += result.deleted;
      if (await this.total(name, owner, collection, docId)) throw new Error("Elasticsearch still exposes the requested Branch passages; cleanup remains pending");
    }
    return removed;
  }
  removeDocument(owner: string, collection: string, docId: string): Promise<number> { return this.remove(owner, collection, docId); }
  removeCollection(owner: string, collection: string): Promise<number> { return this.remove(owner, collection); }
  clearOwner(owner: string): Promise<number> { return this.remove(owner); }
  async count(owner: string, collection?: string): Promise<number> {
    let total = 0;
    for (const name of await this.names(owner)) { await this.ensure(name, Number(name.split("_").at(-1)), false); total += await this.total(name, owner, collection); }
    return total;
  }
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const name of await this.names(owner, model)) {
      await this.ensure(name, Number(name.split("_").at(-1)), false);
      for (const row of await this.rows(name, owner, collection)) result.set(row._source.chunkId, row._source.textHash);
    }
    return result;
  }
}
