import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import type { TrunkMessages } from "./messages.js";

const recentLimit = 100, queueLimit = 100, parentLimit = 20;
type InboxStore = Pick<Store, "sqlite" | "run" | "runs" | "runTitles">;

/** A task's marker wins over today's conversation choice. Helpers inherit only from
 * recorded same-owner parents; a cycle or missing marker is never guessed from a chat. */
function attribution(store: InboxStore, owner: string): (id: string) => string | null {
  const memo = new Map<string, string | null>();
  return (id) => {
    const seen = new Set<string>();
    let cursor: string | null = id, found: string | null = null;
    while (cursor && seen.size < parentLimit && !seen.has(cursor)) {
      if (memo.has(cursor)) { found = memo.get(cursor) ?? null; break; }
      seen.add(cursor);
      if (store.run(cursor)?.owner !== owner) break;
      const marker: { trunk?: unknown } | undefined = store.sqlite.prepare("SELECT json_extract(data,'$.trunkId') AS trunk FROM events WHERE run_id=? AND kind='trunk.turn' ORDER BY id DESC LIMIT 1").get(cursor);
      if (typeof marker?.trunk === "string") { found = marker.trunk; break; }
      const start: { parent?: unknown } | undefined = store.sqlite.prepare("SELECT json_extract(data,'$.parentRunId') AS parent FROM events WHERE run_id=? AND kind='run.started' ORDER BY id LIMIT 1").get(cursor);
      cursor = typeof start?.parent === "string" ? start.parent : null;
    }
    if (found) for (const visited of seen) memo.set(visited, found);
    else memo.set(id, null);
    return found;
  };
}

/** A bounded owner-facing read; answering still uses the item's existing review controls. */
export function trunkInbox(store: InboxStore, owner: string, trunkId: string,
  runtime: Pick<Runtime, "waitingApprovals" | "deferrals">, messages: Pick<TrunkMessages, "waiting">) {
  const who = attribution(store, owner), recent = store.runs(owner).slice(0, recentLimit);
  const waiting = runtime.waitingApprovals(), handed = runtime.deferrals.list({ waiting: true });
  const ownRun = (id: string) => store.run(id)?.owner === owner;
  const runs = recent.filter((run) => who(run.id) === trunkId && !store.sqlite
    .prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.aside' LIMIT 1").get(run.id));
  const titles = store.runTitles(runs);
  const queuedMessages = messages.waiting().filter((message) => message.from === trunkId || message.to === trunkId);
  return {
    runs: runs.map((run) => ({ ...run, title: titles.get(run.id) ?? "" })),
    asks: waiting.slice(0, queueLimit).filter((q) => ownRun(q.runId) && (q.trunk ? q.trunk === trunkId : who(q.runId) === trunkId)),
    deferred: handed.slice(0, queueLimit).filter((job) => who(job.runId) === trunkId),
    messages: queuedMessages.slice(0, queueLimit),
    limits: { recentRuns: recentLimit, queueEntries: queueLimit, parentDepth: parentLimit,
      historyCapped: recent.length === recentLimit, queuesCapped: waiting.length > queueLimit || handed.length > queueLimit || queuedMessages.length > queueLimit },
  };
}
