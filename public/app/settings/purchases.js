import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";

const root = "personal/purchases", grants = new Map();
const field = (id) => document.getElementById(`purchase-${id}`);
async function show() {
  if (!ownerHere()) return;
  try {
    const got = await api(root), s = got.settings;
    if (!ownerHere()) return;
    openDlg({ title: "Exact purchases · Stripe Link", wide: true, body: `<p>Off by default. US Link account, owner-selected wallet payment method and named Link access-token secret required. Supported: single Stripe MPP charge GET endpoints, USD cents, at most $1,000. No cards, checkout forms, subscriptions or shipping. Quotes are untrusted price challenges, not verified invoice totals.</p>
      <label><input id="purchase-enabled" type="checkbox" ${s.enabled ? "checked" : ""}>Enable purchases</label>
      <label><input id="purchase-free" type="checkbox" ${s.freeWithoutMoneyPrompt ? "checked" : ""}>Zero amount: no additional money prompt; retain all write/security gates. Paid: always exact one-time owner authorization.</label>
      <label>Secret name (not its value)<input class="inp" id="purchase-secret" value="${esc(s.secretName)}"></label>
      <label>Link payment-method ID<input class="inp" id="purchase-method" value="${esc(s.paymentMethodId)}"></label>
      <label>Allowed exact HTTPS seller origins (one per line)<textarea class="inp" id="purchase-origins">${esc(s.origins.join("\n"))}</textarea></label>
      <label><input id="purchase-ack" type="checkbox">I enable single-use Stripe Link USD purchases and understand uncertain failures must be inspected before retry.</label>
      <button class="btn" data-act="purchase-save">Save purchase settings</button><hr>
      <label>Exact GET endpoint (no query)<input class="inp" id="purchase-url"></label><label>Item label<input class="inp" id="purchase-item" maxlength="200"></label><label>Seller label<input class="inp" id="purchase-seller" maxlength="100"></label>
      <button class="btn" data-act="purchase-quote">Get quote</button>
      ${got.quotes.map((q) => `<article><h3>${esc(q.seller)}: ${esc(q.item)}</h3><p>${q.amountMinor} USD cents · ${esc(q.url)} · Expires ${esc(q.expiresAt)}</p><p>${esc(q.note)}</p>
        <button class="btn" data-act="purchase-authorize" data-v="${esc(q.id)}">Authorize this exact amount once</button>
        ${grants.has(q.id) ? `<button class="btn" data-act="purchase-spend" data-v="${esc(q.id)}">Submit authorized purchase</button>` : ""}</article>`).join("")}
      <h3>Receipts and pending requests</h3><p>Payment evidence, merchant response and fulfilment are separate. No automatic retry.</p>
      ${got.receipts.map((r) => `<article><b>${esc(r.seller)}: ${esc(r.item)}</b><p>${esc(r.state)} · Requested ${esc(r.amountMinor)} ${esc(r.currency)} cents · Charged ${esc(r.chargedAmount ?? "unknown")} ${esc(r.chargedCurrency ?? "")}</p>
        <small>${esc(r.requestId ?? "")} · Invoice total ${esc(r.invoiceTotal)} · Delivery ${esc(r.delivery)}</small>
        ${r.approvalURL ? `<p><a href="${esc(r.approvalURL)}" target="_blank" rel="noopener noreferrer">Open Link approval</a></p>` : ""}
        ${got.pending.includes(r.requestId) ? `<button class="btn" data-act="purchase-complete" data-v="${esc(r.requestId)}">Complete exact request after Link approval</button>` : ""}</article>`).join("")}` });
  } catch (error) { toast(error.message); }
}
async function post(path, value) {
  if (!ownerHere()) return;
  try { const got = await api(`${root}/${path}`, value); if (ownerHere()) await show(); return got; }
  catch (error) { toast(error.message); }
}
export function initPurchases() {
  markLive(["purchases", "purchase-save", "purchase-quote", "purchase-authorize", "purchase-spend", "purchase-complete"]);
  on("purchases", show);
  on("purchase-save", async () => {
    if (!ownerHere()) return;
    const enabled = field("enabled")?.checked;
    if (enabled && !field("ack")?.checked) { toast("Acknowledge the exact purchase scope first."); return; }
    try { await api(root, { enabled, freeWithoutMoneyPrompt: field("free")?.checked, secretName: field("secret")?.value,
      paymentMethodId: field("method")?.value, origins: field("origins")?.value.split("\n").map((x) => x.trim()).filter(Boolean),
      ...(enabled ? { acknowledge: "single-use Stripe Link USD purchases" } : {}) }); grants.clear(); await show(); }
    catch (error) { toast(error.message); }
  });
  on("purchase-quote", () => post("quote", { url: field("url")?.value, item: field("item")?.value, seller: field("seller")?.value }));
  on("purchase-authorize", async (el) => {
    if (!ownerHere()) return;
    try { const got = await api(`${root}/authorize`, { quoteId: el.dataset.v }); if (!ownerHere()) return; grants.set(el.dataset.v, got.authorizationId); await show(); }
    catch (error) { toast(error.message); }
  });
  on("purchase-spend", (el) => { const authorizationId = grants.get(el.dataset.v); grants.delete(el.dataset.v); return post("spend", { quoteId: el.dataset.v, authorizationId }); });
  on("purchase-complete", (el) => post("complete", { requestId: el.dataset.v }));
}
