import { $, esc } from "../core/dom.js";
import { openDlg, closePop, dialog, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
let frame = null, busy = false;
const button = (action, title, value = "") => `<button class="btn" type="button" data-act="brief-source-${action}" data-v="${esc(value)}">${esc(title)}</button>`;
function draw(body, foot = button("refresh", "Back to sources")) { frame = openDlg({ title: "Morning brief & watch history", body, foot, wide: true }); }
async function perform(work) {
  if (busy || dialog() !== frame) return;
  busy = true; const current = frame;
  current.querySelectorAll("button[data-act^=brief-source-]").forEach(el => { el.disabled = true; });
  try { await work(() => dialog() === current); } catch (error) { if (dialog() === current) toast(error.message); }
  finally { busy = false; current.querySelectorAll("button[data-act^=brief-source-]").forEach(el => { el.disabled = false; }); }
}
async function open() {
  if (busy) return;
  closePop(); draw("<p>Loading configured sources and retained watches…</p>", "");
  await perform(async alive => {
    const data = await api("brief/sources"), all = await api("monitors"); if (!alive()) return;
    const day = new Date().toISOString().slice(0, 10), s = data.sources;
    draw(`<p>News and health sources are off until approved. Selected news uses existing search watches and their last stored results; this screen fetches no news. Sources are owner-curated, not independently verified. Stale timestamps and watch failures remain visible.</p>
      <p>News appears in the saved morning conversation${data.settings.deliverTo ? ` and goes to ${esc(data.settings.deliverTo.channel)}:${esc(data.settings.deliverTo.chatId)}` : ""}. Health contributes only a private-review reminder. Metrics require a separate read click and are never saved, delivered or sent to models.</p>
      <p>Pick up to three existing news search watches. Create them through existing watch controls/tools first.</p>
      ${data.watches.map(w => `<label class="fld"><input type="checkbox" name="brief-news-watch" value="${esc(w.id)}" ${s.newsWatchIds.includes(w.id) ? "checked" : ""}> ${esc(w.label)} — ${esc(w.target)} (${esc(w.lastCheckedAt ?? "never checked")})</label>`).join("") || "<p>No search watches exist.</p>"}
      <label class="fld"><span>Private health review source</span><select class="inp" id="brief-health">${["off", "oura", "whoop"].map(v => `<option value="${v}" ${s.healthSource === v ? "selected" : ""}>${v.toUpperCase()}</option>`).join("")}</select></label>
      <p>Configure and authorize Oura/WHOOP in their private connector controls first. No automatic refresh or background health fetch. Provider membership, app approval and pricing may apply.</p>
      <label class="fld">Private UTC start date<input class="inp" id="brief-health-start" type="date" value="${day}"></label><label class="fld">End date (up to 31 days)<input class="inp" id="brief-health-end" type="date" value="${day}"></label>
      <h3>Watch histories</h3><p>Last 100 retained outcomes per watch, from this version onward; older alerts are not reconstructed. Changes, held deliveries and failures are shown separately.</p>
      ${all.monitors.map(w => `<p>${esc(w.label)} — ${esc(w.health)} ${button("history", "View history", w.id)}</p>`).join("") || "<p>No watches.</p>"}`,
      button("save", "Approve these brief sources") + button("preview", "Preview saved brief text") + button("health", "Approve private date-range health read"));
  });
}
export function initBriefSources() {
  markLive(["brief-sources", ...["refresh", "save", "preview", "health", "history"].map(x => "brief-source-" + x)]);
  on("brief-sources", open); on("brief-source-refresh", open);
  on("brief-source-save", () => perform(async alive => {
    await api("brief/sources", { newsWatchIds: [...frame.querySelectorAll('input[name="brief-news-watch"]:checked')].map(el => el.value), healthSource: $("#brief-health")?.value ?? "off", approveBriefSources: true });
    if (alive()) toast("Approved sources saved; private health metrics remain excluded from delivery.");
  }));
  on("brief-source-preview", () => perform(async alive => { const result = await api("brief"); if (alive()) draw(`<pre>${esc(result.markdown)}</pre>`); }));
  on("brief-source-history", el => perform(async alive => {
    const result = await api(`monitors/${encodeURIComponent(el.dataset.v)}/history`); if (!alive()) return;
    draw(result.entries.slice().reverse().map(e => `<p><strong>${esc(e.at)} — ${esc(e.status)}${e.changed ? " / alert" : ""}</strong><br>${esc(e.summary)}<br>Delivery: ${esc(e.delivered ?? "none / unacknowledged")}${e.held ? `<br>Held: ${esc(e.held)}` : ""}</p>`).join("") || "<p>No retained outcomes yet; no historical alerts were invented.</p>");
  }));
  on("brief-source-health", () => perform(async alive => {
    const source = $("#brief-health")?.value; if (!["oura", "whoop"].includes(source)) throw new Error("Choose Oura or WHOOP for this explicit private read");
    const result = await api(`personal/${source}/read`, { start: $("#brief-health-start")?.value, end: $("#brief-health-end")?.value, approvePrivateRead: true });
    if (alive()) draw(`<p>Private live provider response. This display is not inserted into the saved/delivered brief.</p><pre>${esc(JSON.stringify(result, null, 2))}</pre>`);
  }));
}
