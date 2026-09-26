/* Library: memory, documents, generated files.
   Memory: each fact with where it came from (the engine's data.source) and when, as the prototype's rows are; how full it is (state.memoryCapacity), a tidy-up of the engine's findings (GET /api/memory/tidy; opening it
   stages them as suggestions with POST /api/memory/tidy, and each is applied or left through
   POST /api/memory/proposals/<id>/accept|reject), and a menu to export what is remembered (GET /api/memory/export),
   see the archive and put a fact back (GET /api/memory/archive, POST /api/memory/archive/<id>/restore).
   Documents: the engine's document library (GET /api/documents), shown as a list or as the Map, where the engine's map
   of names is asked (library17.js, with pass 17's spreadsheet, compare, labels and "How it learns"). */

import { esc, renderNow } from "../core/dom.js";
import { S, E, refresh, level } from "../core/state.js";
import { ic, mi, toast, openPop, closePop, openDlg, dialog } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { inlineText } from "../chat/markdown.js"; // a fact keeps its inline formatting, drawn from escaped text
import { workSection, labelled, mapSection, manageSection, learnSection, readLibrary17, initLibrary17 } from "./library17.js";
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";

function tabBar(tabs, place, current) {
  return `<div class="tabs" role="tablist">${tabs.map(([id, label, count]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${id === current ? 'true' : 'false'}" data-act="ptab" data-place="${place}" data-v="${id}">${esc(label)}${count > 0 ? `<span class="n">${count}</span>` : ''}</button>`
  ).join('')}</div>`;
}

let docsKey = "";
let docsList = [];
let docsFailed = false;
let artsFailed = false;
let artsKey = "";
let artsList = [];
let findings = null;
let tidyFailed = false;
let docView = "list";

const TIDY_SOURCE = "Suggested while tidying memory";
const TIDY_LABEL = { merge: "Said twice", archive: "Disagree" };
const TIDY_DO = { merge: "Merge them", archive: "Keep the newer one", forget: "Archive it" };
const findingCount = () => (findings ? findings.duplicates.length + findings.contradictions.length + findings.leastUseful.length : 0);

function ring(n, cap) {
  const p = Math.max(2, (n / cap) * 100);
  return `<span class="ring15" role="img" aria-label="${t("window.places.library.count-of-cap-facts", { count: n, cap })}"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" pathLength="100"/><circle class="r-arc15" cx="18" cy="18" r="15" pathLength="100" data-css="stroke-dasharray:${p} 100"/></svg></span>`;
}

function memoryTab(mem) {
  const cap = E.state.memoryCapacity;
  const n = findingCount();
  const acts = `<span class="st-acts15"><button type="button" class="btn sm" data-act="tidy15">${t("memory.card.tidy-up")}${n ? `<span class="n15">${n}</span>` : ""}</button><button type="button" class="icon-btn" aria-label="${t("window.places.library.more-for-memory")}" data-act="memmore15">${ic("more", "s")}</button></span>`;
  let html = `<div class="status memst15" data-css="margin:6px 0 10px">${cap ? ring(cap.count, cap.maxFacts) : '<span class="sdot"></span>'}<div>
      <b>${cap ? t("window.places.library.count-of-maxfacts-remembered", { count: cap.count, maxFacts: cap.maxFacts }) : t("window.places.library.count-things-remembered", { count: mem.length })}</b>
      <p>${t("window.places.library.trunks-suggest-what-to-remember-and")}</p></div>${acts}</div>`;
  html += mem.map((m, i) => `<div class="prow"><span class="ico-tile">${ic('star', 's')}</span>
        <span class="grow"><b>${inlineText(m.data?.text ?? m.data?.fact ?? m.data?.content ?? "")}</b><small>${esc([m.data?.source, when(m.updatedAt ?? m.createdAt)].filter(Boolean).join(" · "))}</small></span>
        <button class="btn ghost sm" type="button" data-act="forget" data-i="${i}" data-id="${esc(m.id || '')}">${t("window.places.library.forget")}</button></div>`).join('');
  return html;
}

function documentsTab() {
  const view = [["list", "list15", t("addons.lists.address")], ["map", "map15", t("window.places.library.map")]].map(([k, i, l]) => `<button type="button" aria-pressed="${docView === k}" data-act="dv15" data-v="${k}">${ic(i, "s")}${l}</button>`).join("");
  let html = `<div class="acts docacts15" data-css="margin:6px 0"><button class="btn" type="button" data-act="toast" data-msg="Opens a blank document.">
      ${ic('file', 's')}${t("window.places.library.write-a-new-document")}</button><span class="seg dv15" role="group" aria-label="${t("window.places.library.show-documents-as")}">${view}</span></div>`;
  html += workSection();
  /* The Map view shows what the map says about a name in place of the list, as the prototype's Map does. */
  if (docView !== "map") html += labelled(docsList).map((d) => `<div class="prow"><span class="fi">${esc((d.name || '').split('.').pop() || 'txt')}</span>
        <span class="grow"><b>${esc(d.name)}</b><small>${esc(when(d.updatedAt))}</small></span>
        <button class="btn sm" type="button" data-act="toast" data-msg="Opens in its own app.">${t("ov.open")}</button></div>`).join('');
  return html + mapSection(docView) + manageSection();
}
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(language(), { month: "short", day: "numeric" }) : "");

export function draw() {
  const tab = S.tabs.library || "memory";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const mem = E.state.memory || [];
  /* As the prototype draws them, only Memory carries its count. */
  const tabs = [
    ["memory", t("memory.movein.kind.memory"), mem.length],
    ["documents", t("nav.documents"), 0],
    ["made", t("place.library.made"), 0]
  ];

  const lockBanner = E.state.lock ? `<div class="lock-banner">${ic('lock', 's')}${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div>` : "";

  let html = `<main class="main enter11" id="main">${lockBanner}<div class="scroll"><div class="place">
    <h1>${t("place.library")}</h1><p class="lede">${t("window.places.library.what-your-trunks-remember-the-documents")}</p>
    ${tabBar(tabs, "library", tab)}<div class="rows">`;

  if (tab === "memory") html += memoryTab(mem) + learnSection();
  else if (tab === "documents") html += documentsTab();
  else if (tab === "made") {
    html += artsList.map((a) => `<div class="prow"><span class="fi">${esc((a.name || '').split('.').pop() || 'bin')}</span>
        <span class="grow"><b>${esc(a.name)}</b><small>${esc(a.source || '')}</small></span>
        <button class="btn sm" type="button" data-act="toast" data-msg="Opens in its own app.">${t("ov.open")}</button></div>`).join('');
  }

  html += `</div></div></div></main>`;
  return html;
}

export async function after() {
  const tab = S.tabs.library || "memory";
  if (tab === "memory") {
    if (tidyFailed) return;
    let fresh = null;
    try { fresh = await api("memory/tidy"); } catch (error) { tidyFailed = true; toast(error.message); return; }
    if (JSON.stringify(fresh) !== JSON.stringify(findings)) { findings = fresh; renderNow(); }
  } else if (tab === "documents") {
    const p17 = await readLibrary17(tab, docView);
    if (p17.error) toast(p17.error.message);
    if (p17.changed) renderNow();
    /* The engine answers {documents: [...]} with its settings beside the list; only the list is drawn. */
    /* Q261: the documents library and the files tasks made are kept for the owner; a household person reads neither. */
    if (docsFailed || E.profiles?.isOwner === false) return;
    let fresh = [];
    try { fresh = (await api("documents")).documents ?? []; } catch (error) { docsFailed = true; toast(error.message); }
    const key = JSON.stringify(fresh);
    if (key !== docsKey) { docsKey = key; docsList = fresh; renderNow(); }
  } else if (tab === "made") {
    /* The engine answers {artifacts: [...]} (each kept file's name, path and media type). */
    if (artsFailed || E.profiles?.isOwner === false) return; // Q261: as the documents above
    let fresh = [];
    try { fresh = (await api("artifacts")).artifacts ?? []; } catch (error) { artsFailed = true; toast(error.message); }
    const key = JSON.stringify(fresh);
    if (key !== artsKey) { artsKey = key; artsList = fresh; renderNow(); }
  }
}

/* ---------- tidy up ---------- */
function tidyRow(p) {
  const texts = p.kind === "merge" ? [p.text] : [];
  const label = TIDY_LABEL[p.kind] ? `<span class="td-k15 ${p.kind === "merge" ? "dup" : "clash"}">${esc(say(TIDY_LABEL[p.kind]))}</span>` : "";
  return `<div class="td-row15" data-td15="${esc(p.id)}">${label}<p>${esc([...texts, p.note].filter(Boolean).join(" "))}</p><span class="acts"><button type="button" class="btn ghost sm" data-act="tidydo15" data-id="${esc(p.id)}" data-x="skip">${t("window.places.inbox.leave-it")}</button><button type="button" class="btn sm" data-act="tidydo15" data-id="${esc(p.id)}">${esc(say(TIDY_DO[p.kind]))}</button></span></div>`;
}
/* Stages the engine's findings as suggestions (nothing changes), then lists every tidying suggestion still waiting. */
async function openTidy() {
  let waiting;
  try {
    await api("memory/tidy", {});
    waiting = (await api("memory/proposals")).proposals.filter((p) => p.status === "pending" && p.source === TIDY_SOURCE && TIDY_DO[p.kind]);
  } catch (error) { toast(error.message); return; }
  openDlg({ title: t("window.places.library.tidy-up-memory"), body: `<p class="hint" data-css="margin:0 0 10px">${t("window.places.library.found-by-comparing-what-each-fact")}</p><div class="tidy15">${waiting.map(tidyRow).join("")}</div>`, foot: `<button class="btn" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}
async function decideTidy(el) {
  const skip = Boolean(el.dataset.x);
  try { await api(`memory/proposals/${encodeURIComponent(el.dataset.id)}/${skip ? "reject" : "accept"}`, {}); } catch (error) { toast(error.message); return; }
  const row = [...(dialog()?.querySelectorAll("[data-td15]") ?? [])].find((r) => r.dataset.td15 === el.dataset.id);
  if (row) { row.classList.add("done15"); row.querySelector(".acts").innerHTML = `<span class="pill ${skip ? "idle" : "done"}"><i></i>${skip ? t("window.places.library.left-as-it-is") : t("first-run-steps.done")}</span>`; }
  findings = null;
  await refresh().catch((error) => toast(error.message));
}

/* ---------- export and the archive ---------- */
function save(blob, name) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/* JSON Lines comes as a file with its own name; the full archive is the engine's JSON, named by its format. */
async function exportMemory(el) {
  closePop();
  try {
    if (el.dataset.v !== "archive") {
      const response = await fetch("/api/memory/export?format=jsonl", { cache: "no-store", headers: token.get() ? { authorization: "Bearer " + token.get() } : {} });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
      /* The desktop app drops every download: there the lines go to the Save dialog through its guarded export. */
      if (typeof window.branchDesktop?.exportMemoryLines === "function") { await window.branchDesktop.exportMemoryLines(await response.text()); return; }
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "";
      save(await response.blob(), name);
      return;
    }
    const archive = await api("memory/export");
    /* The desktop app drops every download: there the archive goes to the Save dialog through its guarded export. */
    if (typeof window.branchDesktop?.exportMemory === "function") { await window.branchDesktop.exportMemory(JSON.stringify(archive)); return; }
    save(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }), `${archive.format}.json`);
  } catch (error) { toast(error.message); }
}
async function openArchive() {
  closePop();
  let archived, total;
  try { ({ archived, total } = await api("memory/archive")); } catch (error) { toast(error.message); return; }
  const rows = archived.map((a) => `<div class="prow"><span class="grow"><b>${esc(a.data?.text ?? "")}</b><small>${esc(["archived " + new Date(a.archivedAt).toLocaleDateString(language(), { month: "short", day: "numeric" }), a.note].filter(Boolean).join(" · "))}</small></span><button class="btn ghost sm" type="button" data-act="memarch15" data-id="${esc(a.id)}">${t("window.places.library.restore")}</button></div>`).join("");
  openDlg({ title: t("window.places.library.archived-facts"), body: `<div class="rows">${rows}</div><p class="hint">${t("window.places.library.archived-facts-are-never-used-purge")}</p>`, foot: `<button class="btn ghost bad" type="button" data-act="memarch15" data-v="purge" data-n="${esc(total)}" ${total ? "" : "disabled"}>${t("window.places.library.purge-all")}</button><button class="btn" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}
/* Purge all: the engine removes every archived fact for good. Its confirm step is how many the owner was shown; when
   that is no longer how many there are, nothing is removed and its sentence is shown. */
async function purgeArchive(el) {
  const count = Number(el.dataset.n);
  let done;
  try { done = await api("memory/archive/purge", { confirm: "purge", count }); } catch (error) { toast(error.message); return; }
  await openArchive();
  toast(t("window.places.library.purged-purged-archived-facts", { purged: done.purged }));
}
async function restoreFact(id) {
  try { await api(`memory/archive/${encodeURIComponent(id)}/restore`, {}); } catch (error) { toast(error.message); return; }
  await refresh().catch((error) => toast(error.message));
  await openArchive();
}
function memoryMenu(el) {
  const settings = level() >= 1 ? mi("setgo", "gear", t("window.places.library.memory-settings"), "", 'data-v="advanced"') : "";
  openPop(el, mi("memexp15", "up", t("window.places.library.export-what-it-remembers"), t("window.places.library.json-lines")) + mi("memexp15", "folder", t("window.places.library.save-a-full-archive"), "", 'data-v="archive"') + "<hr>" + mi("memarch15", "clock", t("window.places.library.archived-facts")) + settings, { right: true });
}

export function init() {
  markLive(["ptab", "forget", "tidy15", "tidydo15", "memmore15", "memexp15", "memarch15", "dv15"]);
  /* List or Map: which way the documents are shown (window state); the Map asks the engine's map (library17.js). */
  on("dv15", (el) => { docView = el.dataset.v === "map" ? "map" : "list"; renderNow(); });
  initLibrary17();
  /* One memory, by its id, through the engine's own memory.delete (POST /api/action); nothing else is forgotten. */
  on("forget", async (el) => {
    const id = el.dataset.id;
    if (!id) return;
    try { await api("action", { tool: "memory.delete", args: { id } }); } catch (error) { toast(error.message); return; }
    await refresh().catch((error) => toast(error.message));
    renderNow();
  });
  on("tidy15", () => openTidy());
  on("tidydo15", (el) => decideTidy(el));
  on("memmore15", (el) => memoryMenu(el));
  on("memexp15", (el) => exportMemory(el));
  /* The menu's row opens the archive; a row's Restore (with its id) puts that fact back; Purge all removes them all. */
  on("memarch15", (el) => (el.dataset.v === "purge" ? purgeArchive(el) : el.dataset.id ? restoreFact(el.dataset.id) : openArchive()));
}
