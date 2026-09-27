import { z } from "zod";
import { declareShape, type AnswerShape, type ShapedAnswer } from "./answer-shape.js";
import { ScheduleSchema, nextTurn } from "./scheduler.js";

/**
 * Words to a schedule, for the owner to confirm. "every weekday at 8, check my inbox for invoices"
 * becomes a proposal: what to do, when it comes round, and when it would first run. Nothing is saved
 * here; the owner's yes is the ordinary POST /api/schedules with the proposal's `schedule`.
 *
 * The common ways of saying when are read here, with no model and nothing leaving this computer.
 * Only words this cannot read are put to the configured model, as one question with a fixed answer
 * shape, and its answer goes through the same checks. Words about an event rather than a clock ("when a
 * receipt arrives", "after each meeting") are not a schedule, and are refused in one sentence.
 */
/** The owner's changes on the proposal card: what to do and when, read again with its first run worked out. */
const EditSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
  intervalMs: z.number().int().min(60_000).max(31_536_000_000).optional(),
}).strict();
export const ProposeScheduleSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  edit: EditSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
}).strict().refine((body) => (body.text === undefined) !== (body.edit === undefined), "Send either the words or the edited schedule");

export interface Recurrence { dailyAt?: string; weekdays?: number[]; monthDay?: number; intervalMs?: number }
/** Whether the words said the time, only hinted at it ("every evening"), or said none (nine is filled in). */
export type TimeSaid = "said" | "guessed" | "none";
export interface ReadWords { prompt: string; recurrence: Recurrence; time: TimeSaid }
export interface ScheduleProposal {
  /** Ready for POST /api/schedules as it is. */
  schedule: z.infer<typeof ScheduleSchema>;
  firstRunAt: string;
  /** When it comes round and when it first runs, in plain words. */
  words: string;
  /** The same clock as a five-field cron line, for the Technical level; null for "every so often". */
  cron: string | null;
  time: TimeSaid;
  source: "words" | "model" | "edit";
}
export type AskModel = (question: string, shape: AnswerShape) => Promise<ShapedAnswer>;

export const notASchedule = "Branch could not read when this should run from those words. Say when, for example: every weekday at 8, check my inbox for invoices.";

const minuteMs = 60_000;
const NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DAY = "(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)day";
const DAYS = `${DAY}s?(?:\\s*(?:,|and|&)\\s*${DAY}s?)*`;
const SPAN = "week\\s?days?|working\\s+days?|weekends?|day|morning|evening|night|afternoon";
const EVERY = `(?:every|each)\\s+(?:${DAYS}|${SPAN})`;
const PLURAL = `(?:on\\s+)?(?:${DAY}s(?:\\s*(?:,|and|&)\\s*${DAY}s)*|weekdays|weekends)`;
const SPEC = `${EVERY}|${PLURAL}|daily|nightly`;
const ORD = "(\\d{1,2})(?:st|nd|rd|th)?";
const MONTH = `(?:every|each)\\s+month(?:\\s+on\\s+the\\s+${ORD})?|monthly(?:\\s+on\\s+the\\s+${ORD})?|on\\s+the\\s+${ORD}\\s+of\\s+(?:every|each)\\s+month`;
const TIME = "at\\s+(?:noon|midday|midnight|\\d{1,2}(?::\\d{2})?(?:\\s*[ap]\\.?m\\.?)?)|\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?|\\d{1,2}:\\d{2}";
const COUNT = "\\d{1,3}|a|an|one|two|three|four|five|six|ten|twelve|fifteen|twenty|thirty|forty-five|forty five";
const INTERVAL = `(?:every|each)\\s+(?:(?:${COUNT})\\s+)?(?:minutes?|mins?|hours?|hrs?)|hourly|(?:every|each)\\s+(?:${COUNT})\\s+days`;
const PHRASE = new RegExp(`\\b(?:(?:${MONTH}|${SPEC})(?:\\s*,?\\s*(?:${TIME}))?|(?:${TIME})\\s+(?:${MONTH}|${SPEC})|${INTERVAL})\\b\\.?`, "i");

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45, "forty five": 45 };
const count = (word: string | undefined): number => (word === undefined ? 1 : WORD_NUMBERS[word.toLowerCase()] ?? Number(word));

/** Every N minutes, hours or days, or null when the phrase is not an interval. */
function intervalOf(phrase: string): number | null {
  if (/^hourly\b/i.test(phrase)) return 60 * minuteMs;
  const found = new RegExp(`(?:every|each)\\s+(?:(${COUNT})\\s+)?(minutes?|mins?|hours?|hrs?|days)`, "i").exec(phrase);
  if (!found) return null;
  const unit = found[2]!.toLowerCase();
  return count(found[1]) * (unit.startsWith("d") ? 1440 : unit.startsWith("h") ? 60 : 1) * minuteMs;
}

/** The clock time the phrase names, as HH:MM. A bare hour is read the way people say it: 5 is 5 PM, 8 is 8 AM, and
 *  "morning", "evening" or "night" beside it settle it. */
function timeOf(phrase: string): string | null {
  const said = new RegExp(TIME, "i").exec(phrase)?.[0].toLowerCase();
  if (!said) return null;
  if (/noon|midday/.test(said)) return "12:00";
  if (/midnight/.test(said)) return "00:00";
  const [, h, m, half] = /(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?/.exec(said) ?? [];
  let hour = Number(h);
  const minute = Number(m ?? 0);
  if (hour > 23 || minute > 59 || (half && (hour < 1 || hour > 12))) return null;
  if (half) hour = half === "p" ? (hour % 12) + 12 : hour % 12;
  else if (hour <= 12) hour = bareHour(hour, phrase.toLowerCase());
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
function bareHour(hour: number, lower: string): number {
  if (/\b(evening|afternoon)\b/.test(lower)) return (hour % 12) + 12;
  if (/\bnight(ly)?\b/.test(lower)) return hour >= 7 && hour < 12 ? hour + 12 : hour % 12;
  if (/\bmorning\b/.test(lower)) return hour % 12;
  return hour >= 1 && hour <= 6 ? hour + 12 : hour;
}

/** With no time said, the usual time for the part of the day the words name, or null when they name none. */
function usualTime(phrase: string): string | null {
  const lower = phrase.toLowerCase();
  if (/\bmorning\b/.test(lower)) return "08:00";
  return /\bafternoon\b/.test(lower) ? "14:00" : /\bevening\b/.test(lower) ? "18:00" : /\bnight(ly)?\b/.test(lower) ? "21:00" : null;
}
const LEFT_OVER = /\b(morning|afternoon|evening|night|tonight|noon|midday|midnight|o'?clock|half past|quarter (past|to)|at \d|\d{1,2}\s*[ap]\.?m\b|\d{1,2}:\d{2})/i;

function daysOf(phrase: string): number[] | null {
  const lower = phrase.toLowerCase();
  if (/\b(week\s?days?|working\s+days?)\b/.test(lower)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(lower)) return [0, 6];
  const named = [...lower.matchAll(new RegExp(DAY, "g"))].map((m) => NAMES.findIndex((name) => name.startsWith(m[0].slice(0, 3))));
  return named.length ? [...new Set(named)].sort((a, b) => a - b) : null;
}

/** The when and the what, read from the words with no model; null when the words say no clock. */
export function readScheduleWords(text: string): ReadWords | null {
  const found = PHRASE.exec(text);
  if (!found) return null;
  const phrase = found[0];
  const prompt = (text.slice(0, found.index) + " " + text.slice(found.index + phrase.length))
    .replace(/\s+/g, " ").replace(/^[\s,;:.-]+|[\s,;:-]+$/g, "").replace(/^(then|and)\s+/i, "").trim();
  // Words about when left over in what to do mean the reading is not whole ("each wednesday evening
  // around half six"), so it is not guessed at here.
  if (!prompt || LEFT_OVER.test(prompt)) return null;
  const interval = intervalOf(phrase);
  if (interval !== null) return interval >= minuteMs ? { prompt, recurrence: { intervalMs: interval }, time: "said" } : null;
  const said = timeOf(phrase), usual = usualTime(phrase);
  const dailyAt = said ?? usual ?? "09:00", time: TimeSaid = said ? "said" : usual ? "guessed" : "none";
  const month = new RegExp(MONTH, "i").exec(phrase);
  if (month) {
    const day = Number(month[1] ?? month[2] ?? month[3] ?? 1);
    return day >= 1 && day <= 31 ? { prompt, recurrence: { dailyAt, monthDay: day }, time } : null;
  }
  const days = daysOf(phrase);
  return { prompt, recurrence: days && days.length < 7 ? { dailyAt, weekdays: days } : { dailyAt }, time };
}

/** The clock as a five-field cron line (minute hour day month weekday); null for "every so often". */
export function cronOf(r: Recurrence): string | null {
  if (!r.dailyAt) return null;
  const [hour, minute] = r.dailyAt.split(":").map(Number);
  const days = r.weekdays?.join(",") === "1,2,3,4,5" ? "1-5" : r.weekdays?.join(",") ?? "*";
  return `${minute} ${hour} ${r.monthDay ?? "*"} * ${days}`;
}

/** When it comes round, in plain words. */
export function recurrenceWords(r: Recurrence): string {
  if (r.intervalMs !== undefined) {
    const minutes = Math.round(r.intervalMs / minuteMs);
    if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const at = ` at ${r.dailyAt ?? "09:00"}`;
  if (r.monthDay !== undefined) return `On day ${r.monthDay} of every month${at}`;
  const days = r.weekdays;
  if (!days) return `Every day${at}`;
  if (days.join() === "1,2,3,4,5") return `Every weekday${at}`;
  if (days.join() === "0,6") return `Every weekend day${at}`;
  const names = days.map((d) => NAMES[d]!.charAt(0).toUpperCase() + NAMES[d]!.slice(1) + "s");
  return `${names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.at(-1) : names[0]}${at}`;
}

function firstRunWords(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));
}

/** The proposal for words already read: checked by the schedule's own schema, with its first run worked out. */
export function proposalFrom(read: ReadWords, timezone: string, now: Date, source: ScheduleProposal["source"]): ScheduleProposal {
  const recurrence = read.recurrence;
  const base = { prompt: read.prompt, kind: "task" as const, timezone, ...recurrence };
  const firstRunAt = nextTurn(base as Record<string, unknown>, now);
  const schedule = ScheduleSchema.parse({ ...base, dueAt: firstRunAt });
  return { schedule, firstRunAt, source, time: read.time, cron: cronOf(recurrence),
    words: `${recurrenceWords(recurrence)} (${timezone}), first on ${firstRunWords(firstRunAt, timezone)}` };
}

/* ---------- the model, only for words the reader above cannot read ---------- */

/** Flat on purpose: no unions, nothing but what to do and when. No delivery, webhook, script or permission can come back. */
export const ModelReadingSchema = z.object({
  isSchedule: z.boolean(),
  prompt: z.string().max(2000),
  repeat: z.enum(["daily", "weekdays", "weekly", "monthly", "interval", "none"]),
  time: z.string().max(5),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  monthDay: z.number().int().min(0).max(31),
  intervalMinutes: z.number().int().min(0).max(525_600),
}).strict();
const readingShape = declareShape("schedule_reading", ModelReadingSchema);

function modelQuestion(text: string): string {
  return [
    "Read when a repeating job should run from the owner's words below. Only a clock counts: a time of day, days of the week, a day of the month, or every so many minutes.",
    "If the words describe an event instead (something arriving, a meeting ending, a file appearing) or say no time at all, answer isSchedule false.",
    "prompt is what the job should do, in the owner's own words, without the part that says when. time is 24-hour HH:MM, or empty.",
    "days are 0 Sunday to 6 Saturday, for weekly. monthDay is 0 unless monthly. intervalMinutes is 0 unless interval.",
    "",
    `The owner's words: ${JSON.stringify(text)}`,
  ].join("\n");
}

function recurrenceFromModel(reading: z.infer<typeof ModelReadingSchema>): Recurrence | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(reading.time) ? reading.time : "09:00";
  if (reading.repeat === "interval") return reading.intervalMinutes >= 1 ? { intervalMs: reading.intervalMinutes * minuteMs } : null;
  if (reading.repeat === "daily") return { dailyAt: time };
  if (reading.repeat === "weekdays") return { dailyAt: time, weekdays: [1, 2, 3, 4, 5] };
  if (reading.repeat === "weekly") return reading.days.length ? { dailyAt: time, weekdays: [...new Set(reading.days)].sort((a, b) => a - b) } : null;
  if (reading.repeat === "monthly") return reading.monthDay >= 1 ? { dailyAt: time, monthDay: reading.monthDay } : null;
  return null;
}

/**
 * Reads the words, putting them to the model only when the reader here cannot; throws `notASchedule`
 * otherwise. An edited schedule from the proposal card is checked and its first run worked out again.
 */
export async function proposeSchedule(input: unknown, deps: { now: Date; defaultTimezone: string; askModel?: AskModel }): Promise<ScheduleProposal> {
  const { text, edit, timezone: asked } = ProposeScheduleSchema.parse(input);
  const timezone = z.string().refine((zone) => { try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; } }, "Unknown timezone")
    .parse(asked ?? deps.defaultTimezone);
  if (edit) {
    const { prompt, ...when } = edit;
    const recurrence = Object.fromEntries(Object.entries(when).filter(([, value]) => value !== undefined)) as Recurrence;
    return proposalFrom({ prompt, recurrence, time: "said" }, timezone, deps.now, "edit");
  }
  const read = readScheduleWords(text!);
  if (read) return proposalFrom(read, timezone, deps.now, "words");
  if (!deps.askModel) throw new Error(notASchedule);
  const answer = await deps.askModel(modelQuestion(text!), readingShape);
  if (answer.status !== "resolved") throw new Error(notASchedule);
  const reading = ModelReadingSchema.safeParse(answer.value);
  const recurrence = reading.success && reading.data.isSchedule ? recurrenceFromModel(reading.data) : null;
  const prompt = reading.success ? reading.data.prompt.trim() : "";
  if (!recurrence || !prompt) throw new Error(notASchedule);
  const time: TimeSaid = recurrence.intervalMs !== undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(reading.success ? reading.data.time : "") ? "guessed" : "none";
  return proposalFrom({ prompt, recurrence, time }, timezone, deps.now, "model");
}
