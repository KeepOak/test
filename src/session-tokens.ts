import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";

/**
 * Short-lived keys for the things that are not the app window: the SDK, a browser extension, a
 * small script. The local session key lets its holder do everything for as long as Branch is
 * installed, which is the wrong thing to paste into a script. A key made here says what it is for
 * ("read" may only look; "run" may also start a task), stops working at a stated minute, and can be
 * taken back at any time. Only the hash is kept, so the key itself exists once, on the screen it
 * was printed on, and nowhere else.
 *
 * The master session key is never one of these and is never touched by this file. That is
 * deliberate: a mistake here must be able to lock out a script, and never the owner.
 */
export const tokenScopes = ["read", "run"] as const;
/**
 * "a2a" is never offered to `branch token create`: it is the key a pairing link carries (src/a2a-client.ts), and it
 * reaches exactly the door another assistant uses, POST /a2a and the card at GET /.well-known/agent.json.
 */
export type TokenScope = (typeof tokenScopes)[number] | "a2a";
/** How long a key handed out in a pairing link works for. Pairing again makes a new one. */
export const pairingKeyDays = 30;

export const scopeDescriptions: Record<TokenScope, string> = {
  read: "May look at things only. It cannot start a task or change a setting.",
  run: "May look at things and start a task, but cannot change what Branch is allowed to do.",
  a2a: "May only hand this assistant a task the way another assistant does, and read its card.",
};

export const TokenRequestSchema = z.object({
  /** What the key is for, in the owner's own words, so a list of them means something later. */
  name: z.string().trim().min(1).max(80).default("A script"),
  scope: z.enum(tokenScopes).default("read"),
  /** How long it works for. A key with no end is not offered at all. */
  minutes: z.number().int().min(1).max(60 * 24 * 30).default(60),
  /** bucket 19: the one conversation this key is held to (a conversation handed to another device). */
  sessionId: z.string().uuid().optional(),
}).strict();
export type TokenRequest = z.input<typeof TokenRequestSchema>;

export interface TokenEntry {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
  /** bucket 19: the one conversation this key may reach, or null for a key that is not held to one. */
  sessionId: string | null;
}
/** A key exists in full exactly once: here, on the way back to whoever asked for it. */
export interface IssuedToken { entry: TokenEntry; token: string }

const prefix = "branch_";
const digest = (token: string): Buffer => createHash("sha256").update(token).digest();
const sameHash = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** What a request wants to do, so a "read" key can be told apart from one that starts work. */
export interface TokenUse {
  method: string; executes: boolean;
  /** bucket 19: the address asked for, so a key held to one conversation can be kept to it. */
  path?: string;
}
/** bucket 19: why a key held to `sessionId` may not use this address, or null (src/people/access.ts). */
export type BoundKeyCheck = (sessionId: string, method: string, path: string) => string | null;

export class SessionTokens {
  /** bucket 19: set by the app; with none set, a key held to a conversation is refused everywhere. */
  boundCheck: BoundKeyCheck = () => "This key only reaches the conversation it was made for.";
  constructor(private readonly db: DatabaseSync, private readonly store: Store) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_tokens(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      scope TEXT NOT NULL, hash BLOB NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, last_used_at TEXT, uses INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS session_tokens_owner ON session_tokens(owner, expires_at)`);
    // bucket 19: a key may be held to one conversation.
    if (!db.prepare("PRAGMA table_info(session_tokens)").all().some((row) => row.name === "session_id"))
      db.exec("ALTER TABLE session_tokens ADD COLUMN session_id TEXT");
  }

  /** Makes one key. The text is handed back once and never stored; only its hash is kept. */
  create(owner: string, input: unknown = {}): IssuedToken {
    const value = TokenRequestSchema.parse(input ?? {});
    return this.issue(owner, { name: value.name, scope: value.scope, minutes: value.minutes, sessionId: value.sessionId ?? null });
  }
  /**
   * The key a pairing link carries: it reaches only the assistant-to-assistant door, stops working after
   * `pairingKeyDays`, and is listed and taken back like any other short-lived key. Never the master key.
   */
  createPairingKey(owner: string): IssuedToken {
    return this.issue(owner, { name: "An assistant paired by link", scope: "a2a", minutes: pairingKeyDays * 24 * 60, sessionId: null });
  }
  private issue(owner: string, value: { name: string; scope: TokenScope; minutes: number; sessionId: string | null }): IssuedToken {
    const token = prefix + randomBytes(24).toString("hex");
    const id = randomBytes(8).toString("hex"), now = new Date();
    const entry: TokenEntry = {
      id, name: value.name, scope: value.scope, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + value.minutes * 60_000).toISOString(),
      revokedAt: null, lastUsedAt: null, uses: 0, sessionId: value.sessionId,
    };
    this.db.prepare("INSERT INTO session_tokens(id,owner,name,scope,hash,created_at,expires_at,session_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, owner, entry.name, entry.scope, digest(token), entry.createdAt, entry.expiresAt, entry.sessionId);
    audit(this.store, owner, {
      action: "token.issued", actor: owner, subject: `${entry.name} (${entry.scope}, ${value.minutes} minute(s))`,
      reason: "A short-lived key was made for something outside the app window", outcome: "issued",
    });
    return { entry, token };
  }

  /** Every key of this owner, newest first. The keys themselves are not in here and cannot be. */
  list(owner: string): TokenEntry[] {
    return this.db.prepare("SELECT * FROM session_tokens WHERE owner=? ORDER BY created_at DESC LIMIT 200")
      .all(owner).map(toEntry);
  }

  /** Takes a key back at once. Answers false when there was no such key of this owner's. */
  revoke(owner: string, id: string): boolean {
    const row = this.db.prepare("SELECT name FROM session_tokens WHERE id=? AND owner=? AND revoked_at IS NULL").get(id, owner);
    if (!row) return false;
    this.db.prepare("UPDATE session_tokens SET revoked_at=? WHERE id=? AND owner=?").run(new Date().toISOString(), id, owner);
    audit(this.store, owner, {
      action: "token.issued", actor: owner, subject: `${String(row.name)} (${id})`,
      reason: "A short-lived key was taken back", outcome: "revoked",
    });
    return true;
  }

  /** Forgets keys that stopped working a while ago, so the table cannot grow for ever. */
  prune(owner: string, keepDays = 30): number {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    return Number(this.db.prepare("DELETE FROM session_tokens WHERE owner=? AND expires_at < ?").run(owner, cutoff).changes);
  }

  /**
   * Checks a key that is not the master one. Answers the plain reason it was refused, or null when
   * the request may go ahead. A key that works has its use counted, so the owner can see it working.
   */
  check(owner: string, supplied: string, use: TokenUse, now = new Date()): string | null {
    const found = this.working(owner, supplied, now);
    if (typeof found === "string") return found;
    const refusal = scopeRefusal(found.scope, use)
      ?? (found.sessionId ? this.boundCheck(found.sessionId, use.method, use.path ?? "") : null);
    if (refusal) return refusal;
    this.db.prepare("UPDATE session_tokens SET uses=uses+1, last_used_at=? WHERE id=?").run(now.toISOString(), found.id);
    return null;
  }

  /**
   * What a working key may do, or null when it is not a working key of this owner's. Unlike check()
   * this counts nothing, so a page that has already been let in can ask without a second use showing.
   */
  scopeOf(owner: string, supplied: string, now = new Date()): TokenScope | null {
    const found = this.working(owner, supplied, now);
    return typeof found === "string" ? null : found.scope;
  }

  /** bucket 19: the working key's id and the conversation it is held to, counting nothing; null if it is not one. */
  markOf(owner: string, supplied: string, now = new Date()): { keyId: string; sessionId?: string } | null {
    const found = this.working(owner, supplied, now);
    if (typeof found === "string") return null;
    return { keyId: found.id, ...(found.sessionId ? { sessionId: found.sessionId } : {}) };
  }

  /** The entry for a key that is known, not taken back and not run out; otherwise why not. */
  private working(owner: string, supplied: string, now: Date): TokenEntry | string {
    if (!supplied.startsWith(prefix)) return "Local session token required";
    const hash = digest(supplied);
    const rows = this.db.prepare("SELECT * FROM session_tokens WHERE owner=?").all(owner).map(toRow);
    const found = rows.find((row) => sameHash(row.hash, hash));
    if (!found) return "That key is not one of this computer's keys";
    const entry = toEntry(found.row);
    if (entry.revokedAt) return "That key was taken back. Make a new one with: branch token create";
    if (Date.parse(entry.expiresAt) <= now.getTime())
      return "That key has run out. Make a new one with: branch token create";
    return entry;
  }
}

/** What a pairing key is told anywhere but the assistant-to-assistant door. */
export const a2aKeyRefusal = "That key only lets another assistant hand this one a task. It reaches nothing else.";
function a2aKeyReaches(use: TokenUse): boolean {
  return (use.method === "POST" && use.path === "/a2a") || (use.method === "GET" && use.path === "/.well-known/agent.json");
}
/** What a read key is told when it asks for anything but a look. */
export const readKeyRefusal = "That key may only look at things. Make one with --scope run to start a task.";
/** What each scope may not do, in one sentence the holder of the key can act on. */
export function scopeRefusal(scope: TokenScope, use: TokenUse): string | null {
  if (scope === "a2a") return a2aKeyReaches(use) ? null : a2aKeyRefusal;
  if (scope === "read" && use.method !== "GET")
    return readKeyRefusal;
  if (scope === "run") return null;
  return use.executes ? "That key may only look at things, and this would make Branch do something." : null;
}

function toRow(row: Record<string, unknown>): { hash: Buffer; row: Record<string, unknown> } {
  return { hash: Buffer.from(row.hash as Uint8Array), row };
}
function toEntry(row: Record<string, unknown>): TokenEntry {
  return {
    id: String(row.id), name: String(row.name), scope: String(row.scope) as TokenScope,
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    uses: Number(row.uses ?? 0),
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
  };
}
