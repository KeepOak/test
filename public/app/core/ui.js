/* Shared pieces every area draws with: icons, avatars, menus, dialogs, toasts and tooltips. Behaviour and classes match
   the prototype (design doc 2 and 5.3). */

import { ICONS } from "./icons.js";
import { $, esc, applyCss, afterDraw } from "./dom.js";
import { greyOut } from "./features.js";
import { look17 } from "./art17.js";
import { figureFace } from "./figures.js";
import { agentState } from "./doing.js";
import { pebbleFace } from "./pebble.js";
import { t } from "../../i18n.js";
import { engineAway } from "./api.js";
import { syncModalBackground } from "./modal-background.js";

export const app = () => document.getElementById("app");

export const ic = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* The prototype's eight Trunk colours and five shapes (prototype.html COLOURS, SHAPES). The engine names seven shapes
   (src/trunks/look.ts); shape i is saved as SHAPE_NAMES[i]. */
export const COLOURS = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A", "#4F6FA8", "#C9982E", "#B84A6B", "#56616B"];
export const SHAPES = ["50%", "58% 42% 54% 46% / 52% 56% 44% 48%", "46% 54% 42% 58% / 60% 44% 56% 40%", "62% 38% 50% 50% / 45% 55% 45% 55%", "42% 58% 58% 42% / 50% 42% 58% 50%"];
export const SHAPE_NAMES = ["circle", "pebble", "leaf", "acorn", "shield"];
export const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : null);
/* A colour or shape left empty is the one its name gives (src/trunks/look.ts), picked from the eight colours and five
   shapes with the prototype's own name hash (prototype.html logo, wave15). */
const nameHash = (name) => { let h = 0; for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const shapeIndex = (t) => {
  const named = SHAPE_NAMES.indexOf(t.look ? t.look.shape : t.shape);
  if (named >= 0) return named;
  return Number.isInteger(t.shape) && SHAPES[t.shape] ? t.shape : nameHash(t.name) % SHAPES.length;
};
/* What a Trunk's face is drawn from, the same everywhere: the engine keeps the colour as chosenColour and the emoji and
   shape inside look (GET /api/trunks); a face already drawn from (color, emoji, shape) passes through. */
export function faceOf(t) {
  const look = t?.look ?? {};
  const emoji = t?.look ? (look.face === "emoji" ? look.emoji || "" : "") : t?.emoji || "";
  return { name: t?.name, color: hex(t?.chosenColour) ?? hex(t?.color) ?? COLOURS[nameHash(t?.name) % COLOURS.length].toLowerCase(),
    shape: SHAPE_NAMES[shapeIndex(t ?? {})], emoji, paused: !!t?.paused, character: t?.character ?? null, lookStill: t?.lookStill,
    photo: photoOf(t), eyes: EYES.includes(t?.eyes) ? t.eyes : "", motion: t?.look ? look.motion : t?.motion };
}

/* The prototype's eyes (Round, Wide, Sleepy; round draws no class) and its moves: the engine's sway is the prototype's Bob. */
const EYES = ["wide", "sleepy"];
const MOVES = { breathe: "anim-breathe", sway: "anim-bob" };
/* A Trunk's photo (POST /api/trunks/{id}/avatar, GET /api/trunks avatar): only a PNG, JPEG or WebP picture the engine
   keeps as data; a face already drawn from passes its photo through. Drawn from a blob: address made once per picture,
   so a redraw never copies the picture's text into the page again. */
const PHOTO = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;
const photos = new Map();
function photoOf(t) {
  if (typeof t?.photo === "string" && t.photo.startsWith("blob:")) return t.photo;
  const a = t?.avatar, data = a && (a.kind === "image" || a.kind === "generated") ? a.dataUrl : null;
  if (typeof data !== "string") return null;
  if (!photos.has(data)) {
    const m = PHOTO.exec(data);
    photos.set(data, m ? URL.createObjectURL(new Blob([Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))], { type: m[1] })) : null);
  }
  return photos.get(data);
}

/* A Trunk's face, in the prototype's order: its photo, else its character if it has a look (moving, core/figures.js),
   its emoji on a pebble, else the pebble with eyes. The pebble takes its eyes and how it moves. Each Trunk's character
   acts out its own conversation. A conversation with no Trunk has no face of its own: the Branch mascot is the logo
   only (never a row, a reply or quick-ask), so it gets a neutral chat tile, with the working ring or waiting dot of
   its conversation, until the default Trunk (#594) takes such conversations in. */
/* The prototype's list marks (app.css .av.working, .av.waiting): a moving copper ring while a task of its conversation
   works, a copper dot while one waits for you (core/doing.js agentState, from GET /api/state runs and attention). */
const RING = { work: " working", wait: " waiting" };
export function av(trunk, size = 40, sessionId) {
  if (!trunk) return "";
  if (trunk.kind === "main" || trunk.isBranch) {
    const st = agentState({ chatSessionId: sessionId ?? trunk.chatSessionId });
    return `<span class="av none18c${RING[st] ?? ""}" data-css="--s:${size}px" aria-hidden="true">${ic("chat", "s")}</span>`;
  }
  /* A room (core/state.js roomFace): the prototype's stack of two member faces, drawn idle; one member alone, none Branch. */
  if (trunk.kind === "room") {
    const [a, b] = (trunk.members ?? []).map((m) => ({ ...m, paused: false }));
    if (!b) return a ? av(a, size, sessionId) : "";
    const sz = Math.round(size * 0.7);
    return `<span class="stack" data-css="--s:${size}px;--sz:${sz}" aria-hidden="true">${av(a, sz)}${av(b, sz)}</span>`;
  }
  const f = faceOf(trunk);
  const css = `--s:${size}px;--c:${f.color};--r:${SHAPES[SHAPE_NAMES.indexOf(f.shape)]}`;
  const st = agentState(trunk), ring = RING[st] ?? "";
  const paused = f.paused ? " paused" : ""; // a paused Trunk's face is drawn grey (GET /api/trunks `paused`)
  const marks = `${f.eyes ? ` ${f.eyes}` : ""}${MOVES[f.motion] ? ` ${MOVES[f.motion]}` : ""}${ring}`;
  if (f.photo) return `<span class="av photo-tl${paused}${marks}" data-css="${css}" aria-hidden="true"><span class="peb"><img src="${esc(f.photo)}" alt="" draggable="false"></span></span>`;
  const look = f.lookStill ? null : look17(f.character); // pass 17: the character the engine says it wears
  if (look) return figureFace(look, st, css, paused + (st === "work" ? ring : ""), size, `t:${trunk.id}`);
  const still = f.lookStill;
  if (still) return `<span class="av look12${paused}${ring}" data-css="${css}" aria-hidden="true"><img src="${esc(still)}" alt="" loading="lazy" draggable="false"></span>`;
  if (f.emoji) return `<span class="av emoji15${paused}${marks}" data-css="${css}" aria-hidden="true"><span class="peb"></span><i data-css="font-size:${Math.round(size * 0.56)}px">${esc(f.emoji)}</i></span>`;
  /* The classic pebble: rendered in 3D and moving with what the Trunk does (core/pebble.js); flat at 24px and under. */
  return pebbleFace(trunk, f, size, css, paused, SHAPE_NAMES.indexOf(f.shape), marks);
}

export const mi = (act, icon, text, extra = "", attrs = "") =>
  `<button class="mi" type="button" role="menuitem" data-act="${act}" ${attrs}>${icon ? `<span class="ico">${ic(icon, "s")}</span>` : ""}<span class="mi-t">${text}</span>${extra ? `<span class="r">${extra}</span>` : ""}</button>`;
export const radio = (act, value, text, sub, on) =>
  `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="${act}" data-v="${esc(value)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${text}</span>${sub ? `<span class="mi-s">${sub}</span>` : ""}</span></button>`;

/* ---------- popovers ---------- */
let popEl = null;
let popAnchor = null;
/* Escape hands the keyboard back to the button that opened it ({ refocus: true }); a redraw may have replaced that
   button, so then the one drawn in its place (same data-act, data-v and data-id) is used. A click outside leaves the
   keyboard where the click put it, as the browser does. */
/* The button of a popover closed in this same turn, so a dialog opened from one of its items knows its opener. */
let justClosed = null;
export function closePop(opt = {}) {
  const anchor = liveAnchor(), open = !!popEl;
  if (open && anchor) { justClosed = anchor; setTimeout(() => { justClosed = null; }, 0); }
  popEl?.remove();
  document.getElementById("composer")?.classList.remove("under-pop");
  popAnchor?.setAttribute("aria-expanded", "false");
  popEl = popAnchor = null;
  if (opt.refocus && open && anchor) openerOf(anchor)?.focus({ preventScroll: true });
}
function openerOf(anchor) {
  if (anchor.isConnected) return anchor;
  const { act, v, id } = anchor.dataset;
  if (!act) return null;
  const same = (el) => el.dataset.v === v && el.dataset.id === id && el.getClientRects().length > 0;
  return [...document.querySelectorAll(`[data-act="${CSS.escape(act)}"]`)].find(same) ?? null;
}
/* The one visible button drawn with every data-* of the old one (a message's More also by its data-mid); when several
   match, none is taken rather than a guess. */
function drawnInPlaceOf(anchor) {
  const { act } = anchor.dataset;
  if (!act) return null;
  const key = (el) => JSON.stringify(Object.entries(el.dataset).sort());
  const want = key(anchor);
  const found = [...document.querySelectorAll(`[data-act="${CSS.escape(act)}"]`)].filter((el) => key(el) === want && el.getClientRects().length > 0);
  return found.length === 1 ? found[0] : null;
}
/* A redraw may replace the button an open popover came from: the one drawn in its place becomes its button, so it says
   it is open, and pressing it again closes the popover, as the prototype's does. */
function liveAnchor() {
  const again = popAnchor && !popAnchor.isConnected ? drawnInPlaceOf(popAnchor) : null;
  if (again) { popAnchor = again; again.setAttribute("aria-expanded", "true"); }
  return popAnchor;
}
afterDraw(() => { if (popEl) liveAnchor(); });
export function openPop(anchor, html, opt = {}) {
  const same = liveAnchor() === anchor, fresh = !popEl || (!same && !opt.force);
  closePop();
  hideTip();
  if (same && !opt.force) return;
  const root = app();
  popEl = document.createElement("div");
  popEl.className = "pop";
  popEl.setAttribute("role", opt.role ?? "menu");
  if (opt.label) popEl.setAttribute("aria-label", opt.label); /* a menu that is someone's says whose, to a screen reader */
  popEl.innerHTML = html;
  applyCss(popEl);
  greyOut(popEl);
  root.appendChild(popEl);
  popAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  place(popEl, root.getBoundingClientRect(), anchor.getBoundingClientRect(), opt.right);
  underPop(popEl, anchor);
  if (fresh) popEl.classList.add("in17"); /* pass 17: a popover that opens fresh eases in once; a redraw does not replay it */
  popEl.querySelector("button:not([aria-disabled='true']),input")?.focus({ preventScroll: true });
}
/* A click anywhere outside the open popover and its button closes it. */
document.addEventListener("pointerdown", (e) => {
  if (popEl && !popEl.contains(e.target) && !liveAnchor()?.contains(e.target)) closePop();
}, true);

/* A popover stays next to the button that opened it (the owner: "this is the correct space"). When one opened from outside
   the message box lands over it, the box steps back, faded and out of reach, until the popover closes, as a Mac menu
   sits over what is behind it. */
function underPop(el, anchor) {
  const box = document.getElementById("composer");
  if (!box || box.contains(anchor)) return;
  const c = box.getBoundingClientRect(), p = el.getBoundingClientRect();
  box.classList.toggle("under-pop", p.left < c.right && p.right > c.left && p.top < c.bottom && p.bottom > c.top);
}

function place(el, a, r, right) {
  if (a.width <= 480) Object.assign(el.style, { left: "8px", right: "8px", maxWidth: "none" });
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (a.width > 480) el.style.left = Math.min(Math.max((right ? r.right - a.left - w : r.left - a.left), 8), a.width - w - 8) + "px";
  const below = r.bottom - a.top + 6;
  const above = r.top - a.top - h - 6;
  el.style.top = (below + h > a.height - 8 && above > 8 ? above : Math.max(8, Math.min(below, a.height - h - 8))) + "px";
}

/* ---------- dialogs ---------- */
let dlgEl = null;
export const dialog = () => dlgEl;
/* Moves on every time a dialog opens or closes, so a late answer can tell that the screen changed even when it looks
   the same again (nothing open, then something opened and closed): core/view-fence.js. */
let dlgRevision = 0;
export const dialogRevision = () => dlgRevision;
/* Pass 13c: closing a dialog puts the keyboard back on the button that opened it, or the one drawn in its place. */
let opener = null;
export function closeDlg() {
  const had = !!dlgEl;
  if (had) dlgRevision += 1;
  dlgEl?.remove();
  dlgEl = null;
  syncModalBackground();
  if (had) setTimeout(() => {
    if (dlgEl || !opener) return;
    const back = opener.isConnected ? opener : openerOf(opener);
    opener = null;
    if (back?.getClientRects().length) back.focus({ preventScroll: true });
  }, 0);
}
export function openDlg({ title, body, foot = "", wide = false }) {
  const fresh = !dlgEl;
  if (fresh) { const at = document.activeElement; opener = at && at.isConnected && at !== document.body && !at.closest?.(".pop") ? at : liveAnchor() ?? justClosed; }
  closePop();
  closeDlg();
  dlgEl = document.createElement("div");
  dlgRevision += 1;
  dlgEl.className = fresh ? "scrim in17" : "scrim"; /* pass 17: a fresh dialog eases in once */
  dlgEl.innerHTML = `<div class="dlg ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dlg-h"><h2>${esc(title)}</h2><button class="icon-btn" type="button" aria-label="${t("delight.ach.close")}" data-act="dlg-close">${ic("x")}</button></div><div class="dlg-b">${body}</div>${foot ? `<div class="dlg-f">${foot}</div>` : ""}</div>`;
  applyCss(dlgEl);
  greyOut(dlgEl);
  app().appendChild(dlgEl);
  syncModalBackground();
  const first = [".dlg-b input:not([type=checkbox])", ".dlg-b textarea", ".dlg-f .btn.pri:not(:disabled)", ".dlg-f .btn"].map((q) => dlgEl.querySelector(q)).find(Boolean);
  /* A dialog with no text box and no button at its foot focuses itself, not its X (pass 13c). */
  if (first) first.focus({ preventScroll: true });
  else { const d = dlgEl.querySelector(".dlg"); d.tabIndex = -1; d.focus({ preventScroll: true }); }
  return dlgEl;
}

/* ---------- pass 13c: the keyboard stays in the window on top ---------- */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/* Tab and Shift+Tab go round inside the open dialog, or setup, instead of wandering into the window behind it. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.defaultPrevented || e.ctrlKey || e.altKey) return;
  const box = dlgEl?.querySelector(".dlg") ?? document.querySelector(".ob9");
  if (!box) return;
  const list = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length && el.getAttribute("aria-disabled") !== "true");
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1], at = document.activeElement;
  if (!box.contains(at) || at === box) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}, true);
/* The arrow keys move between the cards of a gallery or list: to the nearest card that way. */
const CARDS = ["pet-c12", "scene-c12", "look-c12", "ch12", "prov12"];
document.addEventListener("keydown", (e) => {
  const dir = { ArrowLeft: "l", ArrowRight: "r", ArrowUp: "u", ArrowDown: "d" }[e.key];
  if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const cur = e.target.closest?.("button"), cls = cur && CARDS.find((c) => cur.classList.contains(c));
  if (!cls) return;
  const scope = cur.closest(".dlg, .ob9, .sec, #main") ?? document, r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bd = Infinity;
  for (const b of scope.querySelectorAll(`button.${cls}`)) {
    if (b === cur || b.disabled || !b.getClientRects().length) continue;
    const q = b.getBoundingClientRect(), x = q.left + q.width / 2 - cx, y = q.top + q.height / 2 - cy, row = Math.abs(y) < r.height / 2;
    const ok = dir === "l" ? x < -4 && row : dir === "r" ? x > 4 && row : dir === "u" ? y < -4 : y > 4;
    const d = dir === "l" || dir === "r" ? Math.abs(x) : Math.abs(y) + Math.abs(x) * 2;
    if (ok && d < bd) { bd = d; best = b; }
  }
  if (best) { e.preventDefault(); best.focus(); best.scrollIntoView({ block: "nearest" }); }
});
/* A pairing code's boxes: Backspace in an empty box steps back, the arrows move between boxes. */
document.addEventListener("keydown", (e) => {
  const box = e.target;
  if (box.dataset?.code == null || !box.closest?.(".code12")) return;
  const all = [...box.closest(".code12").querySelectorAll("input")], i = all.indexOf(box);
  if (e.key === "Backspace" && !box.value && i > 0) { e.preventDefault(); all[i - 1].value = ""; all[i - 1].focus(); all[i - 1].dispatchEvent(new Event("input", { bubbles: true })); }
  else if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); all[i - 1].focus(); }
  else if (e.key === "ArrowRight" && i < all.length - 1) { e.preventDefault(); all[i + 1].focus(); }
});

/* ---------- toasts ---------- */
let toastTimer;
/* With `undo`, the toast carries an Undo button (data-act="undo", handled in chat/messages.js) that calls it. */
/* The browser's own words for a request that never reached the engine (Chrome, Firefox, Safari), from any fetch, and for
   one cut off as the page went away. Neither is ever shown as a toast: the engine being away is the window's offline
   notice (main.js), which this puts up, and a request cut off by a reload or an install says nothing (the swap screen). */
const NO_ENGINE = /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|network error)$/i;
const CUT_OFF = /^(The user aborted a request\.?|The operation was aborted\.?|signal is aborted without reason|This operation was aborted)$/i;
export function toast(message, undo) {
  const said = String(message ?? "");
  if (CUT_OFF.test(said)) return;
  if (NO_ENGINE.test(said) || said === t("window.shell.offline")) { engineAway(); return; }
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? `<button type="button" data-act="undo">${t("strip.undo")}</button>` : ""}`;
  toast.undo = undo ?? null;
  app().appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), undo ? 5000 : 2600);
}

/* ---------- tooltips (data-tip, or an icon button's label) ---------- */
const TIP_SEL = "[data-tip],.icon-btn[aria-label],.c-btn[aria-label],.tb-btn[aria-label],.win button[aria-label]";
let tipEl = null;
let tipTimer;
function showTip(el) {
  clearTimeout(tipTimer);
  tipEl?.remove();
  tipEl = null;
  const text = el && (el.dataset.tip || el.getAttribute("aria-label"));
  if (!text) return;
  tipTimer = setTimeout(() => {
    /* QA retest 2026-09-28 (m9): a button whose menu is open says nothing, or its tip lands over the menu's last row. */
    if (!document.body.contains(el) || el.getAttribute("aria-expanded") === "true") return;
    const root = app();
    tipEl = document.createElement("div");
    tipEl.className = "tipx";
    tipEl.textContent = text;
    root.appendChild(tipEl);
    const a = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    tipEl.style.left = Math.min(Math.max(r.left - a.left + r.width / 2 - tipEl.offsetWidth / 2, 6), a.width - tipEl.offsetWidth - 6) + "px";
    tipEl.style.top = (r.top - a.top - tipEl.offsetHeight - 6 < 4 ? r.bottom - a.top + 6 : r.top - a.top - tipEl.offsetHeight - 6) + "px";
  }, 450);
}
function hideTip() { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; }
export function listenTips() {
  let current = null, touched = false;
  /* A tip is a mouse's and the keyboard's: a tap on a phone or tablet hovers and focuses the control it lands on, and the
     tip then stayed on screen after the finger had gone. */
  document.addEventListener("pointerover", (e) => { if (e.pointerType !== "mouse") return; const el = e.target.closest(TIP_SEL); if (el !== current) { current = el; showTip(el); } });
  document.addEventListener("focusin", (e) => { const el = e.target.closest(TIP_SEL); if (el && !touched) showTip(el); });
  document.addEventListener("pointerdown", (e) => { touched = e.pointerType !== "mouse"; hideTip(); }, true);
  document.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") hideTip(); }, true);
  document.addEventListener("keydown", () => { touched = false; }, true);
  document.addEventListener("scroll", hideTip, { capture: true, passive: true });
  // A tip is placed for the layout it was shown in; after a resize it could stand outside the window and widen the page.
  window.addEventListener("resize", hideTip);
}

export { $ };
