import type { DatabaseSync } from "node:sqlite";

/** Synthetic opening rows anchor a conversation's project; they performed no task or model work. */
export const conversationBootstrap = { version: 1, kind: "conversation-opened" } as const;

/** Keep real work, malformed markers and ambiguous old rows in every usage counter. */
export function countedUsageTask(db: Pick<DatabaseSync, "prepare">, task: "tasks" | "t" = "tasks"): string {
  const events = `SELECT 1 FROM events e WHERE e.run_id=${task}.id`;
  const columns = new Set(db.prepare("PRAGMA table_info(usage)").all().map((row) => String(row.name)));
  const used = ["estimated_input", "estimated_output", "reported_input", "reported_output", "reported_cached_input", "reported_cache_write", "reported_cache_write_hour", "reports", "attempts", "unreported_calls", "incomplete_calls"]
    .filter((column) => columns.has(column)).map((column) => `u.${column}<>0`).join(" OR ") || "1";
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='governance'").get()
    ? `EXISTS (SELECT 1 FROM governance g WHERE g.owner=${task}.owner
        AND g.id='trunk:' || json_extract(g.data,'$.id')
        AND json_extract(g.data,'$.chatSessionId')=${task}.session_id
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=${task}.session_id AND s.owner=g.owner))` : "0";
  return `NOT COALESCE((
    ${task}.status='completed' AND ${task}.output='Opened'
    AND (SELECT COUNT(*) FROM events e WHERE e.run_id=${task}.id AND e.kind='run.aside' AND json(e.data)='{}')=1
    AND (SELECT COUNT(*) FROM events e WHERE e.run_id=${task}.id AND e.kind='run.aside')=1
    AND NOT EXISTS (${events} AND e.kind NOT IN ('run.aside','run.bootstrap'))
    AND NOT EXISTS (SELECT 1 FROM usage u WHERE u.run_id=${task}.id AND (${used}))
    AND (
      ((SELECT COUNT(*) FROM events e WHERE e.run_id=${task}.id AND e.kind='run.bootstrap')=1
        AND EXISTS (${events} AND e.kind='run.bootstrap' AND json_type(e.data,'$.version')='integer'
          AND json_extract(e.data,'$.version')=1 AND json_extract(e.data,'$.kind')='conversation-opened'))
      OR (NOT EXISTS (${events} AND e.kind='run.bootstrap') AND ${legacy})
    )
  ),0)`;
}

/** The current window hides bookkeeping only; stored tasks and events remain available to export. */
export function conversationBootstrapIds(db: Pick<DatabaseSync, "prepare">, owner: string): ReadonlySet<string> {
  return new Set(db.prepare(`SELECT id FROM tasks WHERE owner=? AND NOT (${countedUsageTask(db)})`).all(owner).map((row) => String(row.id)));
}
