/* Settings › Advanced › "From now on" for a specialist: a standing instruction kept by one Trunk. The engine keeps it
   (POST /api/autonomy/instructions { text, scope: "specialist:trunk:<id>" }) and gives it to every later task of that
   Trunk only (src/autonomy/instructions.ts forTask). Typed here by the owner, it is the owner's own yes; the same dialog
   lists every one a Trunk keeps, each with Remove (POST /api/autonomy/instructions/remove), so none is ever kept out of
   sight. A household person is refused by the engine, as with every owner setting. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
import { gsel } from "../core/gsel.js";
import { viewFence } from "../core/view-fence.js";
import { t } from "../../i18n.js";

const W = (key, vars) => t(`window.settings.advanced.${key}`, vars);
const prefix = "specialist:trunk:";
const trunkName = (scope) => E.trunks.find((trunk) => prefix + trunk.id === scope)?.name ?? scope.slice(prefix.length);

function kept(list) {
  const rows = list.filter((item) => item.scope.startsWith(prefix)).map((item) =>
    `<div class="prow"><span class="grow"><b>${esc(item.text)}</b><small>${esc(trunkName(item.scope))}</small></span><button class="btn ghost sm" type="button" data-act="ad-fno-rm" data-id="${esc(item.id)}">${esc(W("fno-remove"))}</button></div>`);
  return rows.length ? `<div class="rows">${rows.join("")}</div>` : "";
}

async function openOrder() {
  const still = viewFence("ad-fno");
  let list = [];
  try { list = (await api("autonomy/instructions")).instructions ?? []; } catch (error) { if (still()) toast(error.message); return; }
  if (!still()) return; // closed, replaced, another person or locked while the list was read: nothing is shown late
  const title = W("from-now-on-for-a-specialist");
  if (!E.trunks.length) { openDlg({ title, body: `<p class="lead-b17">${esc(W("fno-none"))}</p>${kept(list)}` }); return; }
  const pick = gsel({ id: "fno-trunk", label: W("fno-trunk"), options: E.trunks.map((trunk) => [trunk.id, trunk.name]) });
  openDlg({ title, body: `<p class="lead-b17">${esc(W("fno-lead"))}</p>${kept(list)}
      <div class="field"><label>${esc(W("fno-trunk"))}</label>${pick}</div>
      <div class="field"><label for="fno-text">${esc(W("fno-text"))}</label><input class="inp" id="fno-text" maxlength="300" autocomplete="off"></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="ad-fno-save">${esc(W("fno-keep"))}</button>` });
}

async function saveOrder() {
  const trunk = document.getElementById("fno-trunk")?.value ?? "", text = (document.getElementById("fno-text")?.value ?? "").trim();
  if (!trunk || !text) return;
  try { await api("autonomy/instructions", { text, scope: prefix + trunk }); } catch (error) { toast(error.message); return; }
  closeDlg();
  toast(W("fno-kept", { name: trunkName(prefix + trunk) }));
}

async function removeOrder(el) {
  try { await api("autonomy/instructions/remove", { id: el.dataset.id }); } catch (error) { toast(error.message); return; }
  await openOrder();
}

export function initSpecialistOrder() {
  on("ad-fno", () => openOrder());
  on("ad-fno-save", () => saveOrder());
  on("ad-fno-rm", (el) => removeOrder(el));
}
export const specialistOrderLive = ["ad-fno", "ad-fno-save", "ad-fno-rm", "sw:fno-trunk", "sw:fno-text"];
