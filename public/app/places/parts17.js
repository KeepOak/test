/* Pieces pass 17 draws the same way in every place (patch17b.js): a status pill, a row with an icon tile, a section with
   its heading, and the time an engine record carries. Every word passed in is the prototype's or the engine's. */

import { esc } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { language } from "../../i18n.js";

/* A pill: its kind (ok, warn, no, idle, work, done) and its words. */
export const pill17 = (kind, text) => `<span class="pill ${esc(kind)}"><i></i>${esc(text)}</span>`;

/* A row with an icon tile, a title, a line under it and whatever sits on the right (already-built markup). */
export const prow17 = (icon, title, sub, right = "") =>
  `<div class="prow"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${right}</div>`;

/* A section of a place with its heading. */
export const sec17 = (title, body, cls = "") => `<div class="sec x15-sec ${cls}"><h2>${esc(title)}</h2>${body}</div>`;

/* A small button on a row: its action, its words and any data-* it carries (already escaped by the caller). */
export const btn17 = (act, text, attrs = "", cls = "btn sm") => `<button class="${cls}" type="button" data-act="${act}" ${attrs}>${esc(text)}</button>`;

/* The engine's ISO time as the prototype writes one: "Sep 24, 11:40". */
export const when17 = (iso) => (iso ? new Date(iso).toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

/* A fingerprint shortened the way the prototype shows one: its first and last four characters. */
export const short17 = (hex) => { const s = String(hex ?? ""); return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };

/* A list the engine answered, whatever object it came in. */
export const list17 = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : []);
