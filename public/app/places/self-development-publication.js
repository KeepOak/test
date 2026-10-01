import { esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";
import { S, ownerHere, activeId } from "../core/state.js";

let publications = [], reading = 0;
const label = (state) => t(`sourcePublication.${state ?? "checked"}`);
/* The owner, the same person on the same page, with the window unlocked, as when a step began. */
function context() {
  const profile = activeId(), view = S.view;
  return () => ownerHere() && activeId() === profile && S.view === view && !document.getElementById("app")?.classList.contains("locked-b17");
}
/* Keeps the publications read only if this is the newest read and `still` (the caller's context, or the one when the
   read began) holds; a late answer after the lock, a person or page switch leaves the cards as they were. */
export async function readSourcePublications(still = context()) {
  const mine = ++reading;
  const fresh = (await api("self-development/publications").catch(() => ({ publications }))).publications ?? [];
  if (mine !== reading || !still()) return false;
  const changed = JSON.stringify(publications) !== JSON.stringify(fresh);
  publications = fresh;
  return changed;
}
export function sourcePublicationCards() {
  return publications.filter((entry) => entry.state !== "published" && entry.state !== "cancelled").map((entry) => {
    const retry = entry.state === "waiting" ? `<p class="hint">${t("sourcePublication.next", { when: esc(new Date(entry.nextAttemptAt).toLocaleString()) })}</p>` : "";
    const cancel = entry.state === "waiting" || entry.state === "sending" || entry.state === "blocked"
      ? `<button class="btn" type="button" data-act="source-publication-cancel" data-id="${esc(entry.id)}">${t("sourcePublication.cancel")}</button>` : "";
    const retryButton = entry.state === "blocked" ? `<button class="btn" type="button" data-act="source-publication-retry" data-id="${esc(entry.id)}">${t("sourcePublication.retry")}</button>` : "";
    return `<section class="card"><b>${esc(label(entry.state))}</b><p>${esc(entry.repository)} · ${esc(entry.branch)}</p><p>${esc(entry.reason ?? t("sourcePublication.sendingDetail"))}</p>${retry}${cancel}${retryButton}</section>`;
  }).join("");
}
/* Cancel and Retry act at once; the cards are read again and drawn, and the result or error said, only in the same context. */
on("source-publication-cancel", async (el) => {
  const still = context();
  el.disabled = true;
  try {
    await api("self-development/publications/cancel", { id: el.dataset.id });
    if (!still()) return;
    await readSourcePublications(still);
    if (!still()) return;
    renderNow();
    toast(t("sourcePublication.cancelledDetail"));
  } catch (error) { if (still()) { el.disabled = false; toast(error.message); } }
});
on("source-publication-retry", async (el) => {
  const still = context();
  el.disabled = true;
  try {
    const result = await api("self-development/publications/retry", { id: el.dataset.id });
    if (!still()) return;
    await readSourcePublications(still);
    if (!still()) return;
    renderNow();
    toast(result.publication?.reason ?? label(result.publication?.state));
  } catch (error) { if (still()) toast(error.message); }
  finally { el.disabled = false; }
});
markLive(["source-publication-cancel", "source-publication-retry"]);
