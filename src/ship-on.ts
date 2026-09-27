import type { Store } from "./store.js";

/**
 * The owner's rule for defaults (2026-09-26): a feature ships on unless it (a) spends money, (b) sends
 * something out of this computer on its own, (c) deletes something, (d) uses the microphone or camera,
 * (e) uses heavy CPU or disk, or (f) loosens approvals or safety. Those stay off and ask.
 *
 * A record that holds several fields is written whole, so saving one field also writes every other
 * field's default. A record written while a feature still shipped off can therefore hold an "off" that
 * nobody chose. This file keeps, per record, the fields the owner (or a preset they ticked) really set,
 * in one settings record of its own, so the feature's own schema stays as it is. A field that is not in
 * that list reads as it ships now; a field in it keeps the owner's choice, off included.
 *
 * It imports nothing from Branch but the store type, so every settings module can use it.
 */
export const chosenKey = "ship-on-chosen";

type Reader = Pick<Store, "get">;
type Writer = Pick<Store, "get" | "save">;

function chosenBook(store: Reader, owner: string): Record<string, string[]> {
  const data = store.get("settings", owner, chosenKey)?.data;
  if (!data || typeof data !== "object") return {};
  const book: Record<string, string[]> = {};
  for (const [key, fields] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(fields)) book[key] = fields.filter((field): field is string => typeof field === "string");
  }
  return book;
}

/** The fields of one record the owner set. */
export function chosenFields(store: Reader, owner: string, key: string): readonly string[] {
  return chosenBook(store, owner)[key] ?? [];
}

/** Writes down that the owner set these fields of a record. Fields named before stay named. */
export function markChosen(store: Writer, owner: string, key: string, fields: readonly string[]): void {
  if (fields.length === 0) return;
  const book = chosenBook(store, owner);
  const before = book[key] ?? [];
  const next = [...new Set([...before, ...fields])];
  if (next.length === before.length) return;
  store.save("settings", owner, chosenKey, { ...book, [key]: next });
}

/** The field names a change really sent (an object's own keys), for `markChosen`. */
export const sentKeys = (input: unknown): string[] =>
  input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];

/** What every flipped field shipped as before the rule: nothing, "off" or false. */
const isOldDefault = (value: unknown): boolean => value === undefined || value === "off" || value === false;

/** The yes/no an older record keeps beside its switch; it moves with the switch, so it says nothing more. */
const companions = new Set(["enabled"]);

/**
 * A record as it reads under the ship-on rule: each field in `ships` that the owner never set reads as
 * it ships. Every other field is the record's own.
 *
 * A field counts as set when it is in the book above, or when the saved record holds nothing but that one
 * switch: such a record is only ever written by the owner moving that switch, so its "off" was chosen. A record that also holds other fields (a limit, a list) may have had its switch written
 * as the old default when one of those was saved, so there only the book counts.
 */
export function shippedUnlessChosen<T extends Record<string, unknown>>(
  store: Reader, owner: string, key: string, record: T, ships: Partial<T>,
): T {
  const saved = store.get("settings", owner, key)?.data;
  const savedKeys = saved && typeof saved === "object" ? Object.keys(saved as object) : [];
  // One switch and nothing else: several switches in one record are written together, so one set says nothing of the rest.
  const held = savedKeys.filter((field) => field in ships || !companions.has(field));
  const onlySwitches = held.length === 1 && held[0]! in ships;
  const chosen = new Set(chosenFields(store, owner, key));
  const next: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(ships)) {
    const set = chosen.has(field) || (onlySwitches && savedKeys.includes(field));
    // Only an old default can have been written without being chosen: every feature here shipped "off" (or false), so a
    // saved "on", "check" or "knock" was the owner's own and is kept.
    if (!set && isOldDefault(next[field])) next[field] = value;
  }
  return next as T;
}

/**
 * True for a record that says nothing: none saved, or the empty record putting a card back writes. Such a switch reads
 * as it ships. Anything else is read by its schema, and a record the schema cannot read is off (fail closed), so damaged
 * or foreign state never switches a part on.
 */
export const unsetRecord = (data: unknown): boolean =>
  data === undefined || data === null || (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0);

/**
 * The fields a save sets: the ones it sent, and, when the record before it could not be read (so every switch in it was
 * held off, fail closed, and shown off), every shipped switch too. That save writes those offs down; without this they
 * would read as shipped on the next read, a switch turned on that no change list showed.
 */
export function savedFields(before: unknown, readable: boolean, input: unknown, ships: object): string[] {
  const sent = sentKeys(input);
  return readable || unsetRecord(before) ? sent : [...new Set([...sent, ...Object.keys(ships)])];
}

/** Forgets the owner's choices for one record, for "put back to how Branch ships". */
export function forgetChosen(store: Writer, owner: string, key: string): void {
  const book = chosenBook(store, owner);
  if (!(key in book)) return;
  const { [key]: _gone, ...rest } = book;
  store.save("settings", owner, chosenKey, rest);
}
