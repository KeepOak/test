import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scrubSecrets, secretNameSchema, projectIdSchema, type Locker } from "./locker.js";

/**
 * One service in front of the secrets locker. Tools and settings pass a reference such as
 * `secret://default/DEPLOY_TOKEN` instead of the value itself; the value is looked up only at the
 * moment it is handed to a program, a web address or a provider, and every value that has ever
 * been looked up is taken back out of results, events, receipts, logs and error messages.
 */
const referenceText = "secret://([a-z0-9][a-z0-9-]{0,39})/([A-Z][A-Z0-9_]{0,63})";
const anyReference = new RegExp(referenceText, "g");
const wholeReference = new RegExp(`^${referenceText}$`);
export interface SecretRef { project: string; name: string }
/** The reference text for a secret, for settings screens and documentation. */
export const secretReference = (project: string, name: string): string => `secret://${project}/${name}`;
export function parseSecretReference(value: unknown): SecretRef | null {
  const match = typeof value === "string" ? wholeReference.exec(value) : null;
  return match ? { project: match[1]!, name: match[2]! } : null;
}

const maxDepth = 8;
/** Rewrites every string inside a value (objects, arrays, nested) and leaves everything else alone. */
export function mapStrings<T>(value: T, change: (text: string) => string, depth = 0): T {
  if (typeof value === "string") return change(value) as T;
  if (depth >= maxDepth || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, change, depth + 1)) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = mapStrings(entry, change, depth + 1);
  return result as T;
}
/** Every secret reference inside a value, so the runtime knows what to look up before a call. */
export function collectReferences(value: unknown): SecretRef[] {
  const found = new Map<string, SecretRef>();
  mapStrings(value, (text) => {
    for (const match of text.matchAll(anyReference))
      found.set(`${match[1]}/${match[2]}`, { project: match[1]!, name: match[2]! });
    return text;
  });
  return [...found.values()];
}

/**
 * Remembers every secret value this launch has unlocked so one scrubber can take them back out
 * wherever they might have ended up. Values shorter than four characters are left alone: they
 * would match ordinary words.
 */
export class SecretScrubber {
  private readonly seen = new Map<string, string>();
  remember(name: string, value: string): void {
    if (value.length < 4 || this.seen.size >= 512) return;
    this.seen.set(value, name);
  }
  get size(): number { return this.seen.size; }
  /** The values themselves, for a guard that looks for them where they must not go (src/egress-guard.ts). */
  values(): string[] { return [...this.seen.keys()]; }
  text(input: string): string {
    let result = input;
    for (const [value, name] of this.seen) result = scrubSecrets(result, { [name]: value });
    return result;
  }
  /** The same replacement applied through a whole result, event payload or error. */
  deep<T>(value: T): T {
    return this.seen.size ? mapStrings(value, (text) => this.text(text)) : value;
  }
}

export const SecretOptionsSchema = z.object({
  /** Days until the owner is reminded to replace this secret; 0 means never remind. */
  expiresInDays: z.number().int().min(0).max(3650).default(0),
}).strict();
export interface SecretEntry {
  name: string; createdAt: string; rotatedAt: string | null;
  expiresAt: string | null; daysLeft: number | null; overdue: boolean;
}
export interface SecretUse { runId: string | null; project: string; name: string; purpose: string; usedAt: string }
const dayMs = 86_400_000;

/**
 * Something that can replace references of its own inside a value at the moment of a call. The
 * password managers on this computer are wired in this way, so the locker does not have to know
 * anything about them.
 */
export interface ReferenceFiller {
  fill<T>(value: T, use: { runId?: string | undefined; purpose: string }): Promise<T>;
}

export class Secrets {
  readonly scrubber = new SecretScrubber();
  /** Set by the session lock: it throws a plain reason when secrets may not be used yet. */
  gate: () => void = () => undefined;
  /**
   * The owner's own password manager, when they have switched that on. It is asked first, so a
   * `secret://bitwarden/...` reference never reaches the locker's own project look-up.
   */
  credentials: ReferenceFiller | null = null;
  /**
   * Batch 20 (wave 8): the other sources that are not the locker's own projects — a command of the
   * owner's above all. They are asked before the project look-up too, so a reference like
   * `secret://cmd/deploy` is never refused for the wrong reason. See src/vault-sources.ts for the
   * contract they all follow.
   */
  readonly sources: ReferenceFiller[] = [];
  constructor(private readonly db: DatabaseSync, private readonly locker: Locker) {
    db.exec(`CREATE TABLE IF NOT EXISTS secret_meta(owner TEXT NOT NULL, project TEXT NOT NULL, name TEXT NOT NULL,
      rotated_at TEXT, expires_at TEXT, PRIMARY KEY(owner,project,name));
      CREATE TABLE IF NOT EXISTS secret_use(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, run_id TEXT,
      project TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL, used_at TEXT NOT NULL)`);
  }

  /**
   * Saves a secret for the first time, or replaces one without counting it as a replacement. With `expect`, only while
   * the value held at the moment of writing is one it accepts (Locker.set; LockerConflict otherwise).
   */
  async put(owner: string, project: string, name: string, value: string, options: unknown = {},
    expect?: (current: string | null) => boolean): Promise<SecretEntry> {
    const { expiresInDays } = SecretOptionsSchema.parse(options ?? {});
    const saved = await this.locker.set(owner, project, name, value, expect);
    this.writeMeta(owner, project, name, null, expiresInDays ? new Date(Date.now() + expiresInDays * dayMs).toISOString() : null);
    return this.entry(owner, project, name, saved.createdAt);
  }
  /** Replaces the value and records the day it happened, so the reminder clock starts again. */
  async rotate(owner: string, project: string, name: string, value: string, options: unknown = {}): Promise<SecretEntry> {
    projectIdSchema.parse(project); secretNameSchema.parse(name);
    if (!this.locker.exists(owner, project, name)) throw new Error(`There is no secret called ${name} in ${project} to replace`);
    const { expiresInDays } = SecretOptionsSchema.parse(options ?? {});
    const keepDays = expiresInDays || this.reminderDays(owner, project, name);
    const saved = await this.locker.set(owner, project, name, value);
    this.writeMeta(owner, project, name, saved.createdAt, keepDays ? new Date(Date.now() + keepDays * dayMs).toISOString() : null);
    return this.entry(owner, project, name, saved.createdAt);
  }
  remove(owner: string, project: string, name: string): boolean {
    this.db.prepare("DELETE FROM secret_meta WHERE owner=? AND project=? AND name=?").run(owner, project, name);
    return this.locker.remove(owner, project, name);
  }
  /** Every secret of one project with its dates; values are never included. */
  list(owner: string, project: string): SecretEntry[] {
    return this.locker.names(owner, project).map((row) => this.entry(owner, project, row.name, row.createdAt));
  }
  /** Secrets whose reminder day has passed or is within a week, for the settings screen. */
  reminders(owner: string, projects: string[]): (SecretEntry & { project: string })[] {
    return projects.flatMap((project) => this.list(owner, project).map((entry) => ({ ...entry, project })))
      .filter((entry) => entry.daysLeft !== null && entry.daysLeft <= 7)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  }

  /**
   * Values for named secrets of one project, for injection only. Every look-up is remembered by the
   * scrubber and written to the audit, so the owner can see which task used which secret.
   */
  async resolve(owner: string, project: string, names: string[], use: { runId?: string | undefined; purpose: string }): Promise<Record<string, string>> {
    if (!names.length) return {};
    this.gate();
    const values = await this.locker.resolve(owner, project, names);
    const at = new Date().toISOString();
    for (const [name, value] of Object.entries(values)) {
      this.scrubber.remember(name, value);
      this.db.prepare("INSERT INTO secret_use(owner,run_id,project,name,purpose,used_at) VALUES(?,?,?,?,?,?)")
        .run(owner, use.runId ?? null, project, name, use.purpose.slice(0, 120), at);
    }
    return values;
  }
  /**
   * Replaces every `secret://project/NAME` reference inside a value with the real secret, at the
   * moment of the call and nowhere earlier. A reference to another project is refused.
   */
  async fill<T>(owner: string, project: string, value: T, use: { runId?: string | undefined; purpose: string }): Promise<T> {
    // The other sources go first: their reference names are not locker names, and reading one as a
    // project would turn "secret://cmd/deploy" or "secret://bitwarden/GitHub" into a refusal about
    // the wrong thing.
    let started = this.credentials ? await this.credentials.fill(value, use) : value;
    for (const source of this.sources) started = await source.fill(started, use);
    const references = collectReferences(started);
    if (!references.length) return started;
    const foreign = references.find((reference) => reference.project !== project);
    if (foreign) throw new Error(`${secretReference(foreign.project, foreign.name)} is not in the active project (${project})`);
    const values = await this.resolve(owner, project, references.map((reference) => reference.name), use);
    return mapStrings(started, (text) => text.replace(anyReference, (whole, _project, name: string) => values[name] ?? whole));
  }

  /** Which run used which secret, newest first. */
  audit(owner: string, limit = 200): SecretUse[] {
    return this.db.prepare("SELECT run_id,project,name,purpose,used_at FROM secret_use WHERE owner=? ORDER BY id DESC LIMIT ?")
      .all(owner, Math.min(Math.max(limit, 1), 1000))
      .map((row) => ({ runId: row.run_id === null ? null : String(row.run_id), project: String(row.project),
        name: String(row.name), purpose: String(row.purpose), usedAt: String(row.used_at) }));
  }

  private writeMeta(owner: string, project: string, name: string, rotatedAt: string | null, expiresAt: string | null): void {
    this.db.prepare(`INSERT INTO secret_meta VALUES(?,?,?,?,?) ON CONFLICT(owner,project,name)
      DO UPDATE SET rotated_at=excluded.rotated_at,expires_at=excluded.expires_at`).run(owner, project, name, rotatedAt, expiresAt);
  }
  private meta(owner: string, project: string, name: string): { rotatedAt: string | null; expiresAt: string | null } {
    const row = this.db.prepare("SELECT rotated_at,expires_at FROM secret_meta WHERE owner=? AND project=? AND name=?").get(owner, project, name);
    return { rotatedAt: row?.rotated_at ? String(row.rotated_at) : null, expiresAt: row?.expires_at ? String(row.expires_at) : null };
  }
  private entry(owner: string, project: string, name: string, createdAt: string): SecretEntry {
    const { rotatedAt, expiresAt } = this.meta(owner, project, name);
    const daysLeft = expiresAt === null ? null : Math.ceil((Date.parse(expiresAt) - Date.now()) / dayMs);
    return { name, createdAt, rotatedAt, expiresAt, daysLeft, overdue: daysLeft !== null && daysLeft <= 0 };
  }
  /** How many days the reminder was set for, so replacing a secret keeps the same rhythm. */
  private reminderDays(owner: string, project: string, name: string): number {
    const { rotatedAt, expiresAt } = this.meta(owner, project, name);
    if (!expiresAt) return 0;
    const started = Date.parse(rotatedAt ?? "") || Date.now();
    return Math.max(1, Math.round((Date.parse(expiresAt) - started) / dayMs));
  }
}
