import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import { nameKey, type Profiles } from "./profiles.js";
import { roleLabels } from "./profile-roles.js";

/**
 * your-profile: what each person on this computer shows of themselves — the name the window calls
 * them by, their picture (a photo, an initial on a colour, or an emoji), and for the owner the time
 * zone their schedules are proposed in. Kept in the owner's settings, one record per person.
 *
 * Only you change your own: the owner's through /api/profiles/owner/…, which a household person is
 * refused at one place in src/server.ts like every other owner-only change (src/household-routes.ts);
 * a household person's through /api/profiles/<their id>/…, which answers only while that person is
 * the one using the app. The owner is refused another person's too: a name and a face are the
 * person's own. Reading is anybody's in the household, so every tile can show every face.
 *
 * A household person's name is their profile's own name (src/profiles.ts), which is also the name
 * they type to sign in from another device, so changing it changes that too.
 */
type Branch = { store: Store; runtime: { owner: string } };
type ReadBody = (maximumBytes?: number) => Promise<unknown>;

const idPattern = "[a-f0-9-]{36}";
export const faces = ["initial", "emoji", "photo"] as const;
const zone = z.string().min(1).max(64).refine((name) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}, "Unknown timezone");
const emoji = z.string().max(16).regex(/^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]{0,12}$/u, "Pick one emoji");
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour is written #rrggbb").transform((value) => value.toLowerCase());
const shared = { face: z.enum(faces).optional(), color: colour.nullable().optional(), emoji: emoji.nullable().optional() };
/** The owner's: the name (null forgets it, and the window calls them by the role again) and the time zone too. */
const OwnerAboutSchema = z.object({ name: z.string().trim().min(1).max(40).nullable().optional(), timezone: zone.nullable().optional(), ...shared }).strict();
/** A household person's: every profile has a name, so it can be changed but not taken away. */
const PersonAboutSchema = z.object({ name: z.string().trim().min(1).max(40).optional(), ...shared }).strict();

/** A picture: PNG, JPEG, WebP or GIF, as a data address, a quarter of a megabyte at most once decoded. */
export const maximumPictureBytes = 256 * 1024;
const PictureSchema = z.object({ picture: z.string().max(Math.ceil(maximumPictureBytes * 4 / 3) + 64) }).strict();
const PICTURE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export interface Face { face: (typeof faces)[number]; color: string | null; emoji: string | null; picture: string | null }
export interface About extends Face { name: string | null; timezone: string | null }

const aboutKey = (who: string) => `person-about:${who}`;
const pictureKey = (who: string) => `person-picture:${who}`;

/** What the bytes say they are, whatever the address claims. */
function sniff(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function saved(store: Store, owner: string, who: string): Record<string, unknown> {
  return store.get("settings", owner, aboutKey(who))?.data ?? {};
}
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** One person's face, for their tile: the picture is only a stamp here; its bytes have their own route. */
export function faceOf(store: Store, owner: string, who: string): Face {
  const data = saved(store, owner, who);
  const picture = text(store.get("settings", owner, pictureKey(who))?.updatedAt);
  const face = faces.includes(data.face as Face["face"]) ? data.face as Face["face"] : "initial";
  return { face: face === "photo" && !picture ? "initial" : face, color: text(data.color), emoji: text(data.emoji), picture };
}

/** One person's profile. A household person's name is their profile's; the owner's is theirs to give. */
export function aboutOf(app: Branch, who: string): About {
  const { store } = app, owner = app.runtime.owner;
  const data = saved(store, owner, who);
  const name = who === "owner" ? text(data.name) : store.profiles.list().find((p) => p.id === who)?.name ?? null;
  return { name, timezone: who === "owner" ? text(data.timezone) : null, ...faceOf(store, owner, who) };
}

/** The owner's time zone for schedules and automations: the one they chose, else this computer's. */
export function ownerTimezone(store: Store, owner: string): string {
  return text(saved(store, owner, "owner").timezone) ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
}

/**
 * Anything a person's own route may do is refused to anybody else, the owner included, and the owner's phone too: a
 * request through the paired door is the owner's (src/people/context.ts), whoever the window here is switched to.
 */
function requireSelf(profiles: Profiles, who: string): void {
  if (!profiles.list().some((p) => p.id === who)) throw new Error("No profile with that name");
  if (profiles.isOwner() || profiles.active()?.id !== who)
    throw new Error("Only that person can change their own profile.");
}

/**
 * The owner's role word in every language the window speaks (household.role.owner in public/locales, and the engine's
 * own in src/profile-roles.ts). The owner's tile shows it until they give a name, so nobody else may go by it.
 */
export const ownerRoleWords: readonly string[] = [roleLabels.owner.label, "Eigentümer", "Propietario", "Propriétaire"];
const isOwnerRoleWord = (key: string): boolean => ownerRoleWords.some((word) => nameKey(word) === key);
const taken = (): Error => new Error("Someone here already uses that name");

/**
 * Refuses a name somebody else here already goes by, compared as the tiles show them (nameKey, src/profiles.ts): two
 * people with one name would make "Switch to" and "Back to" ambiguous at the keyboard. Nobody but the owner may take the
 * owner's role word either, which is what the owner's tile says while they have no name. `who` is the one taking it
 * ("owner", a profile id, or null for somebody new).
 */
export function refuseTakenName(app: Branch, name: string, who: string | null): void {
  const wanted = nameKey(name);
  const owners = who === "owner" ? null : text(saved(app.store, app.runtime.owner, "owner").name);
  if (who !== "owner" && isOwnerRoleWord(wanted)) throw taken();
  if ((owners !== null && nameKey(owners) === wanted)
    || app.store.profiles.list().some((p) => p.id !== who && nameKey(p.name) === wanted)) throw taken();
}

/** Everything is checked before anything changes, so a refused request leaves the profile exactly as it was. */
function saveAbout(app: Branch, who: string, input: unknown): About {
  const { store } = app, owner = app.runtime.owner, profiles = store.profiles;
  const value = who === "owner" ? OwnerAboutSchema.parse(input ?? {}) : PersonAboutSchema.parse(input ?? {});
  const before = aboutOf(app, who);
  const { name, ...rest } = value as z.infer<typeof OwnerAboutSchema>;
  const renamed = name !== undefined && name !== before.name;
  if (renamed && typeof name === "string") refuseTakenName(app, name, who);
  // The owner going back to their role word: not while somebody else here already goes by it.
  if (renamed && name === null && profiles.list().some((p) => isOwnerRoleWord(nameKey(p.name)))) throw taken();
  const next = { ...saved(store, owner, who), ...rest, ...(who === "owner" && name !== undefined ? { name } : {}) };
  if (next.face === "photo" && !faceOf(store, owner, who).picture) throw new Error("Add a photo first");
  if (who !== "owner" && renamed && typeof name === "string") profiles.rename(who, name);
  store.save("settings", owner, aboutKey(who), next);
  const after = aboutOf(app, who);
  if (after.name !== before.name) audit(store, owner, {
    action: "policy.changed", actor: before.name ?? owner, subject: "their own name",
    reason: after.name ? `Now called ${after.name}` : "Went back to being called by their role", outcome: "saved",
  });
  if (after.timezone !== before.timezone) audit(store, owner, {
    action: "policy.changed", actor: after.name ?? owner, subject: "the time zone schedules are proposed in",
    reason: after.timezone ? `Now ${after.timezone}` : "Back to this computer's", outcome: "saved",
  });
  return after;
}

function savePicture(app: Branch, who: string, input: unknown): About {
  const { store } = app, owner = app.runtime.owner;
  const found = PICTURE.exec(PictureSchema.parse(input ?? {}).picture);
  if (!found) throw new Error("Use a PNG, JPEG, WebP or GIF picture");
  const bytes = Buffer.from(found[2]!, "base64");
  if (bytes.length > maximumPictureBytes) throw new Error(`A picture is ${maximumPictureBytes / 1024} KiB at most`);
  if (sniff(bytes) !== found[1]) throw new Error("Use a PNG, JPEG, WebP or GIF picture");
  store.save("settings", owner, pictureKey(who), { type: found[1], data: bytes.toString("base64") });
  store.save("settings", owner, aboutKey(who), { ...saved(store, owner, who), face: "photo" });
  return aboutOf(app, who);
}

function removePicture(app: Branch, who: string): About {
  const { store } = app, owner = app.runtime.owner;
  store.delete("settings", owner, pictureKey(who));
  const data = saved(store, owner, who);
  if (data.face === "photo") store.save("settings", owner, aboutKey(who), { ...data, face: "initial" });
  return aboutOf(app, who);
}

function pictureOf(app: Branch, who: string): { picture: string | null } {
  const data = app.store.get("settings", app.runtime.owner, pictureKey(who))?.data;
  return { picture: typeof data?.type === "string" && typeof data.data === "string" ? `data:${data.type};base64,${data.data}` : null };
}

/** Removing somebody takes their profile's name, face and picture with them. */
export function forgetAbout(store: Store, owner: string, who: string): void {
  store.delete("settings", owner, aboutKey(who));
  store.delete("settings", owner, pictureKey(who));
}

const ownerParts: Record<string, string> = {
  "/api/profiles/owner/about": "about",
  "/api/profiles/owner/picture": "picture",
  "/api/profiles/owner/picture/remove": "picture/remove",
};

/** The profile routes. Answers undefined for any other path. */
export async function personAboutApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown> {
  const mine = new RegExp(`^/api/profiles/(${idPattern})/(about|picture|picture/remove)$`).exec(path);
  const part = ownerParts[path] ?? mine?.[2];
  if (!part) return undefined;
  const who = mine ? mine[1]! : "owner";
  if (request.method === "GET" && part === "about") return aboutOf(app, who);
  if (request.method === "GET" && part === "picture") return pictureOf(app, who);
  if (request.method !== "POST") return undefined;
  if (who === "owner") app.store.profiles.requireOwner("Your profile");
  else requireSelf(app.store.profiles, who);
  if (part === "about") return saveAbout(app, who, await body());
  if (part === "picture") return savePicture(app, who, await body(Math.ceil(maximumPictureBytes * 4 / 3) + 1024));
  await body();
  return removePicture(app, who);
}
