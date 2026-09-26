/* The walkthrough (design doc 6.2), 1:1 with the prototype's: a spotlight on one part of the window, a card beside it
   with the guide's pose, "n of N", dots, Back, Skip and Next. A stop whose part is not on screen is passed over, so the
   tour only ever shows what this window has. */

import { $, esc, renderNow } from "../core/dom.js";
import { app, closePop, closeDlg } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const chat = () => { S.view = "chat"; };
/* Each stop's title and words are keys, drawn in the language in force. */
const TOUR = [
  { sel: ".list", prep: chat, title: "window.flows.tour.contacts", text: "window.flows.tour.contacts-text" },
  { sel: ".ask", prep: chat, title: "window.flows.tour.asks", text: "window.flows.tour.asks-text" },
  { sel: '[data-act="modelmenu2"]', prep: chat, title: "window.flows.tour.model", text: "window.flows.tour.model-text" },
  { sel: '[data-act="modemenu2"]', prep: chat, title: "window.flows.tour.may-do", text: "window.flows.tour.may-do-text" },
  { sel: '[data-act="plusmenu"]', prep: chat, title: "window.flows.tour.plus", text: "window.flows.tour.plus-text" },
  { sel: "#pane", title: "window.flows.tour.pane", text: "window.flows.tour.pane-text" },
  { sel: '[data-act="gwpop"]', title: "window.flows.tour.gateway", text: "window.flows.tour.gateway-text" },
  { sel: ".side-nav", title: "window.flows.tour.places", text: "window.flows.tour.places-text" },
  { sel: "#side-q", title: "comfort.field.palette", text: "window.flows.tour.find-text" },
  { sel: '[data-act="view"][data-v="settings"]', title: "window.flows.tour.settings", text: "window.flows.tour.settings-text" },
  { sel: ".lm-grid12", prep: () => { S.view = "settings"; S.setPage = "local"; }, title: "field.local-models-switch", text: "window.flows.tour.local-text" },
  { sel: ".ch-wrap12", prep: () => { S.view = "customize"; S.tabs.customize = "channels"; }, title: "window.flows.tour.apps", text: "window.flows.tour.apps-text" },
  { sel: "#rz-side", prep: chat, title: "window.flows.tour.layout", text: "window.flows.tour.layout-text" },
  { sel: null, prep: chat, title: "window.flows.tour.end", text: "window.flows.tour.end-text" },
];

const T = { on: false, i: 0, dir: 1 };

export function startTour() {
  closePop();
  closeDlg();
  Object.assign(T, { on: true, i: 0, dir: 1 });
  go(0);
}

function end() {
  T.on = false;
  $(".tour-layer")?.remove();
  renderNow();
}

function go(i) {
  if (i >= TOUR.length) return end();
  T.i = Math.max(0, i);
  closePop();
  try { TOUR[T.i].prep?.(); } catch { /* a stop that cannot be prepared is passed over below */ }
  renderNow();
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function layer() {
  let el = $(".tour-layer");
  if (!el) {
    el = document.createElement("div");
    el.className = "tour-layer";
    el.innerHTML = `<div class="tour-spot"></div><div class="tour-card" role="dialog" aria-live="polite" aria-label="${t("window.flows.tour.label")}"></div>`;
    app().appendChild(el);
  }
  return el;
}

function cardHtml(st) {
  const last = T.i === TOUR.length - 1;
  const pose = last ? "yay" : T.i === 0 ? "wave" : "point";
  return `<img class="pose11 tour-pt11" src="/art/branch-${pose}.webp" alt="" loading="lazy" decoding="async" draggable="false"><span class="n">${t("window.find.count", { at: T.i + 1, total: TOUR.length })}</span><b>${esc(t(st.title))}</b><p>${esc(t(st.text))}</p><div class="tour-dots" aria-hidden="true">${TOUR.map((_, j) => `<i class="${j === T.i ? "on" : ""}"></i>`).join("")}</div><div class="acts">${T.i > 0 ? `<button class="btn ghost sm" type="button" data-act="tour-back">${t("action.back")}</button>` : ""}<span class="tb-grow"></span><button class="btn ghost sm" type="button" data-act="tour-end">${last ? t("delight.ach.close") : t("window.flows.tour.skip")}</button>${last ? "" : `<button class="btn pri sm" type="button" data-act="tour-next">${t("action.next")}</button>`}</div>`;
}

function place() {
  if (!T.on) return;
  const st = TOUR[T.i], a = app().getBoundingClientRect();
  let el = st.sel ? document.querySelector(st.sel) : null;
  let r = el?.getBoundingClientRect();
  if (st.sel && (!el || !el.getClientRects().length || r.width < 2)) {
    const next = T.i + T.dir;
    if (next >= 0 && next < TOUR.length) return go(next);
    el = null;
  }
  const root = layer(), spot = root.querySelector(".tour-spot"), card = root.querySelector(".tour-card");
  card.innerHTML = cardHtml(st);
  const cw = card.offsetWidth, ch = card.offsetHeight;
  if (!el) {
    spot.className = "tour-spot none";
    Object.assign(card.style, { left: (a.width - cw) / 2 + "px", top: Math.max(60, (a.height - ch) / 2) + "px" });
    card.querySelector(".btn.pri,.btn")?.focus({ preventScroll: true });
    return;
  }
  spot.className = "tour-spot";
  const pad = 6, x = Math.max(4, r.left - a.left - pad), y = Math.max(4, r.top - a.top - pad);
  const w = Math.min(a.width - x - 4, r.width + pad * 2), h = Math.min(a.height - y - 4, r.height + pad * 2);
  Object.assign(spot.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  let top = y + h + 12;
  if (top + ch > a.height - 8) top = y - ch - 12;
  if (top < 8) top = Math.max(8, Math.min(a.height - ch - 8, y + 12));
  let left = Math.min(Math.max(x, 12), a.width - cw - 12);
  if (top < y + h && top + ch > y && w < a.width - cw - 40) left = x + w + 12 + cw < a.width ? x + w + 12 : Math.max(12, x - cw - 12);
  Object.assign(card.style, { left: left + "px", top: top + "px" });
  card.querySelector('[data-act="tour-next"]')?.focus({ preventScroll: true });
}

export function init() {
  markLive(["tour", "tour-next", "tour-back", "tour-end"]);
  on("tour", () => startTour());
  on("tour-next", () => { T.dir = 1; go(T.i + 1); });
  on("tour-back", () => { T.dir = -1; go(T.i - 1); });
  on("tour-end", () => end());
  document.addEventListener("keydown", (e) => {
    if (!T.on) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") { T.dir = 1; go(T.i + 1); }
    else if (e.key === "ArrowLeft" && T.i > 0) { T.dir = -1; go(T.i - 1); }
  });
  window.addEventListener("resize", () => { if (T.on) place(); });
}
