/* Browse recorded graph-flow steps. GETs only: inspecting a snapshot never starts or forks work. */
import { esc } from "../core/dom.js";
import { ownerHere, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, dialog } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let current = null;
const word = (key, args = {}) => t(`window.flow-history.${key}`, args);
const time = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value ?? "") : date.toLocaleString(); };
const here = (view) => current === view && ownerHere() && activeId() === view.scope && dialog()?.querySelector("#flow-history");

export function flowHistoryButton() {
  return ownerHere() ? `<button class="btn" type="button" data-act="tt15">${esc(word("title"))}</button>` : "";
}
function draw(view) {
  if (current !== view || !ownerHere() || activeId() !== view.scope) return;
  let content;
  if (view.loading) content = `<p class="hint">${esc(word("loading"))}</p>`;
  else if (view.error) content = `<p class="hint">${esc(view.error)}</p>`;
  else if (!view.detail) content = `<p class="hint">${esc(word("recent"))}</p>${view.runs.length ? view.runs.map((run) => `<div class="prow"><span class="grow"><b>${esc(run.flowId)}</b><small>${esc(run.status)} · ${esc(time(run.updatedAt))} · ${esc(word("count", { n: run.steps }))}</small></span><button class="btn sm" type="button" data-act="flow-history-run" data-id="${esc(run.runId)}">${esc(word("open"))}</button></div>`).join("") : `<p class="hint">${esc(word("empty"))}</p>`}`;
  else {
    const detail = view.detail, step = detail.steps.find((one) => one.seq === view.seq);
    content = `<button class="btn ghost sm" type="button" data-act="flow-history-back">${esc(word("back"))}</button><h3>${esc(detail.run.flowId)}</h3><p class="hint">${esc(detail.run.status)}${detail.forkedFrom ? ` · ${esc(word("copy", { id: detail.forkedFrom.runId, n: detail.forkedFrom.seq }))}` : ""}</p>
      <ol>${detail.steps.map((one) => `<li><button class="btn ghost sm" type="button" data-act="flow-history-step" data-seq="${one.seq}" aria-pressed="${one.seq === view.seq}">${esc(word("step", { n: one.seq }))} · ${esc(one.name)} · ${esc(time(one.at))}</button></li>`).join("")}</ol>
      ${step ? `<h3>${esc(word("snapshot", { n: step.seq }))}</h3>${step.state === null ? `<p class="hint">${esc(word("unavailable"))}</p>` : `<pre>${esc(JSON.stringify(step.state, null, 2))}</pre>`}` : `<p class="hint">${esc(word("no-steps"))}</p>`}`;
  }
  openDlg({ title: word("title"), wide: true, body: `<div id="flow-history"><p class="hint">${esc(word("inspect-only"))}</p>${content}</div>`, foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("first-run-steps.done"))}</button>` });
}
async function openHistory() {
  if (!ownerHere()) return;
  const view = { scope: activeId(), runs: [], detail: null, seq: null, loading: true, error: "" };
  current = view;
  draw(view);
  try {
    const result = await api("flows-boards/flows");
    if (!here(view)) return;
    view.runs = result.runs ?? [];
  } catch (error) { if (here(view)) view.error = error.message; }
  if (!here(view)) return;
  view.loading = false;
  draw(view);
}
async function openRun(id) {
  const view = current;
  if (!view || !here(view) || view.loading || !view.runs.some((run) => run.runId === id)) return;
  view.loading = true;
  view.error = "";
  draw(view);
  try {
    const result = await api(`flows-boards/flows/${encodeURIComponent(id)}/steps`);
    if (!here(view)) return;
    view.detail = result;
    view.seq = result.steps?.at(-1)?.seq ?? null;
  } catch (error) { if (here(view)) view.error = error.message; }
  if (!here(view)) return;
  view.loading = false;
  draw(view);
}
export function initFlowHistory() {
  markLive(["tt15", "flow-history-run", "flow-history-step", "flow-history-back"]);
  on("tt15", openHistory);
  on("flow-history-run", (el) => openRun(el.dataset.id));
  on("flow-history-step", (el) => {
    const view = current, seq = Number(el.dataset.seq);
    if (!view || !here(view) || view.loading || !view.detail?.steps.some((step) => step.seq === seq)) return;
    view.seq = seq;
    draw(view);
  });
  on("flow-history-back", () => {
    if (!current || !here(current) || current.loading) return;
    current.detail = null;
    current.error = "";
    draw(current);
  });
}
