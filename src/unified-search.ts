import { z } from "zod";
import type { createBranch } from "./index.js";
import { auditLabel } from "./audit.js";
import { historyKeywordLimit, historyKeywords } from "./history.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

export const UnifiedSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
}).strict();

/**
 * One row from any of the three places this searches. `link` is always a route the app can open
 * on its own (a conversation, a saved workflow, or the record of what the assistant was allowed to
 * do) so a result never needs its own new page.
 */
export interface UnifiedSearchResult {
  kind: "conversation" | "workflow" | "repository" | "document";
  title: string;
  snippet: string;
  link: string;
}

/** How many rows each source may contribute, so one busy source cannot crowd out the other two. */
const perSourceLimit = 5;
/**
 * Message hits read from history before they are grouped into conversations: more than
 * perSourceLimit, so one conversation with many matching messages cannot fill every place.
 * 20 is the most history.search itself allows.
 */
const conversationHitLimit = 20;

/** True when every word of the query appears somewhere in the text, ignoring case. */
function matchesAllWords(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.length > 0 && words.every((word) => lower.includes(word));
}

/**
 * FQ-collaboration.unified-search: one query, fanned out to the searches Branch already has —
 * conversations (src/history.ts, the same full-text index the "history.search" tool uses),
 * saved workflows (src/workflows.ts), and the durable record of what the assistant was allowed to
 * do (src/audit.ts, which is what the app treats as its "repository" of collaboration events). No
 * new index or database is created here; this only reads what those three already keep.
 */
export function unifiedSearch(app: Branch, owner: string, rawQuery: string): UnifiedSearchResult[] {
  // Its own guard, not only the route's walls: it reads across everything the owner has done.
  app.store.profiles.requireOwner("Search across everything");
  const { q } = UnifiedSearchQuerySchema.parse({ q: rawQuery });
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const results: UnifiedSearchResult[] = [];

  results.push(...conversationResults(app, owner, q));
  results.push(...documentResults(app, owner, q));
  results.push(...workflowResults(app, owner, words));
  results.push(...repositoryResults(app, owner, words));
  return results;
}

/**
 * Earlier conversations whose messages match the query, by the same search "history.search" uses:
 * one row per conversation (its best-ranked message), up to perSourceLimit conversations. History
 * takes at most historyKeywordLimit words, so a longer query is trimmed to its first ones here
 * rather than failing the whole search and losing the workflow and record matches with it.
 */
function conversationResults(app: Branch, owner: string, query: string): UnifiedSearchResult[] {
  const keywords = historyKeywords(query).slice(0, historyKeywordLimit);
  if (!keywords.length) return [];
  const found = app.store.searchHistory(owner, { query: keywords.join(" "), limit: conversationHitLimit }, "");
  const results: UnifiedSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of found) { // already best-ranked first
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    results.push({
      kind: "conversation",
      title: `Conversation ${row.sessionId.slice(0, 8)}`,
      snippet: row.excerpt,
      link: `/api/sessions/${row.sessionId}`,
    });
    if (results.length >= perSourceLimit) break;
  }
  return results;
}

/** Dogfood D13: documents in the owner's Library whose name or words hold the query (words only, on this computer). */
function documentResults(app: Branch, owner: string, query: string): UnifiedSearchResult[] {
  return app.documents.findByWords(owner, query, perSourceLimit).map((document) => ({
    kind: "document", title: document.name, snippet: document.snippet, link: `/api/documents/${document.id}`,
  }));
}

/** Saved workflows whose name, description or a step's output holds every word of the query. */
function workflowResults(app: Branch, owner: string, words: readonly string[]): UnifiedSearchResult[] {
  const results: UnifiedSearchResult[] = [];
  for (const workflow of app.workflows.list(owner)) {
    const stepOutputs = workflow.state.map((step) => step.output);
    const haystack = [workflow.name, workflow.description, ...stepOutputs].join(" ");
    if (!matchesAllWords(haystack, words)) continue;
    const matchedStep = workflow.state.find((step) => matchesAllWords(step.output, words));
    results.push({
      kind: "workflow",
      title: workflow.name,
      snippet: (matchedStep?.output || workflow.description || workflow.name).slice(0, 200),
      link: `/api/workflows/${workflow.id}`,
    });
    if (results.length >= perSourceLimit) break;
  }
  return results;
}

/** Entries from the audit record whose actor, subject, reason or label holds every word of the query. */
function repositoryResults(app: Branch, owner: string, words: readonly string[]): UnifiedSearchResult[] {
  return app.store.audit.search(owner, words, perSourceLimit).map((entry) => ({
    kind: "repository" as const,
    title: auditLabel(entry.action),
    snippet: entry.subject || entry.reason,
    // The audit record has no single-entry page; its list is the route the app already opens for it.
    link: "/api/audit",
  }));
}
