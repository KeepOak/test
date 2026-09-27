import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Bucket 19: which person one request is for, when it came in with a person's own key.
 *
 * The household's profile switch (src/profiles.ts) is one setting for the whole app: whoever sits
 * at this computer. A person who signed in from their own device is somebody else at the same
 * moment, so their request carries its own answer here, and it follows everything the request
 * starts. While it is set, the profile switch answers for that person and never for the owner:
 * a person's key can never be read as the owner's, whatever the window is switched to.
 */
export interface PersonMark {
  profileId: string;
  /** The person key's id, so a question their task asks can be told apart from anybody else's. */
  keyId: string;
}
const person = new AsyncLocalStorage<PersonMark>();

/** Marks the rest of the current request as one person's. */
export function enterPerson(mark: PersonMark): void {
  person.enterWith({ ...mark });
}
/** Runs `work` as one person (for tests and for callers that already know who it is). */
export function asPerson<T>(mark: PersonMark, work: () => T): T {
  return person.run({ ...mark }, work);
}
/** The person this request is for, or null when it is the app window (the profile switch decides). */
export function currentPerson(): PersonMark | null {
  return person.getStore() ?? null;
}

/**
 * A request through the paired door (the phone's, src/server.ts). The phone was paired by the owner and carries the
 * owner's key, so its request is the owner's, never the household person the window here is switched to. Marked once
 * where the door is checked, it follows everything the request starts, and src/profiles.ts reads it where every
 * request's person is judged. A person's own key still answers for that person, wherever it comes in.
 */
const pairedDoor = new AsyncLocalStorage<true>();
/** Marks the rest of the current request as one through the paired door. */
export function enterPairedDoor(): void {
  pairedDoor.enterWith(true);
}
export function throughPairedDoor(): boolean {
  return pairedDoor.getStore() === true;
}
