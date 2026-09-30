import { constants, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";

/**
 * The list that ships with the app; the owner's own copy in their data folder wins over it. The
 * build puts a copy beside the compiled code, because the packaged app ships that and not the
 * repository's `data/` folder; running straight from the repository finds the original.
 */
const bundledHolidays = [new URL("./holidays.json", import.meta.url), new URL("../data/holidays.json", import.meta.url)];

/**
 * Days off and quiet hours. The app ships with a short, plainly incomplete list of public holidays
 * for a few countries; on first use a copy is put in the owner's data folder, and that copy is the
 * one that counts, so anything wrong or missing can simply be corrected. A schedule can be told to
 * skip a day off or move to the next working day, and messages wait until quiet hours are over.
 */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-25");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 21:30");
/** Nothing is held back until the owner switches quiet hours on. */
export const quietHoursDefaults = { enabled: false, from: "21:00", to: "07:00", timezone: "UTC", days: [] as number[] };
export const QuietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  from: clock.default("21:00"),
  to: clock.default("07:00"),
  timezone: z.string().min(1).max(64).default("UTC"),
  /** wire-greyed: whole days off from notifications, every week (1 is Monday, 7 is Sunday), quiet all day long. */
  days: z.array(z.number().int().min(1).max(7)).max(6, "Leave at least one day of the week with notifications").default([]),
}).strict();
export const CalendarSchema = z.object({
  /** Which bundled holiday list to use; empty means none. */
  country: z.string().regex(/^[A-Z]{0,2}$/, "Use a two-letter country code").default(""),
  /** The owner's own days off, on top of the holiday list. */
  daysOff: z.array(isoDay).max(200).default([]),
  /** Which weekdays count as working days; 1 is Monday and 7 is Sunday. */
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5]),
  timezone: z.string().min(1).max(64).default("UTC"),
  quietHours: QuietHoursSchema.default(quietHoursDefaults),
}).strict();
export type CalendarSettings = z.infer<typeof CalendarSchema>;
export type QuietHours = z.infer<typeof QuietHoursSchema>;
/** Quiet hours as the checks read them: whole days off may be left out. */
export type QuietRule = Omit<QuietHours, "days"> & { days?: readonly number[] | undefined };
export interface HolidayList { name: string; days: Record<string, string> }

/** The day and weekday a moment falls on in a given place, as plain numbers. */
export function localDay(at: Date, timezone: string): { day: string; weekday: number; minutes: number } {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(at))
    if (part.type !== "literal") parts[part.type] = part.value;
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: order.indexOf(parts.weekday ?? "Mon") + 1,
    minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
/** Whether a moment lands on a day the owner does not work: a weekend, a holiday or their own day off. */
export function dayOffReason(at: Date, settings: CalendarSettings, holidays: Record<string, string>): string | null {
  const { day, weekday } = localDay(at, settings.timezone);
  if (settings.daysOff.includes(day)) return "a day you marked off";
  if (holidays[day]) return holidays[day]!;
  if (!settings.workingDays.includes(weekday)) return "not one of your working days";
  return null;
}
/** The same clock time on the next day that is a working day, at most a fortnight ahead. */
export function nextWorkingDay(at: Date, settings: CalendarSettings, holidays: Record<string, string>): Date {
  let candidate = at;
  for (let step = 0; step < 14; step++) {
    candidate = new Date(candidate.getTime() + 86400000);
    if (!dayOffReason(candidate, settings, holidays)) return candidate;
  }
  return candidate;
}
/** What a schedule set to mind days off should do right now: run, skip this one, or move it. */
export function dayOffDecision(at: Date, mode: "run" | "skip" | "shift", settings: CalendarSettings, holidays: Record<string, string>):
  { action: "run" | "skip" | "shift"; reason: string | null; moveTo?: string } {
  if (mode === "run") return { action: "run", reason: null };
  const reason = dayOffReason(at, settings, holidays);
  if (!reason) return { action: "run", reason: null };
  if (mode === "skip") return { action: "skip", reason };
  return { action: "shift", reason, moveTo: nextWorkingDay(at, settings, holidays).toISOString() };
}
/** Whether a moment falls on one of the whole days off from notifications. They hold even while quiet hours are off. */
const quietDay = (at: Date, quiet: QuietRule): boolean => (quiet.days ?? []).includes(localDay(at, quiet.timezone).weekday);
/** Whether a moment falls inside quiet hours, which may run past midnight, or on a whole day off. */
export function inQuietHours(at: Date, quiet: QuietRule): boolean {
  if (quietDay(at, quiet)) return true;
  if (!quiet.enabled) return false;
  const now = localDay(at, quiet.timezone).minutes;
  const from = Number(quiet.from.slice(0, 2)) * 60 + Number(quiet.from.slice(3));
  const to = Number(quiet.to.slice(0, 2)) * 60 + Number(quiet.to.slice(3));
  return from === to ? true : from < to ? now >= from && now < to : now >= from || now < to;
}
/** When quiet hours end, so a message can be held until then; null when it is not quiet now. */
export function quietUntil(at: Date, quiet: QuietRule): string | null {
  if (!inQuietHours(at, quiet)) return null;
  // A whole day off lasts until the next local midnight that starts a day that isn't one, then quiet hours may go on.
  let from = at;
  for (let step = 0; step < 7 && quietDay(from, quiet); step++)
    from = new Date(from.getTime() + (1440 - localDay(from, quiet.timezone).minutes) * 60000);
  if (from !== at) return inQuietHours(from, quiet) ? quietUntil(from, quiet) : from.toISOString();
  const to = Number(quiet.to.slice(0, 2)) * 60 + Number(quiet.to.slice(3));
  const now = localDay(at, quiet.timezone).minutes;
  const minutes = to > now ? to - now : 1440 - now + to;
  return new Date(at.getTime() + minutes * 60000).toISOString();
}

export class CalendarSettingsStore {
  private cached: Record<string, HolidayList> | undefined;
  constructor(private readonly store: Store, private readonly dataDir: string) {}
  settings(owner: string): CalendarSettings {
    return CalendarSchema.parse(this.store.get("settings", owner, "calendar")?.data ?? {});
  }
  configure(owner: string, input: unknown): CalendarSettings {
    const value = CalendarSchema.parse(input);
    this.store.save("settings", owner, "calendar", value);
    return value;
  }
  /** The holiday lists in use: the owner's own copy if they have one, otherwise the bundled one. */
  lists(): Record<string, HolidayList> {
    if (this.cached) return this.cached;
    const sources: (string | URL)[] = [join(this.dataDir, "holidays.json"), ...bundledHolidays];
    for (const source of sources) {
      try {
        const parsed = JSON.parse(readFileSync(source, "utf8")) as { countries?: Record<string, HolidayList> };
        if (parsed.countries) return (this.cached = parsed.countries);
      } catch { /* the owner's copy may not exist yet, and a damaged one falls back to the bundled list */ }
    }
    return (this.cached = {});
  }
  /** Puts an editable copy of the bundled list in the owner's data folder, once. */
  async seed(): Promise<void> {
    for (const source of bundledHolidays) {
      const copied = await copyFile(source, join(this.dataDir, "holidays.json"), constants.COPYFILE_EXCL)
        .then(() => true, () => false);
      if (copied) return;
    }
  }
  /** The chosen country's days, or an empty list when the owner has not picked one. */
  holidays(owner: string): Record<string, string> {
    const country = this.settings(owner).country;
    return country ? this.lists()[country]?.days ?? {} : {};
  }
  /** Countries the app knows about, for the settings list. */
  countries(): { code: string; name: string; days: number }[] {
    return Object.entries(this.lists()).map(([code, list]) => ({ code, name: list.name, days: Object.keys(list.days).length }));
  }
  /** When a message should be held until, or null to send it now. */
  holdUntil(owner: string, at = new Date()): string | null {
    return quietUntil(at, this.settings(owner).quietHours);
  }
  decide(owner: string, at: Date, mode: "run" | "skip" | "shift") {
    return dayOffDecision(at, mode, this.settings(owner), this.holidays(owner));
  }
}
