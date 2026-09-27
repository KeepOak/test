/* Every Trunk's and Branch's face is its character, moving (the owner, 2026-09-26: "always use animations"): core/ui.js
   av draws the character a Trunk wears (src/trunks/record.ts character, GET /api/trunks; Branch's own is the engine's
   "branch" character) as the prototype's figure12 does beside the conversation, acting out what it is doing
   (core/doing.js), with the prototype's Needs-you dot. The prototype's own av (pass 12) draws the character's still;
   the owner asked for the loop everywhere instead.
   Cost: a face's loop loads nothing until it is on screen; only the busiest few on screen play (then the larger, then
   the first); none play while the window is hidden; when motion is reduced (core/art17.js calm17) each shows its still. */

import { esc } from "./dom.js";
import { figure17, onGate, calm17 } from "./art17.js";

/* At most this many faces play at once; the rest show their still until one stops. */
export const PLAY_MAX = 6;
const REST = new Set(["idle", "sleep"]);

/* A character's face size px wide (css holds --s and --c), acting out st. The figure is drawn 118% of the face
   (app.css .av.look12.fig17r .fig12), so its loop is picked for that width. */
export const figureFace = (look, st, css, extra = "", size = 0) =>
  `<span class="av look12 fig17r${extra}${st === "wait" ? " waiting" : ""}" data-css="${esc(css)}" data-st="${esc(st)}" aria-hidden="true">${figure17(look, st, "gate17", size * 1.18)}</span>`;

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
  const play = new Set(document.hidden || calm17() ? [] : [...loops].filter((v) => onScreen.get(v)).sort(order).slice(0, PLAY_MAX));
  for (const v of loops) {
    if (!play.has(v)) { if (!v.paused) v.pause(); }
    else if (v.paused) v.play().catch((error) => console.warn(error.message));
  }
}

onGate((v) => {
  if (!loops.has(v)) { loops.add(v); seen.observe(v); }
  plan();
});
document.addEventListener("visibilitychange", plan);
