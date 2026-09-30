/* The measured learning history, read from each person's own Seasons journal. */
import { api } from "../core/api.js";
import { activeId } from "../core/state.js";
import { esc, renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let history = null, scope;
let failed = false;
const busy = new Set();
const button = (action, id, label) => `<button class="btn ghost sm" type="button" data-act="seasons-change" data-change="${action}" data-id="${esc(id)}" ${busy.has(id) ? "disabled" : ""}>${label}</button>`;
const proofWords = (proof) => proof ? t("seasons.proof", { before: (proof.without.mean * 100).toFixed(0), after: (proof.with.mean * 100).toFixed(0), gain: (proof.gain * 100).toFixed(1), tasks: proof.tasks }) : "";

export function seasonsTab() {
  if (scope !== activeId() || !history) return "";
  const { nights, garden, morning } = history;
  const welcome = morning ? `<div class="status"><div><b>${t("seasons.morning")}</b><p>${esc(morning.kept.map((p) => p.text).join(" · "))}</p><small>${t("seasons.waiting", { count: morning.staged })}</small></div>${button("morning/seen", morning.night, t("first-run-steps.done"))}</div>` : "";
  const nightRows = nights.map((n) => `<div class="prow"><span class="grow"><b>${esc(n.night)} · ${esc(n.status)}</b><small>${esc([n.model, n.data.reason].filter(Boolean).join(" · "))}</small><p>${t("seasons.night-summary", { read: n.data.read, kept: n.data.deep.promoted.length, waiting: n.data.deep.staged.length })}</p></span>${n.status !== "running" && n.status !== "undone" ? button("rings/undo", n.night, t("seasons.undo")) : ""}</div>`).join("");
  return `${welcome}<section class="sec"><h2>Rings</h2>${nightRows || `<p>${t("seasons.no-nights")}</p>`}</section>${candidateRows(history.candidates)}${garden ? gardenRows(garden) : ""}${history.buds ? budRows(history.buds) : ""}`;
}

export function draw() {
  const content = scope === activeId() && history ? seasonsTab()
    : `<p role="status">${t(failed ? "seasons.load-failed" : "seasons.loading")}</p>`;
  return `<main class="main enter11" id="main"><div class="scroll"><div class="place"><h1>${t("place.seasons")}</h1><p class="lede">${t("seasons.intro")}</p>${content}</div></div></main>`;
}

export async function after() {
  try { await readSeasons(); }
  catch (error) { if (!failed) { toast(error.message); failed = true; renderNow(); } }
}

function candidateRows(candidates = []) {
  const rows = candidates.map((c) => {
    const action = ["vetoed", "undone"].includes(c.status) ? button("rings/keep", c.id, t("seasons.keep"))
      : ["pending", "promoted", "staged"].includes(c.status) ? button("rings/veto", c.id, t("seasons.veto")) : "";
    return `<div class="prow"><span class="grow"><b>${esc(c.text)}</b><small>${esc(c.status)} · ${t("seasons.candidate-proof", { score: (c.score * 100).toFixed(0), mentions: c.mentions, conversations: c.conversations })}</small></span>${action}</div>`;
  }).join("");
  return rows ? `<section class="sec"><h2>${t("seasons.candidates")}</h2>${rows}</section>` : "";
}

function budRows(buds) {
  const rows = buds.map((b) => {
    const connectors = b.stage === "connector-review" && !b.serverId ? b.connectors.map((c) => `<div class="prow"><span class="grow"><b>${esc(c.name)}</b><small>${esc(c.description)} · ${esc(c.needs)}</small></span><button type="button" class="btn sm" data-act="seasons-change" data-change="budding/connector" data-id="${esc(b.id)}" data-connector="${esc(c.id)}">${t("seasons.connector-approve")}</button></div>`).join("") : "";
    const next = b.stage === "connector-review" && !b.serverId ? button("budding/decline-connector", b.id, t("seasons.next-rung"))
      : b.stage === "sandbox-ready" && b.error ? button("budding/branch", b.id, t("seasons.branch-review"))
      : b.stage === "branch-review" && !b.branchConfirmed ? button("budding/branch-arrived", b.id, t("seasons.branch-arrived")) : "";
    return `<div class="sec"><b>${esc(b.task)}</b><p>${esc(b.stage)} · ${esc(b.gap)}</p><small>${esc(b.error || b.output || "")}</small>${connectors}${next}</div>`;
  }).join("");
  return `<section class="sec"><h2>Budding</h2><p>${t("seasons.budding-order")}</p>${rows}</section>`;
}

function gardenRows(garden) {
  const seeds = garden.seeds.map((s) => `<div class="prow"><span class="grow"><b>${esc(s.name || s.trigger)} · ${esc(s.state || s.status)}</b><small>${esc(s.reason || "")}</small><p>${esc(proofWords(s.proofs.at(-1)))}</p></span>${s.status === "adopted" ? button("garden/prune", s.id, t("seasons.set-aside")) + button(s.pinned ? "garden/unpin" : "garden/pin", s.id, t(s.pinned ? "seasons.unpin" : "seasons.pin")) : ["archived", "rolled-back"].includes(s.status) ? button("garden/reroot", s.id, t("window.places.library.restore")) : ""}</div>`).join("");
  const ledger = garden.ledger.map((e) => `<div class="prow"><span class="grow"><b>${esc(e.name)} · ${esc(e.action)}</b><small>${esc([e.at, e.reason].filter(Boolean).join(" · "))}</small><p>${esc(proofWords(e.proof))}</p></span>${!e.undoneAt ? button("garden/undo", e.id, t("seasons.undo")) : `<small>${t("seasons.undone")}</small>`}</div>`).join("");
  return `<section class="sec"><h2>Gardener</h2><p>${t("seasons.context-budget", { cost: garden.indexCost, budget: garden.indexBudget })}</p>${seeds}</section><section class="sec"><h2>${t("seasons.changes")}</h2>${ledger}</section>`;
}

export async function readSeasons() {
  const askedFor = activeId();
  const fresh = await api("seasons");
  if (askedFor !== activeId()) return;
  if (!failed && scope === askedFor && JSON.stringify(fresh) === JSON.stringify(history)) return;
  scope = askedFor;
  history = fresh;
  failed = false;
  renderNow();
}

async function changeSeason(el) {
  const { id, change } = el.dataset;
  if (scope !== activeId() || busy.has(id) || !["morning/seen", "rings/undo", "rings/veto", "rings/keep", "garden/pin", "garden/unpin", "garden/prune", "garden/reroot", "garden/undo", "budding/connector", "budding/decline-connector", "budding/branch", "budding/branch-arrived"].includes(change)) return;
  busy.add(id); renderNow();
  try {
    const body = change === "rings/undo" || change === "morning/seen" ? { night: id }
      : change === "budding/connector" ? { id, connectorId: el.dataset.connector }
      : ["garden/pin", "garden/unpin"].includes(change) ? { id, pinned: change === "garden/pin" } : { id };
    await api(`seasons/${change === "garden/unpin" ? "garden/pin" : change}`, body);
    await readSeasons();
  } catch (error) { toast(error.message); }
  finally { busy.delete(id); renderNow(); }
}

export function initSeasons() {
  markLive(["seasons-change"]);
  on("seasons-change", changeSeason);
}

export const init = initSeasons;
