import { esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let publications = [];
const label = (state) => t(`sourcePublication.${state ?? "checked"}`);
export async function readSourcePublications() {
  const fresh = (await api("self-development/publications").catch(() => ({ publications }))).publications ?? [];
  const changed = JSON.stringify(publications) !== JSON.stringify(fresh);
  publications = fresh;
  return changed;
}
export function sourcePublicationCards() {
  const visible = publications.filter((entry) => entry.state !== "published" && entry.state !== "cancelled")
    .concat(publications.filter((entry) => entry.state === "published").slice(0, 20));
  return visible.map((entry) => {
    const retry = entry.state === "waiting" ? `<p class="hint">${t("sourcePublication.next", { when: esc(new Date(entry.nextAttemptAt).toLocaleString()) })}</p>` : "";
    const cancel = entry.state === "waiting" || entry.state === "sending" || entry.state === "blocked"
      ? `<button class="btn" type="button" data-act="source-publication-cancel" data-id="${esc(entry.id)}">${t("sourcePublication.cancel")}</button>` : "";
    const retryButton = entry.state === "blocked" ? `<button class="btn" type="button" data-act="source-publication-retry" data-id="${esc(entry.id)}">${t("sourcePublication.retry")}</button>` : "";
    const pr = Number.isSafeInteger(entry.rollout?.number) ? `#${entry.rollout.number}` : "";
    const rollout = entry.state === "published" ? rolloutReadout(entry.rollout) : "";
    const detail = entry.state === "published" ? t("sourceRollout.published") : entry.reason ?? t("sourcePublication.sendingDetail");
    return `<section class="card"><b>${esc(label(entry.state))}</b><p>${esc(entry.repository)}${esc(pr)} · ${esc(entry.branch)}</p><p>${esc(detail)}</p>${rollout}${retry}${cancel}${retryButton}</section>`;
  }).join("");
}
function rolloutReadout(receipt) {
  const state = ["merged", "running"].includes(receipt?.state) ? receipt.state : "unknown";
  const identity = (key, value) => value ? `<p class="hint">${esc(t(key))}: <code>${esc(value)}</code></p>` : "";
  const when = (key, value) => {
    const at = value ? new Date(value) : null;
    return at && Number.isFinite(at.getTime()) ? `<p class="hint">${esc(t(key))}: <time datetime="${esc(value)}">${esc(at.toLocaleString())}</time></p>` : "";
  };
  return `<p>${esc(t(`sourceRollout.${state}`))}</p>${identity("sourceRollout.reviewedHead", receipt?.reviewedHead)}${identity("sourceRollout.merge", receipt?.mergeSha)}${identity("sourceRollout.engine", receipt?.engineCommit)}${when("sourceRollout.confirmed", receipt?.mergeObservedAt)}${when("sourceRollout.observed", receipt?.observedAt)}<p class="hint">${esc(t("sourceRollout.localOnly"))}</p>`;
}
on("source-publication-cancel", async (el) => {
  el.disabled = true;
  try {
    await api("self-development/publications/cancel", { id: el.dataset.id });
    await readSourcePublications(); renderNow();
    toast(t("sourcePublication.cancelledDetail"));
  } catch (error) { el.disabled = false; toast(error.message); }
});
on("source-publication-retry", async (el) => {
  el.disabled = true;
  try {
    const result = await api("self-development/publications/retry", { id: el.dataset.id });
    await readSourcePublications(); renderNow();
    toast(result.publication?.reason ?? label(result.publication?.state));
  } catch (error) { toast(error.message); }
  finally { el.disabled = false; }
});
markLive(["source-publication-cancel", "source-publication-retry"]);
