import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { currentPerson, throughPairedDoor } from "./people/context.js"; // bucket 19
import { currentTaskRun } from "./task-scope.js"; // household-followups

/**
 * Profiles for a household. Someone else who uses this computer can be given their own named
 * profile with a PIN: their conversations and what the assistant remembers for them are kept apart
 * from the owner's, and they cannot reach the owner's saved secrets or projects. This is separation
 * on one computer, not separate accounts: it does not sync anywhere, and anyone who can open the
 * files on this machine can still read everything. The PIN keeps profiles apart, it does not lock
 * the data away.
 *
 * household-followups: going back to the owner needs no PIN unless the owner sets one (Settings →
 * People; off out of the box). With it set, switching back asks for it, with the same hashing, the
 * same run of five wrong tries and the same refusals as a person's PIN, and the window stays that
 * person's across a restart of the app. That makes the household restriction a lock against
 * somebody at the keyboard, still not against somebody who can open the data folder.
 */
export const ProfileSchema = z.object({
  name: z.string().trim().min(1).max(40),
  pin: z.string().regex(/^\d{4,8}$/, "A PIN is four to eight digits"),
}).strict();
export const SwitchSchema = z.object({
  /** The profile to switch to, or null to go back to the owner. */
  profileId: z.string().uuid().nullable(),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
}).strict();
export interface Profile { id: string; name: string; createdAt: string; lastUsedAt: string | null }
/**
 * your-profile: the form two names are compared in. Names that look the same on a tile are the same name: compatibility
 * forms folded (a full-width letter is its plain one), invisible characters dropped, runs of spaces made one, and case
 * folded the full way (so "SS" and "ß" match too).
 */
export function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim().toUpperCase().toLowerCase();
}
const maximumProfiles = 8;
/** Wrong PINs in a row before a profile stops accepting them for a while. */
export const maximumPinAttempts = 5;
/** How long a profile waits after too many wrong PINs, in milliseconds. */
export const pinLockoutMs = 300000;
/** household-followups: the key wrong PINs for the owner's own PIN are counted under; never a profile id. */
const ownerPinKey = "owner";
export const OwnerPinSchema = z.object({
  /** The owner's PIN for switching back, or null to switch the PIN off again. */
  pin: z.string().regex(/^\d{4,8}$/, "A PIN is four to eight digits").nullable(),
}).strict();
const hash = (pin: string, salt: string): Buffer => scryptSync(pin, salt, 32);
/** True when a typed PIN is the one saved in this row. */
const pinMatches = (pin: string, row: Record<string, unknown>): boolean => {
  const supplied = hash(pin, String(row.salt)), stored = Buffer.from(row.pin_hash as Uint8Array);
  return supplied.length === stored.length && timingSafeEqual(supplied, stored);
};
/** QA Q001: said when the owner's PIN and a person's PIN would be the same. */
export const ownPinNotTheirs = "The owner's PIN and a person's PIN must not be the same.";
/** The name one household person's records are saved under. */
export const profileScope = (profileId: string): string => `profile:${profileId}`;

export class Profiles {
  /** The profile in use in this launch; null means the owner themselves. */
  private current: string | null = null;
  /** Wrong PINs counted per profile for this launch, so nobody can sit and try every number. */
  private readonly wrongPins = new Map<string, { count: number; until: number }>();
  /** household-followups: whether the owner's PIN is set, read once and kept up to date here. */
  private ownerPinSet = false;
  /**
   * household-followups: who a task was started for — a profile id, null for the owner, or
   * undefined when `runId` is not a task (src/runtime.ts installs it). Owner-only checks made while a
   * task's tool runs answer for that person rather than for the window.
   */
  taskPerson?: (runId: string) => string | null | undefined;
  /** Overridden in tests so the wait can be stepped over without sleeping. */
  now: () => number = () => Date.now();
  constructor(private readonly db: DatabaseSync, private readonly owner: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS household_profiles(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      name TEXT NOT NULL, salt TEXT NOT NULL, pin_hash BLOB NOT NULL, created_at TEXT NOT NULL,
      last_used_at TEXT)`);
    // household-followups: the owner's PIN for switching back, and the profile the window was left
    // on while it is set, so quitting and reopening the app is not a way back to the owner.
    db.exec(`CREATE TABLE IF NOT EXISTS household_owner_pin(owner TEXT PRIMARY KEY, salt TEXT NOT NULL,
      pin_hash BLOB NOT NULL, active_profile TEXT)`);
    this.ownerPinSet = !!db.prepare("SELECT 1 AS here FROM household_owner_pin WHERE owner=?").get(owner);
  }
  /**
   * household-followups: while the owner's PIN is set, puts the window back on the profile it was
   * left on before the app last closed. Called once, after the app has started up as the owner.
   */
  resumeWhereLeft(): void {
    if (!this.ownerPinSet) return;
    const left = this.db.prepare("SELECT active_profile FROM household_owner_pin WHERE owner=?").get(this.owner)?.active_profile;
    if (typeof left === "string" && this.list().some((profile) => profile.id === left)) this.current = left;
  }
  create(input: unknown): Profile {
    const value = ProfileSchema.parse(input);
    if (this.list().length >= maximumProfiles) throw new Error(`At most ${maximumProfiles} people can share this computer`);
    if (this.list().some((profile) => nameKey(profile.name) === nameKey(value.name)))
      throw new Error("Someone here already uses that name");
    if (this.opensOwner(value.pin)) throw new Error(ownPinNotTheirs);
    const id = randomUUID(), salt = randomBytes(16).toString("hex"), createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO household_profiles VALUES(?,?,?,?,?,?,?)")
      .run(id, this.owner, value.name, salt, hash(value.pin, salt), createdAt, null);
    return { id, name: value.name, createdAt, lastUsedAt: null };
  }
  /**
   * your-profile: a new name for one profile, chosen by that person (src/person-about.ts). The same
   * rule as a new profile's: nobody else here may already use it, whatever the case.
   */
  rename(id: string, name: string): Profile {
    const value = ProfileSchema.shape.name.parse(name);
    if (this.list().some((profile) => profile.id !== id && nameKey(profile.name) === nameKey(value)))
      throw new Error("Someone here already uses that name");
    if (!this.db.prepare("UPDATE household_profiles SET name=? WHERE owner=? AND id=?").run(value, this.owner, id).changes)
      throw new Error("No profile with that name");
    return this.list().find((profile) => profile.id === id)!;
  }
  list(): Profile[] {
    return this.db.prepare("SELECT id,name,created_at,last_used_at FROM household_profiles WHERE owner=? ORDER BY name")
      .all(this.owner).map((row) => ({ id: String(row.id), name: String(row.name),
        createdAt: String(row.created_at), lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at) }));
  }
  remove(id: string): { removed: boolean } {
    if (this.current === id) this.leaveOn(null);
    return { removed: this.db.prepare("DELETE FROM household_profiles WHERE owner=? AND id=?").run(this.owner, id).changes > 0 };
  }
  /**
   * Switches to a profile after checking its PIN, or back to the owner — with no PIN needed unless
   * the owner has set one (household-followups).
   */
  switch(input: unknown): { active: Profile | null; scope: string } {
    // bucket 19: a person signed in on their own device cannot switch the window's profile.
    if (currentPerson()) throw new Error("Switching who uses this computer is done at the computer itself.");
    const value = SwitchSchema.parse(input);
    if (value.profileId === null) {
      if (this.current !== null && this.ownerPinOn()) this.verifyOwnerPin(value.pin ?? "");
      this.leaveOn(null);
      return { active: null, scope: this.owner };
    }
    const row = this.db.prepare("SELECT * FROM household_profiles WHERE owner=? AND id=?").get(this.owner, value.profileId);
    if (!row) throw new Error("No profile with that name");
    const at = this.verifyPin(value.profileId, value.pin ?? "");
    this.leaveOn(value.profileId);
    return { active: { id: value.profileId, name: String(row.name), createdAt: String(row.created_at), lastUsedAt: at }, scope: this.scope() };
  }
  /**
   * bucket 19: checks one profile's PIN without switching the window, counting wrong ones exactly as
   * a switch does (the same lockout), and answers when it was last used. Throws on a wrong PIN.
   */
  verifyPin(profileId: string, pin: string): string {
    const row = this.db.prepare("SELECT * FROM household_profiles WHERE owner=? AND id=?").get(this.owner, profileId);
    if (!row) throw new Error("That PIN is not right");
    this.checkPin(profileId, row, pin);
    const at = new Date().toISOString();
    this.db.prepare("UPDATE household_profiles SET last_used_at=? WHERE id=?").run(at, profileId);
    return at;
  }
  /** household-followups: whether switching back to the owner asks for the owner's PIN. */
  ownerPinOn(): boolean {
    return this.ownerPinSet;
  }
  /**
   * household-followups: sets the owner's PIN for switching back, or switches it off with null. Only
   * the owner may, and only from the owner's own profile.
   */
  setOwnerPin(input: unknown): { ownerPin: boolean } {
    this.requireOwner("The PIN for switching back to the owner");
    const { pin } = OwnerPinSchema.parse(input);
    this.wrongPins.delete(ownerPinKey);
    if (pin === null) {
      this.db.prepare("DELETE FROM household_owner_pin WHERE owner=?").run(this.owner);
      this.ownerPinSet = false;
      return { ownerPin: false };
    }
    if (this.opensAProfile(pin)) throw new Error(ownPinNotTheirs);
    const salt = randomBytes(16).toString("hex");
    this.db.prepare(`INSERT INTO household_owner_pin(owner,salt,pin_hash,active_profile) VALUES(?,?,?,NULL)
      ON CONFLICT(owner) DO UPDATE SET salt=excluded.salt, pin_hash=excluded.pin_hash`).run(this.owner, salt, hash(pin, salt));
    this.ownerPinSet = true;
    return { ownerPin: true };
  }
  /**
   * QA Q001: the owner's PIN and a person's PIN are never the same, or that person could switch back to the owner. Both
   * are asked only on the owner's own steps (adding somebody, setting the owner's PIN), never on a person's own change,
   * so nobody else can use them to test guesses at the owner's PIN.
   */
  private opensOwner(pin: string): boolean {
    const row = this.db.prepare("SELECT salt, pin_hash FROM household_owner_pin WHERE owner=?").get(this.owner);
    return !!row && pinMatches(pin, row);
  }
  private opensAProfile(pin: string): boolean {
    return this.db.prepare("SELECT salt, pin_hash FROM household_profiles WHERE owner=?").all(this.owner)
      .some((row) => pinMatches(pin, row));
  }
  /** household-followups: the owner's PIN, checked exactly as a profile's is, in the same words. */
  private verifyOwnerPin(pin: string): void {
    const row = this.db.prepare("SELECT salt, pin_hash FROM household_owner_pin WHERE owner=?").get(this.owner);
    if (row) this.checkPin(ownerPinKey, row, pin);
  }
  /** One saved PIN against the one typed, counting wrong ones under `key` towards the same lockout. */
  private checkPin(key: string, row: Record<string, unknown>, pin: string): void {
    this.checkNotLockedOut(key);
    const supplied = hash(pin, String(row.salt));
    const stored = Buffer.from(row.pin_hash as Uint8Array);
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
      this.countWrongPin(key);
      throw new Error("That PIN is not right");
    }
    this.wrongPins.delete(key);
  }
  private readonly switchListeners = new Set<(profileId: string | null) => void>();
  /** Hears each change of who uses the window (null: the owner); answers a function that stops listening. */
  onSwitched(listener: (profileId: string | null) => void): () => void {
    this.switchListeners.add(listener);
    return () => { this.switchListeners.delete(listener); };
  }
  /** Puts the window on a profile (null: the owner), remembered across a restart while the owner's PIN is set. */
  private leaveOn(profileId: string | null): void {
    const before = this.current;
    this.current = profileId;
    if (before !== profileId) for (const listener of [...this.switchListeners]) try { listener(profileId); } catch { /* telling must not undo the switch */ }
    // Without the owner's PIN nothing is remembered, and nothing touches the database.
    if (this.ownerPinSet) this.db.prepare("UPDATE household_owner_pin SET active_profile=? WHERE owner=?").run(profileId, this.owner);
  }
  /** bucket 19: a new PIN for one profile, after a reset the owner started or the person's own change. */
  setPin(profileId: string, pin: string): void {
    const value = ProfileSchema.shape.pin.parse(pin);
    const salt = randomBytes(16).toString("hex");
    const changed = this.db.prepare("UPDATE household_profiles SET salt=?, pin_hash=? WHERE owner=? AND id=?")
      .run(salt, hash(value, salt), this.owner, profileId).changes;
    if (!changed) throw new Error("No profile with that name");
    this.wrongPins.delete(profileId);
  }
  /** bucket 19: the profile a typed name belongs to, ignoring case; null when nobody here has it. */
  byName(name: string): Profile | null {
    const wanted = name.trim().toLowerCase();
    return this.list().find((profile) => profile.name.toLowerCase() === wanted) ?? null;
  }
  /** Refuses a switch while a profile is still waiting out its run of wrong PINs. */
  private checkNotLockedOut(profileId: string): void {
    const record = this.wrongPins.get(profileId);
    if (!record || record.count < maximumPinAttempts) return;
    if (this.now() < record.until)
      throw new Error("Too many wrong PINs. Wait a few minutes and try again.");
    this.wrongPins.delete(profileId);
  }
  private countWrongPin(profileId: string): void {
    const count = (this.wrongPins.get(profileId)?.count ?? 0) + 1;
    this.wrongPins.set(profileId, { count, until: this.now() + pinLockoutMs });
  }
  /** Who is using the app right now (inside a task's tool: who the task is for): a profile, or the owner. */
  /** Physical window identity, including from an owner's paired device. */
  localWindowProfileId(): string | null { return this.current; }
  active(): Profile | null {
    const id = this.judged();
    if (!id) return null;
    const found = this.list().find((profile) => profile.id === id) ?? null;
    // bucket 19: a person's key whose profile was removed is nobody, and never falls back to the owner.
    if (!found && currentPerson()) throw new Error("That person is no longer on this computer.");
    return found;
  }
  /**
   * bucket 19: a signed-in person's request answers for them; otherwise the window's switch does. A request through
   * the paired door is the owner's (src/people/context.ts), never whoever the window is switched to.
   */
  private who(): string | null {
    return currentPerson()?.profileId ?? this.window();
  }
  private window(): string | null {
    return throughPairedDoor() ? null : this.current;
  }
  /**
   * household-followups: whom an owner-only check answers for. A signed-in person first; then,
   * inside a tool call that belongs to a task, the person that task was started for; otherwise the
   * window's switch, which a request through the paired door never takes (it is the owner's). Where records are filed
   * (scope) still follows the window, as it always has.
   */
  private judged(): string | null {
    const person = currentPerson();
    if (person) return person.profileId;
    const runId = currentTaskRun();
    const bound = runId ? this.taskPerson?.(runId) : undefined;
    return bound === undefined ? this.window() : bound;
  }
  /** The name records are saved under for whoever is using the app: separate per profile. */
  scope(): string {
    const id = this.who();
    return id ? profileScope(id) : this.owner;
  }
  /** The owner's own name, so a caller can tell the owner's records apart from a profile's. */
  get ownerName(): string {
    return this.owner;
  }
  isOwner(): boolean {
    return this.judged() === null;
  }
  /** Refuses anything only the owner may reach: their secrets, their projects, their settings. */
  requireOwner(what = "This"): void {
    if (this.judged() !== null)
      throw new Error(`${what} belongs to the owner. Switch back to the owner's profile to use it.`);
  }
}
