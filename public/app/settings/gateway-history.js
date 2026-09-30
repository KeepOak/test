import { esc, render } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { E, activeId } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";
import { controlRow } from "./row-kit.js";
import { t } from "../../i18n.js";

const timings = ["startSeconds", "holdSeconds", "maxQuickCrashes", "gapSeconds", "watchSeconds"];
let pending = null, busy = false, generation = 0;
const locked = () => document.getElementById("app")?.classList.contains("locked");
const valid = change => generation === change.generation && E.profiles === change.profile && activeId() === change.id && token.get() === change.token && E.profiles?.isOwner === true && !locked();

export function gatewayDiagnostics(gw, health) {
  if (!gw) return "";
  const breaker = health ? (health.slowedDown === true ? t("gateway.settings.tripped") : t("gateway.settings.normal")) : t("gateway.settings.unavailable");
  const crashes = Number.isInteger(gw.recentCrashes) ? gw.recentCrashes : t("gateway.settings.unavailable");
  return `<div class="sec"><h2>${esc(t("gateway.settings.breaker"))}</h2><dl class="kv"><dt>${esc(t("gateway.settings.state"))}</dt><dd>${esc(breaker)}</dd><dt>${esc(t("gateway.settings.crashes"))}</dt><dd>${esc(crashes)}</dd></dl><p class="hint">${esc(t("gateway.settings.breaker-note"))}</p></div>`;
}

export function gatewayAcceptedChange(gw) {
  const changes = gw?.acceptedChanges ?? (gw?.accepted ? [gw.accepted] : []);
  return [...changes].reverse().map((change, index) => {
  const rows = timings.map(key => `<dt>${esc(key)}</dt><dd>${esc(change.before?.[key])} → ${esc(change.after?.[key])}</dd>`).join("");
  const off = index !== 0 || change.rolledBackAt || E.profiles?.isOwner !== true || locked();
  return `<div class="sec"><h2>${esc(t("gateway.settings.accepted"))}</h2><p>${esc(change.why)}</p><time>${esc(change.acceptedAt)}</time><dl class="kv">${rows}</dl>${change.rolledBackAt ? `<p>${esc(t("gateway.settings.undone"))} ${esc(change.rolledBackAt)}</p>` : controlRow(`<b>${esc(t("gateway.settings.undo"))}</b><span class="right"><button class="btn sm" type="button" data-act="gateway-settings-undo" data-at="${esc(change.acceptedAt)}" ${off ? "disabled" : ""}>${esc(t("gateway.settings.undo"))}</button></span><small>${esc(t("gateway.settings.undo-note"))}</small>`)}</div>`;
  }).join("");
}

async function undo() {
  const change = pending;
  if (!change || busy || !valid(change)) return;
  busy = true; pending = null;
  try {
    const profiles = await api("profiles");
    if (!valid(change) || !profiles.isOwner || (profiles.active?.id ?? null) !== change.id) throw new Error(t("gateway.settings.changed"));
    const result = await api("never-break/rollback", { acceptedAt: change.at });
    if (!valid(change)) return;
    toast(result.note); await change.reload();
  } catch (error) { if (valid(change)) toast(error.message); }
  finally { busy = false; render(); }
}

export function initGatewayHistory(reload) {
  markLive(["gateway-settings-undo", "gateway-settings-confirm"]);
  on("gateway-settings-undo", el => {
    if (E.profiles?.isOwner !== true || locked() || busy) return;
    pending = {profile: E.profiles, id: activeId(), token: token.get(), at: el.dataset.at, reload, generation};
    openDlg({title: t("gateway.settings.undo"), body: `<p>${esc(t("gateway.settings.undo-note"))}</p>`, foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("mode.cancel"))}</button><button class="btn" type="button" data-act="gateway-settings-confirm">${esc(t("gateway.settings.undo"))}</button>`});
  });
  on("gateway-settings-confirm", undo);
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (locked()) { generation++; pending = null; } }).observe(app, {attributes: true, attributeFilter: ["class"]});
}
