/* MODEL-108 in the window (public/app/places/team-tabs.js), with a stand-in page and engine: Team › Usage takes a usage
   answer only while the read that asked is still the newest one, for the same person, unlocked, on Team › Usage, and a
   report already read is dropped once someone else is at the window or the app locks. */
import test from "node:test";
import assert from "node:assert/strict";

const locks = new Set();
const el = () => ({ classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, addEventListener() {}, removeEventListener() {},
  setAttribute() {}, getAttribute: () => null, append() {}, appendChild() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [],
  style: { setProperty() {} }, dataset: {} });
const app = { ...el(), classList: { contains: (name) => locks.has(name), add: (name) => locks.add(name), remove: (name) => locks.delete(name), toggle() {} } };
const Obs = class { observe() {} disconnect() {} unobserve() {} };
Object.assign(globalThis, { MutationObserver: Obs, ResizeObserver: Obs, IntersectionObserver: Obs, addEventListener() {}, removeEventListener() {},
  requestAnimationFrame: (f) => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }) });
globalThis.document = { getElementById: (id) => (id === "app" ? app : el()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  removeEventListener() {}, createElement: el, documentElement: el(), body: el(), head: el(), hidden: false };
globalThis.window = globalThis;
/* The window's modules start their own timers when loaded (core/sleep.js plans a check minutes ahead); none of them keeps
   this test running. */
const setIntervalReal = globalThis.setInterval, setTimeoutReal = globalThis.setTimeout;
globalThis.setInterval = (...args) => { const timer = setIntervalReal(...args); timer.unref?.(); return timer; };
globalThis.setTimeout = (fn, ms, ...rest) => { const timer = setTimeoutReal(fn, ms, ...rest); if (ms > 1000) timer.unref?.(); return timer; };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.location = { href: "http://branch.test/", search: "", hash: "", pathname: "/", origin: "http://branch.test" };

/* Each usage read is held until the test answers it, so answers can arrive in any order. */
const held = [];
globalThis.fetch = (url) => new Promise((resolve) => held.push({ url: String(url), answer: (data) => resolve({ ok: true, status: 200, json: async () => data }) }));
const report = (name) => ({ days: 30, capped: false, inspected: 1, rows: [{ kind: "person", name, tasks: 1, tokens: { input: 10, output: 5 }, estimatedModelCost: null, unpricedTasks: 0 }] });
const glance = { rows: [] };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/* Answers the glance and people requests of one read (the n-th pair) with this person's report. */
async function answer(pair, name) {
  await flush();
  const [a, b] = held.slice(pair * 2, pair * 2 + 2);
  for (const request of [a, b]) request.answer(request.url.includes("people=1") ? { byPerson: report(name) } : glance);
  await flush(); await flush();
}

const { S, E } = await import("../public/app/core/state.js");
let fresh = 0;
async function setup() {
  held.length = 0; locks.clear();
  E.profiles = { isOwner: true, active: { id: "owner-1" }, profiles: [] };
  S.view = "team"; S.tabs.team = "usage";
  return import(`../public/app/places/team-tabs.js?case=${++fresh}`);
}
const drawn = (tabs) => tabs.tabBody("usage", null);

test("an older usage answer that arrives after a newer read never replaces it", async () => {
  const tabs = await setup();
  const first = tabs.readTab("usage"), second = tabs.readTab("usage");
  await answer(1, "Newer Reader");
  await second;
  await answer(0, "Older Reader");
  await first;
  assert.match(drawn(tabs), /Newer Reader/);
  assert.doesNotMatch(drawn(tabs), /Older Reader/, "the late answer to the older read was dropped");
});

test("a usage answer that arrives after the app locked is dropped, and a report read before the lock is not drawn", async () => {
  const tabs = await setup();
  const read = tabs.readTab("usage");
  locks.add("locked-b17");
  await answer(0, "Locked Out");
  assert.equal(await read, false, "nothing to draw");
  locks.clear();
  assert.doesNotMatch(drawn(tabs), /Locked Out/);
  const again = tabs.readTab("usage");
  await answer(1, "Owner Before Lock");
  await again;
  assert.match(drawn(tabs), /Owner Before Lock/, "control: an answer in time is drawn");
  locks.add("locked-b17");
  assert.doesNotMatch(drawn(tabs), /Owner Before Lock/, "the kept report is dropped once the app locks");
});

test("a usage answer that arrives after another person is at the window is dropped, and so is the kept report", async () => {
  const tabs = await setup();
  const read = tabs.readTab("usage");
  await answer(0, "Kept For Owner");
  await read;
  assert.match(drawn(tabs), /Kept For Owner/, "control");
  const next = tabs.readTab("usage");
  E.profiles = { isOwner: true, active: { id: "owner-2" }, profiles: [] };
  await answer(1, "Asked By Previous");
  assert.equal(await next, false, "nothing to draw");
  assert.doesNotMatch(drawn(tabs), /Asked By Previous/);
  assert.doesNotMatch(drawn(tabs), /Kept For Owner/, "the previous person's report is dropped");
});

test("a usage answer that arrives after the window left Team › Usage is dropped", async () => {
  const tabs = await setup();
  const read = tabs.readTab("usage");
  S.tabs.team = "activity";
  await answer(0, "Left Behind");
  assert.equal(await read, false);
  S.tabs.team = "usage";
  assert.doesNotMatch(drawn(tabs), /Left Behind/);
});

