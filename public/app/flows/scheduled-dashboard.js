import { esc } from "../core/dom.js";
import { ownerHere, activeId, S } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let generation = 0;
let exportPage = null;
let refreshTimer = null;
const stopRefresh = () => { clearTimeout(refreshTimer); refreshTimer = null; };
const allowed = () => ownerHere() && !document.getElementById("app")?.classList.contains("locked-b17");
async function open(el) {
  if (!allowed()) return;
  stopRefresh();
  exportPage = null;
  const id = el.dataset.id, ticket = ++generation, profile = activeId(), view = S.view, before = dialog();
  try {
    const result = await api(`schedules/${encodeURIComponent(id)}/dashboard`);
    if (ticket !== generation || !allowed() || activeId() !== profile || S.view !== view || dialog() !== before) return;
    if (!result.html) { toast(result.error || t("scheduleddash.pending")); return; }
    const box = openDlg({ title: t("scheduleddash.title"), wide: true,
      body: `<p>${esc(t("scheduleddash.note"))}</p><iframe id="schedule-dashboard-frame" title="${esc(t("scheduleddash.title"))}" sandbox="" referrerpolicy="no-referrer" width="100%" height="480"></iframe>`,
      foot: `<button class="btn sm" type="button" data-act="schedule-dashboard-export" data-format="html">${esc(t("scheduleddash.export-html"))}</button><button class="btn sm" type="button" data-act="schedule-dashboard-export" data-format="json">${esc(t("scheduleddash.export-json"))}</button><button class="btn sm" type="button" data-act="schedule-dashboard" data-id="${esc(id)}">${esc(t("scheduleddash.refresh"))}</button><button class="btn sm" type="button" data-act="dlg-close">${esc(t("delight.ach.close"))}</button>` });
    box.querySelector("#schedule-dashboard-frame").srcdoc = result.html;
    exportPage = { box, profile, view, id, html: result.html, json: result.exportJson };
    refreshTimer = setTimeout(() => refreshDashboard(exportPage), 15000);
  } catch (error) { if (ticket === generation && allowed() && activeId() === profile && S.view === view) toast(error.message); }
}
const currentPage = (page) => page && exportPage === page && allowed()
  && activeId() === page.profile && S.view === page.view && dialog() === page.box;
async function refreshDashboard(page) {
  refreshTimer = null;
  if (!currentPage(page)) { if (exportPage === page) exportPage = null; return; }
  try {
    if (!document.hidden) {
      const result = await api(`schedules/${encodeURIComponent(page.id)}/dashboard`);
      if (!currentPage(page)) return;
      if (!result.html) { exportPage = null; return; }
      if (result.html !== page.html) page.box.querySelector("#schedule-dashboard-frame").srcdoc = result.html;
      page.html = result.html;
      page.json = result.exportJson;
    }
  } catch {
    // A failed read keeps the displayed snapshot; it does not rerun the schedule.
  }
  if (currentPage(page)) refreshTimer = setTimeout(() => refreshDashboard(page), 15000);
}
function exportDashboard(el) {
  const page = exportPage, format = el.dataset.format;
  if (!page || !allowed() || activeId() !== page.profile || S.view !== page.view || dialog() !== page.box) {
    exportPage = null;
    return;
  }
  if (format !== "html" && format !== "json") return;
  const content = page[format];
  if (typeof content !== "string") return;
  const url = URL.createObjectURL(new Blob([content], { type: format === "html" ? "text/html;charset=utf-8" : "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `branch-dashboard-${page.id}.${format}` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function initScheduledDashboard() {
  markLive(["schedule-dashboard", "schedule-dashboard-export"]);
  on("schedule-dashboard", open);
  on("schedule-dashboard-export", exportDashboard);
}
