import { $, esc } from "../core/dom.js";
import { openDlg, closePop, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

let frame = null, busy = false;
const value = id => $("#whoop-" + id)?.value ?? "";
const field = (id, label, text = "", max = 300) => `<label class="fld"><span>${esc(label)}</span><input class="inp" id="whoop-${id}" maxlength="${max}" value="${esc(text)}"></label>`;
const button = (act, title) => `<button class="btn" type="button" data-act="whoop-${act}">${esc(title)}</button>`;
function draw(body, foot) { frame = openDlg({ title: "Private WHOOP sleep and recovery", body, foot, wide: true }); }
async function perform(work) {
  if (busy || dialog() !== frame) return;
  busy = true; const current = frame;
  current.querySelectorAll("button[data-act^=whoop-]").forEach(el => { el.disabled = true; });
  try { await work(() => dialog() === current); }
  catch (error) { if (dialog() === current) toast(error.message); }
  finally { busy = false; current.querySelectorAll("button[data-act^=whoop-]").forEach(el => { el.disabled = false; }); }
}
async function open() {
  if (busy) return;
  closePop(); draw("<p>Loading saved WHOOP metadata…</p>", "");
  await perform(async alive => {
    const s = await api("personal/whoop/status"); if (!alive()) return;
    const v = s.settings ?? {}, day = new Date().toISOString().slice(0, 10);
    draw(`<p>Default off. Owner-created WHOOP app and account authorization required. Only read:sleep and read:recovery; no offline/profile/body/workout scope. Data is displayed privately, not saved or sent to a model.</p>
      <p>Device/membership and provider app-approval terms apply. API/commercial price is unverified; no free-service claim. Use only your own authorized application.</p>
      <p>Saved tokens: ${s.signedIn ? "present, live access unverified" : "none"}. Returned scope: ${esc(s.grantedScope ?? "unknown / not returned")}. Expiry: ${esc(s.expiresAt ?? "unknown")}.</p>
      ${field("client", "WHOOP client ID", v.clientId ?? "")}${field("secret", "Existing client-secret locker reference", v.clientSecretName ?? "WHOOP_CLIENT_SECRET", 80)}${field("port", "Exact registered loopback callback port", String(v.callbackPort ?? 33570), 5)}
      <p>Register http://127.0.0.1:PORT/oauth/callback exactly in WHOOP. Save configuration before sign-in; changes require reauthorization. No automatic refresh.</p>
      <label class="fld"><input type="checkbox" id="whoop-enabled" ${v.enabled ? "checked" : ""}> Allow private WHOOP reads</label>
      ${field("start", "UTC start date", day, 10)}${field("end", "UTC end date (up to 31 days)", day, 10)}
      <p>Provider range semantics apply; naps may add records. Maximum 50 records per type; extra pages are disclosed as truncated.</p>`,
    button("save", "Save explicit configuration") + button("signin", "Authorize sleep and recovery") + button("read", "Approve private date-range read") + button("disable", "Disable local access") + button("revoke", "Revoke saved WHOOP app access and disable"));
  });
}
export function initWhoop() {
  markLive(["whoop", ...["save", "signin", "read", "disable", "revoke", "refresh"].map(x => "whoop-" + x)]);
  on("whoop", open); on("whoop-refresh", open);
  on("whoop-save", () => perform(async alive => {
    const answer = await api("personal/whoop/configure", { enabled: $("#whoop-enabled")?.checked === true, clientId: value("client"), clientSecretName: value("secret"), callbackPort: Number(value("port")) });
    if (alive()) toast(answer.note);
  }));
  on("whoop-signin", () => perform(async alive => {
    const answer = await api("personal/whoop/start", {}); if (!alive()) return;
    draw(`<p>Requested scopes: read:sleep read:recovery. Exact redirect: ${esc(answer.redirectUri)}.</p><p><a href="${esc(answer.url)}" target="_blank" rel="noopener noreferrer">Open WHOOP authorization</a></p><p>Sign-in window expires in ${Math.round(answer.expiresInMs / 60000)} minutes.</p>`, button("refresh", "Return to saved status"));
  }));
  on("whoop-read", () => perform(async alive => {
    const answer = await api("personal/whoop/read", { start: value("start"), end: value("end"), approvePrivateRead: true });
    if (alive()) draw(`<p>${esc(answer.note)}</p><pre>${esc(JSON.stringify({ range: answer.range, sleep: answer.sleep, recovery: answer.recovery }, null, 2))}</pre>`, button("refresh", "Back to private controls"));
  }));
  on("whoop-disable", () => perform(async alive => { const answer = await api("personal/whoop/disable", {}); if (alive()) draw(`<p>${esc(answer.note)}</p>`, button("refresh", "Read local disabled status")); }));
  on("whoop-revoke", () => perform(async alive => { const answer = await api("personal/whoop/revoke", { approveProviderRevocation: true }); if (alive()) draw(`<p>${esc(answer.note)}</p>`, button("refresh", "Read disabled status")); }));
}
