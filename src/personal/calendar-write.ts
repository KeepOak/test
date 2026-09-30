import { z } from "zod";
import type { ToolRegistry } from "../registry.js";

const time = z.string().datetime({ offset: true });
const interval = { starts: time, ends: time };
const etag = z.string().min(1).max(500).regex(/^[\x20-\x7e]+$/, "Give the etag from the event list");
const ordered = (v: { starts: string; ends: string }): boolean => Date.parse(v.ends) > Date.parse(v.starts);
export const CalendarCreateSchema = z.object({
  title: z.string().trim().min(1).max(200), ...interval,
  location: z.string().max(200).default(""),
}).strict().refine(ordered, "The end must follow the start");
export const CalendarMoveSchema = z.object({
  id: z.string().trim().min(1).max(400), etag, ...interval,
}).strict().refine(ordered, "The end must follow the start");
export const CalendarDeleteSchema = z.object({
  id: z.string().trim().min(1).max(400), etag,
}).strict();
export const calendarWriteTools = new Set(["gcal.create", "gcal.move", "gcal.delete", "outlook.create", "outlook.move", "outlook.delete"]);

/** Provider reminders, 24 hours before: no local timer or promise that a device will display it. */
export const googleDayBefore = { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] };
export const microsoftDayBefore = { isReminderOn: true, reminderMinutesBeforeStart: 1440 };

export function registerCalendarWrites(registry: Pick<ToolRegistry, "register">, prefix: "gcal" | "outlook",
  run: (action: "create" | "move" | "delete", input: unknown, signal: AbortSignal) => Promise<unknown>): void {
  registry.register({ name: `${prefix}.create`, permission: "personal.write", parameters: CalendarCreateSchema,
    description: "Create a timed event in your primary calendar after one-time confirmation, with a provider reminder 24 hours before. No attendees.",
    target: v => `${prefix}: create ${v.title}; ${v.starts} to ${v.ends}; location ${v.location}; reminder 24 hours before`,
    execute: async (input, context) => run("create", input, context.signal) });
  registry.register({ name: `${prefix}.move`, permission: "personal.write", parameters: CalendarMoveSchema,
    description: "Move one calendar event by its id and etag from the events list, after confirmation; set its provider reminder to 24 hours before.",
    target: v => `${prefix}: move event ${v.id} (${v.etag}) to ${v.starts} through ${v.ends}; reminder 24 hours before; meeting updates may notify attendees`,
    execute: async (input, context) => run("move", input, context.signal) });
  registry.register({ name: `${prefix}.delete`, permission: "personal.write", parameters: CalendarDeleteSchema,
    description: "Delete one calendar event by its id and etag from the events list after one-time confirmation. Meeting cancellation may notify attendees.",
    target: v => `${prefix}: delete event ${v.id} (${v.etag}); meeting cancellation may notify attendees`,
    execute: async (input, context) => run("delete", input, context.signal) });
}
