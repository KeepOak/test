import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

export function ownerCommandCard(state) {
  const saved = state.ownerCommands;
  if (!saved) return "";
  return `<div class="rows"><div class="ctl"><b>${esc(t("window.chat-command.title"))}</b><span class="right"><button class="btn sm" type="button" data-act="chat-command-edit">${esc(t("ov.open"))}</button></span><small>${esc(t(saved.on ? "window.chat-command.on" : "window.chat-command.off"))}</small>${state.ownerNamed === false && (state.approved ?? []).length ? `<small>${esc(t("window.chat-command.none-yet"))}</small>` : ""}</div></div>`;
}
export function initOwnerCommands(state, reload) {
  markLive(["chat-command-edit", "chat-command-save", "sw:chat-command-on", "sw:chat-command-pin", "sw:chatCommandAccount"]);
  on("chat-command-edit", async () => {
    try {
      const lock = await api("lock");
      const kinds = new Map((state.channels ?? []).map((channel) => [channel.id, channel.kind]));
      const pairs = (state.approved ?? []).filter((pair) => ["telegram", "discord", "slack"].includes(kinds.get(pair.channel)));
      const rows = pairs.map((pair) => {
        const checked = state.ownerCommands.accounts.some((account) => account.channel === pair.channel && account.sender === pair.senderId);
        return `<label class="ctl"><input type="checkbox" data-sw="chatCommandAccount" data-chat-command-account data-channel="${esc(pair.channel)}" value="${esc(pair.senderId)}" ${checked ? "checked" : ""}><span>${esc(pair.name)} · ${esc(pair.channel)} · ${esc(pair.senderId)}</span></label>`;
      }).join("");
      openDlg({ title: t("window.chat-command.title"), body: `<p>${esc(t("window.chat-command.warning"))}</p><label class="ctl"><input id="chat-command-on" type="checkbox" ${state.ownerCommands.on ? "checked" : ""}>${esc(t("accounts.switch.on"))}</label>${rows || `<p>${esc(t("window.chat-command.pair"))}</p>`}${lock.pinSet ? `<label>${esc(t("window.chat-command.pin"))}<input class="inp" id="chat-command-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>` : ""}<div class="acts"><button class="btn pri" type="button" data-act="chat-command-save">${esc(t("action.save"))}</button></div>` });
    } catch (error) { toast(error.message); }
  });
  on("chat-command-save", async () => {
    const on = document.getElementById("chat-command-on");
    if (!on) return;
    const accounts = [...document.querySelectorAll("input")].filter((node) => node.dataset.chatCommandAccount !== undefined && node.checked)
      .map((node) => ({ channel: node.dataset.channel, sender: node.value }));
    const pin = document.getElementById("chat-command-pin");
    try {
      await api("channels/owner-commands", { on: on.checked, accounts, ...(pin ? { pin: pin.value } : {}) });
      closeDlg();
      await reload();
    } catch (error) { toast(error.message); }
  });
}
