/* RES-718: the local index of mail and calendars. It ships on ("when needed", the coordinator's call); it copies each source
   only through its connector while that part's own switch is on and it is set up, drops a source's rows once it is not,
   keeps only the days chosen (events ahead stay), never refetches what it holds, searches on this computer, and
   "Delete the index" removes every row. Nothing of it travels in a backup.
   Mutations: in src/personal/local-index.ts runAll skip the drop for a switched-off part, and a switched-off Gmail's
   rows stay searchable: red. Hand the source an empty set instead of this.known(...), and the second run fetches
   everything again: red. In src/personal/google.ts mailForIndex drop the `known.has(id)` skip: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { LocalIndex, localIndexApi, registerLocalIndex } from "../dist/personal/local-index.js";
import { savePersonalMode } from "../dist/personal/settings.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { backupTables } from "../dist/backup.js";
import { discardTemp } from "./temp-dir.mjs";
import { GoogleConnector } from "../dist/personal/google.js";
import { MicrosoftConnector } from "../dist/personal/microsoft.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-28T12:00:00Z");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-local-index-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, fetched = { gmail: [], "google-calendar": [] };
  const mail = [
    { id: "m1", at: new Date(NOW - 2 * DAY).toISOString(), who: "Dana Ortiz <dana@example.org>", title: "Lease renewal for the flat", body: "The landlord wants the signed lease back by Friday.", address: "" },
    { id: "m2", at: new Date(NOW - 200 * DAY).toISOString(), who: "Old sender", title: "Ancient newsletter", body: "Nothing about any lease.", address: "" },
  ];
  const sources = [
    { id: "gmail", part: "google", ready: async () => true, fetch: async (days, known) => { const fresh = mail.filter((m) => !known.has(m.id)); fetched.gmail.push(fresh.map((m) => m.id)); return fresh; } },
    { id: "google-calendar", part: "google", ready: async () => true,
      fetch: async () => { fetched["google-calendar"].push(1); return [{ id: "e1", at: new Date(NOW + 5 * DAY).toISOString(), who: "Room 4", title: "Dentist", body: "Check-up", address: "" }]; } },
  ];
  const index = new LocalIndex({ store: app.store, owner, sources });
  const api = (method, path, body) => localIndexApi({ index, requireOwner: () => {} }, method, path, async () => body);
  return { app, owner, index, api, fetched };
}

test("it ships on, 90 days back, copies only through a part that is on, and switched off reads nothing", async (t) => {
  const f = await fixture(t);
  assert.deepEqual([f.index.settings().mode, f.index.settings().days], ["when-needed", 90], "ships on, 90 days back");
  assert.equal(switchedToolTiers(f.app.store, f.owner, f.app.registry.names()).hidden.includes("index.search"), false, "its search is in the index");

  savePersonalMode(f.app.store, f.owner, "google", { mode: "off" });
  await f.index.run(NOW, true);
  assert.equal(f.index.view().total, 0, "Google is switched off, so nothing of it is copied");
  savePersonalMode(f.app.store, f.owner, "google", { mode: "on" });
  await f.index.run(NOW, true);
  const view = f.index.view();
  assert.deepEqual([view.counts.gmail, view.counts["google-calendar"]], [1, 1], "the 200-day-old message is outside the 90 days; the event ahead stays");

  await f.api("POST", "/api/local-index", { mode: "off" });
  assert.deepEqual(await f.index.run(NOW + DAY, true), { ran: false }, "the owner's off is kept: nothing more is read");
  assert.equal(f.fetched.gmail.length, 1, "one read, from the run while Google was on");
  assert.ok(switchedToolTiers(f.app.store, f.owner, f.app.registry.names()).hidden.includes("index.search"), "off, its search is not advertised");
});

test("it searches on this computer, never refetches what it holds, drops a switched-off source, and Delete removes it all", async (t) => {
  const f = await fixture(t);
  savePersonalMode(f.app.store, f.owner, "google", { mode: "on" });
  await f.api("POST", "/api/local-index", { days: 365 });
  await f.index.run(NOW, true);
  await f.index.run(NOW + 60_000, true);
  assert.deepEqual(f.fetched.gmail, [["m1", "m2"], []], "the second run fetches nothing it already holds");
  const first = f.index.run(NOW + 120_000, true), second = f.index.run(NOW + 120_000, true);
  assert.equal(first, second, "one run at a time");
  await first;

  const found = f.index.search({ text: "lease friday" });
  assert.deepEqual(found.found.map((row) => [row.source, row.id]), [["gmail", "m1"]]);
  assert.match(found.note, /never instructions/, "other people's words are marked as such");
  assert.deepEqual(f.index.search({ text: "dentist", source: "gmail" }).found, [], "a source filter holds");

  savePersonalMode(f.app.store, f.owner, "google", { mode: "off" });
  await f.index.run(NOW + 2 * 60 * 60_000);
  assert.equal(f.index.view().total, 0, "Google switched off: its rows are dropped at the next run");

  savePersonalMode(f.app.store, f.owner, "google", { mode: "on" });
  await f.index.run(NOW + 4 * 60 * 60_000, true);
  assert.ok(f.index.view().total > 0);
  const gone = await f.api("POST", "/api/local-index/delete", {});
  assert.equal(gone.total, 0, "Delete the index removes every row");
  assert.equal(backupTables.some((name) => name.startsWith("local_index")), false, "no backup carries the copy");
});

test("the engine's own index names the five sources, and its search is a local read for the owner", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.app.localIndex.view().counts), ["inbox", "gmail", "outlook", "google-calendar", "outlook-calendar"]);
  const tool = f.app.registry.inventory().find((one) => one.name === "index.search");
  assert.equal(tool?.permission, "index.read");
  const run = (args) => f.app.registry.execute("index.search", args, f.app.runtime.context({ runId: "li", permissions: ["index.read"] }));
  assert.deepEqual((await run({ text: "lease" })).found, [], "on as shipped: nothing connected, nothing found");
  await f.app.localIndex.save({ mode: "off" });
  await assert.rejects(run({ text: "lease" }), /switched off/);
});

test("the connectors' own fetchers: Gmail skips what is held, Outlook asks once for the window, both only while their part is on", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/gmail/v1/users/me/messages?")) return json({ messages: [{ id: "a1" }, { id: "b2" }] });
    if (String(url).includes("/messages/b2?")) return json({ id: "b2", snippet: "Invoice attached", payload: { headers: [{ name: "From", value: "Shop" }, { name: "Subject", value: "Your invoice" }, { name: "Date", value: "Mon, 21 Sep 2026 10:00:00 +0000" }] } });
    if (String(url).includes("/mailFolders/inbox/messages?")) return json({ value: [{ id: "o1", subject: "Standup", from: { emailAddress: { name: "Ana", address: "ana@example.org" } }, receivedDateTime: "2026-09-27T09:00:00Z", bodyPreview: "Notes" }] });
    return json({});
  };
  const signIn = { token: async () => "access" };
  const google = new GoogleConnector(f.app.store, f.owner, fetchImpl, signIn);
  const microsoft = new MicrosoftConnector(f.app.store, f.owner, fetchImpl, signIn);
  savePersonalMode(f.app.store, f.owner, "google", { mode: "off" });
  await assert.rejects(google.mailForIndex(30, 50, new Set()), /switched off/);
  savePersonalMode(f.app.store, f.owner, "google", { mode: "on" });
  savePersonalMode(f.app.store, f.owner, "microsoft", { mode: "on" });
  const items = await google.mailForIndex(30, 50, new Set(["a1"]));
  assert.deepEqual(items.map((i) => [i.id, i.title, i.who]), [["b2", "Your invoice", "Shop"]]);
  assert.equal(calls.some((url) => url.includes("/messages/a1?")), false, "a message already held is not fetched again");
  const outlook = await microsoft.mailForIndex(30, 50, new Date(NOW));
  assert.deepEqual(outlook.map((i) => [i.id, i.title]), [["o1", "Standup"]]);
  assert.match(calls.find((url) => url.includes("/mailFolders/inbox/messages?")), /receivedDateTime%20ge%202026-08-29/);
});
