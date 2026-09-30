import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { personalMode, requirePersonal } from "./settings.js";
import type { SignIn } from "./signin.js";
import { PersonalAccountId } from "./accounts.js";

const instant = z.string().datetime({ offset: true });
const calendarId = z.string().trim().min(1).max(254).refine((s) => !/[\x00-\x20\x7f]/.test(s));
export const FreeSlotsSchema = z.object({
  from: instant, to: instant,
  googleCalendars: z.array(calendarId).max(10).default([]),
  microsoftSchedules: z.array(z.string().trim().email().max(254)).max(10).default([]),
  googleAccount: PersonalAccountId.optional().describe("Google account ID from gmail.accounts; omitted uses the selected Google account."),
  microsoftAccount: PersonalAccountId.optional().describe("Microsoft account ID from outlook.accounts; omitted uses the selected Microsoft account."),
  minutes: z.number().int().min(5).max(480).default(30),
  stepMinutes: z.number().int().min(5).max(120).default(15),
  max: z.number().int().min(1).max(50).default(10),
  /** Explicit working windows avoid guessing anyone's time zone or business hours. */
  windows: z.array(z.object({ from: instant, to: instant }).strict()).max(14).default([]),
}).strict().superRefine((v, ctx) => {
  const from = Date.parse(v.from), to = Date.parse(v.to);
  if (to <= from || to - from > 7 * 86400000)
    ctx.addIssue({ code: "custom", message: "Choose a forward interval of at most seven days" });
  if (v.googleCalendars.length + v.microsoftSchedules.length < 2)
    ctx.addIssue({ code: "custom", message: "Name at least two calendars or people to compare" });
  if (new Set(v.googleCalendars).size !== v.googleCalendars.length ||
      new Set(v.microsoftSchedules.map((s) => s.toLowerCase())).size !== v.microsoftSchedules.length)
    ctx.addIssue({ code: "custom", message: "Each calendar or person must appear only once" });
  for (const w of v.windows) if (Date.parse(w.from) < from || Date.parse(w.to) > to || Date.parse(w.to) <= Date.parse(w.from))
    ctx.addIssue({ code: "custom", message: "Working windows must lie inside the requested interval" });
});
type Query = z.infer<typeof FreeSlotsSchema>;
type Interval = { start: number; end: number };
const Busy = z.object({ start: instant, end: instant }).passthrough();
const GoogleAnswer = z.object({ timeMin: instant, timeMax: instant,
  calendars: z.record(z.string(), z.object({ errors: z.array(z.unknown()).max(50).optional(),
    busy: z.array(Busy).max(10000) }).passthrough()) }).passthrough();
const GraphTime = z.object({ dateTime: z.string().max(80), timeZone: z.string().max(80) }).passthrough();
const GraphAnswer = z.object({ value: z.array(z.object({ scheduleId: z.string().max(254), error: z.unknown().optional(),
  scheduleItems: z.array(z.object({ status: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]),
    start: GraphTime, end: GraphTime }).passthrough()).max(10000) }).passthrough()).max(20) }).passthrough();

function interval(start: string, end: string): Interval {
  const found = { start: Date.parse(start), end: Date.parse(end) };
  if (!Number.isFinite(found.start) || !Number.isFinite(found.end) || found.end <= found.start)
    throw new Error("The calendar returned an invalid busy interval; availability is unknown.");
  return found;
}

function graphInstant(value: z.infer<typeof GraphTime>): string {
  if (!["UTC", "Etc/UTC"].includes(value.timeZone))
    throw new Error("The calendar did not return UTC times; availability is unknown.");
  const text = /(?:Z|[+-]\d\d:\d\d)$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  if (!instant.safeParse(text).success) throw new Error("The calendar returned an invalid time.");
  return text;
}

/** Suggestions use only complete provider busy answers, never missing calendars or event titles. */
export function commonFreeSlots(query: Query, busy: readonly Interval[]) {
  const duration = query.minutes * 60000, step = query.stepMinutes * 60000;
  const windows = query.windows.length ? query.windows : [{ from: query.from, to: query.to }];
  const candidates = new Set<number>();
  for (const w of windows) {
    const end = Date.parse(w.to);
    for (let at = Date.parse(w.from); at + duration <= end; at += step) candidates.add(at);
  }
  const merged: Interval[] = [];
  for (const value of [...busy].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && value.start <= last.end) last.end = Math.max(last.end, value.end);
    else merged.push({ ...value });
  }
  const slots: { from: string; to: string }[] = [];
  let cursor = 0;
  for (const at of [...candidates].sort((a, b) => a - b)) {
    while (merged[cursor] && merged[cursor]!.end <= at) cursor++;
    if (merged[cursor] && merged[cursor]!.start < at + duration) continue;
    slots.push({ from: new Date(at).toISOString(), to: new Date(at + duration).toISOString() });
    if (slots.length === query.max) break;
  }
  return slots;
}

export interface AvailabilityDeps {
  store: Store; owner: string; fetch: typeof fetch;
  signIns: { google: SignIn; microsoft: SignIn };
  requireOwner: (what: string) => void;
}

export class CalendarAvailability {
  constructor(private readonly deps: AvailabilityDeps) {}

  private check(service: "google" | "microsoft", context: ToolContext, identity: string): void {
    context.signal.throwIfAborted();
    this.deps.requireOwner("Comparing your calendars");
    requirePersonal(this.deps.store, this.deps.owner, service);
    if (this.deps.signIns[service].mailPreviewIdentity() !== identity)
      throw new Error("The account changed during this request. Ask again using the current sign-in.");
    if (service === "google" && !this.deps.signIns.google.settings().availability)
      throw new Error("Allow shared calendar availability on your Google card, then sign in again.");
  }

  private async call(service: "google" | "microsoft", url: string, json: unknown, context: ToolContext): Promise<unknown> {
    const signin = this.deps.signIns[service], identity = signin.mailPreviewIdentity();
    this.check(service, context, identity);
    if (service === "google") {
      const status = await signin.status();
      this.check(service, context, identity);
      if (!status.scope?.split(/\s+/).includes("https://www.googleapis.com/auth/calendar.freebusy"))
        throw new Error("Sign in again to consent to shared calendar availability.");
    }
    const token = await signin.token();
    this.check(service, context, identity);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)]);
    const response = await this.deps.fetch(url, { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: 'outlook.timezone="UTC"' },
      body: JSON.stringify(json) });
    this.check(service, context, identity);
    if (!response.ok) throw new Error(`${service} availability is unavailable (${response.status}); no free slots inferred.`);
    return this.read(response, context, service, identity);
  }

  private async read(response: Response, context: ToolContext, service: "google" | "microsoft", identity: string): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty calendar response; availability is unknown.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        this.check(service, context, identity);
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error("Calendar response is too large; no free slots inferred.");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally { await reader.cancel().catch(() => undefined); }
  }

  private async google(query: Query, context: ToolContext): Promise<Interval[]> {
    if (!query.googleCalendars.length) return [];
    const body = GoogleAnswer.parse(await this.call("google", "https://www.googleapis.com/calendar/v3/freeBusy",
      { timeMin: query.from, timeMax: query.to, timeZone: "UTC", calendarExpansionMax: 10,
        items: query.googleCalendars.map((id) => ({ id })) }, context));
    if (Date.parse(body.timeMin) !== Date.parse(query.from) || Date.parse(body.timeMax) !== Date.parse(query.to))
      throw new Error("Calendar response did not cover the requested interval.");
    return query.googleCalendars.flatMap((id) => {
      const calendar = Object.hasOwn(body.calendars, id) ? body.calendars[id] : undefined;
      if (!calendar || calendar.errors?.length) throw new Error("One requested Google calendar is unavailable; no common free slots inferred.");
      return calendar.busy.map((b) => interval(b.start, b.end));
    });
  }

  private async microsoft(query: Query, context: ToolContext): Promise<Interval[]> {
    if (!query.microsoftSchedules.length) return [];
    const body = GraphAnswer.parse(await this.call("microsoft", "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
      { schedules: query.microsoftSchedules, startTime: { dateTime: new Date(query.from).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
        endTime: { dateTime: new Date(query.to).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, availabilityViewInterval: 15 }, context));
    return query.microsoftSchedules.flatMap((id) => {
      const matches = body.value.filter((v) => v.scheduleId.toLowerCase() === id.toLowerCase());
      if (matches.length !== 1 || matches[0]!.error != null)
        throw new Error("One requested Outlook schedule is unavailable. Shared availability requires a work or school account.");
      return matches[0]!.scheduleItems.flatMap((item) => {
        if (item.status === "unknown") throw new Error("A requested Outlook schedule has unknown availability.");
        const range = interval(graphInstant(item.start), graphInstant(item.end));
        return item.status === "free" ? [] : [range];
      });
    });
  }

  async find(input: unknown, context: ToolContext) {
    const query = FreeSlotsSchema.parse(input);
    // Resolve both owner namespaces before the first await and keep them pinned through every provider read.
    return this.deps.signIns.google.withAccount(query.googleAccount, () =>
      this.deps.signIns.microsoft.withAccount(query.microsoftAccount, () => this.findBound(query, context)));
  }

  private async findBound(query: Query, context: ToolContext) {
    const identities = { google: this.deps.signIns.google.mailPreviewIdentity(), microsoft: this.deps.signIns.microsoft.mailPreviewIdentity() };
    const busy = [...await this.google(query, context), ...await this.microsoft(query, context)];
    if (query.googleCalendars.length) this.check("google", context, identities.google);
    if (query.microsoftSchedules.length) this.check("microsoft", context, identities.microsoft);
    return { from: query.from, to: query.to, timeZone: "UTC", calendarsCompared: query.googleCalendars.length + query.microsoftSchedules.length,
      accounts: { google: query.googleCalendars.length ? this.deps.signIns.google.accountId() : null,
        microsoft: query.microsoftSchedules.length ? this.deps.signIns.microsoft.accountId() : null },
      minutes: query.minutes, slots: commonFreeSlots(query, busy), booked: false,
      note: "Availability at the time of this request only. No event was booked. Tentative and away times count as busy; specify working windows for business hours." };
  }
}

export function registerCalendarAvailability(registry: Pick<ToolRegistry, "register">, helper: CalendarAvailability): void {
  registry.register({ name: "calendars.free_slots", permission: "personal.read", parameters: FreeSlotsSchema,
    description: "Find common free slots across named Google calendars and Microsoft work/school schedules. Choose Google/Microsoft account IDs from gmail.accounts/outlook.accounts, or use the selected accounts. Uses only calendars those owner accounts can access; does not book anything.",
    execute: (input, context) => helper.find(input, context) });
}

export function availabilityEnabled(store: Store, owner: string): boolean {
  return personalMode(store, owner, "google") !== "off" || personalMode(store, owner, "microsoft") !== "off";
}
