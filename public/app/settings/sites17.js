/* Settings › Computer & browser › The browser, more › Site skills (pass 17's siteb17), from the engine: the websites the
   owner's switched-on skills know about (GET /api/browser/site-skills: each skill's websites, its notes, the skill it came
   from and that skill's revision). "See N" opens them; Forget removes the skill the site came from, after a confirm that
   names it (POST /api/skills/<id>/remove { expectedRevision }, the same route Customize › Skills uses), and the list is
   read again. The row is the owner's: on a household profile it is drawn as before, without the button. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast, openDlg, closeDlg } from "../core/ui.js";
import { t } from "../../i18n.js";

const S = { sites: null };

export async function loadSites() {
  if (E.profiles?.isOwner === false) { S.sites = null; return; }
  S.sites = (await api("browser/site-skills").catch((error) => { toast(error.message); return null; }))?.sites ?? null;
}

/** The row: its words, and "See N" once the engine has said how many there are. */
export function siteRow() {
  const button = S.sites ? `<span class="right"><button class="btn sm" type="button" data-act="siteb17">${esc(t("window.settings.p17-permissions.see-count", { count: S.sites.length }))}</button></span>` : "";
  return `<div class="ctl"><b>${t("window.settings.computer.site-skills")}</b>${button}<small>${t("window.settings.computer.what-branch-learned-about-the-sites")}</small></div>`;
}

function siteDialog() {
  const rows = (S.sites ?? []).map((s) => `<div class="prow"><span class="ico-tile">${ic("globe", "s")}</span><span class="grow"><b>${esc(s.hosts.join(", "))}</b><small>${esc(s.notes || s.skill)}</small></span>${s.skillId ? `<button class="btn ghost sm" type="button" data-act="siteforgetb17" data-id="${esc(s.skillId)}">${esc(t("window.settings.computer.forget"))}</button>` : ""}</div>`).join("");
  openDlg({ title: t("window.settings.computer.site-skills"), body: `<p class="lead-b17">${t("window.settings.computer.what-branch-learned-about-the-sites")}</p><div class="rows">${rows || `<p class="empty">${esc(t("window.settings.computer.nothing-learned-yet"))}</p>`}</div>`,
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

/* Forget asks first, naming the skill; a yes removes it at the revision shown. */
function forget(el) {
  const site = (S.sites ?? []).find((s) => s.skillId === el.dataset.id);
  if (!site) return;
  if (!el.dataset.sure) {
    openDlg({ title: t("studio.remove.title", { name: site.skill }), body: "",
      foot: `<button class="btn ghost" type="button" data-act="siteb17">${t("first-run-steps.restore-no")}</button><button class="btn bad" type="button" data-act="siteforgetb17" data-id="${esc(site.skillId)}" data-sure="1">${esc(t("window.settings.computer.forget"))}</button>` });
    return;
  }
  el.disabled = true;
  api(`skills/${encodeURIComponent(site.skillId)}/remove`, { expectedRevision: site.revision })
    .then(async () => { closeDlg(); await loadSites(); siteDialog(); })
    .catch((error) => { el.disabled = false; toast(error.message); });
}

export function initSites(redraw) {
  markLive(["siteb17", "siteforgetb17"]);
  on("siteb17", async () => { await loadSites(); redraw(); siteDialog(); });
  on("siteforgetb17", (el) => forget(el));
}
