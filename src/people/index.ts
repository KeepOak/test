import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AuthLimiter } from "../auth-limits.js";
import type { ProfileRoles } from "../profile-roles.js";
import type { Profiles } from "../profiles.js";
import type { SessionTokens } from "../session-tokens.js";
import type { Store } from "../store.js";
import { boundDoorRefusal, personDoorRefusal } from "./access.js";
import { enterPerson } from "./context.js";
import { PeopleGroups } from "./groups.js";
import { PersonKeys, personKeyPrefix, type PersonKeyEntry } from "./keys.js";
import type { GuardedFetch } from "./oidc.js";
import { Passkeys } from "./passkeys.js";
import { ResetCodes } from "./reset-codes.js";
import { peopleEnabled, peopleSettings, savePeopleSettings } from "./settings.js";
import { returnLentSessions } from "./lending.js";
import { SignIns } from "./sign-in.js";
import { onLockdownChange } from "../lockdown.js";

/**
 * Bucket 19: more than one person, safely. Everything a person signing in from their own device
 * needs, in one object the app holds. It ships off (src/people/settings.ts).
 */
export interface PeopleParts {
  store: Store; owner: string; db: DatabaseSync; roles: ProfileRoles; tokens: SessionTokens;
  fetch: GuardedFetch; secret: (name: string) => Promise<string | undefined>;
}

const SuggestionSchema = z.object({
  provider: z.string().max(40), profileId: z.string().uuid(), subject: z.string().max(255),
  email: z.string().max(254), at: z.string().max(40),
}).strict();
export type Suggestion = z.infer<typeof SuggestionSchema>;
const suggestionsKey = "people-oidc-waiting", maximumSuggestions = 20;

export const peopleOffRefusal = "Signing in from other devices is switched off. The owner can switch it on in Settings.";

export class People {
  readonly keys: PersonKeys;
  readonly passkeys: Passkeys;
  readonly groups: PeopleGroups;
  readonly signIns: SignIns;
  readonly resetCodes = new ResetCodes();
  /** Wrong answers on the sign-in page, counted per place, apart from the computer's own key. */
  readonly limiter = new AuthLimiter();
  constructor(readonly parts: PeopleParts) {
    this.keys = new PersonKeys(parts.db, parts.owner);
    this.passkeys = new Passkeys(parts.store, parts.owner);
    this.groups = new PeopleGroups(parts.store, parts.owner);
    this.signIns = new SignIns({
      profiles: this.profiles, passkeys: this.passkeys, settings: () => this.settings(),
      fetch: parts.fetch, secret: parts.secret, suggest: (found) => this.suggest(found),
    });
    // Integration review: a person's conversation a restart caught while lent to the assistant goes back to them.
    returnLentSessions(parts.store, parts.owner);
    parts.roles.narrowers.push(this.groups.narrow);
    // A key handed to another device for one conversation is held to it (src/session-tokens.ts).
    parts.tokens.boundCheck = (sessionId, method, path) =>
      boundDoorRefusal(sessionId, method, path, (runId) => parts.store.run(runId)?.sessionId ?? null);
    // Lockdown voids every one-time code not used yet, so none outlives it.
    this.stopListening = onLockdownChange((store, owner, on) => {
      if (on && store === parts.store && owner === parts.owner) this.resetCodes.voidAll();
    });
  }
  private readonly stopListening: () => void;
  /** Stops listening for Lockdown; the app is closing. */
  close(): void { this.stopListening(); }
  get profiles(): Profiles { return this.parts.store.profiles; }
  settings() { return peopleSettings(this.parts.store, this.parts.owner); }
  enabled(): boolean { return peopleEnabled(this.parts.store, this.parts.owner); }

  static isPersonKey(supplied: string): boolean { return supplied.startsWith(personKeyPrefix); }

  /**
   * Whose key this is, without asking where it may go (src/caller-policy.ts decides that): the switch, the key and
   * the profile. Answers the plain refusal when it is nobody's.
   */
  identify(supplied: string): { profileId: string; keyId: string; setupOnly: boolean } | string {
    if (!this.enabled()) return peopleOffRefusal;
    const found = this.keys.check(supplied);
    if (typeof found === "string") return found;
    if (!this.profiles.list().some((profile) => profile.id === found.profileId)) {
      this.keys.revokeAll(found.profileId);
      return "That person is no longer on this computer.";
    }
    return { profileId: found.profileId, keyId: found.id, setupOnly: found.method === "setup" };
  }

  /** The entry for the key this request came with (for "who am I" and signing out). */
  entryFor(keyId: string): PersonKeyEntry | null {
    return this.keys.list().find((entry) => entry.id === keyId) ?? null;
  }

  /* ---------- integration review: an account found by its email waits for the owner ---------- */

  suggestions(): Suggestion[] {
    const saved = z.object({ waiting: z.array(SuggestionSchema).max(maximumSuggestions) })
      .safeParse(this.parts.store.get("settings", this.parts.owner, suggestionsKey)?.data);
    return saved.success ? saved.data.waiting : [];
  }
  private suggest(found: Omit<Suggestion, "at">): void {
    const others = this.suggestions().filter((each) => !(each.provider === found.provider && each.profileId === found.profileId));
    const next = [...others, SuggestionSchema.parse({ ...found, at: new Date().toISOString() })].slice(-maximumSuggestions);
    this.writeSuggestions(next);
  }
  private writeSuggestions(waiting: Suggestion[]): void {
    this.parts.store.save("settings", this.parts.owner, suggestionsKey, { waiting });
  }
  /** The owner confirms a waiting account: its subject id is written into the link, and signs the person in from then on. */
  confirmSuggestion(input: unknown): void {
    const wanted = z.object({ provider: z.string().max(40), profileId: z.string().uuid(), subject: z.string().max(255) }).strict().parse(input);
    const waiting = this.suggestions();
    const found = waiting.find((each) => each.provider === wanted.provider && each.profileId === wanted.profileId && each.subject === wanted.subject);
    if (!found) throw new Error("Nothing like that is waiting to be confirmed");
    const links = this.settings().links.filter((link) => !(link.provider === found.provider && link.profileId === found.profileId && !link.subject));
    savePeopleSettings(this.parts.store, this.parts.owner, { links: [...links, { provider: found.provider, profileId: found.profileId, subject: found.subject, email: found.email }] });
    this.writeSuggestions(waiting.filter((each) => each !== found));
  }

  /** Forgets a person everywhere this feature keeps anything about them. */
  forgetProfile(profileId: string): void {
    this.keys.revokeAll(profileId);
    this.passkeys.forget(profileId);
    this.groups.forgetProfile(profileId);
    const waiting = this.suggestions();
    if (waiting.some((each) => each.profileId === profileId))
      this.writeSuggestions(waiting.filter((each) => each.profileId !== profileId));
  }
}
