/* Every panel edge, 1:1 with the prototype's pass 10a: one drag handler for the list's edge, the side panel's and the
   computer dock's. Dragging the list's edge below 150px makes it a rail of icons and below 40px hides it; a double-click
   puts an edge back to its usual size; a focused edge moves 16px with the arrow keys. The widths and modes are kept in
   this browser with the window's other saved choices (core/state.js save()). */

import { $, renderNow, afterDraw, esc } from "../core/dom.js";
import { S, save } from "../core/state.js";
import { toast } from "../core/ui.js";
import { binding } from "./keys.js";
import { t } from "../../i18n.js";

export const RAIL_W = 68;
const USUAL = { side: 292, pane: 352, dock: 340 };
const STEP = 16;
const WIDE = matchMedia("(min-width: 761px)");
let dragging = null;

const app = () => document.getElementById("app");
const appW = () => app().getBoundingClientRect().width;
const sideW = () => S.sideW ?? USUAL.side;
const sideWidth = () => (S.sideHidden ? 0 : S.rail ? RAIL_W : sideW());
const dockEl = () => $("#stage7 .st7-dock");
/* The list as the window shows it now: a rail or hidden only on a wide window. */
export const railNow = () => WIDE.matches && S.rail && !S.sideHidden;
export const hiddenNow = () => WIDE.matches && S.sideHidden;
function width(kind) {
  if (kind === "side") return sideWidth();
  if (kind === "pane") return S.paneW ?? USUAL.pane;
  return Math.round(dockEl()?.getBoundingClientRect().width || S.dockW || USUAL.dock);
}
const limits = (kind) => (kind === "side" ? [0, 640] : kind === "pane" ? [240, Math.round(appW() * 0.7)] : [260, Math.round(appW() * 0.6)]);

/* The edge itself, drawn inside its region's own markup: a separator a keyboard can reach, named by its tooltip. With the
   list hidden, the list's edge stays at the window's left as the way back (the owner removed the title bar's button). */
function tipFor(kind) {
  if (kind !== "side") return t("window.shell.resize.edge-tip");
  if (!hiddenNow()) return t("window.shell.resize.side-tip");
  const keys = binding("sideList");
  return keys ? t("window.shell.resize.show-tip", { keys }) : t("window.shell.resize.show-tip-bare");
}
export function resizerHTML(kind) {
  const [min, max] = limits(kind), tip = esc(tipFor(kind));
  return `<div class="resizer${dragging === kind ? " drag" : ""}" id="rz-${kind}" data-resize="${kind}" role="separator" aria-orientation="vertical" tabindex="0" aria-valuenow="${width(kind)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-label="${tip}" title="${tip}"><i class="grip9"></i></div>`;
}

/* The widths as CSS variables, and the list's mode as the app's rail9 / side-hidden classes (only on a wide window: a
   narrow one slides the list in over the conversation instead). */
export function applyLayout() {
  const a = app(), body = $("#body");
  if (!a || !body) return;
  const wide = WIDE.matches, w = wide ? sideWidth() : USUAL.side;
  a.classList.toggle("rail9", railNow());
  a.classList.toggle("side-hidden", hiddenNow());
  body.style.setProperty("--side-w", w + "px");
  body.style.setProperty("--pane-w", width("pane") + "px");
  if (S.dockW) a.style.setProperty("--dock-w", S.dockW + "px");
  a.querySelector(".titlebar")?.style.setProperty("--side-w", w + "px");
  for (const rz of document.querySelectorAll("[data-resize]")) rz.setAttribute("aria-valuenow", String(width(rz.dataset.resize)));
}

/* The computer dock's own width setter, when the stage has one (chat/stage.js setDockWidth keeps it and refits the screen). */
function setDock(px) {
  S.dockW = px;
  app().style.setProperty("--dock-w", px + "px");
  import("../chat/stage.js").then((m) => m.setDockWidth?.(px), (error) => toast(error.message));
}

/* The prototype's thresholds for a drag: under 40px the list hides, under 150px it is a rail, else 180–640px. */
function setWidth(kind, w, W) {
  if (kind === "side") {
    if (w < 40) S.sideHidden = true;
    else if (w < 150) { S.sideHidden = false; S.rail = true; }
    else { S.sideHidden = false; S.rail = false; S.sideW = Math.min(640, Math.max(180, Math.round(w))); }
  } else if (kind === "pane") S.paneW = Math.min(Math.round(W * 0.7), Math.max(240, Math.round(w)));
  else setDock(Math.min(Math.round(W * 0.6), Math.max(260, Math.round(w))));
}

const mode = () => `${S.sideHidden}/${S.rail}`;
function startDrag(e) {
  const rz = e.target.closest?.("[data-resize]");
  if (!rz || e.button !== 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const kind = rz.dataset.resize, x0 = e.clientX, W = appW(), w0 = width(kind);
  dragging = kind;
  rz.classList.add("drag");
  document.body.classList.add("resizing9");
  let moved = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (Math.abs(dx) > 2) moved = true;
    if (!moved) return;
    const was = mode();
    setWidth(kind, kind === "side" ? w0 + dx : w0 - dx, W);
    if (mode() !== was) renderNow(); else applyLayout(); // the rail and hidden list draw differently, not only narrower
  };
  const up = () => {
    dragging = null;
    document.querySelectorAll(".resizer.drag").forEach((el) => el.classList.remove("drag"));
    document.body.classList.remove("resizing9");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    if (moved) { save(); renderNow(); }
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

function reset(e) {
  const rz = e.target.closest?.("[data-resize]");
  if (!rz) return;
  const kind = rz.dataset.resize;
  if (kind === "side") Object.assign(S, { sideW: USUAL.side, rail: false, sideHidden: false });
  else if (kind === "pane") S.paneW = USUAL.pane;
  else setDock(USUAL.dock);
  save();
  renderNow();
  toast(t("window.shell.resize.usual"));
}

/* The keyboard walks the list's edge hidden → rail → 180px … 640px, 16px a press; the side panel and the dock widen
   towards the conversation with the Left arrow, as dragging their edge left does. */
function stepSide(dx) {
  if (S.sideHidden) { if (dx > 0) Object.assign(S, { sideHidden: false, rail: true }); return; }
  if (S.rail) { if (dx > 0) Object.assign(S, { rail: false, sideW: 180 }); else S.sideHidden = true; return; }
  const w = sideW() + dx;
  if (w < 180) S.rail = true; else S.sideW = Math.min(640, w);
}
function arrows(e) {
  if (!e.target.matches?.("[data-resize]")) return;
  const kind = e.target.dataset.resize, restore = kind === "side" && hiddenNow() && e.key === "Enter";
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && !restore) return;
  e.preventDefault();
  const dx = e.key === "ArrowRight" ? STEP : -STEP;
  if (restore) Object.assign(S, { sideHidden: false, rail: false });
  else if (kind === "side") stepSide(dx);
  else setWidth(kind, width(kind) - dx, appW());
  save();
  renderNow();
}

/* Hide the list, or show it again (Ctrl+B); a narrow window slides it in instead. */
export function toggleSide() {
  if (!WIDE.matches) { app().classList.toggle("side-open"); return; }
  S.sideHidden = !S.sideHidden;
  save();
  renderNow();
}

/* In the rail, a conversation's icon says whose it is, and the search icon opens the list again to type in. */
function railTips() {
  if (!app()?.classList.contains("rail9")) return;
  for (const row of document.querySelectorAll("#side .list .row[data-id]")) row.dataset.tip = row.querySelector(".ellip14")?.textContent ?? "";
}
function railSearch(e) {
  if (!app().classList.contains("rail9") || !e.target.closest?.("#side .sq9")) return;
  e.preventDefault();
  S.rail = false;
  save();
  renderNow();
  $("#side-q")?.focus();
}

export function initResize() {
  if (S.sideW != null && !(S.sideW >= 180 && S.sideW <= 640)) S.sideW = null;
  if (S.paneW != null && !(S.paneW >= 240)) S.paneW = null;
  if (S.dockW != null && !(S.dockW >= 260)) S.dockW = null;
  document.addEventListener("pointerdown", startDrag, true);
  document.addEventListener("dblclick", reset, true);
  document.addEventListener("keydown", arrows);
  document.addEventListener("click", railSearch, true);
  afterDraw(applyLayout);
  afterDraw(railTips);
  WIDE.addEventListener("change", applyLayout);
}
