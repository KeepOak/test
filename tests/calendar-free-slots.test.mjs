/**
 * RES-103: common free slots across several calendars. Busy times from every calendar are merged,
 * and a calendar that answers with an error gives no suggestion at all rather than a wrong one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStore, on } from "./personal-kit.mjs";
import { CalendarAvailability, FreeSlotsSchema, commonFreeSlots } from "../dist/personal/calendar-availability.js";

const at = (hhmm) => Date.parse(`2026-10-01T${hhmm}:00Z`);
const query = (extra = {}) => FreeSlotsSchema.parse({ from: "2026-10-01T09:00:00Z", to: "2026-10-01T12:00:00Z",
  googleCalendars: ["primary", "ada@example.com"], minutes: 60, stepMinutes: 30, ...extra });

test("RES-103: only times free in every calendar are suggested", () => {
  const found = commonFreeSlots(query(), [{ start: at("09:00"), end: at("10:00") }, { start: at("10:30"), end: at("11:00") }]);
  assert.deepEqual(found.map((slot) => slot.from), ["2026-10-01T11:00:00.000Z"]);
});

test("RES-103: one calendar with an error means no suggestions", async () => {
  const store = fakeStore();
  on(store, "google");
  const signIn = { mailPreviewIdentity: () => "same", settings: () => ({ availability: true }),
    status: async () => ({ scope: "https://www.googleapis.com/auth/calendar.freebusy" }), token: async () => "t",
    withAccount: (_id, work) => work(), accountId: () => "default" };
  const answer = { timeMin: "2026-10-01T09:00:00Z", timeMax: "2026-10-01T12:00:00Z",
    calendars: { primary: { busy: [] }, "ada@example.com": { errors: [{ reason: "notFound" }], busy: [] } } };
  const helper = new CalendarAvailability({ store, owner: "local", requireOwner: () => undefined,
    fetch: async () => new Response(JSON.stringify(answer)), signIns: { google: signIn, microsoft: signIn } });
  const context = { signal: new AbortController().signal };
  await assert.rejects(helper.find(query(), context), /no common free slots/);
});
