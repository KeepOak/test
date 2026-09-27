import type { DatabaseSync } from "node:sqlite";

/**
 * What a conversation's tasks left in the owner's lists, found and removed with "Delete now" (src/store.ts purgeForGood):
 * the facts memory learned only from those tasks, the to-dos and board cards they made, and the earlier file versions
 * they kept. A fact also taught elsewhere (another task, or the owner's own edit) stays, and stops naming the gone tasks.
 */
export interface Residue {
  facts: { id: string; owner: string; text: string }[];
  todos: { id: string; text: string }[];
  cards: { id: string; title: string }[];
  versions: { id: string; path: string }[];
}
type Attributed = { originRunId?: unknown; sourceRunId?: unknown };

const has = (db: DatabaseSync, table: string): boolean =>
  !!db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=?").get(table);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const parse = (raw: unknown): Record<string, unknown> => { try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; } };

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
  return {
    facts,
    todos: rows("todos", "text").map((row) => ({ id: row.id, text: row.label })),
    cards: rows("board_cards", "title").map((row) => ({ id: row.id, title: row.label })),
    versions: rows("file_versions", "path").map((row) => ({ id: row.id, path: row.label })),
  };
}

/** Removes the residue and every copy of a removed fact (its versions, archive, index, suggestions); call inside a transaction. */
export function forgetResidue(db: DatabaseSync, runIds: readonly string[], residue: Residue): void {
  const runs = new Set(runIds), list = JSON.stringify(runIds);
  for (const fact of residue.facts) {
    for (const table of ["memory", "memory_archive"]) if (has(db, table)) db.prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`).run(fact.owner, fact.id);
    if (has(db, "memory_versions")) db.prepare("DELETE FROM memory_versions WHERE owner=? AND memory_id=?").run(fact.owner, fact.id);
    if (has(db, "memory_terms")) {
      if (has(db, "memory_search")) db.prepare("DELETE FROM memory_search WHERE rowid IN (SELECT row_id FROM memory_terms WHERE owner=? AND memory_id=?)").run(fact.owner, fact.id);
      db.prepare("DELETE FROM memory_terms WHERE owner=? AND memory_id=?").run(fact.owner, fact.id);
    }
    for (const table of ["memory_vectors", "memory_uses"]) if (has(db, table)) db.prepare(`DELETE FROM ${table} WHERE owner=? AND memory_id=?`).run(fact.owner, fact.id);
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
  if (has(db, "memory_proposals")) db.prepare("DELETE FROM memory_proposals WHERE json_extract(data,'$.runId') IN (SELECT value FROM json_each(?))").run(list);
  if (has(db, "todos")) db.prepare("DELETE FROM todos WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  if (has(db, "board_cards")) db.prepare("DELETE FROM board_cards WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  if (has(db, "file_versions")) {
    const versions = JSON.stringify(residue.versions.map((version) => version.id));
    if (has(db, "workspace_undo")) db.prepare(`DELETE FROM workspace_undo WHERE version_id IN (SELECT value FROM json_each(?))
      OR redo_version_id IN (SELECT value FROM json_each(?))`).run(versions, versions);
    db.prepare("DELETE FROM file_versions WHERE run_id IN (SELECT value FROM json_each(?))").run(list);
  }
}
