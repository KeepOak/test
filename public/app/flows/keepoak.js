/* KeepOak is off until the owner enables it. Device-code polling exists only while this dialog is open. */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { E } from "../core/state.js";
import { t } from "../../i18n.js";

export const K = { view: null, profile: null };
let ticket = 0;
const owner = () => !E.profiles?.active?.id;
export async function loadKeepOak() {
  if (!owner()) { K.view = null; K.profile = null; return; }
  try { K.view = await api("keepoak"); } catch { K.view = null; }
  if (!owner()) { K.view = null; K.profile = null; }
  render();
}
export function keepOakCard() {
  const view = owner() ? K.view : null;
  const live = !!view, connected = !!view?.connected;
  const action = connected ? "ko-disconnect" : view?.enabled ? "ko-connect" : "ko-enable";
  const label = connected ? "keepoak.disconnect" : view?.enabled ? "keepoak.connect" : "keepoak.enable";
  const status = connected ? "keepoak.connected" : view?.enabled ? "keepoak.ready" : "keepoak.off";
  return `<div class="sec"><h2>keepoak.com</h2><div class="ko-card"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>${t("window.settings.accounts.your-keepoak-com-account")}</b><small>${esc((connected ? K.profile?.name : null) ?? t(status))}</small></span></div><p class="hint">${t("keepoak.profile-only")}</p><div class="acts"><button class="btn pri" type="button" data-act="${action}" ${live ? "" : 'disabled aria-disabled="true"'}>${t(label)}</button>${connected ? `<button class="btn" type="button" data-act="ko-profile">${t("keepoak.profile")}</button>` : ""}</div></div>`;
}
function showPrompt(message = "") {
  const view = K.view;
  openDlg({ title: t("keepoak.connect"),
    body: `<div id="keepoak-code"><p>${t("keepoak.enter-code")}</p><code class="devcode14">${esc(view?.userCode ?? "")}</code><p><a class="btn" href="${esc(view?.verificationUrl ?? "https://keepoak.com/activate")}" target="_blank" rel="noopener noreferrer">${t("keepoak.open")}</a></p><p class="hint" role="status">${esc(message || t("keepoak.waiting"))}</p><p class="hint">${t("keepoak.profile-only")}</p></div>`,
    foot: `<button class="btn ghost" type="button" data-act="ko-cancel">${t("action.cancel")}</button>${message ? `<button class="btn" type="button" data-act="ko-retry">${t("first-run-trouble.retry")}</button>` : ""}` });
}
function schedule(mine) {
  setTimeout(() => { if (mine === ticket && document.getElementById("keepoak-code")) void poll(mine); }, Math.max(1000, K.view?.pollAfterMs ?? 5000));
}
async function poll(mine) {
  try {
    const view = await api("keepoak/poll", {});
    if (mine !== ticket || !document.getElementById("keepoak-code")) return;
    K.view = view;
    if (view.connected) { ticket++; closeDlg(); render(); toast(t("keepoak.connected")); return; }
    if (!view.pending) { ticket++; closeDlg(); render(); toast(t("keepoak.expired")); return; }
    schedule(mine);
  } catch (error) {
    if (mine === ticket && document.getElementById("keepoak-code")) showPrompt(error.message);
  }
}
async function connect() {
  if (!owner()) return;
  try {
    if (!K.view?.enabled) { toast(t("keepoak.enable-first")); return; }
    K.view = K.view?.pending ? await api("keepoak") : await api("keepoak/begin", {});
    if (!owner()) return;
    showPrompt(); schedule(++ticket);
  } catch (error) { toast(error.message); }
}
async function disconnect() {
  if (!owner()) return;
  try { K.view = await api("keepoak/disconnect", {}); ticket++; K.profile = null; render(); toast(t("keepoak.disconnected")); }
  catch (error) { toast(error.message); }
}
export function initKeepOak() {
  markLive(["ko-enable", "ko-connect", "ko-disconnect", "ko-profile", "ko-cancel", "ko-retry"]);
  on("ko-enable", async () => {
    if (!owner()) return;
    try { K.view = await api("keepoak/enable", {}); render(); } catch (error) { toast(error.message); }
  });
  on("ko-connect", () => connect());
  on("ko-disconnect", () => disconnect());
  on("ko-profile", async () => {
    if (!owner()) return;
    try { const profile = await api("keepoak/profile", {}); if (owner()) { K.profile = profile; render(); } }
    catch (error) { toast(error.message); }
  });
  on("ko-cancel", async () => {
    try { K.view = await api("keepoak/cancel", {}); ticket++; closeDlg(); render(); } catch (error) { toast(error.message); }
  });
  on("ko-retry", () => poll(++ticket));
}
