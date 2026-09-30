import { z } from "zod";
import type { Store } from "./store.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentPerson } from "./people/context.js";
import { fromSetup } from "./setup-origin.js";
import {
  achievementCatalogue, backgroundKinds, keepOakVerifiedFlag, measure, noticedFlags, petKinds, rankFor, seasons, themeNames,
  type Achievement, type AchievementFacts,
} from "./achievements.js";
import { inFrench } from "./achievements-fr.js";
import { inGerman } from "./achievements-de.js";
import { inSpanish } from "./achievements-es.js";
import { popupsOn } from "./onboarding.js";

/**
 * phase2/delight: the playful extras — a pet in the acorn's corner, achievements, and your own
 * background. Each has its own switch and, by the owner's rule (Q251, 2026-09-26: nothing here reaches outside,
 * spends, sends data out or weakens a guard), every one ships on.
 *
 * Everything here is the owner's and stays on this computer: the switches and the achievements are
 * two records in Branch's own settings table, the owner's own picture never leaves the window at all
 * (it is kept in the window's own storage, public/delight.js), and nothing is sent anywhere. A
 * short-lived key, a household profile and a chat app are all refused before anything is read.
 *
 *   GET  /api/delight                 the switches, and how many achievements are earned
 *   POST /api/delight/settings        change a switch
 *   GET  /api/delight/achievements    every achievement, worked out from what really happened
 *   POST /api/delight/noticed         the window saw something (a theme worn, the acorn turned…)
 *   POST /api/delight/told            these achievements were celebrated, so they are not shown again
 */
export class DelightError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/**
 * Whether a switch's `on` was chosen: set only when a change names that `on`. A record written while these shipped off
 * (before Q251) holds `on: false` that nobody chose; such an "off" reads as shipped, on.
 */
const chosen = z.boolean().default(false);
const switchParts = ["pets", "achievements", "background"] as const;
export const DelightSettingsSchema = z.object({
  pets: z.object({
    on: z.boolean().default(true),
    kind: z.enum(petKinds).default("squirrel"),
    name: z.string().trim().min(1).max(20).default("Hazel"),
    /** A small bubble in plain words about what Branch is doing. */
    talks: z.boolean().default(true),
    /** Now and then a short tip about what is on screen. Scarcer as the owner's rank rises. */
    tips: z.boolean().default(true),
    chosen,
  }).strict().prefault({}),
  achievements: z.object({
    on: z.boolean().default(true),
    /** Earned without any pop-up. */
    quiet: z.boolean().default(false),
    chosen,
  }).strict().prefault({}),
  /** How the acorn and the pet are drawn: in pixels (the default) or in 3D. */
  look: z.object({
    style: z.enum(["pixel", "3d"]).default("pixel"),
  }).strict().prefault({}),
  background: z.object({
    on: z.boolean().default(true),
    /** How strongly the theme's own colour is laid over the picture, so text stays readable (20–90). */
    scrim: z.number().int().min(20).max(90).default(60),
    fit: z.enum(["fill", "fit", "tile"]).default("fill"),
    chosen,
  }).strict().prefault({}),
}).strict();
export type DelightSettings = z.infer<typeof DelightSettingsSchema>;
const NoticedSchema = z.object({
  themes: z.array(z.string()).max(200).default([]),
  leaves: z.array(z.string()).max(800).default([]),
  seasons: z.array(z.string()).max(4).default([]),
  pages: z.array(z.string()).max(60).default([]),
  pets: z.array(z.string()).max(petKinds.length).default([]),
  pats: z.number().int().min(0).default(0),
  backgrounds: z.array(z.string()).max(4).default([]),
  flags: z.array(z.string()).max(40).default([]),
});
/** The events counted so far (src/achievement-tallies.ts), so each look reads only what is new. */
const ScanSchema = z.object({
  through: z.number().int().min(0).default(0),
  tools: z.record(z.string(), z.number()).default({}),
  events: z.record(z.string(), z.number()).default({}),
});
const ProgressSchema = z.object({
  /** Achievement id → the day it was earned (YYYY-MM-DD). */
  got: z.record(z.string(), z.string()).default({}),
  /** Earned, and not yet celebrated in the window. */
  fresh: z.array(z.string()).default([]),
  noticed: NoticedSchema.prefault({}),
  scan: ScanSchema.prefault({}),
  /** Still counting a long past (switched on after a busy year): what it brings is found quietly. */
  counting: z.boolean().default(false),
  /**
   * Q251: whether achievements have been worked out for this owner before. They ship on, so an install
   * updated with a long past never sees the switch move: its first look finds that past quietly too.
   */
  looked: z.boolean().default(false),
  /**
   * Setup polish 2: what setup caused (src/setup-origin.ts), never counted: the audit entries by action (switching
   * Devices on to pair a phone is not "Rule maker") and the tasks it started (a new Trunk introducing itself).
   */
  setup: z.object({
    audit: z.record(z.string(), z.number().int().min(0)).default({}),
    tasks: z.array(z.string().max(64)).max(500).default([]),
  }).prefault({}),
});
type Progress = z.infer<typeof ProgressSchema>;
const settingsKey = "delight", progressKey = "delight-achievements";

export function delightSettings(store: Pick<Store, "get">, owner: string): DelightSettings {
  const saved = DelightSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  const settings = saved.success ? saved.data : DelightSettingsSchema.parse({});
  // Each is off only when somebody switched it off; an "off" nobody chose is the old shipped default.
  for (const part of switchParts) if (!settings[part].chosen) settings[part].on = true;
  return settings;
}
function progress(store: Pick<Store, "get">, owner: string): Progress {
  const saved = ProgressSchema.safeParse(store.get("settings", owner, progressKey)?.data ?? {});
  return saved.success ? saved.data : ProgressSchema.parse({});
}
const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/* ---------- working out what is earned ---------- */
const recordTables = ["schedules", "procedures", "specialists", "triggers", "webhooks", "workflows", "memory"] as const;
type DelightStore = Pick<Store, "get" | "save" | "list" | "achievementTallies" | "audit">;
/** What really happened. Moves `saved.scan` on; `caughtUp` is false while a long history is still being counted. */
function factsFor(store: DelightStore, owner: string, saved: Progress): { facts: Omit<AchievementFacts, "earned">; caughtUp: boolean } {
  const audit: Record<string, number> = {};
  for (const row of store.audit.counts(owner)) audit[row.action] = Math.max(0, row.count - (saved.setup.audit[row.action] ?? 0));
  const records: Record<string, number> = {};
  for (const table of recordTables) records[table] = store.list(table, owner).length;
  const { tallies, caughtUp } = store.achievementTallies(owner, saved.scan, saved.setup.tasks);
  return { facts: { tallies, audit, records, noticed: saved.noticed }, caughtUp };
}
let regularIds: Set<string> | null = null;
const regular = (): Set<string> => (regularIds ??= new Set(achievementCatalogue().filter((a) => !a.bonus && a.tier !== "SSS+").map((a) => a.id)));
const earnedOf = (got: Record<string, string>): number => Object.keys(got).filter((id) => regular().has(id)).length;

interface Evaluated { newly: string[]; facts: AchievementFacts; caughtUp: boolean }
/** Writes down every achievement the facts now reach, and which were earned just now. */
function evaluate(store: DelightStore, owner: string, saved: Progress): Evaluated {
  const { facts: base, caughtUp } = factsFor(store, owner, saved), newly: string[] = [];
  let facts: AchievementFacts = { ...base, earned: earnedOf(saved.got) };
  for (let pass = 0; pass < 3; pass++) {
    const reached = achievementCatalogue().filter((a) => !saved.got[a.id] && measure(a.metric, facts) >= a.goal);
    for (const a of reached) { saved.got[a.id] = today(); newly.push(a.id); }
    facts = { ...base, earned: earnedOf(saved.got) };
    if (!reached.length) break;
  }
  return { newly, facts, caughtUp };
}
/** mac7/residuals: the window's language for the achievements' own words ("fr", "de", "es", or English for anything else). */
export const achievementLanguages = ["en", "fr", "de", "es"] as const;
export type AchievementLanguage = (typeof achievementLanguages)[number];
const inLanguage: Record<Exclude<AchievementLanguage, "en">, (a: Achievement) => Partial<Achievement>> = { fr: inFrench, de: inGerman, es: inSpanish };
const worded = (a: Achievement, language: AchievementLanguage): Achievement =>
  (language === "en" ? a : { ...a, ...inLanguage[language](a) });
const achievementLanguage = (asked: string | null): AchievementLanguage =>
  achievementLanguages.find((code) => code === asked) ?? "en";
/** One achievement as the window may see it. The higher the tier, the less a locked one gives away. */
function shown(a: Achievement, saved: Progress, facts: AchievementFacts): Record<string, unknown> {
  const got = saved.got[a.id];
  const bonus = a.bonus ? { bonus: true } : {};
  if (got) return { id: a.id, name: a.name, desc: a.desc, kind: a.kind, tier: a.tier, got, ...bonus };
  if (a.tier === "Godly" || a.tier === "SSS+") return { id: a.id, name: "", desc: "", kind: a.kind, tier: a.tier };
  if (a.tier === "Diamond") return { id: a.id, name: "???", desc: "???", kind: a.kind, tier: a.tier };
  const now = Math.min(measure(a.metric, facts), a.goal);
  return { id: a.id, name: a.name, desc: a.tier === "Gold" ? "???" : a.desc, kind: a.kind, tier: a.tier, now, goal: a.goal, ...bonus };
}
/** Works out and writes down what is earned now, and which of it is to be celebrated. */
function settle(store: DelightStore, owner: string, saved: Progress, settings: DelightSettings): { facts: AchievementFacts; caughtUp: boolean } {
  const through = saved.scan.through, counting = saved.counting, looked = saved.looked;
  const { newly, facts, caughtUp } = evaluate(store, owner, saved);
  // What a long past brings while it is still being counted, or at the first look, is found quietly, like switching on.
  // setup-resume: with "Show tips and pop-ups" off (src/onboarding.ts) they are earned without a pop-up, as when quiet.
  const popups = popupsOn(store, owner);
  if (newly.length && looked && !counting && caughtUp && !settings.achievements.quiet && popups) saved.fresh = [...saved.fresh, ...newly].slice(-50);
  saved.counting = !caughtUp;
  saved.looked = true;
  if (newly.length || !looked || saved.scan.through !== through || saved.counting !== counting) store.save("settings", owner, progressKey, saved);
  return { facts, caughtUp };
}
export function achievementsView(store: DelightStore, owner: string, language: AchievementLanguage = "en"): Record<string, unknown> {
  const settings = delightSettings(store, owner);
  if (!settings.achievements.on) return { on: false };
  const saved = progress(store, owner), during = fromSetup();
  // Setup polish 2: a look from setup works nothing out, writes nothing down and celebrates nothing. What setup caused
  // is set aside; anything real that happened meanwhile is found, and celebrated, at the first look after setup.
  const { facts, caughtUp } = during ? { facts: { ...factsFor(store, owner, saved).facts, earned: earnedOf(saved.got) }, caughtUp: true }
    : settle(store, owner, saved, settings);
  const catalogue = achievementCatalogue().map((a) => worded(a, language));
  const byId = new Map(catalogue.map((a) => [a.id, a]));
  const fresh = (during || !popupsOn(store, owner) ? [] : saved.fresh).map((id) => byId.get(id)).filter((a): a is Achievement => Boolean(a))
    .map((a) => ({ id: a.id, name: a.name, desc: a.desc, tier: a.tier, kind: a.kind, ...(a.bonus ? { bonus: true } : {}) }));
  return {
    on: true, quiet: settings.achievements.quiet, earned: facts.earned, total: catalogue.filter((a) => !a.bonus).length, behind: !caughtUp,
    bonusEarned: catalogue.filter((a) => a.bonus && saved.got[a.id]).length,
    bonusTotal: catalogue.filter((a) => a.bonus).length,
    rank: rankFor(facts.earned), list: catalogue.map((a) => shown(a, saved, facts)), fresh,
  };
}

/** Called only by the connection client's validated /me producer, never by a window notice or locker metadata. */
export function noteKeepOakProfileVerified(store: Pick<Store, "get" | "save" | "profiles">, owner: string,
  identity: { id: string }): void {
  store.profiles.requireOwner("Recording a verified KeepOak profile");
  if (startedWithShortLivedKey() || currentPerson() || owner !== store.profiles.ownerName)
    throw new DelightError(403, "KeepOak verification belongs to the owner's own connection.");
  z.object({ id: z.string().trim().min(1).max(200) }).strict().parse(identity);
  const saved = progress(store, owner);
  if (saved.noticed.flags.includes(keepOakVerifiedFlag)) return;
  // Existing notice endpoints retain their closed list; neither this flag nor account identifiers are accepted there.
  if (saved.noticed.flags.length >= 40) throw new DelightError(409, "The achievement flag record is full.");
  saved.noticed.flags.push(keepOakVerifiedFlag);
  store.save("settings", owner, progressKey, saved);
}

/* ---------- the switches ---------- */
export function delightSummary(store: DelightStore, owner: string): Record<string, unknown> {
  const settings = delightSettings(store, owner);
  const earned = settings.achievements.on ? earnedOf(progress(store, owner).got) : 0;
  return { available: true, settings, earned, rank: rankFor(earned) };
}
export function saveDelightSettings(store: DelightStore, owner: string, input: unknown): DelightSettings {
  const before = delightSettings(store, owner);
  const wanted = z.object({
    pets: z.record(z.string(), z.unknown()).optional(),
    achievements: z.record(z.string(), z.unknown()).optional(),
    background: z.record(z.string(), z.unknown()).optional(),
    look: z.record(z.string(), z.unknown()).optional(),
  }).strict().parse(input ?? {});
  const named = (part: (typeof switchParts)[number]): boolean => before[part].chosen || (wanted[part] !== undefined && "on" in wanted[part]);
  const next = DelightSettingsSchema.parse({
    pets: { ...before.pets, ...wanted.pets, chosen: named("pets") },
    achievements: { ...before.achievements, ...wanted.achievements, chosen: named("achievements") },
    background: { ...before.background, ...wanted.background, chosen: named("background") }, look: { ...before.look, ...wanted.look },
  });
  store.save("settings", owner, settingsKey, next);
  if (next.achievements.on) settingsNoticed(store, owner, before, next);
  return next;
}
/** Changing a switch is a real moment too; switching achievements on finds the past without a party. */
function settingsNoticed(store: DelightStore, owner: string, before: DelightSettings, next: DelightSettings): void {
  if (fromSetup()) return; // setup polish 2: a choice made in setup is first-run configuration
  const saved = progress(store, owner), seen = saved.noticed;
  const add = (list: string[], value: string): void => { if (!list.includes(value)) list.push(value); };
  if (next.pets.on) add(seen.pets, next.pets.kind);
  if (next.pets.on && next.pets.name !== before.pets.name) add(seen.flags, "pet-named");
  if (next.pets.on && !next.pets.talks) add(seen.flags, "pet-talks-off");
  if (next.achievements.quiet) add(seen.flags, "quiet");
  if (next.look.style === "3d") add(seen.flags, "style-3d");
  const { newly, caughtUp } = evaluate(store, owner, saved);
  const quietly = !before.achievements.on || !saved.looked || next.achievements.quiet || saved.counting || !caughtUp || !popupsOn(store, owner);
  if (newly.length && !quietly) saved.fresh = [...saved.fresh, ...newly].slice(-50);
  saved.counting = !caughtUp;
  saved.looked = true;
  store.save("settings", owner, progressKey, saved);
}

/* ---------- what the window saw ---------- */
const windowFlags = ["acorn-shown", "acorn-turned", "still", "everything", "follow-system", "language", "lonely"] as const;
const NoticeSchema = z.discriminatedUnion("what", [
  z.object({ what: z.literal("theme"), mode: z.enum(["light", "dark"]), theme: z.string().max(40), season: z.enum(seasons).optional() }).strict(),
  z.object({ what: z.literal("season"), season: z.enum(seasons) }).strict(),
  z.object({ what: z.literal("page"), page: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
  z.object({ what: z.literal("pat") }).strict(),
  z.object({ what: z.literal("background"), kind: z.enum(backgroundKinds) }).strict(),
  z.object({ what: z.literal("flag"), flag: z.enum(windowFlags) }).strict(),
]);
export function notice(store: DelightStore, owner: string, input: unknown): { kept: boolean } {
  if (!delightSettings(store, owner).achievements.on) return { kept: false };
  const said = NoticeSchema.parse(input ?? {});
  if (fromSetup()) return { kept: false }; // setup polish 2: the look picked in setup is first-run configuration
  const saved = progress(store, owner), seen = saved.noticed, before = JSON.stringify(seen);
  const add = (list: string[], value: string, cap: number): void => { if (!list.includes(value) && list.length < cap) list.push(value); };
  if (said.what === "theme") {
    if (!themeNames().some(([id]) => id === said.theme)) throw new DelightError(400, "Branch has no theme by that name.");
    add(seen.themes, `${said.mode}:${said.theme}`, 200);
    if (said.season) add(seen.leaves, `${said.mode}:${said.theme}:${said.season}`, 800);
  }
  if (said.what === "season") add(seen.seasons, said.season, 4);
  if (said.what === "page") add(seen.pages, said.page, 60);
  if (said.what === "pat") seen.pats = Math.min(seen.pats + 1, 1_000_000);
  if (said.what === "background") add(seen.backgrounds, said.kind, 4);
  if (said.what === "flag" && said.flag in noticedFlags) add(seen.flags, said.flag, 40);
  // Most reports repeat what is already known; only something new is written down.
  if (JSON.stringify(seen) !== before) store.save("settings", owner, progressKey, saved);
  return { kept: true };
}
export function told(store: DelightStore, owner: string, input: unknown): { fresh: number } {
  const { ids } = z.object({ ids: z.array(z.string().max(80)).max(600) }).strict().parse(input ?? {});
  const saved = progress(store, owner);
  saved.fresh = saved.fresh.filter((id) => !ids.includes(id));
  store.save("settings", owner, progressKey, saved);
  return { fresh: saved.fresh.length };
}

/* ---------- what setup caused (setup polish 2) ---------- */
/** Sets aside, as it happens, every audit entry and every task that setup caused (src/setup-origin.ts). */
export function watchSetupOrigin(store: Pick<Store, "get" | "save" | "audit" | "onEvent" | "onRunFinished" | "run">): void {
  const setAside = (owner: string, change: (setup: Progress["setup"]) => void): void => {
    const saved = progress(store, owner);
    change(saved.setup);
    store.save("settings", owner, progressKey, saved);
  };
  store.audit.onRecord((entry) => {
    if (fromSetup()) setAside(entry.owner, (setup) => { setup.audit[entry.action] = (setup.audit[entry.action] ?? 0) + 1; });
  });
  /* A task is set aside when it starts, or when it ends for one that never starts (a Trunk's conversation is opened as
     a task that is only finished). */
  const task = (runId: string): void => {
    const owner = fromSetup() ? store.run(runId)?.owner : undefined;
    if (owner) setAside(owner, (setup) => { if (!setup.tasks.includes(runId)) setup.tasks = [...setup.tasks, runId].slice(-500); });
  };
  store.onEvent((runId, kind) => { if (kind === "run.started") task(runId); });
  store.onRunFinished((runId) => task(runId));
}
/** The tasks setup started, as set aside above; the Overview's recent activity leaves them out (GET /api/state). */
export function setupTaskIds(store: Pick<Store, "get">, owner: string): ReadonlySet<string> {
  return new Set(progress(store, owner).setup.tasks);
}

/* ---------- the one way in ---------- */
interface DelightApp { store: Store; runtime: { owner: string } }
export const delightPaths = ["/api/delight", "/api/delight/settings", "/api/delight/achievements", "/api/delight/noticed", "/api/delight/told"] as const;
export const handlesDelightPath = (path: string): boolean => (delightPaths as readonly string[]).includes(path);
/** Nobody but the owner, at this computer's own window, gets anything here. */
function ownerHere(store: Store): boolean {
  if (startedWithShortLivedKey() || currentPerson()) return false;
  return store.profiles.isOwner();
}
export async function delightRoute(app: DelightApp, method: string, path: string, readBody: () => Promise<unknown>,
  language: string | null = null): Promise<unknown> {
  const { store } = app, owner = app.runtime.owner;
  // Somebody else only learns that there is nothing here for them, never an error in their window.
  if (path === "/api/delight" && method === "GET") return ownerHere(store) ? delightSummary(store, owner) : { available: false };
  if (!ownerHere(store)) throw new DelightError(403, "Only the owner can see or change these, in the app window.");
  if (path === "/api/delight/achievements" && method === "GET") return achievementsView(store, owner, achievementLanguage(language));
  if (method !== "POST") throw new DelightError(405, "Use POST to change this.");
  const body = await readBody();
  if (path === "/api/delight/settings") return { settings: saveDelightSettings(store, owner, body) };
  if (path === "/api/delight/noticed") return notice(store, owner, body);
  if (path === "/api/delight/told") return told(store, owner, body);
  throw new DelightError(404, "Endpoint not found");
}
