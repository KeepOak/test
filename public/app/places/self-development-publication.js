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
  return publications.filter((entry) => entry.state !== "published" && entry.state !== "cancelled").map((entry) => {
    const retry = entry.state === "waiting" ? `<p class="hint">${t("sourcePublication.next", { when: esc(new Date(entry.nextAttemptAt).toLocaleString()) })}</p>` : "";
    const cancel = entry.state === "waiting" || entry.state === "sending" || entry.state === "blocked"
      ? `<button class="btn" type="button" data-act="source-publication-cancel" data-id="${esc(entry.id)}">${t("sourcePublication.cancel")}</button>` : "";
    const retryButton = entry.state === "blocked" ? `<button class="btn" type="button" data-act="source-publication-retry" data-id="${esc(entry.id)}">${t("sourcePublication.retry")}</button>` : "";
    return `<section class="card"><b>${esc(label(entry.state))}</b><p>${esc(entry.repository)} · ${esc(entry.branch)}</p><p>${esc(entry.reason ?? t("sourcePublication.sendingDetail"))}</p>${retry}${cancel}${retryButton}</section>`;
  }).join("");
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
