import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

export function routingCard(state) {
  if (!state.routing) return "";
  return `<div class="rows"><div class="ctl"><b>${esc(t("window.chat-route.title"))}</b><span class="right"><button class="btn sm" type="button" data-act="chat-route-edit">${esc(t("ov.open"))}</button></span><small>${esc(t("window.chat-route.hint"))}</small></div></div>`;
}
const targetValue = (channel, scope) => JSON.stringify({ channel, scope });
function selectedRoute(state) {
  const select = document.getElementById("chat-route-target");
  const trunk = document.getElementById("chat-route-trunk");
  if (!select || !trunk) return;
  const target = JSON.parse(select.value);
  trunk.value = state.routing.routes.find(route => route.channel === target.channel && route.scope === target.scope)?.trunkId ?? "inherit";
}
export function initRouting(state, reload) {
  markLive(["chat-route-edit", "chat-route-save", "sw:chat-route-target", "sw:chat-route-trunk"]);
  on("chat-route-edit", () => {
    const targets = (state.channels ?? []).map(channel => ({ channel: channel.id, scope: "*", title: `${channel.id} · ${t("window.chat-route.whole")}` }));
    for (const chat of state.chats ?? []) targets.push({ channel: chat.channel, scope: chat.chatId, title: `${chat.channel} · ${chat.title}` });
    if (!targets.length) { toast(t("window.chat-route.connect")); return; }
    const opts = targets.map(target => `<option value="${esc(targetValue(target.channel, target.scope))}">${esc(target.title)}</option>`).join("");
    const trunks = state.routing.trunks.map(trunk => `<option value="${esc(trunk.id)}">${esc(trunk.name)}</option>`).join("");
    openDlg({ title: t("window.chat-route.title"), body: `<p>${esc(t("window.chat-route.hint"))}</p><label>${esc(t("window.chat-route.where"))}<select class="inp" id="chat-route-target">${opts}</select></label><label>${esc(t("window.chat-route.title"))}<select class="inp" id="chat-route-trunk"><option value="inherit">${esc(t("window.chat-route.inherit"))}</option><option value="default">${esc(t("window.chat-route.default"))}</option>${trunks}</select></label><p>${esc(t("window.chat-route.fresh"))}</p><div class="acts"><button class="btn pri" type="button" data-act="chat-route-save">${esc(t("action.save"))}</button></div>` });
    selectedRoute(state);
  });
  document.addEventListener("change", event => { if (event.target.id === "chat-route-target") selectedRoute(state); });
  on("chat-route-save", async () => {
    const target = document.getElementById("chat-route-target"), trunk = document.getElementById("chat-route-trunk");
    if (!target || !trunk) return;
    try {
      await api("channels/routes", { ...JSON.parse(target.value), trunkId: trunk.value === "inherit" ? null : trunk.value });
      closeDlg(); await reload();
    } catch (error) { toast(error.message); }
  });
}
