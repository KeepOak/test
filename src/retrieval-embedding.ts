import { cosine } from './document-embeddings.js';
import { embeddingsFor, type EmbeddingConnection, type Embeddings, type EmbeddingSources } from './embeddings.js';
import type { RetrievedPassage } from './retrieval.js';

export interface LocalRerankSource { reader: Embeddings; current: () => boolean }
interface LocalRerankGuards {
  allowed(): boolean;
  policy(): string;
  fetchFor(connection: EmbeddingConnection): typeof fetch;
  assertAllowed(target: URL): void;
}

/** Original code. Only the cosine/threshold approach was reviewed in Open WebUI; none of its code is copied. */
export function localRerankSource(sources: EmbeddingSources, owner: string, guards: LocalRerankGuards): LocalRerankSource | null {
  if (!guards.allowed()) return null;
  const connection = sources.connection(owner);
  if (!connection?.local) return null;
  // Private, in-memory equality only: no endpoint, credential or signature is returned or logged.
  const signature = () => JSON.stringify([sources.settings(owner), sources.connection(owner), guards.policy()]);
  const initial = signature();
  const current = () => guards.allowed() && signature() === initial;
  const check = () => { if (!current()) throw new Error('The local reranking source changed'); };
  const base = guards.fetchFor(connection);
  const fetchImpl: typeof fetch = async (input, init) => {
    check();
    const target = new URL(input instanceof Request ? input.url : String(input));
    guards.assertAllowed(target);
    const response = await base(input, { ...init, redirect: 'error' });
    check(); guards.assertAllowed(target);
    return response;
  };
  const reader = embeddingsFor({ ...connection, fetchImpl }, fetchImpl);
  return reader?.local ? { reader, current } : null;
}

/** Invalid or unavailable vectors mean word fallback; a valid threshold can intentionally keep no passages. */
export async function embeddingRerank(
  query: string, passages: RetrievedPassage[], keep: number, threshold: number,
  source: LocalRerankSource, signal: AbortSignal,
): Promise<RetrievedPassage[] | null> {
  if (!source.reader.local || !source.current()) return null;
  signal.throwIfAborted();
  await source.reader.prepare?.(signal);
  signal.throwIfAborted();
  if (!source.current()) return null;
  const identity = source.reader.vectorKey;
  // One query and at most fifty bounded passage prefixes; every vector is from the same reader/batch.
  const vectors = await source.reader.embed([query.slice(0, 500), ...passages.map(p => p.text.slice(0, 2048))], signal);
  signal.throwIfAborted();
  if (!source.current() || source.reader.vectorKey !== identity || vectors.length !== passages.length + 1) return null;
  const queryVector = vectors[0];
  if (!queryVector?.length || queryVector.length > 8192) return null;
  if (vectors.some(v => v.length !== queryVector.length || v.some(n => !Number.isFinite(n)) || !v.some(n => n !== 0))) return null;
  return passages.map((passage, at) => ({ passage, at, score: Math.max(-1, Math.min(1, cosine(queryVector, vectors[at + 1]!))) }))
    .filter(row => row.score >= threshold).sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, keep).map(row => ({ ...row.passage, score: row.score }));
}
