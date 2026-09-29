/* Settings › Advanced › Agent marketplace › Browse (RES-720): the engine's agent markets (src/interop/agent-market.ts,
   /api/interop/market). A market is a plain list someone publishes at a web address; the owner keeps up to ten of those
   addresses here (POST /api/interop/market/indexes). Browsing one lists its assistants (…/browse), Look inside opens one
   and checks its fingerprint (…/preview), and Bring in brings only the parts chosen of those a market may bring
   (specialists, saved procedures, skills), each skill switched off until the owner switches it on (…/install). Rules,
   model choices and memory never come from a market. The engine refuses in its own words while the switch
   "Sharing assistants" is off. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

const M = { indexes: [], url: "", market: null, open: null, chosen: new Set() };
const SECTIONS = { specialists: "window.settings.market.specialists", procedures: "window.settings.market.procedures", skills: "window.settings.market.skills" };

function listView() {
  const rows = M.indexes.map((url) => `<div class="prow"><span class="grow"><b>${esc(new URL(url).host)}</b><small>${esc(url)}</small></span>`
    + `<button class="btn sm" type="button" data-act="mk-browse" data-v="${esc(url)}">${esc(t("window.settings.advanced.browse"))}</button>`
    + `<button class="btn sm ghost" type="button" data-act="mk-remove" data-v="${esc(url)}">${esc(t("accounts.action.remove"))}</button></div>`).join("");
  return `${rows || `<p class="hint" data-css="margin:0">${esc(t("window.settings.market.none-yet"))}</p>`}`
    + `<div class="fld"><label for="mk-url">${esc(t("window.settings.market.add-label"))}</label><input class="inp" id="mk-url" placeholder="https://example.org/market.json" spellcheck="false" autocomplete="off"></div>`
    + `<p class="hint" data-css="margin:0">${esc(t("window.settings.market.note"))}</p>`;
}

function marketView() {
  const agents = M.market.agents.map((a) => {
    const inside = M.open?.entry.id === a.id ? insideView() : "";
    return `<div class="prow"><span class="grow"><b>${esc(a.name)}</b><small>${esc(a.summary ?? "")}${a.author ? ` · ${esc(a.author)}` : ""}${a.version ? ` · ${esc(a.version)}` : ""}</small>${inside}</span>`
      + `<button class="btn sm" type="button" data-act="mk-preview" data-v="${esc(a.id)}">${esc(t("window.settings.market.look-inside"))}</button></div>`;
  }).join("");
  return `<p class="hint" data-css="margin:0 0 8px">${esc(t("window.settings.market.from", { name: M.market.name, host: new URL(M.url).host }))}</p>${agents || `<p class="hint">${esc(t("window.settings.market.empty"))}</p>`}`;
}

function insideView() {
  const parts = M.open.sections.map((s) => s.allowed
    ? `<label class="opt"><input type="checkbox" data-sw="mk-part" data-v="${esc(s.name)}" ${M.chosen.has(s.name) ? "checked" : ""}><b>${esc(t(SECTIONS[s.name] ?? s.name))}</b><small>${esc(s.summary ?? "")}</small></label>`
    : `<div class="opt" aria-disabled="true"><b>${esc(s.name)}</b><small>${esc(t("window.settings.market.never"))}</small></div>`).join("");
  return `<div class="opts" data-css="margin-top:8px">${parts}</div><div class="acts" data-css="margin-top:8px"><button class="btn sm pri" type="button" data-act="mk-install">${esc(t("window.settings.market.bring-in"))}</button></div>`;
}

function draw() {
  const back = M.market ? `<button class="btn ghost" type="button" data-act="mk-back">${esc(t("window.settings.market.back"))}</button>` : "";
  const add = M.market ? "" : `<button class="btn" type="button" data-act="mk-add">${esc(t("window.settings.market.add"))}</button>`;
  openDlg({ title: t("window.settings.advanced.agent-marketplace"), body: M.market ? marketView() : listView(), wide: true,
    foot: `${back}<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>${add}` });
}

async function openMarket() {
  M.market = null; M.open = null;
  try { M.indexes = (await api("interop/market")).indexes ?? []; } catch (error) { toast(error.message); return; }
  draw();
}
async function saveList(urls) {
  try { M.indexes = (await api("interop/market/indexes", { urls })).indexes; } catch (error) { toast(error.message); return; }
  draw();
}
async function browse(url) {
  try { M.market = await api("interop/market/browse", { url }); M.url = url; M.open = null; } catch (error) { toast(error.message); return; }
  draw();
}
async function preview(id) {
  try { M.open = await api("interop/market/preview", { url: M.url, id }); } catch (error) { toast(error.message); return; }
  M.chosen = new Set(M.open.sections.filter((s) => s.allowed).map((s) => s.name));
  draw();
}
async function install() {
  const sections = [...M.chosen];
  if (!sections.length) { toast(t("window.settings.market.pick-a-part")); return; }
  try {
    const done = await api("interop/market/install", { url: M.url, id: M.open.entry.id, sections });
    const count = (done.reports ?? []).reduce((sum, report) => sum + (Number(report.brought) || 0), 0);
    toast(t("window.settings.market.brought", { name: done.entry.name, count }));
  } catch (error) { toast(error.message); return; }
  M.open = null;
  draw();
}

let started = false;
export function initMarket() {
  if (started) return;
  started = true;
  markLive(["mk-open", "mk-add", "mk-remove", "mk-browse", "mk-back", "mk-preview", "mk-install", "sw:mk-url", "sw:mk-part"]);
  on("mk-open", () => openMarket());
  on("mk-add", () => { const url = document.getElementById("mk-url")?.value.trim(); if (url) saveList([...M.indexes, url]); });
  on("mk-remove", (el) => saveList(M.indexes.filter((u) => u !== el.dataset.v)));
  on("mk-browse", (el) => browse(el.dataset.v));
  on("mk-back", () => { M.market = null; M.open = null; draw(); });
  on("mk-preview", (el) => preview(el.dataset.v));
  on("mk-install", () => install());
  document.addEventListener("change", (e) => {
    if (e.target?.dataset?.sw !== "mk-part") return;
    if (e.target.checked) M.chosen.add(e.target.dataset.v); else M.chosen.delete(e.target.dataset.v);
  });
}
