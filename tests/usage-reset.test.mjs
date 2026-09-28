import test from "node:test";
import assert from "node:assert/strict";
import { usageReset } from "../public/app/core/usage-reset.js";

test("reset dates include the actual calendar date, local time and timezone across daylight saving boundaries", () => {
  const local = { locale: "en-US", timeZone: "America/New_York" };
  assert.equal(usageReset("2026-10-03T20:15:00Z", local).full, "Saturday, 10/3/2026, 4:15 PM EDT");
  assert.equal(usageReset("2026-10-03T20:15:00Z", local).compact, "Oct 3, 4:15 PM EDT");
  assert.equal(usageReset("2026-11-01T05:30:00Z", local).full, "Sunday, 11/1/2026, 1:30 AM EDT");
  assert.equal(usageReset("2026-11-01T06:30:00Z", local).full, "Sunday, 11/1/2026, 1:30 AM EST");
  assert.equal(usageReset("2026-10-04T00:15:00Z", local).full, "Saturday, 10/3/2026, 8:15 PM EDT", "the date belongs to the local zone, not UTC");
});

test("missing or invalid reset instants stay unknown, and the chosen locale controls date and clock conventions", () => {
  for (const value of [null, undefined, "", " ", "invalid", "<script>", 0]) assert.equal(usageReset(value), null);
  const german = usageReset("2026-10-03T20:15:00Z", { locale: "de-DE", timeZone: "Europe/Berlin" }).full;
  assert.match(german, /Samstag, 3\.10\.2026, 22:15/);
  assert.match(german, /MESZ/);
});
