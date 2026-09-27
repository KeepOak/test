/* Everything that moves falls asleep when nobody is looking at it, and wakes when you come back (the owner, 2026-09-27:
   "ALL the animations have a sleeping side when they're left for a certain amount of time, because that can eat CPU").

   A face (a Trunk's or Branch's own) sleeps DOZE_MS after it was last in focus: its conversation open while you were
   using the window, or its row hovered or clicked. So only the open conversation's face, and faces at work, move for
   long. Everything else that moves (the pet, the painted scene, the feature pictures, the rings and dots) sleeps
   DOZE_MS after your last click, key, touch or pointer move, unless a task is working in view. After STILL_MS every
   sleeping loop holds still as well: nothing decodes or draws.
   A face at work never sleeps. Your input, the window regaining focus, a task starting and a reply or question arriving
   wake what they concern at once; what wakes plays a short wake (app.css area: sleep) instead of jumping. A hidden
   window pauses everything as before (core/art17.js, core/figures.js, core/pebble.js, core/pets.js). */

import { E, S } from "./state.js";
import { render, afterDraw } from "./dom.js";

export const DOZE_MS = 2 * 60 * 1000;
export const STILL_MS = 10 * 60 * 1000;
/* What a face does while its task works: it keeps its working loop wherever it is drawn. */
export const WORKING = new Set(["work", "think", "search", "read"]);

const bornAt = Date.now();
let lastInput = bornAt;
const focusAt = new Map();                 // face key ("t:<trunk id>" or "branch") → when it was last in focus

/* The faces of the conversation that is open: its Trunk, a room's members, or Branch for any other conversation. */
function openKeys() {
  if (S.view !== "chat") return [];
  const id = S.chat;
  const own = id ? E.trunks.find((t) => t.chatSessionId === id || (t.retiredChats ?? []).includes(id)) : null;
  if (own) return [`t:${own.id}`];
  const room = id ? (E.rooms ?? []).find((r) => r.sessionId === id) : null;
  return room ? (room.members ?? []).map((m) => `t:${m}`) : ["branch"];
}
export const trunkKey = (trunk) => (trunk?.kind === "main" || trunk?.isBranch ? "branch" : trunk?.id ? `t:${trunk.id}` : "");

const stageAt = (since, now) => (now - since >= STILL_MS ? "still" : now - since >= DOZE_MS ? "doze" : "awake");
const sinceOf = (key) => (openKeys().includes(key) ? lastInput : Math.min(focusAt.get(key) ?? bornAt, lastInput));

/* A face's stage: "awake", "doze" (its sleeping loop) or "still" (its sleeping loop held still). */
export function restOf(key, st = "idle") {
  if (WORKING.has(st)) return "awake";
  return stageAt(key ? sinceOf(key) : lastInput, Date.now());
}

/* A task working in a conversation that is open or whose face is drawn keeps the window's own motion awake. */
function workingInView() {
  const open = openKeys();
  return (E.state?.runs ?? []).some((r) => {
    if (r.status !== "running") return false;
    if (r.sessionId === S.chat && S.view === "chat") return true;
    const trunk = E.trunks.find((t) => t.chatSessionId === r.sessionId);
    return !!trunk && (open.includes(`t:${trunk.id}`) || !!document.querySelector(`[data-rk="t:${CSS.escape(trunk.id)}"]`));
  });
}
/* The window's own stage, for what belongs to no face. */
export function windowRest() {
  const stage = stageAt(lastInput, Date.now());
  return stage !== "awake" && workingInView() ? "awake" : stage;
}

/* Whether a loop that plays by itself is held asleep now: a face's by its own stage (core/figures.js holds the gated
   ones); the pet's and Branch's hero by the window's long sleep (before it they play their sleeping loop,
   shell/scene.js); every other loop (the feature pictures, the cheer, your own background video) as soon as the window
   sleeps. */
export function sleeps(v) {
  if (!v.loop) return false;
  if (v.closest("[data-rk]")) return !!v.closest(".still18");
  if (v.closest(".petbox, .hero11")) return windowRest() === "still";
  return windowRest() !== "awake";
}
function sweep() {
  for (const v of document.querySelectorAll("video")) {
    if (!v.autoplay || !v.loop) continue;
    if (sleeps(v)) { if (!v.paused) { v.pause(); v.dataset.rest18 = "1"; } }
    else if (v.dataset.rest18) {
      delete v.dataset.rest18;
      if (!document.hidden && !v.dataset.off13 && !v.closest(".zz11")) v.play().catch((error) => console.warn(error.message));
    }
  }
}

/* ---------- telling everyone ---------- */

const listeners = [];
/* fn runs whenever any stage may have changed (the faces are drawn again as well). */
export const onRest = (fn) => { listeners.push(fn); };
let shown = "";
function changed() {
  const stage = windowRest(), html = document.documentElement;
  if (stage !== shown) {
    if (shown && shown !== "awake" && stage === "awake") wakeUp(html);
    html.classList.toggle("doze18", stage !== "awake");
    html.classList.toggle("still18", stage === "still");
    shown = stage;
  }
  sweep();
  for (const fn of listeners) {
    try { fn(); } catch (error) { console.error(error); }
  }
  render();
  plan();
}
/* A short wake, for the window's own motion; a face plays its own (app.css .av.wake18, core/pebble.js "wake"). */
let wakeTimer = 0;
function wakeUp(html) {
  html.classList.add("wake18");
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => html.classList.remove("wake18"), 700);
}

/* One timer, set for the next moment any stage changes. */
let timer = 0;
function plan() {
  clearTimeout(timer);
  const now = Date.now(), times = [lastInput, bornAt, ...focusAt.values()].flatMap((t) => [t + DOZE_MS, t + STILL_MS]).filter((t) => t > now);
  if (times.length) timer = setTimeout(changed, Math.min(...times) - now + 20);
}

/* Faces woken this moment play their wake as they are drawn again. */
export const justWoke = new Set();
function wakeFaces(keys) {
  const now = Date.now();
  let any = false;
  for (const key of keys) {
    if (!key) continue;
    if (restOf(key) !== "awake") { justWoke.add(key); any = true; }
    focusAt.set(key, now);
  }
  if (any) { changed(); setTimeout(() => justWoke.clear(), 900); }
  else plan();
}

/* Your input: the window and the open conversation's faces are in focus now. Read at most once a second. */
let lastSeen = 0;
export function touch() {
  const now = Date.now(), was = windowRest();
  if (now - lastSeen < 1000 && was === "awake") return;
  lastSeen = now;
  const open = openKeys(), asleep = open.filter((k) => restOf(k) !== "awake");
  lastInput = now;
  for (const key of open) focusAt.set(key, now);
  if (was !== "awake" || asleep.length) { asleep.forEach((k) => justWoke.add(k)); changed(); setTimeout(() => justWoke.clear(), 900); }
  else plan();
}

/* Hovering or clicking a row (or a face) wakes the faces in it. */
function faceKeys(target) {
  const host = target.closest?.("[data-rk]") ?? target.closest?.("button,.row,.prow,.mi,.sr-row,[data-id]");
  if (!host) return [];
  const keys = host.dataset.rk ? [host.dataset.rk] : [...host.querySelectorAll("[data-rk]")].map((el) => el.dataset.rk);
  return [...new Set(keys)];
}

/* A task starting, and a reply or question arriving, wake the window and that Trunk's face. */
let seenState = null, seenRuns = null, seenAsks = 0;
function followState() {
  if (!E.state || E.state === seenState) return;
  seenState = E.state;
  const runs = new Map((E.state.runs ?? []).map((r) => [r.id, r.status]));
  const asks = (E.state.attention ?? []).length;
  const first = !seenRuns, moved = first ? [] : [...runs].filter(([id, st]) => seenRuns.has(id) ? seenRuns.get(id) !== st : st === "running");
  seenRuns = runs;
  const asked = asks > seenAsks;
  seenAsks = asks;
  if (first || (!moved.length && !asked)) return;
  const sessions = new Set((E.state.runs ?? []).filter((r) => moved.some(([id]) => id === r.id)).map((r) => r.sessionId));
  const keys = E.trunks.filter((t) => sessions.has(t.chatSessionId)).map((t) => `t:${t.id}`);
  if ([...sessions].some((s) => !E.trunks.some((t) => t.chatSessionId === s))) keys.push("branch");
  lastSeen = 0;
  touch();
  wakeFaces(keys);
}

for (const ev of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) addEventListener(ev, touch, { capture: true, passive: true });
addEventListener("focus", touch);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastSeen = 0; touch(); } });
document.addEventListener("pointerover", (e) => { const keys = faceKeys(e.target); if (keys.length) wakeFaces(keys); });
document.addEventListener("pointerdown", (e) => { const keys = faceKeys(e.target); if (keys.length) wakeFaces(keys); }, true);
/* Opening a conversation puts its faces in focus as it is drawn. */
let seenOpen = "";
afterDraw(() => {
  followState();
  const open = openKeys().join(",");
  if (open !== seenOpen) { seenOpen = open; lastSeen = 0; touch(); }
});
plan();
