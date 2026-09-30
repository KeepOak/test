import { $, esc } from "../core/dom.js";
import { openDlg, closePop, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

let frame = null, busy = false;
const value = id => $("#oura-" + id)?.value ?? "";
const field = (id, label, text = "", max = 300) => `<label class="fld"><span>${esc(label)}</span><input class="inp" id="oura-${id}" maxlength="${max}" value="${esc(text)}"></label>`;
const button = (act, title) => `<button class="btn" type="button" data-act="oura-${act}">${esc(title)}</button>`;
function draw(body, foot) { frame = openDlg({ title: "Private Oura daily summaries", body, foot, wide: true }); }
async function open() {
  if (busy) return;
  closePop(); draw("<p>Loading saved connection metadata…</p>", "");
  await perform(async alive => {
    const s = await api("personal/oura/status"); if (!alive()) return;
    const v = s.settings ?? {}, day = new Date().toISOString().slice(0, 10);
    draw(`<p>Off until you opt in and authorize your Oura application. Only the daily scope (sleep, activity, readiness) is requested. This form does not send metrics to models or retain them in Branch.</p>
      <p>Oura ring/membership requirements and commercial API approval may apply. API pricing is not verified; no free-service claim. Applications are limited to 10 users before Oura approval.</p>
      <p>Saved tokens: ${s.signedIn ? "present; live access unverified" : "none"}. Returned scope: ${esc(s.grantedScope ?? "unknown / not returned")}. Expiry: ${esc(s.expiresAt ?? "unknown")}.</p>
      ${field("client", "Your registered Oura client ID", v.clientId ?? "")}${field("secret", "Existing client-secret locker reference", v.clientSecretName ?? "OURA_CLIENT_SECRET", 80)}${field("port", "Registered loopback callback port (1024–65535)", String(v.callbackPort ?? 33569), 5)}
      <p>Register exactly http://127.0.0.1:PORT/oauth/callback in Oura. Saving configuration invalidates the previous local grant and requires sign-in again. Secrets and app registration must be prepared by you.</p>
      <label class="fld"><input type="checkbox" id="oura-enabled" ${v.enabled ? "checked" : ""}> Allow private daily reads</label>
      ${field("start", "Start date (YYYY-MM-DD)", day, 10)}${field("end", "End date (up to 31 days)", day, 10)}`,
    button("save", "Save explicit configuration") + button("signin", "Authorize daily scope") + button("read", "Approve private date-range read") + button("disable", "Disable local access"));
  });
}
async function perform(work) {
  if (busy || dialog() !== frame) return;
  busy = true; const current = frame;
  current.querySelectorAll("button[data-act^=oura-]").forEach(el => { el.disabled = true; });
  try { await work(() => dialog() === current); }
  catch (error) { if (dialog() === current) toast(error.message); }
  finally { busy = false; current.querySelectorAll("button[data-act^=oura-]").forEach(el => { el.disabled = false; }); }
}
export function initOura() {
  markLive(["oura", ...["save", "signin", "read", "disable", "refresh"].map(x => "oura-" + x)]);
  on("oura", open); on("oura-refresh", open);
  on("oura-save", () => perform(async alive => {
    const answer = await api("personal/oura/configure", { enabled: $("#oura-enabled")?.checked === true, clientId: value("client"), clientSecretName: value("secret"), callbackPort: Number(value("port")) });
    if (alive()) toast(answer.note);
  }));
  on("oura-signin", () => perform(async alive => {
    const answer = await api("personal/oura/start", {}); if (!alive()) return;
    draw(`<p>Requested scope: daily. Register this exact redirect before continuing: ${esc(answer.redirectUri)}.</p><p><a href="${esc(answer.url)}" target="_blank" rel="noopener noreferrer">Open Oura's authorization page</a></p><p>This local sign-in expires after ${Math.round(answer.expiresInMs / 60000)} minutes. Denied daily access will not be silently expanded.</p>`, button("refresh", "Return and read saved status"));
  }));
  on("oura-read", () => perform(async alive => {
    const answer = await api("personal/oura/read", { start: value("start"), end: value("end"), approvePrivateRead: true });
    if (alive()) draw(`<p>${esc(answer.note)}</p><pre>${esc(JSON.stringify({ range: answer.range, sleep: answer.sleep, readiness: answer.readiness, activity: answer.activity }, null, 2))}</pre>`, button("refresh", "Back to private controls"));
  }));
  on("oura-disable", () => perform(async alive => { const answer = await api("personal/oura/disable", {}); if (alive()) draw(`<p>${esc(answer.note)}</p>`, button("refresh", "Read disabled status")); }));
}
