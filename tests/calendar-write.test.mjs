/**
 * RES-102: Google and Outlook calendar writes. Off until the owner opts in and signs in again with the
 * write scope; a move or delete needs the listed etag; every change is held for the owner once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStore, fakeWeb, on } from "./personal-kit.mjs";
import { scopesFor, SignIn } from "../dist/personal/signin.js";
import { GoogleConnector, registerGoogle } from "../dist/personal/google.js";
import { personalHold } from "../dist/personal/guard.js";

/** A real sign-in over the fake store: calendar changes allowed, and a saved grant holding `scope`. */
function writer(store, scope) {
  const oauth = { saved: async () => ({ scope }), accessToken: async () => "access-token-1" };
  const signIn = new SignIn({ store, owner: "local", oauth, secret: async () => "" }, "google", "google");
  signIn.save({ clientId: "abc", calendarWrite: true });
  return signIn;
}

test("RES-102: the write scope is asked for only when calendar changes are allowed", () => {
  assert.ok(scopesFor("google", false).includes("https://www.googleapis.com/auth/calendar.events.readonly"));
  assert.ok(scopesFor("google", false, true).includes("https://www.googleapis.com/auth/calendar.events"));
  assert.ok(scopesFor("microsoft", false, true).includes("Calendars.ReadWrite"));
  assert.equal(scopesFor("microsoft", false).includes("Calendars.ReadWrite"), false);
});

test("RES-102: a new event carries a reminder a day before; a saved read-only grant cannot write", async () => {
  const store = fakeStore();
  on(store, "google");
  const web = fakeWeb([[/\/calendars\/primary\/events/, { id: "e1" }]]);
  const input = { title: "Dentist", starts: "2026-10-02T09:00:00Z", ends: "2026-10-02T10:00:00Z" };
  const readOnly = new GoogleConnector(store, "local", web.fetch, writer(store, "https://www.googleapis.com/auth/calendar.events.readonly"));
  await assert.rejects(readOnly.writeCalendar("create", input), /Sign in again/);
  assert.equal(web.seen.length, 0);
  await new GoogleConnector(store, "local", web.fetch, writer(store, "https://www.googleapis.com/auth/calendar.events")).writeCalendar("create", input);
  const sent = JSON.parse(web.seen[0].body);
  assert.equal(web.seen[0].method, "POST");
  assert.deepEqual(sent.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] });
});

test("RES-102: a move with an old etag changes nothing", async () => {
  const store = fakeStore();
  on(store, "google");
  const web = fakeWeb([[/\/events\/e1/, { etag: "\"new\"" }]]);
  const google = new GoogleConnector(store, "local", web.fetch, writer(store, "https://www.googleapis.com/auth/calendar.events"));
  await assert.rejects(google.writeCalendar("move", { id: "e1", etag: "\"old\"", starts: "2026-10-02T09:00:00Z", ends: "2026-10-02T10:00:00Z" }),
    /changed/);
  assert.deepEqual(web.seen.map((r) => r.method), ["GET"]);
});

test("RES-102: every calendar change is registered and put to the owner once, even in Full Access", () => {
  const names = [];
  registerGoogle({ register: (tool) => names.push(tool.name) }, new GoogleConnector(fakeStore(), "local", fetch, writer(fakeStore(), "")));
  for (const name of ["gcal.create", "gcal.move", "gcal.delete"]) {
    assert.ok(names.includes(name));
    assert.equal(personalHold(name, {}, "owner")?.onceOnly, true);
  }
});
