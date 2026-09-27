/* Settings › Chat apps (pass 17 part D §8), a page under Your assistant, 1:1 with the prototype's patch17d.js. The apps
   and how each is doing are the engine's: the connected ones and their health from GET /api/channels, every app's name
   and the count from GET /api/channel-setup. Telegram now says when it refuses its bot token (src/channels/telegram.ts);
   that one state shows the same way here, in Customize › Channels, on the app's own page (flows/chatapps17d.js) and in
   Inbox › Needs you, where "Paste the new token" opens its setup at Paste, whose Save brings it back. Seeing edited
   messages, albums as one message, joining split messages, the stall watchdog, online status in the app and per-app
   formatting are not in the engine yet, so those rows stay greyed with nothing pressed; turning Telegram off has no route
   that is not deleting its saved token, so it stays greyed too. Every word goes through t() (public/locales); a switch
   keeps its English title (its id is made from it) and shows through say(); the engine's reason is shown as it wrote it. */

import { esc, render } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { sw15, sec15 } from "../rows15.js";
import { ctlSeg } from "../parts.js";
import { nativeFormat, pill17d, stateOf } from "../../flows/chatapps17d.js";
import { t } from "../../../i18n.js";

const A = { channels: null, apps: [], at: 0 };
const kindOf = (c) => c.kind ?? c.id;

async function loadApps() {
  if (E.profiles?.isOwner === false) return; // the owner's chat apps: no page asks for them on a household person's profile
  A.at = Date.now();
  const [live, setup] = await Promise.all(["channels", "channel-setup"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  A.channels = live?.channels ?? [];
  A.apps = setup?.channels ?? [];
  render();
}

const nameOf = (id) => A.apps.find((x) => x.id === id)?.name ?? id;
/** Telegram refusing its bot token: the one "offline" the engine reports. */
export const revoked = (c) => kindOf(c) === "telegram" && c.health?.state === "needs attention";

export function draw() {
  const lv = level(), on = A.channels ?? [];
  const rows = on.map((c) => { const [cls, w, s] = stateOf(c.health); return `<div class="prow">${logo(kindOf(c), nameOf(kindOf(c)), 32)}<span class="grow"><b>${esc(nameOf(kindOf(c)))}</b><small>${esc(s)}</small></span>${pill17d(cls, w)}<button class="btn sm" type="button" data-act="ch-open" data-v="${esc(kindOf(c))}">${esc(t("ov.open"))}</button></div>`; }).join("");
  let html = `<h1>${esc(t("dashboard.links.chats"))}</h1><p class="lede">${esc(t("window.p17d.chat-apps-lede"))}</p>
    <div class="rows ca17d">${A.channels === null ? "" : rows || `<p class="empty">${esc(t("window.p17d.no-chat-app"))}</p>`}</div>
    <div class="acts" data-css="margin-top:10px"><button class="btn" type="button" data-act="ptab" data-place="customize" data-v="channels">${esc(t("window.p17d.all-chat-apps", { count: A.apps.length }))}</button></div>`;
  if (lv >= 1) html += advanced(on);
  if (lv >= 2) html += `<div class="sec x15-sec"><h2>${esc(t("window.p17d.chat-apps-technical"))}</h2><div class="ctl"><b>${esc(t("window.p17d.stalled-after"))}</b><span class="right num15"><input class="inp" id="ca-stall17d" value="" aria-label="${esc(t("window.p17d.stalled-after"))}"><small>${esc(t("window.p17d.seconds"))}</small></span><small>${esc(t("window.p17d.stalled-hint"))}</small></div></div>`;
  return html;
}

function advanced(on) {
  const seen = sec15(t("window.p17d.trunk-sees"), sw15("Edited messages", "When you edit a message, the Trunk sees the latest version and answers that one.")
    + sw15("Photo albums as one message", "Ten photos sent together arrive as one message, not ten.")
    + ctlSeg(t("window.p17d.split-wait"), t("window.p17d.split-wait-hint"), [t("accounts.switch.off"), t("window.p17d.one-second"), t("window.p17d.three-seconds")], null));
  const staying = sec15(t("window.p17d.staying-connected"), sw15("Watch for a chat app that stops receiving", "If no update arrives for a while, Branch reconnects it and tells you if that fails.")
    + ctlSeg(t("window.p17d.reconnect-after"), t("window.p17d.reconnect-hint"), [t("window.p17d.one-minute"), t("window.p17d.three-minutes"), t("window.p17d.ten-minutes")], null)
    + sw15("Show online or offline in the app", "The bot’s description says “Online” or “Offline, back soon”, so people know."));
  const connected = new Set(on.map(kindOf));
  const fmt = [...new Set([...connected, "slack", "discord", "whatsapp"])].map((id) => { const name = esc(nameOf(id));
    return `<div class="ctl"><b>${name}${connected.has(id) ? "" : ` <small>${esc(t("window.p17d.when-connected"))}</small>`}</b><span class="right"><span class="seg" role="group" aria-label="${esc(t("window.p17d.formatting-in", { name: nameOf(id) }))}">${[nativeFormat(id), t("window.p17d.plain-text")].map((o) => `<button type="button" data-act="chfmt17d" data-id="${esc(id)}" data-v="${esc(o)}" aria-pressed="false">${esc(o)}</button>`).join("")}</span></span><small>${esc(t("window.p17d.formatting-in-hint", { name: nameOf(id) }))}</small></div>`; }).join("");
  return seen + staying + `<div class="sec x15-sec"><h2>${esc(t("window.p17d.formatting-each"))}</h2><p class="hint">${esc(t("window.p17d.formatting-each-hint"))}</p>${fmt}</div>`;
}

/** Inbox › Needs you: a prompt while Telegram refuses its token. Read again at most every half minute; the owner's only. */
export function revokedPrompts() {
  if (E.profiles?.isOwner === false) return "";
  if (Date.now() - A.at > 30_000) loadApps();
  return (A.channels ?? []).filter(revoked).map((c) => `<div class="rev17d" role="status">${logo("telegram", "Telegram", 34)}<span class="grow"><b>${esc(t("window.p17d.revoked-title"))}</b><small>${esc(c.health.reason ?? "")}</small></span><button class="btn ghost sm" type="button" data-act="revoff17d">${esc(t("window.p17d.turn-telegram-off"))}</button><button class="btn pri sm" type="button" data-act="revfix17d">${esc(t("window.p17d.paste-the-new-token"))}</button></div>`).join("");
}
/** Customize › Channels: whether a connected app is offline because its token was refused. */
export const offlineIn = (connected, id) => connected.some((c) => kindOf(c) === id && revoked(c));

export function init() { loadApps(); }
export function load() { return loadApps(); }
