import { esc, renderNow } from "../core/dom.js";
import { ownerHere, S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t, language } from "../../i18n.js";

let recap = null, lastRead = 0, reading = false, generation = 0, saving = false;
const here = () => ownerHere() && S.view === "overview";
function clear() { if (recap || reading) { generation += 1; recap = null; reading = false; lastRead = 0; } }
const hours = (minutes) => new Intl.NumberFormat(language(), { maximumFractionDigits: 1 }).format(minutes / 60);

export function recapTile() {
  if (!here()) { clear(); return ""; }
  if (!recap) return "";
  const estimate = recap.estimatedMinutesSaved === null ? t("recap.noEstimate")
    : t("recap.estimate", { hours: hours(recap.estimatedMinutesSaved), minutes: recap.settings.manualMinutesPerTask });
  const rows = recap.groups.map((group) => `<div class="ovs-act"><b>${esc(group.trunkId ? group.name : t("recap.other"))}</b><span class="ml">${group.completed}</span></div>`).join("");
  const value = recap.settings.manualMinutesPerTask ?? "";
  return `<section class="tile" data-recap><h2>${t("recap.title")}</h2><p>${t("recap.completed", { count: recap.trunkTasks })}</p>
    <p>${esc(estimate)}</p>${rows}${recap.capped ? `<p>${t("recap.capped", { count: recap.scanned })}</p>` : ""}
    <small>${t("recap.retained")}</small><details class="ovs-details"><summary>${t("recap.configure")}</summary>
    <label>${t("recap.minutes")} <input id="recap-minutes" data-recap-minutes type="number" min="0" max="1440" step="0.1" value="${esc(value)}"></label>
    <p>${t("recap.basis")}</p><button class="btn sm" type="button" data-act="recap-save"${saving ? " disabled" : ""}>${t("action.save")}</button>
    <button class="btn ghost sm" type="button" data-act="recap-clear"${saving ? " disabled" : ""}>${t("recap.clear")}</button></details></section>`;
}

export async function loadRecap() {
  if (!here()) { clear(); return false; }
  if (reading || saving || Date.now() - lastRead < 30_000) return false;
  const ticket = ++generation;
  reading = true;
  try {
    const data = await api("weekly-recap");
    if (ticket !== generation || !here()) return false;
    lastRead = Date.now();
    const changed = JSON.stringify(data) !== JSON.stringify(recap);
    recap = data;
    return changed;
  } catch {
    if (ticket !== generation) return false;
    const changed = recap !== null;
    recap = null; lastRead = Date.now();
    return changed;
  }
  finally { if (ticket === generation) reading = false; }
}

async function saveRecap(el, reset) {
  if (!here() || saving) return;
  const input = el.closest("[data-recap]")?.querySelector("[data-recap-minutes]");
  if (!reset && !input?.checkValidity()) { input?.reportValidity(); return; }
  const minutes = reset || input.value === "" ? null : Number(input.value);
  const ticket = ++generation;
  reading = false;
  saving = true;
  try {
    const data = await api("weekly-recap", { manualMinutesPerTask: minutes });
    if (ticket === generation && here()) { recap = data; lastRead = Date.now(); }
  } catch (error) { if (here()) toast(error.message); }
  finally { saving = false; if (here()) renderNow(); }
}

export function initRecap() {
  markLive(["sw:recap-minutes", "recap-save", "recap-clear"]);
  on("recap-save", (el) => saveRecap(el, false));
  on("recap-clear", (el) => saveRecap(el, true));
}
