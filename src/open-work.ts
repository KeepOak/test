import type { BackgroundProcesses } from "./processes.js";
import type { Store } from "./store.js";
import type { Wakeups } from "./wakeups.js";

/**
 * The lead's workbench (SELF-307): long sessions keep their open work. What a conversation still has going (helpers
 * working, wake-ups set, programs left running) is sent with every round of its tasks and never stored, beside the
 * checklist (src/coding/hooks.ts RoundNotes.every), so folding the conversation (Runtime.maybeCompact) never loses the
 * numbers the lead needs to message, cancel or stop them. Nothing is said when nothing is open.
 */
const most = 10;

function helpersWorking(store: Store, owner: string, sessionId: string): string[] {
  const rows = store.sqlite.prepare(`SELECT json_extract(e.data,'$.childRunId') AS child, json_extract(e.data,'$.prompt') AS brief
    FROM events e JOIN tasks t ON t.id=e.run_id JOIN tasks c ON c.id=json_extract(e.data,'$.childRunId')
    WHERE t.session_id=? AND t.owner=? AND e.kind='delegation.background_started' AND c.status IN ('running','needs_input')
    ORDER BY e.id DESC LIMIT ?`).all(sessionId, owner, most);
  return rows.map((row) => `- Helper ${String(row.child)} is working on: ${String(row.brief ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
}

export function openWork(store: Store, owner: string, sessionId: string, wakeups: Wakeups, processes: BackgroundProcesses): string | null {
  const lines = [
    ...helpersWorking(store, owner, sessionId),
    ...wakeups.list(sessionId).slice(0, most).map((one) => `- Wake-up ${one.id} at ${one.nextAt}`
      + `${one.cron ? ` (on "${one.cron}", ${one.timezone})` : one.everyMinutes ? ` (every ${one.everyMinutes} minutes)` : ""}: ${one.message.slice(0, 120)}`),
    ...processes.list({ sessionId, active: true }).slice(0, most).map((one) => `- Program ${one.id} "${one.name}" is running`),
  ];
  if (!lines.length) return null;
  return "Work still open in this conversation (use these numbers with helpers.message, helpers.stop, schedules.cancel_wake "
    + `and process.read or process.stop):\n${lines.join("\n")}`;
}
