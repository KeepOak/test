import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface PublicationIntent {
  cwd: string; workspace: string; remote: string; pushRepo: string; pushAddress: string; repository: string;
  branch: string; base: string; sha: string; walked: string; contractHash: string;
  files: string[]; runId?: string | undefined; receiptRunId?: string | undefined; adapter: "saved" | "computer";
  opening: { repo: string; title: string; body: string; base: string; head: string; draft: true; changes?: string[]; issue?: string };
}
export interface PublicationEntry extends PublicationIntent {
  id: string; state: "waiting" | "sending" | "published" | "blocked" | "cancelled";
  phase: "push" | "open"; attempts: number; nextAttemptAt: number; reason: string | null;
  pullRequest?: unknown;
}
export interface PublicationIO {
  validate(entry: PublicationEntry, signal: AbortSignal): Promise<void>;
  remote(entry: PublicationEntry, signal: AbortSignal): Promise<string | null>;
  push(entry: PublicationEntry, signal: AbortSignal): Promise<void>;
  find(entry: PublicationEntry, signal: AbortSignal): Promise<unknown | null>;
  open(entry: PublicationEntry, signal: AbortSignal): Promise<unknown>;
}
const running = new WeakMap<DatabaseSync, Map<string, AbortController>>();
const final = new Set(["published", "blocked", "cancelled"]);
const maxAttempts = 6;

/** Classify locally; never persist raw provider output, URLs with tokens, or credentials. */
export function publicationFailure(error: unknown): { retry: boolean; reason: string } {
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}` : "";
  const status = (error as { status?: number } | null)?.status;
  if (status === 429 || (status !== undefined && status >= 500))
    return { retry: true, reason: "GitHub is temporarily unavailable or rate limited. The exact saved change will be retried." };
  if (/401|403|404|422|bad credentials|authentication|permission|denied|forbidden|policy|contract|switched off|sign.in|non.fast.forward|rejected/i.test(text))
    return { retry: false, reason: "Publication is blocked by authentication, permissions, policy, or changed source. Review the connection and source contract before publishing again." };
  if (/429|50[0-4]|rate.limit|timeout|timed?.?out|ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND|fetch failed|socket|network|could not (be resolved|resolve)|couldn.t connect|unable to access|remote end hung|service unavailable|connection|having trouble right now/i.test(text))
    return { retry: true, reason: "GitHub could not be reached reliably. The exact saved change will be retried." };
  return { retry: false, reason: "Publication could not be safely completed. Review the saved change and connection before publishing again." };
}

/** Durable outbox. Claims expire after a bounded attempt; uncertain outcomes are reconciled on replay. */
export class PublicationQueue {
  constructor(private readonly db: DatabaseSync, private readonly owner: string, private readonly io: PublicationIO,
    private readonly now: () => number = Date.now,
    private readonly observe?: (entry: PublicationEntry) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS self_development_publications (
      id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, due INTEGER NOT NULL,
      state TEXT NOT NULL, PRIMARY KEY(id,owner));
      CREATE TABLE IF NOT EXISTS self_development_publication_receipts (
        id TEXT NOT NULL, owner TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(id,owner))`);
    if (!running.has(db)) running.set(db, new Map());
  }
  enqueue(intent: PublicationIntent): PublicationEntry {
    const id = createHash("sha256").update(JSON.stringify([this.owner, intent.cwd, intent.repository, intent.branch, intent.sha])).digest("hex");
    const entry: PublicationEntry = { ...intent, id, state: "waiting", phase: "push", attempts: 0, nextAttemptAt: this.now(), reason: null };
    this.db.prepare("INSERT OR IGNORE INTO self_development_publications VALUES(?,?,?,?,?)")
      .run(id, this.owner, JSON.stringify(entry), entry.nextAttemptAt, entry.state);
    const saved = this.get(id)!;
    this.notify(saved);
    return saved;
  }
  private notify(entry: PublicationEntry): void {
    if (!this.observe) return;
    // Evidence may be unavailable during shutdown; drain replays persisted state after restart.
    try {
      this.observe(entry);
      this.db.prepare("INSERT OR REPLACE INTO self_development_publication_receipts VALUES(?,?,?)")
        .run(entry.id, this.owner, `${entry.state}:${entry.phase}:${entry.attempts}`);
    } catch { /* no checkpoint: the durable state will be observed again */ }
  }
  get(id: string): PublicationEntry | null {
    const row = this.db.prepare("SELECT data FROM self_development_publications WHERE id=? AND owner=?").get(id, this.owner);
    return row ? JSON.parse(String(row.data)) as PublicationEntry : null;
  }
  list(): PublicationEntry[] {
    return this.db.prepare("SELECT data FROM self_development_publications WHERE owner=? ORDER BY CASE WHEN state IN ('waiting','sending','blocked') THEN 0 ELSE 1 END,due DESC LIMIT 500")
      .all(this.owner).map((row) => JSON.parse(String(row.data)) as PublicationEntry);
  }
  forBranch(cwd: string, branch: string): PublicationEntry | null {
    const row = this.db.prepare("SELECT data FROM self_development_publications WHERE owner=? AND json_extract(data,'$.cwd')=? AND json_extract(data,'$.branch')=? ORDER BY due DESC LIMIT 1")
      .get(this.owner, cwd, branch);
    return row ? JSON.parse(String(row.data)) as PublicationEntry : null;
  }
  cancel(id: string): PublicationEntry | null {
    const entry = this.get(id);
    if (!entry || entry.state === "published" || entry.state === "cancelled") return entry;
    running.get(this.db)!.get(`${this.owner}:${id}`)?.abort();
    return this.save({ ...entry, state: "cancelled", reason: "Publication cancelled. Any branch or pull request already sent remains on GitHub." });
  }
  /** Only an explicit owner action may restart a blocked intent; its pins and policy still apply. */
  async retry(id: string, signal: AbortSignal): Promise<PublicationEntry | null> {
    const entry = this.get(id);
    if (!entry || entry.state !== "blocked") return entry;
    try { signal.throwIfAborted(); await this.io.validate(entry, signal); signal.throwIfAborted(); }
    catch (error) {
      if (this.get(id)?.state !== "blocked") return this.get(id);
      return this.save({ ...entry, reason: publicationFailure(error).reason });
    }
    const ready = { ...entry, state: "waiting", attempts: 0, nextAttemptAt: this.now(), reason: null };
    const changed = this.db.prepare("UPDATE self_development_publications SET data=?,due=?,state='waiting' WHERE id=? AND owner=? AND state='blocked'")
      .run(JSON.stringify(ready), ready.nextAttemptAt, id, this.owner);
    if (!changed.changes) return this.get(id);
    this.notify(ready);
    return this.attempt(id, signal);
  }
  private save(entry: PublicationEntry): PublicationEntry {
    this.db.prepare("UPDATE self_development_publications SET data=?,due=?,state=? WHERE id=? AND owner=?")
      .run(JSON.stringify(entry), entry.nextAttemptAt, entry.state, entry.id, this.owner);
    this.notify(entry);
    return entry;
  }
  async attempt(id: string, signal: AbortSignal): Promise<PublicationEntry | null> {
    const entry = this.get(id), key = `${this.owner}:${id}`;
    if (!entry || final.has(entry.state) || entry.nextAttemptAt > this.now() || running.get(this.db)!.has(key)) return entry;
    if (signal.aborted) return entry;
    const claimed = this.db.prepare("UPDATE self_development_publications SET due=? WHERE id=? AND owner=? AND due<=? AND state IN ('waiting','sending')")
      .run(this.now() + 600_000, id, this.owner, this.now());
    if (!claimed.changes) return this.get(id);
    const controller = new AbortController(); running.get(this.db)!.set(key, controller);
    const active = this.save({ ...entry, state: "sending", attempts: entry.attempts + 1, nextAttemptAt: this.now() + 600_000 });
    try {
      await this.send(active, AbortSignal.any([signal, controller.signal, AbortSignal.timeout(240_000)]));
    } catch (error) {
      if (this.get(id)?.state !== "cancelled") this.failed(active, error, signal.aborted);
    } finally { running.get(this.db)!.delete(key); }
    return this.get(id);
  }
  private async send(entry: PublicationEntry, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await this.io.validate(entry, signal); signal.throwIfAborted();
    const remote = await this.io.remote(entry, signal);
    if (remote && remote !== entry.sha) throw new Error("Publication source changed: remote branch rejected");
    signal.throwIfAborted();
    if (!remote) {
      if (entry.phase === "open") throw new Error("Publication source changed: remote branch rejected");
      await this.io.push(entry, signal); signal.throwIfAborted();
    }
    entry.phase = "open"; this.save(entry);
    const existing = await this.io.find(entry, signal); signal.throwIfAborted();
    const result = existing ?? await this.io.open(entry, signal); signal.throwIfAborted();
    this.save({ ...entry, state: "published", reason: null, pullRequest: result });
  }
  private failed(entry: PublicationEntry, error: unknown, stopping: boolean): void {
    const failure = publicationFailure(error), exhausted = entry.attempts >= maxAttempts;
    this.save({ ...entry, state: (failure.retry || stopping) && !exhausted ? "waiting" : "blocked",
      nextAttemptAt: this.now() + Math.min(900_000, 15_000 * 2 ** (entry.attempts - 1)),
      reason: exhausted ? "Automatic publication retries stopped after six attempts. The local commit is safe; review publication status before trying again."
        : stopping ? "Publication paused while Branch stopped. Its remote outcome will be checked before retrying." : failure.reason });
  }
  async drain(signal: AbortSignal): Promise<void> {
    // Include terminal entries: a crash between the saved remote outcome and its task receipt
    // must not lose the link. Observers deduplicate by the durable publication identity.
    const unobserved = this.db.prepare(`SELECT p.data FROM self_development_publications p
      LEFT JOIN self_development_publication_receipts r ON r.id=p.id AND r.owner=p.owner
      WHERE p.owner=? AND (r.revision IS NULL OR r.revision !=
        p.state || ':' || json_extract(p.data,'$.phase') || ':' || json_extract(p.data,'$.attempts'))
      ORDER BY p.due,p.id LIMIT 100`).all(this.owner);
    for (const row of unobserved) { if (signal.aborted) return; this.notify(JSON.parse(String(row.data)) as PublicationEntry); }
    const due = this.db.prepare("SELECT id FROM self_development_publications WHERE owner=? AND state IN ('waiting','sending') AND due<=? ORDER BY due LIMIT 100")
      .all(this.owner, this.now());
    for (const entry of due) { if (signal.aborted) break; await this.attempt(String(entry.id), signal); }
  }
}
