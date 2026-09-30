import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensureMarks } from "./conversation-actions.js";

/**
 * What a conversation's tasks left in the owner's lists, found and removed with "Delete now" (src/store.ts purgeForGood):
 * the facts memory learned only from those tasks, the to-dos and board cards they made, and the earlier file versions
 * they kept. A fact also taught elsewhere (another task, or the owner's own edit) stays, and stops naming the gone tasks.
 */
export interface Residue {
  facts: { id: string; owner: string; text: string }[];
  /** Facts learned only from these tasks that sit only in the archive or a memory checkpoint; removed from there too. */
  copies: string[];
  /**
   * The outside memory services these tasks sent something to (src/learning-more/providers.ts, src/asks/hindsight.ts).
   * Branch keeps no handle to what each service stored, so it cannot remove it there; the question says so.
   */
  outside: string[];
  todos: { id: string; text: string }[];
  cards: { id: string; title: string }[];
  versions: { id: string; path: string }[];
}
type Attributed = { originRunId?: unknown; sourceRunId?: unknown };

const has = (db: DatabaseSync, table: string): boolean =>
  !!db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=?").get(table);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const parse = (raw: unknown): Record<string, unknown> => { try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; } };
type Frozen = { id?: unknown; data?: Record<string, unknown> };
const frozen = (raw: unknown): Frozen[] => { try { const list = JSON.parse(String(raw)) as unknown; return Array.isArray(list) ? list as Frozen[] : []; } catch { return []; } };
const services: Record<string, string> = { mem0: "Mem0", honcho: "Honcho", hindsight: "Hindsight" };

/** Learned only from these tasks: the last task that saved it is one of them, and so is the first. */
export function learnedOnlyFrom(runs: ReadonlySet<string>, data: Attributed): boolean {
  const source = text(data.sourceRunId), origin = text(data.originRunId);
  return source !== "" && runs.has(source) && (origin === "" || runs.has(origin));
}
/** A fact that stays loses the gone tasks' names, keeping the task or owner edit that still supports it. */
function scrubbed(runs: ReadonlySet<string>, data: Record<string, unknown>): Record<string, unknown> | null {
  const source = text(data.sourceRunId), origin = text(data.originRunId);
  if (!runs.has(source) && !runs.has(origin)) return null;
  const next = { ...data };
  if (runs.has(source)) next.sourceRunId = runs.has(origin) ? "" : origin;
  if (runs.has(origin)) { if (text(next.sourceRunId)) next.originRunId = next.sourceRunId; else delete next.originRunId; }
  return next;
}

export function findResidue(db: DatabaseSync, runIds: readonly string[]): Residue {
  const runs = new Set(runIds), list = JSON.stringify(runIds);
  const facts = has(db, "memory") ? db.prepare("SELECT id, owner, data FROM memory").all()
    .map((row) => ({ id: String(row.id), owner: String(row.owner), data: parse(row.data) }))
    .filter((row) => learnedOnlyFrom(runs, row.data)).map((row) => ({ id: row.id, owner: row.owner, text: text(row.data.text) })) : [];
  const rows = (table: string, label: string) => has(db, table)
    ? db.prepare(`SELECT id, ${label} AS label FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?))`).all(list)
      .map((row) => ({ id: String(row.id), label: String(row.label) })) : [];
  const live = new Set(facts.map((fact) => fact.text)), copies = new Set<string>();
  const copy = (data: Record<string, unknown> | undefined) => {
    if (data && learnedOnlyFrom(runs, data) && text(data.text) && !live.has(text(data.text))) copies.add(text(data.text));
  };
  if (has(db, "memory_archive")) for (const row of db.prepare("SELECT data FROM memory_archive").all()) copy(parse(row.data));
  if (has(db, "memory_checkpoints"))
    for (const row of db.prepare("SELECT memories FROM memory_checkpoints").all()) for (const entry of frozen(row.memories)) copy(entry.data);
  const outside = has(db, "events") ? db.prepare(`SELECT DISTINCT CASE json_extract(data,'$.name') WHEN 'hindsight.retain' THEN 'hindsight'
      ELSE json_extract(data,'$.result.provider') END AS service FROM events WHERE kind='tool.completed' AND json_valid(data)
      AND json_extract(data,'$.name') IN ('memory.outside_keep','hindsight.retain') AND run_id IN (SELECT value FROM json_each(?))`).all(list)
    .map((row) => services[text(row.service)] ?? "").filter(Boolean) : [];
  return {
    facts, copies: [...copies], outside,
    todos: rows("todos", "text").map((row) => ({ id: row.id, text: row.label })),
    // Orchard: a card whose task was one of these goes with it, as the shared board's did.
    cards: [...rows("board_cards", "title"), ...rows("orchard_cards", "title")].map((row) => ({ id: row.id, title: row.label })),
    versions: rows("file_versions", "path").map((row) => ({ id: row.id, path: row.label })),
  };
}

/**
 * A memory checkpoint froze every fact as it was; putting one back must not bring a removed fact, or a gone task's name,
 * back. Drops the removed facts, and every fact learned only from these tasks, from each checkpoint; with `rename`, the
 * facts that stay stop naming tasks that are gone.
 */
export function scrubCheckpoints(db: DatabaseSync, runs: ReadonlySet<string>, removedFacts: readonly { id: string; owner: string }[], rename = true,
  keptFacts: readonly { id: string; owner: string }[] = []): void {
  if (!has(db, "memory_checkpoints")) return;
  const removed = new Set(removedFacts.map((fact) => `${fact.owner}\u0000${fact.id}`));
  const kept = new Set(keptFacts.map((fact) => `${fact.owner}\u0000${fact.id}`));
  for (const row of db.prepare("SELECT id, owner, memories FROM memory_checkpoints").all()) {
    const before = frozen(row.memories);
    const after = before.filter((entry) => kept.has(`${String(row.owner)}\u0000${text(entry.id)}`)
      || (!removed.has(`${String(row.owner)}\u0000${text(entry.id)}`) && !learnedOnlyFrom(runs, entry.data ?? {})))
      .map((entry) => { const next = rename ? scrubbed(runs, entry.data ?? {}) : null; return next ? { ...entry, data: next } : entry; });
    if (JSON.stringify(after) !== JSON.stringify(before))
      db.prepare("UPDATE memory_checkpoints SET memories=? WHERE id=?").run(JSON.stringify(after), String(row.id));
  }
}

/** Every copy of one fact kept beside it: archived, earlier wordings, and its place in search (words, meaning, uses). */
function dropFactCopies(db: DatabaseSync, fact: { id: string; owner: string }): void {
  if (has(db, "memory_archive")) db.prepare("DELETE FROM memory_archive WHERE owner=? AND id=?").run(fact.owner, fact.id);
  if (has(db, "memory_versions")) db.prepare("DELETE FROM memory_versions WHERE owner=? AND memory_id=?").run(fact.owner, fact.id);
  if (has(db, "memory_terms")) {
    if (has(db, "memory_search")) db.prepare("DELETE FROM memory_search WHERE rowid IN (SELECT row_id FROM memory_terms WHERE owner=? AND memory_id=?)").run(fact.owner, fact.id);
    db.prepare("DELETE FROM memory_terms WHERE owner=? AND memory_id=?").run(fact.owner, fact.id);
  }
  for (const table of ["memory_vectors", "memory_uses"]) if (has(db, table)) db.prepare(`DELETE FROM ${table} WHERE owner=? AND memory_id=?`).run(fact.owner, fact.id);
}

/**
 * Undoing a goal (src/goal-undo.ts) forgets its facts through the memory service, which keeps each one's last wording as a
 * version so an ordinary Forget can be taken back. A goal undone is meant to be gone: these remove the kept versions, the
 * archived copies, its place in search and the checkpoint copies of those facts, and the suggestions its tasks left waiting.
 * Call in a transaction.
 */
export function forgetFactCopies(db: DatabaseSync, runIds: readonly string[], facts: readonly { id: string; owner: string }[],
  keptFacts: readonly { id: string; owner: string }[] = []): void {
  const runs = new Set(runIds);
  const kept = new Set(keptFacts.map((fact) => `${fact.owner}\u0000${fact.id}`));
  for (const fact of facts) dropFactCopies(db, fact);
  if (has(db, "memory_archive"))
    for (const row of db.prepare("SELECT rowid AS k, owner, id, data FROM memory_archive").all())
      if (!kept.has(`${String(row.owner)}\u0000${String(row.id)}`) && learnedOnlyFrom(runs, parse(row.data)))
        db.prepare("DELETE FROM memory_archive WHERE rowid=?").run(Number(row.k));
  scrubCheckpoints(db, runs, facts, false, keptFacts); // the goal's tasks stay in the history, so the facts that stay keep naming them
  if (has(db, "memory_proposals"))
    db.prepare("DELETE FROM memory_proposals WHERE json_extract(data,'$.runId') IN (SELECT value FROM json_each(?))").run(JSON.stringify(runIds));
}

/** Removes the residue and every copy of a removed fact (its versions, archive, index, suggestions); call inside a transaction. */
export function forgetResidue(db: DatabaseSync, runIds: readonly string[], residue: Residue): void {
  const runs = new Set(runIds), list = JSON.stringify(runIds);
  for (const fact of residue.facts) {
    if (has(db, "memory")) db.prepare("DELETE FROM memory WHERE owner=? AND id=?").run(fact.owner, fact.id);
    dropFactCopies(db, fact);
  }
  // An archived fact, and the earlier wordings of one that stays, are handled by the same rule.
  for (const table of ["memory", "memory_archive", "memory_versions"]) {
    if (!has(db, table)) continue;
    for (const row of db.prepare(`SELECT rowid AS k, data FROM ${table}`).all()) {
      const data = parse(row.data);
      if (table === "memory_archive" && learnedOnlyFrom(runs, data)) { db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(Number(row.k)); continue; }
      const next = scrubbed(runs, data);
      if (next) db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(JSON.stringify(next), Number(row.k));
    }
  }
  scrubCheckpoints(db, runs, residue.facts);
  if (has(db, "memory_proposals")) db.prepare("DELETE FROM memory_proposals WHERE json_extract(data,'$.runId') IN (SELECT value FROM json_each(?))").run(list);
  if (has(db, "todos")) db.prepare("DELETE FROM todos WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  if (has(db, "board_cards")) db.prepare("DELETE FROM board_cards WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  if (has(db, "orchard_cards")) {
    const gone = "SELECT id FROM orchard_cards WHERE run_id IN (SELECT value FROM json_each(?))";
    if (has(db, "orchard_comments")) db.prepare(`DELETE FROM orchard_comments WHERE card IN (${gone})`).run(list);
    if (has(db, "orchard_links")) db.prepare(`DELETE FROM orchard_links WHERE parent IN (${gone}) OR child IN (${gone})`).run(list, list);
    db.prepare("DELETE FROM orchard_cards WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  }
  if (has(db, "file_versions")) {
    const versions = JSON.stringify(residue.versions.map((version) => version.id));
    if (has(db, "workspace_undo")) db.prepare(`DELETE FROM workspace_undo WHERE version_id IN (SELECT value FROM json_each(?))
      OR redo_version_id IN (SELECT value FROM json_each(?))`).run(versions, versions);
    db.prepare("DELETE FROM file_versions WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  }
}

/**
 * Conversations deleted for good, and their tasks, kept as a one-way digest of each id (never the id, never a word), on
 * this computer only and never in a backup (src/backup.ts). A backup from before the deletion put back over this install
 * (src/backup.ts importBackup, replacing) brings each one back into Recently Deleted rather than Recent, and never brings
 * back what memory learned only from its tasks.
 */
const digest = (kind: "conversation" | "task", id: string): string => createHash("sha256").update(`branch-forgotten:${kind}:${id}`).digest("hex");
export function ensureForgotten(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS conversations_forgotten(digest TEXT PRIMARY KEY, kind TEXT NOT NULL, forgotten_at TEXT NOT NULL)");
}
export function rememberForgotten(db: DatabaseSync, sessionIds: readonly string[], runIds: readonly string[], at: string): void {
  ensureForgotten(db);
  const put = db.prepare("INSERT OR REPLACE INTO conversations_forgotten(digest,kind,forgotten_at) VALUES(?,?,?)");
  for (const id of sessionIds) put.run(digest("conversation", id), "conversation", at);
  for (const id of runIds) put.run(digest("task", id), "task", at);
}
/** After a restore, inside its transaction: each conversation deleted for good that came back waits in Recently Deleted. */
export function settleForgotten(db: DatabaseSync, at: string): number {
  if (!has(db, "conversations_forgotten")) return 0;
  const known = new Set(db.prepare("SELECT digest FROM conversations_forgotten").all().map((row) => String(row.digest)));
  if (!known.size) return 0;
  const sessions = db.prepare("SELECT id, owner FROM sessions").all().filter((row) => known.has(digest("conversation", String(row.id))));
  const back = new Set(sessions.map((row) => String(row.id)));
  const runIds = db.prepare("SELECT id, session_id FROM tasks").all()
    .filter((row) => back.has(String(row.session_id)) || known.has(digest("task", String(row.id)))).map((row) => String(row.id));
  ensureMarks(db);
  for (const row of sessions) {
    db.prepare("INSERT OR IGNORE INTO conversation_marks(session_id,owner) VALUES(?,?)").run(String(row.id), String(row.owner));
    db.prepare("UPDATE conversation_marks SET deleted_at=? WHERE session_id=?").run(at, String(row.id));
  }
  if (runIds.length) forgetResidue(db, runIds, findResidue(db, runIds));
  return sessions.length;
}
