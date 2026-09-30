import { esc } from "../core/dom.js";
import { ownerHere, activeId, S } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let generation = 0, saving = false;
const dollars = (value) => value == null ? t("routinecost.unknown") : `$${value.toFixed(4)}`;
const row = (key, value) => `<div class="prow"><span class="grow">${esc(t(key))}</span><b>${esc(value)}</b></div>`;
export async function openRoutineUsage(el) {
  if (!ownerHere()) return;
  const id = el.dataset.id, ticket = ++generation, profile = activeId(), view = S.view, before = dialog();
  try {
    const info = await api(`schedules/${encodeURIComponent(id)}/usage`);
    if (ticket !== generation || !ownerHere() || activeId() !== profile || S.view !== view || dialog() !== before) return;
    const body = `<div id="routine-cost" data-id="${esc(id)}" data-profile="${esc(profile ?? "")}"><p>${esc(t("routinecost.period", { month: info.month }))}</p>`
      + row("routinecost.turns", info.turns) + row("routinecost.tasks", info.tasks) + row("routinecost.calls", info.modelCalls)
      + row("routinecost.tokens", info.tokens) + row("routinecost.estimate", dollars(info.estimatedModelDollars))
      + row("routinecost.other", dollars(info.recordedSpendDollars)) + row("routinecost.unpriced", info.unpricedCalls)
      + `<p>${esc(t("routinecost.note"))}</p>${info.capped || info.legacyTurns ? `<p>${esc(t("routinecost.incomplete"))}</p>` : ""}`
      + `<div class="field"><label for="routine-budget">${esc(t("routinecost.limit"))}</label><input class="inp" type="number" id="routine-budget" min="0.01" max="100000" step="0.01" value="${info.budget.monthlyEstimatedDollars ?? ""}"><small>${esc(t("routinecost.help"))}</small></div></div>`;
    openDlg({ title: t("routinecost.title"), body, foot: `<button class="btn sm" type="button" data-act="dlg-close">${esc(t("delight.ach.close"))}</button><button class="btn sm" type="button" data-act="routine-budget-save">${esc(t("action.save"))}</button>` });
  } catch (error) { if (ownerHere() && activeId() === profile && S.view === view) toast(error.message); }
}
async function save(el) {
  const box = document.getElementById("routine-cost"), input = document.getElementById("routine-budget");
  if (!box || !input || saving || !ownerHere() || box.dataset.profile !== String(activeId() ?? "")) return;
  if (!input.checkValidity()) { input.reportValidity(); return; }
  const monthlyEstimatedDollars = input.value.trim() ? Number(input.value) : null;
  saving = true; el.disabled = true;
  try {
    await api(`schedules/${encodeURIComponent(box.dataset.id)}/budget`, { monthlyEstimatedDollars });
    if (ownerHere() && document.contains(box) && box.dataset.profile === String(activeId() ?? "")) { closeDlg(); toast(t("routinecost.saved")); }
  } catch (error) { if (ownerHere() && document.contains(box) && box.dataset.profile === String(activeId() ?? "")) toast(error.message); }
  finally { saving = false; el.disabled = false; }
}
export function initRoutineUsage() {
  markLive(["routine-cost", "routine-budget-save"]);
  on("routine-cost", (el) => openRoutineUsage(el));
  on("routine-budget-save", (el) => save(el));
}
