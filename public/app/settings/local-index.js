/* Settings › Advanced › A local index of mail and calendars (RES-718): the engine's switch and how far back it copies
   (POST /api/local-index), what is kept per source, its size and when it was last brought up to date (GET), Update now
   (POST /api/local-index/update) and, after a yes, Delete the index (POST /api/local-index/delete). The switch keeps its
   id from the greyed row it replaces. It ships on ("when needed"), for the sources already connected and switched on. */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

const L = { view: null, asked: false };
const SWITCH = "f15-a-local-index-of-mail-calendar-and-messa";
const SOURCES = { inbox: "window.settings.local-index.src-inbox", gmail: "window.settings.local-index.src-gmail", outlook: "window.settings.local-index.src-outlook",
  "google-calendar": "window.settings.local-index.src-google-calendar", "outlook-calendar": "window.settings.local-index.src-outlook-calendar" };

async function load() {
  try { L.view = await api("local-index"); } catch (error) { toast(error.message); }
  render();
}
const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

function status(v) {
  const kept = v.lastRunAt ? t("window.settings.local-index.kept", { count: v.total, size: size(v.bytes), when: new Date(v.lastRunAt).toLocaleString() })
    : t("window.settings.local-index.never");
  const problems = Object.keys(v.problems ?? {});
  return problems.length ? `${kept} ${t("window.settings.local-index.problems", { list: problems.map((id) => t(SOURCES[id] ?? id)).join(", ") })}` : kept;
}

/* The switch, and while on (or while anything is still kept) how far back, what is kept and the two buttons. */
export function localIndexRow() {
  if (!L.asked) { L.asked = true; load(); }
  const v = L.view, on = !!v && v.settings.mode !== "off";
  const label = t("window.settings.advanced.a-local-index-of-mail-calendar");
  let html = `<div class="ctl"><b>${esc(label)}</b><input class="sw" type="checkbox" id="${SWITCH}" aria-label="${esc(label)}" data-sw="set" ${on ? "checked" : ""}><small>${esc(t("window.settings.advanced.built-and-kept-on-this-computer"))}</small></div>`;
  if (!v || (!on && !v.total)) return html;
  if (on) {
    const days = [[30, t("window.settings.local-index.d30")], [90, t("window.settings.local-index.d90")], [365, t("window.settings.local-index.d365")]];
    html += `<div class="ctl"><b>${esc(t("window.settings.local-index.days"))}</b><span class="right"><span class="seg" role="group" aria-label="${esc(t("window.settings.local-index.days"))}">${days.map(([d, words]) => `<button type="button" data-act="li-days" data-v="${d}" aria-pressed="${v.settings.days === d}">${esc(words)}</button>`).join("")}</span></span><small>${esc(t("window.settings.local-index.days-sub"))}</small></div>`;
  }
  const buttons = `${on ? `<button class="btn sm" type="button" data-act="li-update">${esc(t("window.settings.local-index.update"))}</button>` : ""}${v.total ? `<button class="btn sm bad" type="button" data-act="li-delete">${esc(t("window.settings.local-index.delete"))}</button>` : ""}`;
  return `${html}<div class="ctl" id="li-row"><b>${esc(t("window.settings.local-index.status"))}</b><span class="right acts">${buttons}</span><small>${esc(status(v))}</small></div>`;
}

async function change(part) {
  try { L.view = await api("local-index", part); } catch (error) { toast(error.message); }
  render();
}
async function update() {
  try { L.view = await api("local-index/update", {}); toast(t("window.settings.local-index.updated")); } catch (error) { toast(error.message); }
  render();
}
function askDelete() {
  openDlg({ title: t("window.settings.local-index.delete-title"), body: `<p data-css="margin:0">${esc(t("window.settings.local-index.delete-body"))}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.core.keep-it")}</button><button class="btn bad" type="button" data-act="li-delete-yes">${esc(t("window.settings.local-index.delete"))}</button>` });
}
async function remove() {
  try { L.view = await api("local-index/delete", {}); } catch (error) { toast(error.message); return; }
  closeDlg();
  toast(t("window.settings.local-index.deleted"));
  render();
}

let started = false;
export function initLocalIndex() {
  if (started) return;
  started = true;
  markLive([`sw:${SWITCH}`, "li-days", "li-update", "li-delete", "li-delete-yes"]);
  on("li-days", (el) => change({ days: Number(el.dataset.v) }));
  on("li-update", () => update());
  on("li-delete", () => askDelete());
  on("li-delete-yes", () => remove());
  document.addEventListener("change", (e) => { if (e.target?.id === SWITCH) change({ mode: e.target.checked ? "when-needed" : "off" }); });
}
