/* Read-only receipts from the owner's existing delivery ledger; no retries or remote sends here. */
import { esc } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

export function deliveryReadout(receipts, nameOf) {
  const rows = Array.isArray(receipts) ? receipts.slice(0, 50).map(receipt => {
    if (!["delivered", "queued", "failed"].includes(receipt.outcome)) return "";
    const at = new Date(receipt.updatedAt);
    const counts = t("window.chat-delivery.parts", { delivered: receipt.delivered, queued: receipt.queued, failed: receipt.failed });
    return `<div class="prow"><span class="grow"><b>${esc(nameOf(receipt.channel))} · ${esc(receipt.chatId)}</b><small>${esc(counts)}</small></span>
      <span class="pill ${receipt.outcome === "delivered" ? "done" : receipt.outcome === "failed" ? "bad" : "warn"}">${esc(t(`window.chat-delivery.${receipt.outcome}`))}</span>
      <time datetime="${esc(receipt.updatedAt)}">${esc(Number.isFinite(at.getTime()) ? at.toLocaleString() : "")}</time></div>`;
  }).join("") : "";
  return `<section class="sec x15-sec"><h2>${esc(t("window.chat-delivery.title"))}</h2><p class="hint">${esc(t("window.chat-delivery.hint"))}</p>
    <div class="acts"><button class="btn sm" type="button" data-act="chat-delivery-refresh">${esc(t("window.chat-delivery.refresh"))}</button></div>
    ${rows || `<p class="empty">${esc(t(receipts === null ? "window.chat-delivery.unavailable" : "window.chat-delivery.empty"))}</p>`}</section>`;
}
export function initDeliveryReadout(refresh) {
  let busy = false;
  markLive(["chat-delivery-refresh"]);
  on("chat-delivery-refresh", async () => {
    if (busy) return;
    busy = true;
    try { await refresh(); } finally { busy = false; }
  });
}
