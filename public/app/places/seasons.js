/* The measured learning history, read from each person's own Seasons journal. */
import { api } from "../core/api.js";
import { activeId } from "../core/state.js";
import { esc, renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let history = null, scope;
const busy = new Set();
const button = (action, id, label) => `<button class="btn ghost sm" type="button" data-act="seasons-change" data-change="${action}" data-id="${esc(id)}" ${busy.has(id) ? "disabled" : ""}>${label}</button>`;
const proofWords = (proof) => proof ? t("seasons.proof", { before: (proof.without.mean * 100).toFixed(0), after: (proof.with.mean * 100).toFixed(0), gain: (proof.gain * 100).toFixed(1), tasks: proof.tasks }) : "";

export function seasonsTab() {
  if (scope !== activeId() || !history) return "";
  const { nights, garden, morning } = history;
  const welcome = morning ? `<div class="status"><div><b>${t("seasons.morning")}</b><p>${esc(morning.kept.map((p) => p.text).join(" · "))}</p><small>${t("seasons.waiting", { count: morning.staged })}</small></div>${button("morning/seen", morning.night, t("first-run-steps.done"))}</div>` : "";
  const nightRows = nights.map((n) => `<div class="prow"><span class="grow"><b>${esc(n.night)} · ${esc(n.status)}</b><small>${esc([n.model, n.data.reason].filter(Boolean).join(" · "))}</small><p>${t("seasons.night-summary", { read: n.data.read, kept: n.data.deep.promoted.length, waiting: n.data.deep.staged.length })}</p></span>${n.status !== "running" && n.status !== "undone" ? button("rings/undo", n.night, t("seasons.undo")) : ""}</div>`).join("");
  return `${welcome}<section class="sec"><h2>Rings</h2>${nightRows || `<p>${t("seasons.no-nights")}</p>`}</section>${garden ? gardenRows(garden) : ""}`;
}

function gardenRows(garden) {
  const seeds = garden.seeds.map((s) => `<div class="prow"><span class="grow"><b>${esc(s.name || s.trigger)} · ${esc(s.state || s.status)}</b><small>${esc(s.reason || "")}</small><p>${esc(proofWords(s.proofs.at(-1)))}</p></span>${s.status === "adopted" ? button("garden/prune", s.id, t("seasons.set-aside")) : ["archived", "rolled-back"].includes(s.status) ? button("garden/reroot", s.id, t("window.places.library.restore")) : ""}</div>`).join("");
  const ledger = garden.ledger.map((e) => `<div class="prow"><span class="grow"><b>${esc(e.name)} · ${esc(e.action)}</b><small>${esc([e.at, e.reason].filter(Boolean).join(" · "))}</small><p>${esc(proofWords(e.proof))}</p></span>${!e.undoneAt ? button("garden/undo", e.id, t("seasons.undo")) : `<small>${t("seasons.undone")}</small>`}</div>`).join("");
  return `<section class="sec"><h2>Gardener</h2><p>${t("seasons.context-budget", { cost: garden.indexCost, budget: garden.indexBudget })}</p>${seeds}</section><section class="sec"><h2>${t("seasons.changes")}</h2>${ledger}</section>`;
}

export async function readSeasons() {
  const askedFor = activeId();
  const fresh = await api("seasons");
  if (askedFor !== activeId()) return;
  if (scope === askedFor && JSON.stringify(fresh) === JSON.stringify(history)) return;
  scope = askedFor;
  history = fresh;
  renderNow();
}

async function changeSeason(el) {
  const { id, change } = el.dataset;
  if (scope !== activeId() || busy.has(id) || !["morning/seen", "rings/undo", "garden/prune", "garden/reroot", "garden/undo"].includes(change)) return;
  busy.add(id); renderNow();
  try {
    await api(`seasons/${change}`, change === "rings/undo" || change === "morning/seen" ? { night: id } : { id });
    await readSeasons();
  } catch (error) { toast(error.message); }
  finally { busy.delete(id); renderNow(); }
}

export function initSeasons() {
  markLive(["seasons-change"]);
  on("seasons-change", changeSeason);
}
