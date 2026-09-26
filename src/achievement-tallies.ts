import type { DatabaseSync } from "node:sqlite";

/**
 * phase2/delight: what the owner has really done, counted from Branch's own records, for achievements.
 *
 * Read-only. Every number here comes from a row Branch wrote when the thing happened: a finished
 * task, a conversation, a tool that ran, a live voice call. Nothing is estimated, so switching
 * achievements on later still finds the past. Times are read in this computer's own time zone
 * ("localtime"), because "a task after midnight" means the owner's midnight.
 *
 * The events table is the big one (every step of every task), so it is never read whole: the counts
 * are kept with the owner's achievements (`EventScan`) and each look adds only the events written
 * since the last one, at most `eventBatch` of them, found by their ever-growing id. A busy history
 * is caught up over a few looks instead of stopping Branch for seconds (integration review: a full
 * scan of a million events took about 8 s, during which the server answered nothing).
 */
export interface AchievementTallies {
  /** Finished tasks, and the ones stopped part-way. */
  tasks: number;
  stopped: number;
  conversations: number;
  /** Finished tasks by where they came from: web (the window), schedule, channel (a chat app), trigger… */
  bySource: Record<string, number>;
  /** Every local day with at least one finished task, oldest first ("2026-09-19"). */
  days: string[];
  /** Finished tasks by local hour ("00".."23") and by weekday ("0" Sunday .. "6" Saturday). */
  hours: Record<string, number>;
  weekdays: Record<string, number>;
  /** Finished tasks begun between midnight and one on 21 December. */
  solstice: number;
  /** Tools that finished, by full name ("files.write") — the prefix is worked out by the reader. */
  tools: Record<string, number>;
  /** Every event kind the owner's tasks wrote ("voice.transcribed", "trunk.turn"…), counted. */
  events: Record<string, number>;
}
/** The events counted so far: every one with an id up to `through`. */
export interface EventScan {
  through: number;
  tools: Record<string, number>;
  events: Record<string, number>;
}
/** How many event ids one look reads at most (about a tenth of a second on a slow disk). */
export const eventBatch = 25_000;

type Row = Record<string, unknown>;
const bump = (counts: Record<string, number>, key: string, n: number): void => { counts[key] = (counts[key] ?? 0) + n; };

type TaskTallies = Omit<AchievementTallies, "tools" | "events" | "stopped" | "conversations">;
/** The last pass over each store's finished tasks, kept until one more finishes (or one is removed). */
const lastPass = new WeakMap<DatabaseSync, Map<string, { mark: string; tallies: TaskTallies }>>();

/** Setup polish 2: the tasks setup started (src/setup-origin.ts), a JSON list of ids, are first-run configuration and
    never counted. In every query here ?1 is the owner and ?2 that list. */
const notAside = "id NOT IN (SELECT value FROM json_each(?2))";

/** One pass over the owner's finished tasks, by local hour and source, added up here. Each row's time is
    turned into local time once, and the pass is reused while the finished tasks are the same ones. */
function finishedTasks(db: DatabaseSync, owner: string, aside: string): TaskTallies {
  const done = `FROM tasks WHERE owner=?1 AND status='completed' AND ${notAside}`;
  const seen = db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u ${done}`).get(owner, aside) as Row | undefined;
  const mark = `${String(seen?.n ?? 0)}|${String(seen?.u ?? "")}|${aside}`, kept = lastPass.get(db)?.get(owner);
  if (kept?.mark === mark) return kept.tallies;
  const rows = db.prepare(`SELECT substr(datetime(created_at,'localtime'),1,13) AS at, source AS s, COUNT(*) AS n ${done} GROUP BY at, s ORDER BY at`).all(owner, aside) as Row[];
  const out: TaskTallies = { tasks: 0, bySource: {}, days: [], hours: {}, weekdays: {}, solstice: 0 };
  for (const row of rows) {
    const at = String(row.at ?? ""), day = at.slice(0, 10), hour = at.slice(11, 13), n = Number(row.n ?? 0);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}$/.test(at)) continue;
    out.tasks += n;
    bump(out.bySource, String(row.s ?? ""), n);
    bump(out.hours, hour, n);
    bump(out.weekdays, String(new Date(`${day}T00:00:00Z`).getUTCDay()), n);
    if (out.days.at(-1) !== day) out.days.push(day);
    if (day.endsWith("-12-21") && hour === "00") out.solstice += n;
  }
  if (!lastPass.has(db)) lastPass.set(db, new Map());
  lastPass.get(db)?.set(owner, { mark, tallies: out });
  return out;
}
/** A conversation holding only setup's tasks (a Trunk introducing itself after setup made it) is not counted; the owner's
    own first task there later makes it count. */
const onlySetups = "EXISTS (SELECT 1 FROM tasks t WHERE t.session_id=s.id AND t.id IN (SELECT value FROM json_each(?2)))"
  + " AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.session_id=s.id AND t.id NOT IN (SELECT value FROM json_each(?2)))";
function taskTallies(db: DatabaseSync, owner: string, aside: string): Omit<AchievementTallies, "tools" | "events"> {
  const count = (sql: string): number => Number((db.prepare(sql).get(owner, aside) as Row | undefined)?.n ?? 0);
  return {
    ...finishedTasks(db, owner, aside),
    stopped: count(`SELECT COUNT(*) AS n FROM tasks WHERE owner=?1 AND status='cancelled' AND ${notAside}`),
    conversations: count(`SELECT COUNT(*) AS n FROM sessions s WHERE s.owner=?1 AND s.temporary=0 AND NOT (${onlySetups})`),
  };
}

/** Adds the owner's events written since `scan.through`, at most `eventBatch` ids. True once caught up. */
export function scanEvents(db: DatabaseSync, owner: string, scan: EventScan, aside = "[]"): boolean {
  const newest = Number((db.prepare("SELECT MAX(id) AS m FROM events").get() as Row | undefined)?.m ?? 0);
  // Fewer events than already counted means the records were replaced (a restored backup): count again.
  if (newest < scan.through) Object.assign(scan, { through: 0, tools: {}, events: {} });
  const upTo = Math.min(newest, scan.through + eventBatch);
  if (upTo <= scan.through) return true;
  const range = "FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.owner=?1 AND e.id>?3 AND e.id<=?4 AND t.id NOT IN (SELECT value FROM json_each(?2))";
  for (const row of db.prepare(`SELECT e.kind AS k, COUNT(*) AS n ${range} GROUP BY e.kind`).all(owner, aside, scan.through, upTo) as Row[])
    bump(scan.events, String(row.k ?? ""), Number(row.n ?? 0));
  for (const row of db.prepare(`SELECT json_extract(e.data,'$.name') AS k, COUNT(*) AS n ${range} AND e.kind='tool.completed' GROUP BY k`)
    .all(owner, aside, scan.through, upTo) as Row[])
    bump(scan.tools, String(row.k ?? ""), Number(row.n ?? 0));
  scan.through = upTo;
  return upTo >= newest;
}

/** Everything counted, with the events brought up to date as far as one look goes; `aside` is setup's tasks, never counted. */
export function achievementTallies(db: DatabaseSync, owner: string, scan: EventScan, aside: readonly string[] = []): { tallies: AchievementTallies; caughtUp: boolean } {
  const list = JSON.stringify(aside), caughtUp = scanEvents(db, owner, scan, list);
  return { tallies: { ...taskTallies(db, owner, list), tools: { ...scan.tools }, events: { ...scan.events } }, caughtUp };
}
