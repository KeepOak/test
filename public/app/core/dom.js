/* The smallest DOM toolkit the window needs: lookups, escaping, the CSP-safe style pass, and one redraw scheduler. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/* The engine's policy refuses style="…" attributes, so markup carries data-css="…" and this applies it through the CSSOM,
   which the policy allows. Run it on anything just drawn with innerHTML. */
export function applyCss(root = document) {
  for (const node of root.querySelectorAll("[data-css]")) {
    node.style.cssText = node.dataset.css;
    node.removeAttribute("data-css");
  }
}

/* Draws html into a region and applies its styles. Returns the region. */
export function paint(region, html) {
  if (!region) return region;
  region.innerHTML = html;
  applyCss(region);
  return region;
}

/* A press lasts from pointerdown to pointerup (80-200 ms for a person). A region drawn anew in between replaces the
   button under the pointer, and the press never becomes a click; so a region being pressed is left alone, and drawn once
   the press ends (after its click has been handled). */
let pressed = null, heldBack = false;
document.addEventListener("pointerdown", (e) => { pressed = e.target instanceof Element ? e.target : null; }, true);
const released = () => { pressed = null; if (heldBack) { heldBack = false; render(); } };
document.addEventListener("pointerup", released, true);
document.addEventListener("pointercancel", released, true);
/* Whether a press is on inside the region; if so, the region's draw waits for its end. */
export function pressIn(region) {
  if (!pressed || !region?.contains(pressed)) return false;
  heldBack = true;
  return true;
}

/* A region drawn with paintChanged() is drawn again only when its markup differs from the last draw, nobody has
   replaced what was drawn, and the person has not done something in it since (their next draw is a fresh one, as
   main.js does for #main). Drawing unchanged markup anew replaced the buttons under a press and cost every redraw. */
const lastDrawn = new WeakMap(), kept = new Set();
for (const kind of ["click", "change", "keydown"])
  document.addEventListener(kind, (e) => { for (const region of kept) if (region.contains(e.target)) lastDrawn.delete(region); }, true);
/* Answers whether it drew. */
export function paintChanged(region, html) {
  if (!region) return false;
  const last = lastDrawn.get(region);
  if (last && last.html === html && region.firstChild === last.first) return false;
  if (pressIn(region)) return false;
  paint(region, html);
  lastDrawn.set(region, { html, first: region.firstChild });
  kept.add(region);
  return true;
}

/* How to find the focused control again after its region is drawn anew: its id, or its tag and the attributes that name
   it (data-act, data-v, data-id, …) with its place among the controls that share them. */
const NAMING = ["data-act", "data-v", "data-id", "data-sw", "data-k", "name", "aria-label"];
function focusKey(el) {
  if (!el || el === document.body || !el.isConnected) return null;
  const caret = "selectionStart" in el ? (() => { try { return [el.selectionStart, el.selectionEnd]; } catch { return null; } })() : null;
  if (el.id) return { selector: "#" + CSS.escape(el.id), index: 0, caret };
  const named = NAMING.filter((a) => el.hasAttribute(a)).map((a) => `[${a}="${CSS.escape(el.getAttribute(a))}"]`).join("");
  if (!named) return null;
  const selector = el.tagName.toLowerCase() + named;
  return { selector, index: $$(selector).indexOf(el), caret };
}
/* A redraw keeps the focused control focused, and a text field's caret where it was. Only when the draw took focus
   away: a draw that moved focus on purpose keeps its choice. */
function keepFocus(draw) {
  const before = document.activeElement, key = focusKey(before);
  draw();
  if (!key || document.activeElement === before && before.isConnected) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  const again = $$(key.selector)[Math.max(key.index, 0)];
  if (!again) return;
  again.focus({ preventScroll: true });
  if (key.caret && key.caret[0] != null) {
    try { again.setSelectionRange(key.caret[0], key.caret[1]); } catch { /* a number or colour field has no caret to put back */ }
  }
}

/* Regions register a draw function; render() redraws all of them on the next frame, once, however often it is asked. */
const painters = [];
const afterDraws = [];
let queued = false;
export function onRender(draw) { painters.push(draw); }
/* Runs after every region is drawn (core/ui.js: an open popover takes the button drawn in its opener's place). */
export function afterDraw(fn) { afterDraws.push(fn); }
function drawAll() {
  for (const draw of [...painters, ...afterDraws]) {
    try { draw(); } catch (error) { console.error(error); }
  }
}
export function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    keepFocus(drawAll);
  });
}
/* A redraw that must happen now (after a click the person can see). */
export function renderNow() {
  queued = false;
  keepFocus(drawAll);
}
