import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { S, E } from "../core/state.js";
import { toast } from "../core/ui.js";
let state = null, initialized = false;
export async function loadTelephone() { if (E.profiles?.isOwner === false) return; try { state = await api("telephone"); } catch (error) { state = { problem: error.message }; } render(); }
export function initTelephone() {
  if (initialized) return; initialized = true;
  markLive(["call17d", ...["save", "propose", "callme", "approve", "cancel", "recover", "refresh"].map((x) => "telephone-" + x), ...["enabled", "account", "token", "from", "own", "origin", "pin", "direction", "to", "purpose", "seconds", "carrier", "tokens", "recovery-sid"].map((x) => "sw:telephone-" + x)]);
  const field = (id) => document.getElementById("telephone-" + id);
  const action = async (work) => { try { await work(); await loadTelephone(); } catch (error) { toast(error.message); } };
  on("call17d", () => { S.view = "settings"; S.setPage = "voice"; void loadTelephone(); });
  on("telephone-save", () => action(() => api("telephone", { enabled: field("enabled").checked, accountSid: field("account").value.trim(), authTokenSecret: field("token").value.trim(), from: field("from").value.trim(), ownNumber: field("own").value.trim(), publicOrigin: field("origin").value.trim(), pinSecret: field("pin").value.trim() })));
  on("telephone-propose", () => action(() => api("telephone/propose", { direction: field("direction").value, to: field("to").value.trim(), purpose: field("purpose").value.trim(), maxSeconds: Number(field("seconds").value), carrierBudgetUsd: Number(field("carrier").value), maxModelTokens: Number(field("tokens").value) })));
  on("telephone-callme", () => { field("to").value = state?.settings?.ownNumber ?? ""; field("direction").value = "outbound"; });
  on("telephone-approve", (el) => action(() => api(`telephone/${el.dataset.id}/approve`, { fingerprint: el.dataset.fingerprint })));
  on("telephone-cancel", (el) => action(() => api(`telephone/${el.dataset.id}/cancel`, {})));
  on("telephone-recover", () => action(() => api("telephone/recover", { id: state?.recovery?.id, sid: field("recovery-sid").value.trim() })));
  on("telephone-refresh", () => loadTelephone());
}
export function telephoneSection() {
  if (E.profiles?.isOwner === false) return "";
  const c = state?.settings ?? {}, input = (id, label, value = "", type = "text") => `<label>${esc(label)}<input id="telephone-${id}" type="${type}" value="${esc(value)}"></label>`;
  return `<section class="sec"><h2>Telephone voice calls</h2><p>Off until you configure it and approve one exact call. Uses Twilio speech recognition and voice; audio leaves this computer. No recordings, tools, purchases or actions during calls.</p>
    <label><input id="telephone-enabled" type="checkbox" ${c.enabled ? "checked" : ""}>Enable call proposals</label>
    ${input("account", "Twilio account SID", c.accountSid)}${input("token", "Saved auth token secret name", c.authTokenSecret)}${input("from", "Your Twilio number (+country code)", c.from)}${input("own", "Your personal number (+country code)", c.ownNumber)}${input("origin", "Your configured HTTPS webhook origin", c.publicOrigin)}${input("pin", "Saved inbound 6–12 digit PIN secret name", c.pinSecret)}
    <button class="btn" data-act="telephone-save">Save call configuration</button>
    ${state?.recovery && state.recovery.state !== "ended" ? `<p>Unresolved call ${esc(state.recovery.id)} blocks another approval. Inspect Twilio first. Enter the exact call SID to end it; account, recipient and creation time will be verified.</p>${input("recovery-sid", "Inspected Twilio call SID", state.recovery.sid ?? "")}<button class="btn" data-act="telephone-recover">End this inspected unresolved call</button>` : ""}
    <h3>Propose one call</h3><select id="telephone-direction"><option value="outbound">Call someone</option><option value="inbound">Allow my incoming call for ten minutes</option></select>
    ${input("to", "Exact recipient / incoming owner number")}${input("purpose", "Approved purpose")}${input("seconds", "Maximum duration in seconds (30–300)", 120, "number")}${input("carrier", "Quoted carrier budget in USD", 1, "number")}${input("tokens", "Model token reservation cap", 2000, "number")}
    <button class="btn ghost" data-act="telephone-callme">Use my number</button><button class="btn" data-act="telephone-propose">Review call proposal</button><button class="btn ghost" data-act="telephone-refresh">Refresh</button>
    <p>Quotes exclude taxes, Twilio speech fees and model charges. Duration and token reservations limit usage; the displayed carrier budget is not an invoice-total guarantee.</p><p>${esc(state?.problem ?? "")}</p>
    ${(state?.calls ?? []).map((call) => `<article><b>${esc(call.terms.direction)} ${esc(call.from)} → ${esc(call.terms.to)}</b><p>${esc(call.terms.purpose)}</p><p>${esc(call.state)} · ${call.terms.maxSeconds}s · carrier quote $${esc(call.quoteUsd)} · ${call.terms.maxModelTokens} model tokens · expires ${esc(call.expiresAt)}</p>${call.webhookUrl ? `<p>For this approved inbound slot, configure Twilio's voice webhook: ${esc(call.webhookUrl)} (POST). Your exact caller number and PIN are required.</p>` : ""}${call.state === "proposed" ? `<button class="btn" data-act="telephone-approve" data-id="${esc(call.id)}" data-fingerprint="${esc(call.fingerprint)}">Approve this exact call</button>` : ""}<button class="btn ghost" data-act="telephone-cancel" data-id="${esc(call.id)}">End / discard</button></article>`).join("")}</section>`;
}
