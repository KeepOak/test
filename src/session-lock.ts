import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";

/**
 * Locking the app. The person can lock it from the header, and it locks itself after a chosen
 * quiet period. While it is locked Branch Agent keeps answering from what it already knows, but it
 * will not take a saved password or key out of the locker until the person unlocks it again.
 *
 * App lock: the owner may set a PIN (four to eight digits). While one is set, unlocking asks for
 * it, and a locked Branch answers nothing but its lock status and the unlock itself (`refusal`,
 * checked once in src/server.ts before any route runs). Only a salted scrypt hash is kept, in its
 * own table, which no backup, export or settings file reads. Wrong tries are counted in that same
 * row, so quitting and reopening Branch does not reset them: every fifth wrong try in a row starts
 * a wait, five minutes the first time and twice as long each time after, up to an hour. Changing or
 * removing the PIN asks for the current one and counts towards the same wait.
 * Without a PIN nothing here changes: locking only closes the locker, and unlocking asks nothing.
 */
export const SessionLockSchema = z.object({
  /** Lock by itself after this many quiet minutes; 0 means never lock by itself. */
  idleMinutes: z.number().int().min(0).max(1440).default(0),
  /** Whether a locked app may still use saved passwords and keys. Off is the safe answer. */
  secretsWhileLocked: z.boolean().default(false),
  /** App lock "Always": with a PIN set, Branch starts locked, and the window locks when it opens. */
  lockOnOpen: z.boolean().default(false),
}).strict();
export type SessionLockConfig = z.infer<typeof SessionLockSchema>;
export interface SessionLockState {
  locked: boolean; idleMinutes: number; idleSeconds: number;
  lockedSince: string | null; lastActiveAt: string;
  /** Whether an App lock PIN is set. Never the PIN or anything derived from it. */
  pinSet: boolean; lockOnOpen: boolean; secretsWhileLocked: boolean;
}
const settingsKey = "session-lock";

/** A PIN as typed: four to eight digits. The words are the ones a profile's PIN uses. */
export const AppLockPin = z.string().regex(/^\d{4,8}$/, "A PIN is four to eight digits");
export const UnlockSchema = z.object({ pin: z.string().max(64).optional() }).strict();
export const AppLockPinSchema = z.object({
  /** The new PIN, or null to remove the App lock. */
  pin: AppLockPin.nullable(),
  /** The PIN set now; needed whenever one is set. */
  current: z.string().max(64).optional(),
}).strict();
/** Wrong tries in a row before a wait starts. */
export const maximumUnlockTries = 5;
/** The first wait; each later one is twice as long, up to `longestUnlockWaitMs`. */
export const firstUnlockWaitMs = 5 * 60_000;
export const longestUnlockWaitMs = 60 * 60_000;
export const lockedRefusal = "Branch is locked. Unlock it with your PIN first.";
export const wrongPin = "That PIN is not right";
/** scrypt's cost, fixed: 2^15 rounds, 32 MiB, about a tenth of a second a try. */
const scryptCost = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashPin = (pin: string, salt: string): Buffer => scryptSync(pin, salt, 32, scryptCost);
/**
 * What a locked Branch still answers while a PIN is set: its lock status and the unlock itself,
 * and — because Branch may start locked — that it is alive and well, and being asked by this
 * computer's own `branch quit` — or, on a Mac, the update — to close. The update's self-test opens the saved
 * work and asks `/api/health`; a locked answer there would fail every update. Closing loosens nothing, and both
 * closing routes still ask for this computer's own key from this computer (src/install/quit.ts, src/deployment-api.ts).
 */
const openWhileLocked = new Set(["GET /api/lock", "POST /api/lock/unlock", "GET /api/alive", "GET /api/health",
  "POST /api/deployment/quit", "POST /api/deployment/close"]);

/** Why an App lock request was refused, with the HTTP status src/server.ts answers it with. */
export class AppLockRefusal extends Error {
  constructor(readonly status: 400 | 403 | 429, message: string) { super(message); }
}

interface PinRow { salt: string; pin_hash: Uint8Array; wrong: number; wait_until: number }

export class SessionLock {
  private lastActive: number;
  private lockedAt: number | null = null;
  /** Whether a PIN is set, read once and kept up to date here: every open stream asks it often. */
  private hasPin = false;
  /** Overridden in tests so a wait can be stepped over without sleeping. */
  now: () => number;
  constructor(private readonly store: Store, private readonly owner: string, now: () => number = Date.now) {
    this.now = now;
    this.lastActive = this.now();
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS app_lock_pin(owner TEXT PRIMARY KEY, salt TEXT NOT NULL,
      pin_hash BLOB NOT NULL, wrong INTEGER NOT NULL DEFAULT 0, wait_until INTEGER NOT NULL DEFAULT 0)`);
    this.hasPin = this.row() !== undefined;
    // "Always": a Branch that opens with a PIN set opens locked.
    if (this.pinSet() && this.settings().lockOnOpen) this.lockedAt = this.now();
  }
  settings(): SessionLockConfig {
    const saved = SessionLockSchema.safeParse(this.store.get("settings", this.owner, settingsKey)?.data ?? {});
    return saved.success ? saved.data : SessionLockSchema.parse({});
  }
  configure(input: unknown): SessionLockConfig {
    const next = SessionLockSchema.parse(input ?? {});
    this.store.save("settings", this.owner, settingsKey, next);
    this.lastActive = this.now();
    return next;
  }
  /** Called whenever the owner does something in the app, so the quiet period starts again. */
  touch(): void {
    // With an App lock PIN, locked() first: a quiet period that has already run out locks here,
    // rather than being started again by the very request that arrives after it. Without a PIN,
    // exactly as before App lock: a request restarts the quiet period unless Branch is locked already.
    if (this.hasPin ? !this.locked() : this.lockedAt === null) this.lastActive = this.now();
  }
  /**
   * Called the moment Branch locks, so anything held only for "while I am here" is let go: the
   * standing yeses given for a conversation end here, as well as the secrets locker closing.
   */
  onLock: () => void = () => undefined;
  lock(): SessionLockState {
    if (this.lockedAt === null) { this.lockedAt = this.now(); this.onLock(); }
    return this.state();
  }
  /**
   * Called the moment Branch is unlocked again, so anything that was let go of only because of the
   * lock can come back by itself. Integration review (mac7/wake-mic): without this, letting go of
   * the microphone on the lock was one-way — the wake word stayed silent afterwards until some
   * setting happened to be saved.
   */
  onUnlock: () => void = () => undefined;
  /**
   * The owner unlocking from their own app; the request already carries the app's session token.
   * With an App lock PIN set, the PIN is checked first (counted towards the wait when wrong).
   */
  unlock(input: unknown = {}): SessionLockState {
    const { pin } = UnlockSchema.parse(input ?? {});
    if (this.pinSet()) {
      if (!pin) throw new AppLockRefusal(400, "Enter your PIN to unlock Branch.");
      this.checkPin(pin);
    }
    const wasLocked = this.lockedAt !== null;
    this.lockedAt = null;
    this.lastActive = this.now();
    if (wasLocked) this.onUnlock();
    return this.state();
  }
  locked(): boolean {
    if (this.lockedAt !== null) return true;
    const { idleMinutes } = this.settings();
    if (idleMinutes > 0 && this.now() - this.lastActive >= idleMinutes * 60_000) { this.lockedAt = this.now(); this.onLock(); }
    return this.lockedAt !== null;
  }
  state(): SessionLockState {
    const locked = this.locked(), { idleMinutes, lockOnOpen, secretsWhileLocked } = this.settings();
    return { locked, idleMinutes, idleSeconds: Math.round((this.now() - this.lastActive) / 1000),
      lockedSince: this.lockedAt === null ? null : new Date(this.lockedAt).toISOString(),
      lastActiveAt: new Date(this.lastActive).toISOString(), pinSet: this.pinSet(), lockOnOpen, secretsWhileLocked };
  }
  /** Refuses to hand out a saved password or key while the app is locked. */
  require(): void {
    if (this.locked() && !this.settings().secretsWhileLocked)
      throw new Error("Branch Agent is locked. Unlock it before it uses a saved password or key.");
  }
  /** Whether an App lock PIN is set. */
  pinSet(): boolean {
    return this.hasPin;
  }
  /**
   * The one check src/server.ts makes before any route: while a PIN is set and Branch is locked,
   * every request is refused except the few in `openWhileLocked`. Null when it may go on.
   */
  refusal(method: string | undefined, path: string): string | null {
    if (openWhileLocked.has(`${method ?? "GET"} ${path}`) || !this.pinSet() || !this.locked()) return null;
    return lockedRefusal;
  }
  /**
   * Sets, changes or removes the App lock PIN. While one is set, the current one is asked for and
   * checked exactly as an unlock is, counting towards the same wait.
   */
  setPin(input: unknown): { pinSet: boolean } {
    this.store.profiles.requireOwner("The App lock");
    const { pin, current } = AppLockPinSchema.parse(input ?? {});
    const had = this.pinSet();
    if (had) {
      if (!current) throw new AppLockRefusal(400, "Enter the PIN set now to change or remove it.");
      this.checkPin(current);
    }
    if (pin === null) {
      if (!had) return { pinSet: false };
      this.store.sqlite.prepare("DELETE FROM app_lock_pin WHERE owner=?").run(this.owner);
      this.hasPin = false;
      this.record("The App lock PIN was removed");
      return { pinSet: false };
    }
    const salt = randomBytes(16).toString("hex");
    this.store.sqlite.prepare(`INSERT INTO app_lock_pin(owner,salt,pin_hash,wrong,wait_until) VALUES(?,?,?,0,0)
      ON CONFLICT(owner) DO UPDATE SET salt=excluded.salt, pin_hash=excluded.pin_hash, wrong=0, wait_until=0`)
      .run(this.owner, salt, hashPin(pin, salt));
    this.hasPin = true;
    this.record(had ? "The App lock PIN was changed" : "An App lock PIN was set");
    return { pinSet: true };
  }
  private row(): PinRow | undefined {
    return this.store.sqlite.prepare("SELECT salt, pin_hash, wrong, wait_until FROM app_lock_pin WHERE owner=?")
      .get(this.owner) as PinRow | undefined;
  }
  /**
   * One typed PIN against the saved hash. Reading the count, hashing and writing the count back is
   * one synchronous step, so requests sent at the same moment cannot slip past the wait.
   */
  private checkPin(pin: string): void {
    const row = this.row();
    if (!row) return;
    const now = this.now();
    if (row.wait_until > now) throw new AppLockRefusal(429, waitWords(row.wait_until - now));
    const supplied = hashPin(pin, row.salt), stored = Buffer.from(row.pin_hash);
    if (supplied.length === stored.length && timingSafeEqual(supplied, stored)) {
      if (row.wrong) this.store.sqlite.prepare("UPDATE app_lock_pin SET wrong=0, wait_until=0 WHERE owner=?").run(this.owner);
      return;
    }
    const wrong = row.wrong + 1;
    if (wrong % maximumUnlockTries !== 0) {
      this.store.sqlite.prepare("UPDATE app_lock_pin SET wrong=? WHERE owner=?").run(wrong, this.owner);
      throw new AppLockRefusal(403, wrongPin);
    }
    const round = wrong / maximumUnlockTries;
    const waitMs = Math.min(longestUnlockWaitMs, firstUnlockWaitMs * 2 ** Math.min(round - 1, 10));
    this.store.sqlite.prepare("UPDATE app_lock_pin SET wrong=?, wait_until=? WHERE owner=?").run(wrong, now + waitMs, this.owner);
    audit(this.store, this.owner, { action: "auth.refused", actor: "App lock", subject: "the App lock PIN",
      reason: `${wrong} wrong PINs in a row; the next try waits ${Math.round(waitMs / 60_000)} minutes`, outcome: "waiting" });
    throw new AppLockRefusal(429, waitWords(waitMs));
  }
  private record(reason: string): void {
    audit(this.store, this.owner, { action: "lock.changed", actor: this.owner, subject: "the App lock", reason, outcome: "saved" });
  }
}

/** The wait, in whole minutes rounded up. */
function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `Too many wrong PINs. Wait ${minutes} ${minutes === 1 ? "minute" : "minutes"} and try again.`;
}
