import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

export function ownerScreenCard(state) {
  if (!state.ownerScreen) return "";
  return `<div class="rows"><div class="ctl"><b>${esc(t("window.chat-screen.title"))}</b><span class="right"><button class="btn sm" type="button" data-act="chat-screen-edit">${esc(t("ov.open"))}</button><button class="btn sm" type="button" data-act="chat-screen-waiting">${esc(t("window.chat-screen.sessions"))}</button></span><small>${esc(t(state.ownerScreen.on ? "window.chat-screen.on" : "window.chat-screen.off"))}</small></div></div>`;
}
async function edit(state) {
  const lock = await api("lock"), kinds = new Map((state.channels ?? []).map(c => [c.id, c.kind]));
  const pairs = (state.approved ?? []).filter(p => kinds.get(p.channel) === "telegram" && /^[1-9]\d{0,15}$/.test(p.senderId));
  const rows = pairs.map(pair => {
    const checked = state.ownerScreen.accounts.some(a => a.channel === pair.channel && a.sender === pair.senderId);
    return `<label class="ctl"><input type="checkbox" data-sw="chatScreenAccount" data-chat-screen-account data-channel="${esc(pair.channel)}" value="${esc(pair.senderId)}" ${checked ? "checked" : ""}><span>${esc(pair.name)} · ${esc(pair.channel)} · ${esc(pair.senderId)}</span></label>`;
  }).join("");
  openDlg({ title: t("window.chat-screen.title"), body: `<p>${esc(t("window.chat-screen.warning"))}</p><label class="ctl"><input id="chat-screen-on" type="checkbox" ${state.ownerScreen.on ? "checked" : ""}>${esc(t("accounts.switch.on"))}</label>${rows || `<p>${esc(t("window.chat-screen.pair"))}</p>`}${lock.pinSet ? `<label>${esc(t("window.chat-command.pin"))}<input class="inp" id="chat-screen-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="64"></label>` : ""}<div class="acts"><button class="btn pri" type="button" data-act="chat-screen-save">${esc(t("action.save"))}</button></div>` });
}
async function waiting() {
  const sessions = await api("channels/screen-confirmations");
  const rows = sessions.waiting.map(p => `<div class="ctl"><b>${esc(p.channel)} · ${esc(p.senderId)}</b><button class="btn" type="button" data-act="chat-screen-confirm" data-v="${esc(p.id)}">${esc(t("window.chat-screen.confirm"))}</button></div>`).join("");
  const active = sessions.active;
  openDlg({ title: t("window.chat-screen.sessions"), body: `<p>${esc(t("window.chat-screen.fresh"))}</p>${rows || `<p>${esc(t("window.chat-screen.none"))}</p>`}${active ? `<p>${esc(active.channel)} · ${esc(active.senderId)}</p>` : ""}<div class="acts"><button class="btn" type="button" data-act="chat-screen-waiting">${esc(t("window.chat-screen.refresh"))}</button><button class="btn danger" type="button" data-act="chat-screen-stop">${esc(t("window.chat-screen.stop"))}</button></div>` });
}
export function initOwnerScreen(state, reload) {
  markLive(["chat-screen-edit", "chat-screen-save", "chat-screen-waiting", "chat-screen-confirm", "chat-screen-stop", "sw:chat-screen-on", "sw:chat-screen-pin", "sw:chatScreenAccount"]);
  const attempt = work => async el => { try { await work(el); } catch (error) { toast(error.message); } };
  on("chat-screen-edit", attempt(() => edit(state)));
  on("chat-screen-waiting", attempt(waiting));
  on("chat-screen-confirm", attempt(async el => { await api("channels/screen-confirmations/confirm", { id: el.dataset.v }); await waiting(); }));
  on("chat-screen-stop", attempt(async () => { await api("channels/screen-stop", {}); await waiting(); }));
  on("chat-screen-save", attempt(async () => {
    const enabled = document.getElementById("chat-screen-on"); if (!enabled) return;
    const accounts = [...document.querySelectorAll("input")].filter(node => node.dataset.chatScreenAccount !== undefined && node.checked)
      .map(node => ({ channel: node.dataset.channel, sender: node.value }));
    const pin = document.getElementById("chat-screen-pin");
    await api("channels/owner-screen", { on: enabled.checked, accounts, ...(pin ? { pin: pin.value } : {}) });
    closeDlg(); await reload();
  }));
}
