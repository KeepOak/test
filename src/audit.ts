import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Store } from "./store.js";

/**
 * The record of what the assistant was allowed to do. Every moment that widens or narrows what
 * Branch Agent may reach — a yes or no to a question, a secret being handed to a command, a change
 * to the approval settings, a messaging account being paired, something being exported, a switch
 * to another project — is written here once and never changed afterwards. Two database rules
 * refuse any later edit or removal, so the list can only grow.
 */
export const auditActions = [
  "approval.decided", "secret.used", "policy.changed", "channel.paired",
  "data.exported", "profile.switched", "practice.switched",
  // Trying somebody else's AI-tool server from Settings reaches outside this computer, so it is
  // kept alongside the rest: which server, which tool, and how it ended.
  "mcp.tried",
  // Batch 19 (wave 7): somewhere kept giving the wrong key, PIN or pairing code and was made to wait.
  "auth.refused",
  // A drafted skill switched on without the trial it is meant to pass first. Only the owner can
  // do it, only by saying so in as many words, and it is written down every time.
  "skill.forced",
  // Batch 26 (wave 8): one of the owner's own checks stopped a tool call, or held it for a yes.
  "hook.blocked",
  // Batch 20 (wave 8): the rest of the moments that widen or narrow what Branch may reach — a
  // short-lived key made or taken back, a connection added or removed, everything locked down, and
  // a browser borrowed from the owner's own window.
  "token.issued", "connection.changed", "lockdown.changed", "browser.borrowed",
  // Wave 8: a connection that stays open — a live voice conversation — reaches outside this
  // computer for as long as it lasts, so every one is written down: which host, and how it ended.
  "network.connected",
  // Batch 26 (wave 8): a conversation, or one person messaging from outside, reached the ceiling
  // the owner set for a minute or an hour, and was held back or turned away.
  "limit.reached",
  // Batch 26 (wave 8): old conversations were offered for deletion, exported, or deleted.
  "history.pruned",
  // Wave mac2 (move-in): chats, memory, skills or settings were brought in from another assistant.
  "data.imported",
  // Q12: Branch changing its own source stepped outside its written contract and was refused, or
  // the owner widened that contract (src/self-development-contract.ts).
  "self_development.contract",
  // Somebody in a chat asked for a change to Branch itself, or the owner answered that request
  // (src/self-development-requests.ts). Only the owner's yes writes a contract.
  "self_development.request",
  // eng-trunk-controls: a Trunk, or all of them, was paused or resumed (src/trunks/pause.ts).
  "trunk.paused",
  // App lock: the PIN that opens a locked Branch was set, changed or removed (src/session-lock.ts).
  // Only that it happened is written; never the PIN.
  "lock.changed",
  // P17-D: the computers a Trunk may use, or how many tasks it may run at once, were changed (src/trunks/computers.ts).
  "trunk.computers",
] as const;
export type AuditAction = (typeof auditActions)[number];

/**
 * Where a task can start: the owner's own app, a schedule, a trigger, or another AI tool. This is
 * what the "started by" column holds, and it is the older, shorter of the two lists below.
 */
export const auditOrigins = ["owner", "trigger", "schedule", "mcp", "a2a", "acp", "system", "channel"] as const;
export type AuditOrigin = (typeof auditOrigins)[number];
/**
 * Where the moment itself happened. Everywhere a task can start, and also every chat app an answer
 * can be pressed in: a yes given on a phone is a yes given on Telegram, and the record should say
 * so in the column a person filters on rather than buried in the sentence beside it. What the task
 * itself came from is kept too, in `origin`, because "answered on WhatsApp" and "started by the
 * schedule" are two different facts and both matter.
 */
export const auditSources = [...auditOrigins,
  "telegram", "discord", "slack", "whatsapp", "email", "chat"] as const;
export type AuditSource = (typeof auditSources)[number];

export const AuditEntrySchema = z.object({
  action: z.enum(auditActions),
  /** Who did it, in plain words: the owner's name, or the part of the app that acted. */
  actor: z.string().trim().min(1).max(120).default("owner"),
  /** What it was about: a tool and target, a secret name, a channel, the thing exported. */
  subject: z.string().trim().max(300).default(""),
  /** Why, in plain language, for the person reading this later. */
  reason: z.string().trim().max(500).default(""),
  source: z.enum(auditSources).default("owner"),
  /** What the task itself came from, when that is not where the moment happened. */
  origin: z.enum(auditOrigins).optional(),
  runId: z.string().max(64).nullable().default(null),
  /** How it ended: "allowed", "refused", "saved", "failed" — one short word. */
  outcome: z.string().trim().min(1).max(60).default("done"),
}).strict();
export type AuditEntryInput = z.input<typeof AuditEntrySchema>;
export interface AuditEntry {
  id: number; owner: string; at: string; action: AuditAction; actor: string;
  subject: string; reason: string; source: AuditSource; origin: AuditOrigin;
  runId: string | null; outcome: string;
}
export const AuditQuerySchema = z.object({
  action: z.enum(auditActions).optional(),
  source: z.enum(auditSources).optional(),
  origin: z.enum(auditOrigins).optional(),
  /** ISO moments; entries outside the pair are left out. */
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(1000).default(200),
}).strict();
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** Plain-language labels for the "What the assistant was allowed to do" section. */
const actionLabels: Record<AuditAction, string> = {
  "approval.decided": "You answered a question about something it wanted to do",
  "secret.used": "A saved password or key was handed to a command",
  "policy.changed": "The approval settings were changed",
  "channel.paired": "A messaging account was connected or disconnected",
  "data.exported": "Something was exported out of the app",
  "profile.switched": "The active project was switched",
  "practice.switched": "The practice workspace was switched on or off",
  "mcp.tried": "You tried out another AI tool's server",
  "auth.refused": "Somewhere kept getting the key wrong and was made to wait",
  "skill.forced": "You switched on a drafted skill without trying it first",
  "hook.blocked": "One of your own checks stopped something, or asked you about it first",
  "token.issued": "A short-lived key for a script was made or taken back",
  "connection.changed": "A connection to a model service was added or removed",
  "lockdown.changed": "Everything was locked down, or let go again",
  "browser.borrowed": "Branch borrowed your own browser window, or gave it back",
  "network.connected": "A connection that stays open was made to a service outside this computer",
  "limit.reached": "Something reached the limit you set for a minute or an hour",
  "history.pruned": "Old conversations were offered for deletion, exported, or deleted",
  "data.imported": "Chats, memory or settings were brought in from another assistant",
  "self_development.contract": "Branch changing its own source was held to its contract, or the contract was widened",
  "self_development.request": "Somebody in a chat asked for a change to Branch itself, or you answered that request",
  "trunk.paused": "A Trunk was paused or resumed",
  "lock.changed": "The App lock PIN was set, changed or removed",
  "trunk.computers": "The computers a Trunk may use were changed",
};
export const auditLabel = (action: AuditAction): string => actionLabels[action];

export class AuditLog {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
      at TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL,
      source TEXT NOT NULL, run_id TEXT, outcome TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_owner_at ON audit(owner, at);
      CREATE TRIGGER IF NOT EXISTS audit_is_append_only_update BEFORE UPDATE ON audit
        BEGIN SELECT RAISE(ABORT, 'The record of what the assistant was allowed to do cannot be changed'); END;
      CREATE TRIGGER IF NOT EXISTS audit_is_append_only_delete BEFORE DELETE ON audit
        BEGIN SELECT RAISE(ABORT, 'The record of what the assistant was allowed to do cannot be removed'); END;`);
    // Batch 20 (wave 8): "where the moment happened" and "what the task came from" became two
    // columns. Rows written before that have no origin of their own; adding the column is the only
    // change that can be made, because the two rules above refuse any edit to a row that exists —
    // so an older row's origin is read back as its source, which is what it always meant.
    this.addOriginColumn();
    // FQ-collaboration.unified-search: the same lower-casing the search's words get in JS, so a
    // match in SQL is exactly a match in JS (SQLite's own lower() only folds ASCII).
    this.db.function("audit_fold", { deterministic: true }, (value) => String(value ?? "").toLowerCase());
  }
  private addOriginColumn(): void {
    const has = this.db.prepare("PRAGMA table_info(audit)").all()
      .some((row) => String(row.name) === "origin");
    if (!has) this.db.exec("ALTER TABLE audit ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
  }
  /** Writes one moment down. Nothing here may fail a task, so an unreadable entry is dropped. */
  record(owner: string, input: AuditEntryInput): AuditEntry | null {
    const parsed = AuditEntrySchema.safeParse(input);
    if (!parsed.success) return null;
    const value = parsed.data, at = new Date().toISOString();
    // With nothing said, the moment happened where the task came from, which is the older meaning.
    const origin: AuditOrigin = value.origin ?? (auditOrigins.includes(value.source as AuditOrigin) ? value.source as AuditOrigin : "owner");
    const row = this.db.prepare(`INSERT INTO audit(owner,at,action,actor,subject,reason,source,origin,run_id,outcome)
      VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .get(owner, at, value.action, value.actor, value.subject, value.reason, value.source, origin, value.runId, value.outcome);
    const entry: AuditEntry = { id: Number(row?.id ?? 0), owner, at, ...value, origin };
    for (const listener of this.recordListeners) { try { listener(entry); } catch { /* a listener never breaks the record */ } } // mac7/r17-g
    return entry;
  }
  // ── mac7/r17-g: the tamper-evident chain (src/safety-extras/activity-chain.ts) follows each entry. ──
  private readonly recordListeners = new Set<(entry: AuditEntry) => void>();
  onRecord(listener: (entry: AuditEntry) => void): () => void {
    this.recordListeners.add(listener);
    return () => { this.recordListeners.delete(listener); };
  }
  // ── end mac7/r17-g ──
  /** Entries newest first, narrowed by what happened, where it came from and when. */
  list(owner: string, input: unknown = {}): AuditEntry[] {
    const query = AuditQuerySchema.parse(input ?? {});
    const where = ["owner=?"];
    const values: (string | number)[] = [owner];
    if (query.action) { where.push("action=?"); values.push(query.action); }
    if (query.source) { where.push("source=?"); values.push(query.source); }
    // An older row has no origin of its own, and its source is what it meant, so both are matched.
    if (query.origin) { where.push("(origin=? OR (origin='' AND source=?))"); values.push(query.origin, query.origin); }
    if (query.from) { where.push("at>=?"); values.push(query.from); }
    if (query.to) { where.push("at<=?"); values.push(query.to); }
    return this.db.prepare(`SELECT * FROM audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...values, query.limit).map(toEntry);
  }
  /**
   * FQ-collaboration.unified-search: the newest entries whose actor, subject, reason or plain label
   * hold every one of `words` (already lower-cased), searched across the whole record rather than a
   * recent window, so an older match is still found.
   */
  search(owner: string, words: readonly string[], limit: number): AuditEntry[] {
    words = searchWords(words);
    if (!words.length) return [];
    const where = ["owner=?"];
    const values: string[] = [owner];
    for (const word of words) {
      const labelled = auditActions.filter((action) => auditLabel(action).toLowerCase().includes(word));
      const byLabel = labelled.length ? ` OR action IN (${labelled.map(() => "?").join(",")})` : "";
      where.push(`(instr(audit_fold(actor),?)>0 OR instr(audit_fold(subject),?)>0 OR instr(audit_fold(reason),?)>0${byLabel})`);
      values.push(word, word, word, ...labelled);
    }
    return this.db.prepare(`SELECT * FROM audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...values, limit).map(toEntry);
  }
  /** How many of each kind there are, for the plain-language summary. */
  counts(owner: string): { action: AuditAction; label: string; count: number }[] {
    const rows = this.db.prepare("SELECT action, COUNT(*) AS n FROM audit WHERE owner=? GROUP BY action").all(owner);
    const found = new Map(rows.map((row) => [String(row.action), Number(row.n)]));
    return auditActions.map((action) => ({ action, label: auditLabel(action), count: found.get(action) ?? 0 }));
  }
}
/**
 * The words worth matching: each word is checked on every entry, so repeats and words already inside a
 * longer one add cost and change nothing, and at most eight are kept (longest first, as they narrow most).
 */
function searchWords(words: readonly string[]): string[] {
  const unique = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length);
  return unique.filter((word, index) => !unique.slice(0, index).some((longer) => longer.includes(word))).slice(0, 8);
}
function toEntry(row: Record<string, unknown>): AuditEntry {
  const source = String(row.source) as AuditSource;
  return {
    id: Number(row.id), owner: String(row.owner), at: String(row.at), action: String(row.action) as AuditAction,
    actor: String(row.actor), subject: String(row.subject), reason: String(row.reason), source,
    // A row written before the two columns were told apart means its source, which is what it was.
    origin: (String(row.origin ?? "") || source) as AuditOrigin,
    runId: row.run_id === null ? null : String(row.run_id),
    outcome: String(row.outcome),
  };
}
/**
 * One cell. A leading `=`, `+`, `-` or `@` would make a spreadsheet treat the text as a formula,
 * so such a cell is prefixed with a single quote and stays plain text wherever it is opened.
 */
export const csvCell = (value: unknown): string => {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
/** The same entries as a spreadsheet file the owner can open anywhere. */
export function auditCsv(entries: AuditEntry[]): string {
  return ["at,action,what it means,who,about,why,where it happened,what started the task,task,outcome"]
    .concat(entries.map((entry) => [
      entry.at, entry.action, auditLabel(entry.action), entry.actor, entry.subject,
      entry.reason, entry.source, entry.origin, entry.runId ?? "", entry.outcome,
    ].map(csvCell).join(",")))
    .join("\n");
}
/** Convenience for call sites that hold a store: never throws, whatever the entry looks like. */
export function audit(store: Store, owner: string, input: AuditEntryInput): void {
  try { store.audit.record(owner, input); } catch { /* the record is a witness, never a gate */ }
}
