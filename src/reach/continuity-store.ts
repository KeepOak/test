import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "../store.js";

export interface ContinuityRecord {
  id: string; sessionId: string; generation: number; peer: string; keyId: string;
  direction: "outgoing" | "incoming";
  state: "held" | "active" | "interrupted" | "stopping" | "released";
  prompt: string; runId: string | null; output: string; error: string | null;
  dispatched?: boolean; contextText?: string; contextFingerprint?: string; contextApproved?: boolean;
  contextRequested?: boolean; prepared?: boolean;
}
const initialized = new WeakSet<Store>();
const execution = new AsyncLocalStorage<{ id: string; generation: number }>();

/** Dedicated table: settings edits, profile changes and feature switches cannot erase a fence. */
export function continuityTable(store: Store): void {
  if (initialized.has(store)) return;
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS continuity_receipts (
    owner TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, direction TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(owner,id));
    CREATE INDEX IF NOT EXISTS continuity_session ON continuity_receipts(owner,session_id);`);
  initialized.add(store);
}
export function continuityRecords(store: Store, owner: string): ContinuityRecord[] {
  continuityTable(store);
  return store.sqlite.prepare("SELECT body FROM continuity_receipts WHERE owner=?").all(owner)
    .map((row) => JSON.parse(String(row.body)) as ContinuityRecord);
}
export function saveContinuity(store: Store, owner: string, record: ContinuityRecord): void {
  continuityTable(store);
  store.sqlite.prepare("INSERT INTO continuity_receipts(owner,id,session_id,direction,body) VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET body=excluded.body")
    .run(owner, record.id, record.sessionId, record.direction, JSON.stringify(record));
}
export const withContinuityExecution = <T>(record: ContinuityRecord, work: () => T): T =>
  execution.run({ id: record.id, generation: record.generation }, work);

function sessionRecords(store: Store, owner: string, sessionId: string): ContinuityRecord[] {
  continuityTable(store);
  return store.sqlite.prepare("SELECT body FROM continuity_receipts WHERE owner=? AND session_id=?").all(owner, sessionId)
    .map((row) => JSON.parse(String(row.body)) as ContinuityRecord);
}
/** Runtime calls this synchronously before admitting any task, including resumes and children. */
export function assertContinuitySession(store: Store, owner: string, sessionId?: string, parentRunId?: string, continuingRunId?: string): void {
  if (parentRunId) assertContinuityTool(store, owner, parentRunId);
  if (!sessionId) return;
  for (const row of sessionRecords(store, owner, sessionId)) {
    if (row.direction === "outgoing" && row.state === "released") continue;
    const held = execution.getStore();
    if (row.direction === "incoming" && row.state === "active" && held?.id === row.id && held.generation === row.generation) continue;
    if (row.direction === "incoming" && row.state === "active" && continuingRunId && row.runId === continuingRunId) continue;
    throw new Error("This conversation is held by a continuity transfer. Release it from Other computers before working here.");
  }
}
/** All ancestors matter: a specialist's fresh conversation cannot bypass its parent's fence. */
export function continuityRunChain(store: Store, runId: string): string[] {
  const found: string[] = [], queue = [runId];
  while (queue.length && found.length < 100) {
    const id = queue.shift()!;
    if (found.includes(id)) continue;
    found.push(id);
    const data = store.events(id).find((event) => event.kind === "run.started")?.data;
    for (const key of ["parentRunId", "resumedFrom", "originFrom"])
      if (typeof data?.[key] === "string") queue.push(data[key] as string);
  }
  if (queue.length) throw new Error("Cannot verify continuity ownership through this task's ancestry.");
  return found;
}
/** The central tool guard checks every real call, also after a remote stop or source wake. */
export function assertContinuityTool(store: Store, owner: string, runId: string): void {
  if (!runId) return;
  const chain = continuityRunChain(store, runId);
  for (const id of chain) {
    const run = store.run(id);
    if (!run) continue;
    for (const row of sessionRecords(store, owner, run.sessionId)) {
      if (row.direction === "outgoing" && row.state === "released") continue;
      if (row.direction === "incoming" && row.state === "active" && row.runId && chain.includes(row.runId)) continue;
      throw new Error("This task no longer owns execution: continuity has fenced this conversation.");
    }
  }
}
