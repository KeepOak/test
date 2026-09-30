import { z } from "zod";
import { errorText } from "./contracts.js";
import type { DocumentLibrary } from "./documents.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import type { ModelRouter } from "./models.js";
import { mergePassages, noSuchRetriever, orderedStages, pipelineFor, rerankStage,
  RetrievalPipelineSettingsSchema, type NamedPipeline, type RetrievalPipelineSettings,
  type StageReport } from "./retrieval-pipeline.js";
import type { Store } from "./store.js";
import { embeddingRerank, type LocalRerankSource } from "./retrieval-embedding.js";

/**
 * One way of finding passages, whatever they are made of. The document library and the saved facts
 * both answer the same question — "which passages fit this?" — so they are both put behind the same
 * small interface, and anything that wants passages asks a retriever rather than one library.
 *
 * On top of that sits a second pass that puts the best answer first. By default that is done here
 * by the owner's local passage reader when available, with word counts as its fallback. The
 * owner can instead have the model read the top twenty and pick the best five; that is one extra
 * request per search, so it stays off until they turn it on.
 */
export interface RetrievedPassage {
  /** Unique within one search, so two retrievers' answers can be merged. */
  key: string;
  /** Where it came from, in words: a document's name or "your saved notes". */
  source: string;
  text: string;
  score: number;
  /** Which retriever found it. */
  from: string;
}
export interface Retriever {
  readonly id: string;
  readonly label: string;
  retrieve(owner: string, query: string, limit: number, signal?: AbortSignal): Promise<RetrievedPassage[]>;
}

export const RerankSettingsSchema = z.object({
  /** "words" uses the local passage reader first, then word counts; "model" asks the model to choose. */
  mode: z.enum(["words", "model"]).default("words"),
  /** How many passages the second pass looks at. */
  candidates: z.number().int().min(2).max(50).default(20),
  /** How many it keeps. */
  keep: z.number().int().min(1).max(20).default(5),
  /** Cosine relevance floor for local embeddings only; word and model scores have different scales. */
  relevanceThreshold: z.number().min(-1).max(1).default(0.1),
}).strict();
export type RerankSettings = z.infer<typeof RerankSettingsSchema>;

const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/**
 * Puts the passages that use more of the question's words first. Ties keep the order they arrived
 * in, so the same passages always come back in the same order.
 */
export function lexicalRerank(query: string, passages: RetrievedPassage[], keep: number): RetrievedPassage[] {
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return passages.slice(0, keep);
  const scored = passages.map((passage, at) => {
    const found = words(passage.text);
    const counts = new Map<string, number>();
    for (const word of found) counts.set(word, (counts.get(word) ?? 0) + 1);
    const covered = wanted.filter((word) => counts.has(word)).length;
    const density = wanted.reduce((sum, word) => sum + Math.log1p(counts.get(word) ?? 0), 0) / Math.log1p(found.length + 1);
    return { passage, at, score: Number((covered / wanted.length + density).toFixed(6)) };
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.slice(0, keep).map((entry) => ({ ...entry.passage, score: entry.score }));
}

const rerankInstructions =
  "You are choosing which passages answer a question best. Reply with JSON only: {\"order\":[2,0,5]} listing the numbers of the most useful passages, best first, at most the number asked for. No prose.";

/** Asks the model once to pick the best passages. Anything unexpected falls back to the word order. */
export async function modelRerank(
  models: ModelRouter, owner: string, query: string, passages: RetrievedPassage[], keep: number,
  signal: AbortSignal = AbortSignal.timeout(20000),
): Promise<{ passages: RetrievedPassage[]; calls: number; note: string }> {
  const provider = models.plan(owner, "").candidates[0]?.provider;
  if (!provider) return { passages: lexicalRerank(query, passages, keep), calls: 0, note: "no model is connected" };
  const listed = passages.map((passage, at) => `${at}. ${passage.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  try {
    const completion = await provider.complete({
      messages: [
        { role: "system", content: rerankInstructions },
        { role: "user", content: `Question: ${query.slice(0, 500)}\nKeep at most ${keep}.\nPassages:\n${listed}` },
      ],
      tools: [], maxTokens: 200, signal,
    });
    const order = readOrder(completion.content, passages.length).slice(0, keep);
    if (!order.length) return { passages: lexicalRerank(query, passages, keep), calls: 1, note: "the model gave no usable order" };
    return { passages: order.map((at, rank) => ({ ...passages[at]!, score: Number((1 / (rank + 1)).toFixed(6)) })), calls: 1, note: "" };
  } catch (error) {
    return { passages: lexicalRerank(query, passages, keep), calls: 1, note: errorText(error).slice(0, 200) };
  }
}
/** The numbers in the model's answer, kept only where they point at a real passage and appear once. */
function readOrder(content: string, count: number): number[] {
  const body = /\{[\s\S]*\}/.exec(content)?.[0] ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  const raw = (parsed as { order?: unknown })?.order;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  return raw.map(Number).filter((at) => Number.isInteger(at) && at >= 0 && at < count && !seen.has(at) && seen.add(at) !== undefined);
}

/** The document library behind the common interface. */
export class DocumentRetriever implements Retriever {
  readonly id = "documents";
  readonly label = "Your documents";
  constructor(private readonly library: DocumentLibrary) {}
  async retrieve(owner: string, query: string, limit: number, signal?: AbortSignal): Promise<RetrievedPassage[]> {
    const results = await this.library.search(owner, { query: query.slice(0, 500), limit: Math.min(limit, 10) },
      signal ?? AbortSignal.timeout(30000));
    return results.map((row) => ({
      key: `documents:${row.documentId}:${row.passage}`, source: row.source,
      text: row.text, score: row.score, from: this.id,
    }));
  }
}
/** The saved facts behind the common interface. */
export class MemoryRetriever implements Retriever {
  readonly id = "memory";
  readonly label = "Your saved notes";
  constructor(private readonly retrieval: MemoryRetrieval) {}
  async retrieve(owner: string, query: string, limit: number, signal?: AbortSignal): Promise<RetrievedPassage[]> {
    const hits = await this.retrieval.search(owner, query, undefined, limit, signal ?? AbortSignal.timeout(20000));
    return hits.map((hit) => ({
      key: `memory:${hit.record.id}`, source: "your saved notes",
      text: String((hit.record.data as { text?: unknown }).text ?? ""), score: hit.score, from: this.id,
    }));
  }
}

export interface RetrievalResult {
  passages: RetrievedPassage[];
  /** How the second pass ordered them, and how many model requests it took (0 or 1). */
  reranked: RerankSettings["mode"] | "embeddings";
  rerankCalls: number;
  note: string;
  /** Which named order ran. "default" is every retriever at once, the way it has always worked. */
  pipeline: string;
  /** One line per step of a named order: what it was allowed, and what it actually brought back. */
  stages: StageReport[];
}

/** Every retriever together, with the second pass applied once over their combined answers. */
export class Retrieval {
  private readonly retrievers: Retriever[] = [];
  private readonly localReranks = new Set<AbortController>();
  /** Installed by the factory: the independently chosen, guarded local embedding source. */
  localEmbeddingSource: (owner: string) => LocalRerankSource | null = () => null;
  cancelLocalReranks(): void { for (const pending of this.localReranks) pending.abort(); this.localReranks.clear(); }
  constructor(private readonly store: Store, private readonly owner: string, private readonly models?: ModelRouter) {}
  add(retriever: Retriever): void { this.retrievers.push(retriever); }
  list(): { id: string; label: string }[] { return this.retrievers.map((r) => ({ id: r.id, label: r.label })); }
  settings(owner: string): RerankSettings {
    const saved = RerankSettingsSchema.safeParse(this.store.get("settings", owner, "reranking")?.data ?? {});
    return saved.success ? saved.data : RerankSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): RerankSettings {
    const value = RerankSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    this.store.save("settings", owner, "reranking", value);
    return value;
  }
  view(owner: string) {
    return { settings: this.settings(owner), retrievers: this.list(), modelRerankReady: Boolean(this.models),
      ...this.pipelineSettings(owner) };
  }
  /** The orders the owner has written down, and which knowledge base uses which. */
  pipelineSettings(owner: string): RetrievalPipelineSettings {
    const saved = RetrievalPipelineSettingsSchema.safeParse(this.store.get("settings", owner, "retrieval-pipelines")?.data ?? {});
    return saved.success ? saved.data : RetrievalPipelineSettingsSchema.parse({});
  }
  configurePipelines(owner: string, input: unknown): RetrievalPipelineSettings {
    const value = RetrievalPipelineSettingsSchema.parse({ ...this.pipelineSettings(owner), ...(input as object) });
    this.store.save("settings", owner, "retrieval-pipelines", value);
    return value;
  }
  /**
   * Asks every retriever, merges what they found, then puts the best first — unless the owner has
   * written down a named order for this search, in which case the steps run one after another with
   * the ceiling each was given.
   */
  async search(owner: string, query: string, signal?: AbortSignal,
    wanted: { pipeline?: string; collection?: string | string[] } = {}): Promise<RetrievalResult> {
    const settings = this.settings(owner);
    const chosen = pipelineFor(this.pipelineSettings(owner), wanted);
    if (chosen) return this.runPipeline(owner, query, chosen, settings, signal);
    const found = await Promise.all(this.retrievers.map((retriever) =>
      retriever.retrieve(owner, query, settings.candidates, signal).catch(() => [] as RetrievedPassage[])));
    const candidates = mergePassages(found.flat(), settings.candidates);
    if (!candidates.length) return empty(settings.mode);
    return this.rerank(owner, query, candidates, settings, signal);
  }
  /** One named order, step by step, each step held to its own ceiling before the next one runs. */
  private async runPipeline(owner: string, query: string, pipeline: NamedPipeline,
    settings: RerankSettings, signal?: AbortSignal): Promise<RetrievalResult> {
    const known = this.retrievers.map((entry) => entry.id);
    const stages: StageReport[] = [];
    let gathered: RetrievedPassage[] = [];
    let keep = settings.keep;
    for (const stage of orderedStages(pipeline, settings.keep)) {
      if (stage.retriever === rerankStage) { keep = stage.cap; stages.push({ ...stage, found: Math.min(gathered.length, keep), note: "" }); continue; }
      const retriever = this.retrievers.find((entry) => entry.id === stage.retriever);
      if (!retriever) { stages.push({ ...stage, found: 0, note: noSuchRetriever(stage.retriever, known) }); continue; }
      const found = (await retriever.retrieve(owner, query, stage.cap, signal).catch(() => [] as RetrievedPassage[])).slice(0, stage.cap);
      stages.push({ ...stage, found: found.length, note: "" });
      gathered = mergePassages([...gathered, ...found], settings.candidates);
    }
    const note = stages.map((stage) => stage.note).filter(Boolean).join(" ");
    if (!gathered.length) return { ...empty(settings.mode), pipeline: pipeline.name, stages, note };
    const result = await this.rerank(owner, query, gathered, { ...settings, keep }, signal);
    return { ...result, pipeline: pipeline.name, stages, note: [result.note, note].filter(Boolean).join(" ") };
  }
  private async rerank(owner: string, query: string, candidates: RetrievedPassage[], settings: RerankSettings, signal?: AbortSignal): Promise<RetrievalResult> {
    if (settings.mode === "model" && this.models) {
      const chosen = await modelRerank(this.models, owner, query, candidates, settings.keep, signal ?? AbortSignal.timeout(20000));
      return { passages: chosen.passages, reranked: "model", rerankCalls: chosen.calls, note: chosen.note, pipeline: "default", stages: [] };
    }
    const local = settings.mode === "words" ? await this.localRerank(owner, query, candidates, settings, signal) : null;
    if (local !== null) return { passages: local, reranked: "embeddings", rerankCalls: 0, note: "", pipeline: "default", stages: [] };
    return { passages: lexicalRerank(query, candidates, settings.keep), reranked: "words", rerankCalls: 0, note: "", pipeline: "default", stages: [] };
  }
  private async localRerank(owner: string, query: string, candidates: RetrievedPassage[], settings: RerankSettings,
    signal?: AbortSignal): Promise<RetrievedPassage[] | null> {
    const abort = new AbortController();
    const bounded = AbortSignal.any([abort.signal, AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
    this.localReranks.add(abort);
    try {
      const source = this.localEmbeddingSource(owner);
      if (!source) return null;
      return await embeddingRerank(query, candidates, settings.keep, settings.relevanceThreshold, source, bounded);
    } catch { signal?.throwIfAborted(); return null; }
    finally { this.localReranks.delete(abort); }
  }
  /** Puts an already-found list in the best order, for the libraries that search on their own. */
  async order(owner: string, query: string, passages: RetrievedPassage[], signal?: AbortSignal): Promise<RetrievedPassage[]> {
    if (!passages.length) return passages;
    const settings = this.settings(owner);
    return (await this.rerank(owner, query, passages.slice(0, settings.candidates), settings, signal)).passages;
  }
  /** The owner this retrieval belongs to, for callers that hold only the façade. */
  get defaultOwner(): string { return this.owner; }
}

/** Nothing found, in the shape every search answers in. */
const empty = (mode: RerankSettings["mode"]): RetrievalResult =>
  ({ passages: [], reranked: mode, rerankCalls: 0, note: "", pipeline: "default", stages: [] });
