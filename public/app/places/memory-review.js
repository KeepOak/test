/* Pending memories are proposals, never saved facts. Each decision names its exact proposal. */
import { api } from "../core/api.js";
import { esc, renderNow } from "../core/dom.js";
import { refresh, activeId } from "../core/state.js";
import { toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let waiting = [];
let scope;
const deciding = new Set();

export function pendingMemories() {
  if (scope !== activeId()) return "";
  if (!waiting.length) return "";
  return `<section class="sec" aria-label="${t("memory.review.waiting")}"><h2>${t("memory.review.waiting")}</h2>${waiting.map((p) =>
    `<div class="prow" data-memory-proposal="${esc(p.id)}"><span class="grow"><b>${esc(p.text || p.card?.title || p.kind)}</b><small>${esc([p.source, p.note, p.card?.body].filter(Boolean).join(" · "))}</small></span><button type="button" class="btn ghost sm" data-act="memory-decide" data-id="${esc(p.id)}" data-decision="reject" ${deciding.has(p.id) ? "disabled" : ""}>${t("memory.review.reject")}</button><button type="button" class="btn sm" data-act="memory-decide" data-id="${esc(p.id)}" data-decision="accept" ${deciding.has(p.id) ? "disabled" : ""}>${t("memory.review.accept")}</button></div>`).join("")}</section>`;
}

export async function readPendingMemories() {
  const askedFor = activeId();
  const { proposals = [] } = await api("memory/proposals");
  if (askedFor !== activeId()) return;
  const fresh = proposals.filter((p) => p.status === "pending");
  if (scope === askedFor && JSON.stringify(fresh) === JSON.stringify(waiting)) return;
  scope = askedFor;
  waiting = fresh;
  renderNow();
}

async function decideMemory(el) {
  const { id, decision } = el.dataset;
  if (scope !== activeId() || !waiting.some((p) => p.id === id) || deciding.has(id) || !["accept", "reject"].includes(decision)) return;
  deciding.add(id);
  renderNow();
  try {
    await api(`memory/proposals/${encodeURIComponent(id)}/${decision}`, {});
    waiting = waiting.filter((p) => p.id !== id);
    await refresh();
    await readPendingMemories();
  } catch (error) { toast(error.message); }
  finally { deciding.delete(id); renderNow(); }
}

export function initMemoryReview() {
  markLive(["memory-decide"]);
  on("memory-decide", decideMemory);
}
