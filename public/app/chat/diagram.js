/* A ```mermaid block in a reply (pass 17, design/redesign/pass17/FEATURES17C.md §6), drawn as the prototype's diagram card
   without a renderer: no library is added, so the card shows the diagram's own text, and Open larger shows it as an
   artifact in the sealed frame the engine serves (POST /api/artifacts/page: its own origin, no script, nothing fetched),
   in a sandboxed iframe. Copy the text puts the text on the clipboard. Save to Library keeps the text beside the task
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
  return `<div class="card dia17c" data-dia17c="1"><div class="card-h">${ic("dia17c", "s")}<span class="pill idle ml">${t("window.chat.dia.diagram")}</span></div>
    <pre>${esc(source)}</pre>
    <div class="acts"><button class="btn sm" type="button" data-act="diaopen17c">${t("window.chat.art.larger")}</button><button class="btn sm" type="button" data-act="diacopy17c">${t("window.chat.dia.copy")}</button>${saveButton(run, source)}</div></div>`;
}

async function openLarger(el) {
  const source = cardSource(el);
  if (!source) return;
  let page;
  try { page = await api("artifacts/page", { kind: "html", title: "Diagram", code: `<pre>${esc(source)}</pre>` }); } catch (error) { toast(error.message); return; }
  if (!/^\/artifact\/[A-Za-z0-9_-]+$/.test(page.url ?? "")) return;
  const run = runOf(source);
  openDlg({ title: t("window.chat.dia.diagram"), wide: true,
    body: `<iframe class="dframe17c" sandbox="" referrerpolicy="no-referrer" title="${t("window.chat.dia.diagram")}" src="${esc(page.url)}"></iframe><p class="hint" data-css="margin:8px 0">${t("window.chat.dia.sealed")}</p><pre class="dsrc17c" data-dia17c="1">${esc(source)}</pre>`,
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
  markLive(["diaopen17c", "diacopy17c", "diasave17c"]);
  on("diaopen17c", (el) => openLarger(el));
  on("diacopy17c", (el) => copyText(el));
  on("diasave17c", (el) => save(el));
}
