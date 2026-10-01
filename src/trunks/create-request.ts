import { createHash } from "node:crypto";
import type { Store } from "../store.js";
import type { Trunk } from "./record.js";

/** Create receipts outlive Trunk deletion: a delayed retry must never resurrect a removed agent. */
function receipts(store: Store): void {
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS trunk_create_requests(
    owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, trunk_id TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner, request_id))`);
}
const conflict = (message: string): Error => Object.assign(new Error(message), { status: 409 });

/** The create-only fields have already been parsed and defaulted in a fixed order. */
export const createFingerprint = (fields: { name: string; title: string; description: string; startsIn?: unknown }): string =>
  createHash("sha256").update(JSON.stringify([fields.name, fields.title, fields.description, fields.startsIn ?? null])).digest("hex");

/** Commit the canonical conversation, Trunk and receipt together; no model work runs in this transaction. */
export function requestedTrunk(store: Store, owner: string, requestId: string, fingerprint: string,
  find: (id: string) => Trunk | undefined, create: () => Trunk): { trunk: Trunk; created: boolean } {
  if (store.sqlite.isTransaction) throw conflict("A keyed Trunk creation must run outside an existing transaction.");
  receipts(store);
  return store.atomically(() => {
    const row = store.sqlite.prepare("SELECT * FROM trunk_create_requests WHERE owner=? AND request_id=?").get(owner, requestId);
    if (row) {
      if (row.fingerprint !== fingerprint) throw conflict("This creation request was already used for different Trunk details. Start a new creation.");
      const trunk = find(String(row.trunk_id));
      if (!trunk) throw conflict("This request already created a Trunk that was later removed. Start a new creation to make another.");
      if (!row.initialized) throw conflict(`Trunk @${trunk.handle} was created, but its initial setup was interrupted. Review that Trunk before starting another creation.`);
      return { trunk, created: false };
    }
    const trunk = create();
    store.sqlite.prepare("INSERT INTO trunk_create_requests(owner,request_id,fingerprint,trunk_id) VALUES(?,?,?,?)")
      .run(owner, requestId, fingerprint, trunk.id);
    return { trunk, created: true };
  });
}

export function initializedTrunk(store: Store, owner: string, requestId: string): void {
  store.sqlite.prepare("UPDATE trunk_create_requests SET initialized=1 WHERE owner=? AND request_id=?").run(owner, requestId);
}
