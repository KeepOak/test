import type { Store } from "../store.js";
import type { Trunk } from "./record.js";
import type { TrunkThreads } from "./threads.js";
import { HeldListSchema, restoredTrunksKey } from "./restore-narrow.js";
import { onboardingRecord } from "../onboarding.js";

/**
 * defaulttrunk: the default Trunk, like Hermes Agent's default profile and OpenClaw's default agent. Whatever names no
 * Trunk goes to it: the window's new conversation and a chat app's chat with no routing of its own.
 *
 * Once setup is over there is always exactly one while any Trunk exists, by how it is read rather than by keeping two
 * things in step: the owner's pick (a `governance` row, `trunk-default`, kept on this computer like the rest of that
 * table), while that Trunk is still here; otherwise the oldest Trunk that may be the default, which is the one setup's
 * "Your first Trunk" made. Removing the default hands the part to the next oldest at once, and a restore or an import
 * never sets it. While setup is still going there is none unless the owner picked one: the Trunks setup makes are only
 * weighed once it is over, and until then a conversation that names nobody is nobody's, as it always was.
 */
export const defaultPointer = "trunk-default";

const oldest = (trunks: readonly Trunk[]): Trunk | undefined =>
  [...trunks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];

/**
 * A Trunk that came from a file, or that a restore brought back and still holds for the owner's yes, is never the
 * default by being oldest: the default is the owner's own assistant, and only the owner's own pick makes such a Trunk
 * that. With only those here, the engine makes a default of its own (Trunks.ensureDefault).
 *
 * The owner's call (2026-09-27): the default ships with the app to take the stray conversations. Unless the owner is
 * handing the part on (`handOn`: they removed the default), only a Trunk setup's own "Your first Trunk" step made
 * (`fromSetup`) may become it by being oldest. A Trunk the owner made by hand keeps the reach they gave it, and the
 * engine makes a default of its own instead.
 */
function eligible(store: Pick<Store, "get">, scope: string, trunks: readonly Trunk[], handOn: boolean): Trunk[] {
  const held = HeldListSchema.safeParse(store.get("settings", scope, restoredTrunksKey)?.data ?? {});
  const holding = new Set(held.success ? held.data.trunks.map((trunk) => trunk.id) : []);
  return trunks.filter((trunk) => !trunk.fromFile && !holding.has(trunk.id) && (handOn || trunk.fromSetup === true));
}

/** Setup finished or skipped (src/onboarding.ts). */
export function setupOver(store: Pick<Store, "get">, scope: string): boolean {
  const setup = onboardingRecord(store, scope);
  return setup.done || setup.skipped;
}

/** The Trunk that is the default when the owner picked none: the oldest that may be (see eligible for `handOn`). */
export function defaultAmong(store: Pick<Store, "get">, scope: string, trunks: readonly Trunk[], handOn = false): Trunk | undefined {
  return oldest(eligible(store, scope, trunks, handOn));
}

/** The default Trunk among these, read and never written. */
export function pickDefault(store: Pick<Store, "get">, scope: string, trunks: readonly Trunk[]): Trunk | undefined {
  return designatedDefault(store, scope, trunks) ?? (setupOver(store, scope) ? defaultAmong(store, scope, trunks) : undefined);
}

/** Only a saved default designation grants the owner's authority; fallback routing alone never does. */
export function designatedDefault(store: Pick<Store, "get">, scope: string, trunks: readonly Trunk[]): Trunk | undefined {
  const picked = store.get("governance", scope, defaultPointer)?.data as { trunkId?: unknown } | undefined;
  return trunks.find((trunk) => trunk.id === picked?.trunkId);
}

/** For the chat apps (lane chatparity's routes fall back to it): the default Trunk's id, or null while there is none. */
export function defaultTrunkId(store: Pick<Store, "get" | "list">, scope: string): string | null {
  const trunks = store.list("governance", scope).filter((row) => /^trunk:[0-9a-f-]{36}$/.test(row.id)).map((row) => row.data as unknown as Trunk);
  return pickDefault(store, scope, trunks)?.id ?? null;
}

export function saveDefault(store: Pick<Store, "save">, scope: string, trunkId: string): void {
  store.save("governance", scope, defaultPointer, { trunkId, at: new Date().toISOString() });
}

/**
 * The conversations that belong to no Trunk yet, each put with one (migration, and again whenever it might have
 * changed: at start, when the first default is made, when a Trunk is removed). A conversation a Trunk already answered
 * in goes to the last Trunk that did, if it is still here; every other one goes to the default. Nothing is moved,
 * renamed, re-dated or marked read: a row saying whose thread it is, and nothing else, is written. It can run any
 * number of times; a conversation that has a Trunk is never looked at again.
 */
export interface AdoptInput {
  store: Store;
  owner: string;
  threads: TrunkThreads;
  /** The default Trunk's id. */
  to: string;
  /** Conversations that are a Trunk's own chat, a room, or a Trunk's side of a room: never a thread. */
  canonical: ReadonlySet<string>;
  /** The Trunks that are here, by id. */
  here: ReadonlySet<string>;
}
export function adoptOrphans(input: AdoptInput): { toDefault: number; toTheirTrunk: number } {
  const db = input.store.sqlite;
  const open = db.prepare(`SELECT id FROM sessions WHERE owner=? AND temporary=0
    AND id NOT IN (SELECT session_id FROM trunk_threads)`).all(input.owner).map((row) => String(row.id))
    .filter((id) => !input.canonical.has(id));
  if (!open.length) return { toDefault: 0, toTheirTrunk: 0 };
  // A Trunk's side of a room it was taken out of stays out of every thread (src/history.ts neverLeft).
  const left = new Set(db.prepare("SELECT substr(id, 17) AS s FROM governance WHERE owner=? AND id GLOB 'trunk-room-left:*'")
    .all(input.owner).map((row) => String(row.s)));
  const lastTurn = new Map(db.prepare(`SELECT t.session_id AS s, json_extract(e.data,'$.trunkId') AS trunk FROM events e
    JOIN tasks t ON t.id=e.run_id WHERE e.kind='trunk.turn' AND t.owner=? ORDER BY e.id`).all(input.owner)
    .map((row) => [String(row.s), String(row.trunk ?? "")] as const));
  let toDefault = 0, toTheirTrunk = 0;
  input.store.atomically(() => {
    for (const sessionId of open) {
      if (left.has(sessionId)) continue;
      const theirs = lastTurn.get(sessionId);
      const trunkId = theirs && input.here.has(theirs) ? theirs : input.to;
      if (!input.threads.claim(sessionId, trunkId, trunkId === input.to ? "migrated" : "claimed")) continue;
      if (trunkId === input.to) toDefault++; else toTheirTrunk++;
    }
  });
  return { toDefault, toTheirTrunk };
}
