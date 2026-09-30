import { z } from "zod";
import { notFromAFile, readOnlyPermissionList } from "../policy.js";

/**
 * #484: how a restore cuts a backed-up Trunk down and what it keeps of what the Trunk had (src/backup.ts uses this
 * inside its transaction; src/trunks/restored.ts answers the owner). No store here, so the backup never imports one.
 * The list lives in one setting that stays on this computer, so a backup never carries it.
 */
export const restoredTrunksKey = "restore-trunks-held";

export const HadSchema = z.object({
  permissions: z.array(z.string().trim().min(1).max(100)).max(100),
  mcpServers: z.array(z.string().trim().min(1).max(64)).max(50),
  keys: z.object({ copyFromOwner: z.boolean(), accounts: z.record(z.string().max(64), z.string().max(64)),
    next: z.record(z.string().max(64), z.array(z.string().max(64)).max(10)).optional() }).strict(),
  // RES-253: "sandboxed" only ever tightens, so a restored Trunk keeps it as it was (an older backup has none: false).
  reach: z.object({ channels: z.array(z.string().trim().min(1).max(64)).max(20), commands: z.boolean(), sandboxed: z.boolean().default(false) }).strict(),
  paused: z.boolean(),
}).strict();
export type Had = z.infer<typeof HadSchema>;
export const HeldTrunkSchema = z.object({ id: z.string().uuid(), name: z.string().max(40), had: HadSchema }).strict();
export const HeldListSchema = z.object({ trunks: z.array(HeldTrunkSchema).max(50).default([]) }).strict();
export type HeldTrunk = z.infer<typeof HeldTrunkSchema>;

/** The permissions a restored Trunk keeps: those of its own that only look here, or all of those when it named none. */
export function lookOnly(permissions: readonly string[]): string[] {
  const looking = readOnlyPermissionList().filter((permission) => permission.endsWith(".read") && !notFromAFile.has(permission));
  const kept = permissions.filter((permission) => looking.includes(permission));
  return kept.length ? kept : looking;
}

/**
 * A backed-up Trunk record cut down for a restore, with what it had; null when the record does not read as a Trunk,
 * so it is left out of the restore rather than brought back as it was.
 */
export function narrowTrunk(data: string, now = new Date()): { data: string; held: Omit<HeldTrunk, "id"> } | null {
  let record: Record<string, unknown>;
  try { record = JSON.parse(data) as Record<string, unknown>; } catch { return null; }
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.name !== "string") return null;
  const had = HadSchema.safeParse({ permissions: record.permissions ?? [], mcpServers: record.mcpServers ?? [],
    keys: record.keys ?? { copyFromOwner: true, accounts: {} }, reach: record.reach ?? { channels: [], commands: false }, paused: record.paused === true });
  if (!had.success) return null;
  const { fromSetup: _setup, ...kept } = record; // defaulttrunk: a restored Trunk is never setup's first Trunk here
  const narrowed = { ...kept, permissions: lookOnly(had.data.permissions), mcpServers: [], keys: { copyFromOwner: true, accounts: {} },
    reach: { channels: [], commands: false, sandboxed: had.data.reach.sandboxed }, paused: true, pausedAt: now.toISOString() };
  return { data: JSON.stringify(narrowed), held: { name: record.name.slice(0, 40), had: had.data } };
}

/** Adds the Trunks one restore cut down to the waiting list (inside the restore's transaction: plain SQL on `db`). */
export function holdRestoredTrunks(db: { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } },
  owner: string, trunks: readonly HeldTrunk[]): void {
  if (!trunks.length) return;
  const row = db.prepare("SELECT data FROM settings WHERE owner=? AND id=?").get(owner, restoredTrunksKey) as { data: string } | undefined;
  const earlier = HeldListSchema.safeParse(row ? JSON.parse(row.data) : {});
  const fresh = new Set(trunks.map((trunk) => trunk.id));
  const list = [...(earlier.success ? earlier.data.trunks : []).filter((trunk) => !fresh.has(trunk.id)), ...trunks].slice(-50);
  const at = new Date().toISOString();
  // The id is written into the statement (it is restoredTrunksKey), so tests/pinned-settings.test.mjs reads it and checks
  // it is no setting the owner can pin; a plain write here, since this runs inside the restore's own transaction.
  db.prepare("INSERT INTO settings(id, owner, data, created_at, updated_at) VALUES('restore-trunks-held',?,?,?,?) ON CONFLICT(id, owner) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
    .run(owner, JSON.stringify({ trunks: list }), at, at);
}

