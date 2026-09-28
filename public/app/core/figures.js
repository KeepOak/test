/* Every Trunk's face is its own character, moving (the owner, 2026-09-26: "always use animations"): core/ui.js
   av draws the character a Trunk wears (src/trunks/record.ts character, GET /api/trunks) beside its conversation,
   acting out what it is doing. The Branch mascot belongs only in the logo.
   (core/doing.js), with the prototype's Needs-you dot. The prototype's own av (pass 12) draws the character's still;
   the owner asked for the loop everywhere instead.
   Cost: a face's loop loads nothing until it is on screen; only the busiest few on screen play (then the larger, then
   the first); none play while the window is hidden; when motion is reduced (core/art17.js calm17) each shows its still. */

import { esc } from "./dom.js";
import { figure17, onGate, calm17 } from "./art17.js";
import { restOf, justWoke, onRest } from "./sleep.js";
import { hold17, play17 } from "./held.js";

/* At most this many faces play at once; the rest show their still until one stops. */
export const PLAY_MAX = 6;
const REST = new Set(["idle", "sleep"]);

/* A character's face size px wide (css holds --s and --c), acting out st. The figure is drawn 118% of the face
   (app.css .av.look12.fig17r .fig12), so its loop is picked for that width. key names whose face it is (core/sleep.js):
   asleep, it plays its sleeping loop (or breathes slowly on its still), and holds still after the long sleep. */
export const restMarks = (key, rest) => (rest === "still" ? " rest18 still18" : rest === "doze" ? " rest18" : justWoke.has(key) ? " wake18" : "");
export function figureFace(look, st, css, extra = "", size = 0, key = "") {
  const rest = key ? restOf(key, st) : "awake";
  return `<span class="av look12 fig17r${extra}${st === "wait" ? " waiting" : ""}${restMarks(key, rest)}" data-css="${esc(css)}" data-st="${esc(st)}"${key ? ` data-rk="${esc(key)}"` : ""} aria-hidden="true">${figure17(look, st, "gate17", size * 1.18, rest)}</span>`;
}

/* ---------- which loops play ---------- */
const loops = new Set(), onScreen = new Map();
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) onScreen.set(e.target, e.isIntersecting);
  plan();
});
const resting = (v) => (REST.has(v.closest("[data-st]")?.dataset.st) ? 1 : 0);
const order = (a, b) => resting(a) - resting(b) || b.clientWidth - a.clientWidth || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

let planned = false;
function plan() {
  if (planned) return;
  planned = true;
  queueMicrotask(choose);
}
function choose() {
  planned = false;
  for (const v of loops) if (!v.isConnected) { loops.delete(v); onScreen.delete(v); seen.unobserve(v); v.pause(); }
  const play = new Set(document.hidden || calm17() ? [] : [...loops].filter((v) => onScreen.get(v) && !v.closest(".still18")).sort(order).slice(0, PLAY_MAX));
  for (const v of loops) {
    // Hidden, out of view or in the long sleep, a face gives back its decoder; one only waiting its turn is paused.
    if (!play.has(v)) { if (document.hidden || onScreen.get(v) === false || v.closest(".still18")) hold17(v); else if (!v.paused) v.pause(); }
    else if (v.paused) play17(v).catch((error) => console.warn(error.message));
  }
}

onGate((v) => {
  if (!loops.has(v)) { loops.add(v); seen.observe(v); }
  plan();
});
document.addEventListener("visibilitychange", plan);
onRest(plan);
