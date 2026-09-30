/* Owner-facing readout of the existing task-result receipts (#992). Reading never asks GitHub or a model. */
import { api } from "../core/api.js";
import { esc } from "../core/dom.js";
import { activeId, ownerHere } from "../core/state.js";
import { t, language } from "../../i18n.js";

const words = (key, vars) => t(`window.chat.source-metrics.${key}`, vars);
const unknown = () => words("unknown");
const list = (value) => Array.isArray(value) ? value : [];
const pair = (title, value) => `<dt>${esc(title)}</dt><dd>${esc(value)}</dd>`;
const money = (value) => typeof value === "number" && Number.isFinite(value)
  ? new Intl.NumberFormat(language(), { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value) : unknown();
const duration = (ms) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return unknown();
  const unit = ms >= 3_600_000 ? "hours" : ms >= 60_000 ? "minutes" : "seconds";
  const divisor = unit === "hours" ? 3_600_000 : unit === "minutes" ? 60_000 : 1000;
  return words(unit, { value: new Intl.NumberFormat(language(), { maximumFractionDigits: 1 }).format(ms / divisor) });
};
function requestLabel(request) {
  // Only a recorded GitHub link matching this exact receipt is clickable; other addresses remain plain identifiers.
  try {
    const url = new URL(request.address);
    if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password &&
        url.pathname === `/${request.repository}/pull/${request.number}`)
      return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(request.key)}</a>`;
  } catch { /* no matching address */ }
  return esc(request.key);
}

export async function readSourceMetrics(runId) {
  if (!ownerHere()) return null;
  const scope = activeId();
  try {
    const result = await api(`runs/${encodeURIComponent(runId)}/result`);
    return ownerHere() && activeId() === scope && result.runId === runId ? result : null;
  } catch { return ownerHere() && activeId() === scope ? { unavailable: true } : null; }
}
export function sourceMetricsReadout(result) {
  if (!ownerHere() || !result) return "";
  if (result.unavailable) return `<p class="hint">${esc(words("unavailable"))}</p>`;
  const metrics = result.selfDevelopmentMetrics;
  if (!metrics || !result.ownChange) return "";
  const requests = list(result.pullRequests).filter((request) => /\/branch-agent$/i.test(request.repository ?? ""));
  const rows = requests.map((request) => {
    const measured = list(metrics.pullRequests).find((entry) => entry.key === request.key);
    const merged = request.state === "merged" && request.mergeEvidence;
    return `<section class="sec"><b>${requestLabel(request)}</b><dl class="kv">${
      pair(words("state"), merged ? words("merged") : words("opened")) +
      pair(words("time-to-pr"), duration(measured?.timeToPrMs)) +
      pair(words("time-to-merge"), duration(measured?.timeToMergeObservedMs)) +
      (merged ? pair(words("evidence"), words(`evidence-${request.mergeEvidence.replaceAll(" ", "-")}`)) : "")
    }</dl></section>`;
  }).join("");
  const reviews = metrics.reviews ?? {}, cost = metrics.cost ?? {};
  const counts = words("cost-counts", { completed: cost.completedCalls ?? 0, unpriced: cost.unpricedCalls ?? 0,
    incomplete: cost.incompleteCalls ?? 0, estimated: cost.estimatedCalls ?? 0 });
  return `<section class="sec"><h2>${esc(words("title"))}</h2><p class="hint">${esc(words("timing-note"))}</p>${rows || `<p class="hint">${esc(words("no-pr"))}</p>`}<dl class="kv">${
    pair(words("review-rounds"), String(reviews.recorded ?? 0)) +
    pair(words("review-history"), reviews.complete === true ? words("complete") : words("incomplete")) +
    pair(words("review-basis"), words("review-basis-note")) +
    pair(words("cost-total"), money(cost.amount)) +
    pair(words("cost-subtotal"), money(cost.pricedSubtotal)) +
    pair(words("call-coverage"), counts) +
    pair(words("release"), unknown())
  }</dl><p class="hint">${esc(words("cost-note"))}</p></section>`;
}
