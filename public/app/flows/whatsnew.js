/* What's new (Guide › What's new, and Settings › Updates › What's new): the notes the engine ships for the installed
   version (GET /api/release-notes), each a row that opens where it lives. A row runs its action only when that control
   is live in this window; otherwise it is greyed out, so a note can never open something that is not ready. */

import { esc } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on, run, has } from "../core/actions.js";
import { markLive, isLive } from "../core/features.js";
import { t } from "../../i18n.js";

const dataAttrs = (data) => Object.entries(data ?? {}).map(([k, v]) => `data-${esc(k)}="${esc(v)}"`).join(" ");
/* A note whose place is not live yet carries its own action, so it is greyed out like that control. */
const ready = (act) => isLive(act) && has(act);
const row = (n) => `<button type="button" class="new-row13" data-act="${ready(n.act) ? "new13-go" : esc(n.act)}" data-a="${esc(n.act)}" ${dataAttrs(n.data)}><span class="ico-tile">${ic(n.icon, "s")}</span><span class="grow"><b>${esc(n.title)}</b><small>${esc(n.text)}</small></span>${ic("chev", "s")}</button>`;

async function openWhatsNew() {
  closePop();
  let notes;
  try { notes = await api("release-notes"); } catch (error) { toast(error.message); return; }
  openDlg({ title: t("window.settings.updates.whats-new"), wide: true,
    body: `<p class="hint" data-css="margin:0 0 10px">${t("window.flows.whatsnew.lede")}</p><div class="new13">${(notes.items ?? []).map(row).join("")}</div>` });
}

function go(el) {
  const act = el.dataset.a;
  closeDlg();
  if (ready(act)) run(act, el);
}

export function init() {
  markLive(["whatsnew13", "new13-go"]);
  on("whatsnew13", () => openWhatsNew());
  on("new13-go", (el) => go(el));
}
