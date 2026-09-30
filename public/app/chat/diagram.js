/* A ```mermaid block in a reply (pass 17, design/redesign/pass17/FEATURES17C.md §6), drawn as the prototype's diagram card:
   the drawing, "The text that drew it" folded under it, Open larger, Copy the text and Save to Library.
   The drawing is made by Mermaid inside the sealed frame the engine serves (GET /diagram-frame, src/diagram-frame.ts): an
   iframe sandboxed with scripts only (an opaque origin: it cannot reach this window, its storage or the key) under its
   own policy (only its two scripts run; nothing is fetched or sent). The window's own policy is unchanged. The frame says
   when it is ready; the window posts it the diagram's text (read back from the card) and whether the window is dark, and
   the frame answers with the drawing's height, which is all that comes back. A diagram that cannot be drawn keeps its text.
   Open larger shows the same frame, wide. Copy the text puts the text on the clipboard. Save to Library keeps the text beside the task
   whose answer holds it (POST /api/artifacts/save), and reads "In Library" once Library › Made for you lists it
   (GET /api/artifacts); with no such task among the engine's recent ones it stays greyed. */

import { esc, render } from "../core/dom.js";
import { E, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, openDlg, toast } from "../core/ui.js";
import { ICONS } from "../core/icons.js";
import { t } from "../../i18n.js";

Object.assign(ICONS, { dia17c: '<rect x="3.5" y="4" width="7" height="5" rx="1.2"/><rect x="13.5" y="15" width="7" height="5" rx="1.2"/><path d="M7 9v4.5h10V15"/>' });

const D = { kept: null, asked: false };
/* A short, steady name for one diagram's text, so saving it twice keeps one file. */
function nameFor(source) {
  let h = 2166136261;
  for (const ch of source) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `diagram-${h.toString(16).padStart(8, "0")}.mmd`;
}
const runOf = (source) => (E.state?.runs ?? []).find((r) => typeof r.output === "string" && r.output.includes(source))?.id ?? "";
const kept = (run, source) => !!D.kept?.some((a) => a.runId === run && a.name === nameFor(source));

async function readKept() {
  const got = await api("artifacts").catch((error) => { toast(error.message); return null; });
  if (!got) return;
  D.kept = got.artifacts ?? [];
  render();
}

/* The diagram's text, read back from its own card: nothing is kept beside the page. */
const cardSource = (el) => el.closest("[data-dia17c]")?.querySelector("pre")?.textContent ?? "";

/* The sealed frame, as the card and Open larger draw it. Its markup never changes once drawn, so a redraw of the
   conversation keeps the same frame; a drawing's height, once known, is given to a new frame of it as soon as it is ready. */
const heights = new Map();
const frame = (source, big) => `<iframe class="dmm-frame${big ? " big" : ""}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/diagram-frame" title="${t("window.chat.dia.diagram")}"></iframe>`;
const dark = () => {
  const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? [255, 255, 255]).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
};
/* Each frame told its card's text, and whether the window was dark when it was told. */
const told = new WeakMap();
/* The window changed between light and dark: each frame already told draws the text it keeps again in the new colours.
   Only the colour is sent: the text went to that frame once, and is never sent again to whatever the frame holds now. */
function recolour() {
  const now = dark();
  for (const el of document.querySelectorAll("iframe.dmm-frame")) {
    if (!told.has(el) || told.get(el) === now) continue;
    told.set(el, now);
    el.contentWindow?.postMessage({ dark: now }, "*");
  }
}
/* Only a frame this window drew is answered, and only with its own card's text; a height is the only thing taken back. */
function frameSaid(event) {
  const el = [...document.querySelectorAll("iframe.dmm-frame")].find((f) => f.contentWindow === event.source);
  if (!el || typeof event.data !== "object" || event.data === null) return;
  const source = cardSource(el);
  /* A frame is told its text once: a frame that says "ready" again has been taken somewhere else, and gets nothing. */
  if (event.data.kind === "ready" && source && !told.has(el)) {
    const now = dark();
    told.set(el, now);
    if (heights.has(source)) el.style.height = `${heights.get(source)}px`;
    el.contentWindow.postMessage({ source, dark: now }, "*");
  }
  else if (event.data.kind === "drawn" && Number.isFinite(event.data.height)) {
    // A very tall drawing is shown up to this height, and scrolls inside its frame beyond it.
    const height = Math.max(40, Math.min(8000, Math.round(event.data.height)));
    heights.set(source, height);
    el.style.height = `${height}px`;
  } else if (event.data.kind === "failed") {
    /* Mermaid could not read it: the drawing's place goes and the text that was meant to draw it is shown instead. */
    const card = el.closest("[data-dia17c]");
    el.closest(".dwrap17c")?.setAttribute("hidden", "");
    const text = card?.querySelector("details");
    if (text) text.open = true;
  }
}

function saveButton(run, source) {
  /* Q262: the file would be kept in the owner's Library, so a household person is not offered Save at all. */
  if (!ownerHere()) return "";
  if (!run) return `<button class="btn sm" type="button" data-act="toast">${t("window.diagram.save-to-library")}</button>`;
  return `<button class="btn sm" type="button" data-act="diasave17c" data-run="${esc(run)}">${kept(run, source) ? t("window.diagram.in-library") : t("window.diagram.save-to-library")}</button>`;
}

/* The card for a mermaid block. */
export function diagramCard(source) {
  if (!D.asked && ownerHere()) { D.asked = true; readKept(); }
  const run = runOf(source);
  return `<div class="card dia17c" data-dia17c="1"><div class="card-h">${ic("dia17c", "s")}<span class="pill idle ml">${t("window.chat.dia.diagram")}</span></div><p class="note">${t("window.chat.dia.note")}</p><div class="dwrap17c">${frame(source, false)}</div>
    <div class="acts"><button class="btn sm" type="button" data-act="diaopen17c">${t("window.chat.art.larger")}</button><button class="btn sm" type="button" data-act="diacopy17c">${t("window.chat.dia.copy")}</button>${saveButton(run, source)}</div>
    <details><summary>${ic("chev", "s chev")}${t("window.chat.dia.text-drew")}</summary><pre>${esc(source)}</pre></details></div>`;
}

function openLarger(el) {
  const source = cardSource(el);
  if (!source) return;
  const run = runOf(source);
  openDlg({ title: t("window.chat.dia.diagram"), wide: true,
    body: `<div data-dia17c="1"><div class="dwrap17c big17c">${frame(source, true)}</div><p class="hint" data-css="margin:8px 0">${t("window.chat.dia.note")}</p><pre class="dsrc17c">${esc(source)}</pre></div>`,
    foot: `<span data-dia17c="1"><pre hidden>${esc(source)}</pre><button class="btn" type="button" data-act="diacopy17c">${t("window.chat.dia.copy")}</button>${saveButton(run, source).replace('class="btn sm"', 'class="btn pri"')}</span>` });
}

async function copyText(el) {
  const source = cardSource(el);
  if (!source) return;
  try { await navigator.clipboard.writeText(source); } catch (error) { toast(error.message); return; }
  toast(t("window.chat.dia.copied"));
}

async function save(el) {
  const source = cardSource(el), run = el.dataset.run;
  if (!source || !run) return;
  const was = kept(run, source);
  try { await api("artifacts/save", { runId: run, name: nameFor(source), mediaType: "text/plain", code: source }); } catch (error) { toast(error.message); return; }
  await readKept();
  for (const b of document.querySelectorAll(`[data-act="diasave17c"][data-run="${CSS.escape(run)}"]`)) if (cardSource(b) === source) b.textContent = kept(run, source) ? t("window.diagram.in-library") : t("window.diagram.save-to-library");
  toast(was ? t("window.chat.dia.already") : t("window.chat.dia.saved-as", { name: nameFor(source) }));
}

export function initDiagram() {
  addEventListener("message", frameSaid);
  new MutationObserver(recolour).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolour);
  markLive(["diaopen17c", "diacopy17c", "diasave17c"]);
  on("diaopen17c", (el) => openLarger(el));
  on("diacopy17c", (el) => copyText(el));
  on("diasave17c", (el) => save(el));
}
