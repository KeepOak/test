import { esc } from "../core/dom.js";
import { ownerHere, activeId, S } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let generation = 0;
const allowed = () => ownerHere() && !document.getElementById("app")?.classList.contains("locked-b17");
async function open(el) {
  if (!allowed()) return;
  const id = el.dataset.id, ticket = ++generation, profile = activeId(), view = S.view, before = dialog();
  try {
    const result = await api(`schedules/${encodeURIComponent(id)}/dashboard`);
    if (ticket !== generation || !allowed() || activeId() !== profile || S.view !== view || dialog() !== before) return;
    if (!result.html) { toast(result.error || t("scheduleddash.pending")); return; }
    const box = openDlg({ title: t("scheduleddash.title"), wide: true,
      body: `<p>${esc(t("scheduleddash.note"))}</p><iframe id="schedule-dashboard-frame" title="${esc(t("scheduleddash.title"))}" sandbox="" referrerpolicy="no-referrer" width="100%" height="480"></iframe>`,
      foot: `<button class="btn sm" type="button" data-act="schedule-dashboard" data-id="${esc(id)}">${esc(t("scheduleddash.refresh"))}</button><button class="btn sm" type="button" data-act="dlg-close">${esc(t("delight.ach.close"))}</button>` });
    box.querySelector("#schedule-dashboard-frame").srcdoc = result.html;
  } catch (error) { if (ticket === generation && allowed() && activeId() === profile && S.view === view) toast(error.message); }
}
export function initScheduledDashboard() {
  markLive(["schedule-dashboard"]);
  on("schedule-dashboard", open);
}
