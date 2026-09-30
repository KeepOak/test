import type { DatabaseSync } from "node:sqlite";
import { type AccountState, freshState } from "./pool.js";

/**
 * Account rests kept on disk, so a restart does not undo a billing bench, a plan limit or a rate-limit rest and send
 * the next task straight back to an account the service just refused. The shape follows Hermes Agent's credential pool
 * (agent/credential_pool.py, MIT, Copyright (c) 2025 Nous Research; see THIRD_PARTY_NOTICES.md), which saves each
 * credential's last_status, last_status_at and last_error_reset_at with the pool. Only times and short reasons are
 * written, never a key or a token; kept in its own table, not in the accounts record that backups copy.
 */
interface Saved {
  restUntil: number;
  limitedUntil: number;
  limitKnown?: boolean;
  models: [string, number][];
  lastError: string | null;
  rateFailures?: number;
  lastRateAt?: number;
  savedAt: number;
}

/** How long a run of rate limits is remembered with nothing resting (openclaw's FAILURE_WINDOW_MS, a day). */
const rateMemoryMs = 24 * 60 * 60_000;

export class AccountRestStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_rests(owner TEXT NOT NULL, pool TEXT NOT NULL, account TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(owner,pool,account))`);
  }

  save(owner: string, pool: string, account: string, state: AccountState, now: number): void {
    const saved: Saved = {
      restUntil: state.restUntil, limitedUntil: state.limitedUntil, models: [...state.models],
      lastError: state.lastError, savedAt: now,
      ...(state.limitKnown !== undefined ? { limitKnown: state.limitKnown } : {}),
      ...(state.rateFailures ? { rateFailures: state.rateFailures } : {}),
      ...(state.lastRateAt !== undefined ? { lastRateAt: state.lastRateAt } : {}),
    };
    this.db.prepare(`INSERT INTO account_rests VALUES(?,?,?,?) ON CONFLICT(owner,pool,account) DO UPDATE SET data=excluded.data`)
      .run(owner, pool, account, JSON.stringify(saved));
  }

  /** Every account of a list that is still resting (or still counting rate limits), as fresh states carrying that. */
  load(owner: string, pool: string, now: number): Map<string, AccountState> {
    const found = new Map<string, AccountState>();
    const rows = this.db.prepare("SELECT account, data FROM account_rests WHERE owner=? AND pool=?").all(owner, pool);
    for (const row of rows) {
      const state = restored(String(row.data), now);
      if (state) found.set(String(row.account), state);
    }
    return found;
  }

  forget(owner: string, pool: string, account: string): void {
    this.db.prepare("DELETE FROM account_rests WHERE owner=? AND pool=? AND account=?").run(owner, pool, account);
  }
}

/** One saved rest as a state, with what has already ended dropped; null when nothing of it still matters. */
function restored(data: string, now: number): AccountState | null {
  let saved: Saved;
  try { saved = JSON.parse(data) as Saved; } catch { return null; } // a damaged row rests nothing
  const time = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > now ? value : 0);
  const state = freshState();
  state.restUntil = time(saved.restUntil);
  state.limitedUntil = time(saved.limitedUntil);
  if (state.limitedUntil && saved.limitKnown !== undefined) state.limitKnown = saved.limitKnown === true;
  for (const [model, until] of Array.isArray(saved.models) ? saved.models : [])
    if (typeof model === "string" && time(until)) state.models.set(model, until);
  const resting = state.restUntil > 0 || state.limitedUntil > 0 || state.models.size > 0;
  const lastRate = typeof saved.lastRateAt === "number" ? saved.lastRateAt : saved.savedAt;
  const recent = typeof lastRate === "number" && now - lastRate < rateMemoryMs;
  if (recent && typeof saved.rateFailures === "number" && saved.rateFailures > 0) {
    state.rateFailures = Math.min(64, Math.trunc(saved.rateFailures));
    state.lastRateAt = lastRate;
  }
  if (!resting && !state.rateFailures) return null;
  if (resting && typeof saved.lastError === "string") state.lastError = saved.lastError.slice(0, 300);
  return state;
}
