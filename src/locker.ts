import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { healthChanged } from "./health-changes.js";
import { assertHealthCurrent } from "./health-check.js";

/**
 * The locker holds project-scoped secrets. Values are encrypted at rest (AES-256-GCM) with a key
 * kept outside the database, are never returned by the HTTP API, and reach a program only through
 * the host command boundary as environment variables; command output is scrubbed of them after.
 */
export interface LockerKeySource { key(): Promise<Buffer> }
export const secretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use an environment-style name such as DEPLOY_TOKEN");
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Project ids use lowercase letters, digits and dashes");
const valueSchema = z.string().min(1).max(8192).refine((v) => !v.includes("\0"), "NUL is not permitted");

/** A random 32-byte key kept in a private file, created on first use. */
export class FileLockerKey implements LockerKeySource {
  private cached: Buffer | undefined;
  constructor(private readonly path: string) {}
  async key(): Promise<Buffer> {
    if (this.cached) return this.cached;
    try {
      const existing = await readFile(this.path);
      if (existing.length !== 32) throw new Error("The locker key file is damaged; move it aside to start a new one");
      return (this.cached = existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const fresh = randomBytes(32);
      try { await writeFile(this.path, fresh, { mode: 0o600, flag: "wx" }); } catch (made) {
        // Another reader of the same key (the ChatGPT sign-in file shares it) made it first: that one is the key.
        if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw made;
        return this.key();
      }
      return (this.cached = fresh);
    }
  }
}

export class Locker {
  constructor(private readonly db: DatabaseSync, private readonly keys: LockerKeySource) {
    db.exec(`CREATE TABLE IF NOT EXISTS locker(owner TEXT NOT NULL, project TEXT NOT NULL, name TEXT NOT NULL,
      iv BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(owner,project,name))`);
  }
  async set(owner: string, project: string, name: string, value: string): Promise<{ project: string; name: string; createdAt: string }> {
    projectIdSchema.parse(project); secretNameSchema.parse(name); valueSchema.parse(value);
    if (this.names(owner, project).length >= 64 && !this.exists(owner, project, name)) throw new Error("At most 64 secrets per project");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", await this.keys.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]), tag = cipher.getAuthTag();
    const createdAt = new Date().toISOString();
    assertHealthCurrent();
    this.db.prepare(`INSERT INTO locker VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,project,name)
      DO UPDATE SET iv=excluded.iv,tag=excluded.tag,ciphertext=excluded.ciphertext,created_at=excluded.created_at`)
      .run(owner, project, name, iv, tag, ciphertext, createdAt);
    healthChanged(this.db, { kind: "credential", owner, project, id: name });
    return { project, name, createdAt };
  }
  /**
   * provider-audit: several secrets of one project written, and others removed, in one transaction: all of it or none.
   * Every value is checked and sealed first; only then is the database touched, in one synchronous run, so a failure
   * part way (a full project, a database error) never leaves some parts new and some old.
   */
  async setAll(owner: string, project: string, values: Record<string, string>, remove: readonly string[] = []): Promise<void> {
    projectIdSchema.parse(project);
    for (const [name, value] of Object.entries(values)) { secretNameSchema.parse(name); valueSchema.parse(value); }
    for (const name of remove) secretNameSchema.parse(name);
    const key = await this.keys.key(), createdAt = new Date().toISOString();
    const sealed = Object.entries(values).map(([name, value]) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return { name, iv, tag: cipher.getAuthTag(), ciphertext };
    });
    const kept = new Set(this.names(owner, project).map((row) => row.name));
    for (const name of remove) kept.delete(name);
    for (const row of sealed) kept.add(row.name);
    if (kept.size > 64) throw new Error("At most 64 secrets per project");
    this.db.exec("SAVEPOINT locker_set_all");
    try {
      const upsert = this.db.prepare(`INSERT INTO locker VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,project,name)
        DO UPDATE SET iv=excluded.iv,tag=excluded.tag,ciphertext=excluded.ciphertext,created_at=excluded.created_at`);
      for (const row of sealed) upsert.run(owner, project, row.name, row.iv, row.tag, row.ciphertext, createdAt);
      const drop = this.db.prepare("DELETE FROM locker WHERE owner=? AND project=? AND name=?");
      for (const name of remove) drop.run(owner, project, name);
      this.db.exec("RELEASE locker_set_all");
    } catch (error) {
      this.db.exec("ROLLBACK TO locker_set_all"); this.db.exec("RELEASE locker_set_all");
      throw error;
    }
  }
  names(owner: string, project: string): { name: string; createdAt: string }[] {
    return this.db.prepare("SELECT name,created_at FROM locker WHERE owner=? AND project=? ORDER BY name").all(owner, project)
      .map((row) => ({ name: String(row.name), createdAt: String(row.created_at) }));
  }
  exists(owner: string, project: string, name: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM locker WHERE owner=? AND project=? AND name=?").get(owner, project, name);
  }
  remove(owner: string, project: string, name: string): boolean {
    const removed = this.db.prepare("DELETE FROM locker WHERE owner=? AND project=? AND name=?").run(owner, project, name).changes > 0;
    if (removed) healthChanged(this.db, { kind: "credential", owner, project, id: name });
    return removed;
  }
  removeProject(owner: string, project: string): number {
    const removed = Number(this.db.prepare("DELETE FROM locker WHERE owner=? AND project=?").run(owner, project).changes);
    if (removed) healthChanged(this.db, { kind: "credential", owner, project, id: "*" });
    return removed;
  }
  /** Values for the named secrets of one project, for injection only. Any name outside that project is refused. */
  async resolve(owner: string, project: string, names: string[]): Promise<Record<string, string>> {
    const key = await this.keys.key(), values: Record<string, string> = {};
    for (const name of new Set(names)) {
      const row = this.db.prepare("SELECT iv,tag,ciphertext FROM locker WHERE owner=? AND project=? AND name=?").get(owner, project, name);
      if (!row) throw new Error(`Secret ${name} is not available in the active project (${project})`);
      const decipher = createDecipheriv("aes-256-gcm", key, row.iv as Buffer);
      decipher.setAuthTag(row.tag as Buffer);
      values[name] = Buffer.concat([decipher.update(row.ciphertext as Buffer), decipher.final()]).toString("utf8");
    }
    return values;
  }
}

/** Replaces every secret value in text with a placeholder naming the secret. */
export function scrubSecrets(text: string, values: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(values))
    if (value.length >= 4) result = result.split(value).join(`[secret ${name}]`);
  return result;
}
