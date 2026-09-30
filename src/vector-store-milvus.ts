import { z } from "zod";
import type { VectorMatch, VectorRecord } from "./vector-store.js";
import { RemoteVectors, branchVectorNamespace, vectorOwnerPrefix, vectorGenerationPrefix, vectorNamespace,
  vectorPointId, vectorPayloadSchema, vectorPayload, validateVectorRecords, vectorGroups, type VectorServiceConfig } from "./vector-store-remote.js";

const responseSchema = z.object({ code: z.number().int(), data: z.unknown().optional() });
const fieldSchema = z.object({ name: z.string(), type: z.string(), primaryKey: z.boolean(), autoId: z.boolean(),
  params: z.array(z.object({ key: z.string(), value: z.string() })).optional() });
const descriptionSchema = z.object({ collectionName: z.string(), enableDynamicField: z.boolean(),
  fields: z.array(fieldSchema).max(20), indexes: z.array(z.object({ fieldName: z.string(), metricType: z.string() })).max(10), load: z.string() });
const passageSchema = vectorPayloadSchema.extend({ id: z.string() });
const passagesSchema = z.array(passageSchema).max(128);
const nativeNumber = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i).transform(Number).pipe(z.number().finite())]);
const countSchema = z.array(z.object({ "count(*)": nativeNumber.pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)) })).length(1);
const searchSchema = z.array(passageSchema.extend({ distance: nativeNumber })).max(100);
type Passage = z.infer<typeof passageSchema>;
const fields = ["id", "owner", "collection", "docId", "chunkId", "model", "textHash"];
const filter = (owner: string, collection?: string, docId?: string): string => [
  `owner == ${JSON.stringify(owner)}`,
  ...(collection === undefined ? [] : [`collection == ${JSON.stringify(collection)}`]),
  ...(docId === undefined ? [] : [`docId == ${JSON.stringify(docId)}`]),
].join(" and ");

/** Native v2 routes adapt actual Milvus Node HTTP Collection/Vector helpers (Apache-2.0),
 * with schema/count/ordered-query response details from the Apache-2.0 Milvus server. */
export class MilvusVectors extends RemoteVectors {
  readonly name = "Milvus";
  constructor(config: VectorServiceConfig) {
    super({ ...config, ...(config.key ? { key: async () => `Bearer ${await config.key!()}` } : {}) });
  }
  private async call(area: "collections" | "entities", action: string, body: Record<string, unknown>): Promise<unknown> {
    const result = responseSchema.parse(await this.request("POST", `/v2/vectordb/${area}/${action}`, { dbName: this.config.database, ...body }));
    if (result.code !== 0) throw new Error(`Milvus refused its ${area}/${action} operation (code ${result.code})`);
    return result.data;
  }
  private async collections(owner: string, model?: string): Promise<string[]> {
    const names = z.array(z.string()).max(2048).parse(await this.call("collections", "list", {}));
    const prefix = model === undefined ? vectorOwnerPrefix(owner) : vectorGenerationPrefix(owner, model);
    return names.filter((name) => name.startsWith(prefix) && branchVectorNamespace.test(name));
  }
  private async ensure(name: string, dimensions: number, create: boolean): Promise<void> {
    const present = z.object({ has: z.boolean() }).parse(await this.call("collections", "has", { collectionName: name }));
    if (!present.has) {
      if (!create) throw new Error("The requested Milvus vector generation is unavailable");
      try {
        await this.call("collections", "create", { collectionName: name, dimension: dimensions, metricType: "COSINE",
          idType: "VarChar", autoID: false, primaryFieldName: "id", vectorFieldName: "vector",
          params: { max_length: 64, enableDynamicField: true, consistencyLevel: "Strong" } });
      } catch (error) {
        const again = z.object({ has: z.boolean() }).parse(await this.call("collections", "has", { collectionName: name }));
        if (!again.has) throw error;
      }
    }
    const value = descriptionSchema.parse(await this.call("collections", "describe", { collectionName: name }));
    const vector = value.fields.find((field) => field.name === "vector"), primary = value.fields.find((field) => field.name === "id");
    const dimension = Number(vector?.params?.find((param) => param.key === "dim")?.value);
    if (value.collectionName !== name || !value.enableDynamicField || vector?.type !== "FloatVector" || dimension !== dimensions
      || primary?.type !== "VarChar" || !primary.primaryKey || primary.autoId || !value.indexes.some((index) => index.fieldName === "vector" && index.metricType === "COSINE"))
      throw new Error("Milvus uses an incompatible generation schema, primary key, dimension or distance");
    if (value.load !== "LoadStateLoaded") await this.call("collections", "load", { collectionName: name });
  }
  private scoped(name: string, owner: string, row: Passage, collection?: string): void {
    if (row.owner !== owner || (collection !== undefined && row.collection !== collection)
      || vectorNamespace(owner, row.model, Number(name.split("_").at(-1))) !== name
      || row.id !== vectorPointId(owner, row.collection, row.chunkId)) throw new Error("Milvus returned an incompatible or out-of-scope passage");
  }
  async upsert(owner: string, records: VectorRecord[]): Promise<number> {
    validateVectorRecords(records);
    for (const [name, rows] of vectorGroups(owner, records)) {
      await this.ensure(name, rows[0]!.vector.length, true);
      for (let at = 0; at < rows.length; at += 64) {
        const batch = rows.slice(at, at + 64);
        const result = z.object({ upsertCount: nativeNumber.pipe(z.number().int().nonnegative()) }).parse(await this.call("entities", "upsert", {
          collectionName: name, data: batch.map((row) => ({ ...vectorPayload(owner, row), id: vectorPointId(owner, row.collection, row.chunkId), vector: Array.from(row.vector) })),
        }));
        if (result.upsertCount !== batch.length) throw new Error("Milvus did not confirm every vector in this batch");
      }
    }
    return records.length;
  }
  private async total(name: string, owner: string, collection?: string, docId?: string): Promise<number> {
    const result = countSchema.parse(await this.call("entities", "query", { collectionName: name,
      filter: filter(owner, collection, docId), outputFields: ["count(*)"], consistencyLevel: "Strong" }));
    return result[0]!["count(*)"];
  }
  private async rows(name: string, owner: string, collection: string): Promise<Passage[]> {
    const expected = await this.total(name, owner, collection);
    if (expected > 50_000) throw new Error("This Milvus generation exceeds the 50,000-passage reading limit");
    const result: Passage[] = [];
    let after = "";
    for (;;) {
      const page = passagesSchema.parse(await this.call("entities", "query", { collectionName: name, outputFields: fields,
        filter: `${filter(owner, collection)}${after ? ` and id > ${JSON.stringify(after)}` : ""}`,
        orderByFields: ["id"], limit: 128, consistencyLevel: "Strong" }));
      for (const row of page) {
        this.scoped(name, owner, row, collection);
        if (row.id <= after) throw new Error("Milvus did not return a strictly ordered passage cursor");
        after = row.id; result.push(row);
      }
      if (result.length > 50_000) throw new Error("This Milvus generation exceeded its reading limit while it was listed");
      if (page.length < 128) break;
    }
    if (result.length !== expected) throw new Error("Milvus's passage inventory changed or omitted entries; retry once it settles");
    return result;
  }
  async search(owner: string, collection: string, query: Float32Array, limit: number, _scan?: number, model?: string): Promise<VectorMatch[]> {
    if (!model || !query.length) return [];
    const name = vectorNamespace(owner, model, query.length);
    if (!(await this.collections(owner, model)).includes(name)) return [];
    await this.ensure(name, query.length, false);
    const rows = searchSchema.parse(await this.call("entities", "search", { collectionName: name, data: [Array.from(query)],
      annsField: "vector", filter: filter(owner, collection), outputFields: fields, limit: Math.max(1, Math.min(limit, 100)),
      consistencyLevel: "Strong", searchParams: { metric_type: "COSINE" } }));
    return rows.map((row) => {
      this.scoped(name, owner, row, collection);
      if (row.model !== model) throw new Error("Milvus returned a different embedding generation");
      return { docId: row.docId, chunkId: row.chunkId, score: row.distance };
    }).filter((hit) => hit.score > 0);
  }
  private async remove(owner: string, collection?: string, docId?: string): Promise<number> {
    let removed = 0;
    for (const name of await this.collections(owner)) {
      await this.ensure(name, Number(name.split("_").at(-1)), false);
      removed += await this.total(name, owner, collection, docId);
      await this.call("entities", "delete", { collectionName: name, filter: filter(owner, collection, docId) });
      if (await this.total(name, owner, collection, docId)) throw new Error("Milvus still exposes the requested Branch passages; cleanup remains pending");
    }
    return removed;
  }
  removeDocument(owner: string, collection: string, docId: string): Promise<number> { return this.remove(owner, collection, docId); }
  removeCollection(owner: string, collection: string): Promise<number> { return this.remove(owner, collection); }
  clearOwner(owner: string): Promise<number> { return this.remove(owner); }
  async count(owner: string, collection?: string): Promise<number> {
    let total = 0;
    for (const name of await this.collections(owner)) {
      await this.ensure(name, Number(name.split("_").at(-1)), false);
      total += await this.total(name, owner, collection);
    }
    return total;
  }
  async fingerprints(owner: string, collection: string, model: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const name of await this.collections(owner, model)) {
      await this.ensure(name, Number(name.split("_").at(-1)), false);
      for (const row of await this.rows(name, owner, collection)) result.set(row.chunkId, row.textHash);
    }
    return result;
  }
}
