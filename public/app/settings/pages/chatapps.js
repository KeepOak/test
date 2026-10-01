/* Settings › Chat apps (pass 17 part D §8), a page under Your assistant, 1:1 with the prototype's patch17d.js. The apps
   and how each is doing are the engine's: the connected ones and their health from GET /api/channels, every app's name
   and the count from GET /api/channel-setup. Telegram now says when it refuses its bot token (src/channels/telegram.ts);
   that one state shows the same way here, in Customize › Channels, on the app's own page (flows/chatapps17d.js) and in
   Inbox › Needs you, where "Paste the new token" opens its setup at Paste, whose Save brings it back.
   What the Trunk sees and Staying connected are the engine's (src/channels/intake-settings.ts: GET /api/channels
   `intake`, saved one field at a time with POST /api/channels/intake): edited messages, albums as one message, the
   wait for messages split in two, the watchdog, when it starts a stalled app again, the "stalled after" figure and
   online status in the app (off until chosen: it changes the bot's profile). Each connected app the watchdog looks at
   has its line: when it last answered and how often it was started again today. Per-app formatting saves native/plain
   choices through channels/formatting; the revoked-card action switches off only the exact guided Telegram
   connection, with a short-lived Undo that retains its token and conversations. Every word goes through t() (public/locales); a switch
   keeps its English title (its id is made from it) and shows through say(); the engine's reason is shown as it wrote it. */

import { esc, render } from "../../core/dom.js";
import { level, S, E, ownerHere, activeId } from "../../core/state.js";
import { api } from "../../core/api.js";
import { toast, openDlg } from "../../core/ui.js";
import { ownerCommandCard, initOwnerCommands } from "../owner-commands.js";
import { routingCard, initRouting } from "../chat-routing.js";
import { stepsCard, initSteps } from "../chat-steps.js";
import { phoneAccessCard, initPhoneAccess, loadPhoneAccess } from "../phone-access.js";
import { logo } from "../../core/logos.js";
import { sw15, sec15, seg15, id15 } from "../rows15.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { nativeFormat, pill17d, stateOf } from "../../flows/chatapps17d.js";
import { formatButtons, initFormatting, loadFormats } from "../chat-formatting.js";
import { initReplyStyle, loadReplyStyles, replyStyleRows } from "../chat-reply-style.js";
import { t } from "../../../i18n.js";

const A = { channels: null, apps: [], at: 0, intake: null, live: null, ownerCommands: null, ownerNamed: true, approved: [], chats: [], routing: null, steps: null, watchdogLog: [] };
const STEPS = "Show steps in chats";
/* owner-dm-full: the owner's own verified direct chat runs with the owner's full access (GET /api/channels
   `permissions.ownerChats`, saved with POST /api/channels/permissions { ownerChats }). On as Branch ships. */
const OWN_FULL = "Your own chats have your full access";
const OWN_FULL_SUB = "Your own account, one to one, on an app that vouches for its senders, can do what you can in the window. Groups and other people keep the short list. Lockdown turns it off.";
const kindOf = (c) => c.kind ?? c.id;

/* The window is not behind the App lock. */
const unlocked = () => !document.getElementById("app")?.classList.contains("locked-b17");
/* The owner, the same person as when a read began, with the window unlocked: what a late answer may still change. */
const sameOwner = (profile) => ownerHere() && activeId() === profile && unlocked();

async function loadApps() {
  const profile = activeId();
  if (!ownerHere() || !unlocked()) return; // the owner's chat apps: no page asks for them on a household person's profile
  A.at = Date.now();
  const [live, setup, routing] = await Promise.all(["channels", "channel-setup", "channels/routes"].map((path) => api(path).catch((error) => { if (sameOwner(profile)) toast(error.message); return null; })));
  if (!sameOwner(profile)) return;
  A.channels = live?.channels ?? [];
  A.intake = live?.intake ?? null;
  A.watchdogLog = live?.watchdogLog ?? [];
  A.live = live?.live ?? null;
  A.ownerCommands = live?.ownerCommands ?? null;
  A.ownerNamed = live?.ownerNamed !== false; // owner-dm-signin: no chat account is marked as the owner's yet
  A.approved = live?.approved ?? [];
  A.chats = live?.chats ?? [];
  A.routing = routing;
  A.steps = live?.steps ?? null;
  A.permissions = live?.permissions ?? null;
  A.apps = setup?.channels ?? [];
  await Promise.all([loadFormats(), loadReplyStyles(), loadPhoneAccess()]);
  if (sameOwner(profile)) render();
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
  if (A.live) html += `<div class="rows">${sw15(STEPS, "While a task works, one message in your direct chat lists each step, with commands and files as code. Groups get a short message.", A.live.steps !== "off")}</div>` + stepsCard(A, lv);
  if (E.profiles?.isOwner !== false && A.permissions)
    html += `<div class="rows">${sw15(OWN_FULL, OWN_FULL_SUB, A.permissions.ownerChats !== false)}</div>`;
  if (E.profiles?.isOwner !== false) html += ownerCommandCard(A) + routingCard(A) + phoneAccessCard();
  // Replies in each connected app: quoting your message, and the reaction on it while Branch works.
  const kinds = [...new Set(on.map(kindOf))];
  const quotes = (id) => on.some((c) => kindOf(c) === id && c.replyQuotes === true); // an app whose replies can quote
  if (kinds.length) html += `<div class="sec x15-sec"><h2>${esc(t("window.chat-reply.title"))}</h2>${kinds.map((id) => replyStyleRows(id, nameOf(id), quotes(id))).join("")}</div>`;
  if (lv >= 1) html += advanced(on);
  if (lv >= 2) html += `<div class="sec x15-sec"><h2>${esc(t("window.p17d.chat-apps-technical"))}</h2><div class="ctl"><b>${esc(t("window.p17d.stalled-after"))}</b><span class="right num15"><input class="inp" id="ca-stall17d" value="${esc(A.intake?.stalledAfterSeconds ?? "")}" aria-label="${esc(t("window.p17d.stalled-after"))}"><small>${esc(t("window.p17d.seconds"))}</small></span><small>${esc(t("window.p17d.stalled-hint"))}</small></div></div>`;
  if (lv >= 2) html += `<div class="ctl"><b>${esc(t("window.p17d.watchdog-log"))}</b><button type="button" class="btn sm" data-act="ca-watchdog-log">${esc(t("ov.open"))}</button><small>${esc(t("window.p17d.watchdog-log-hint"))}</small></div>`;
  return html;
}
async function showWatchdogLog() {
  if (E.profiles?.isOwner === false) return;
  await loadApps();
  if (E.profiles?.isOwner === false) return;
  const rows = [...(A.watchdogLog ?? [])].reverse().map((row) => {
    const at = new Date(row.at);
    const outcome = ["stalled", "restarted", "failed"].includes(row.outcome) ? row.outcome : "stalled";
    return `<div class="prow"><span class="grow"><b>${esc(nameOf(row.kind))}</b><small>${esc(t(`window.p17d.watchdog-log-${outcome}`))}</small></span><time datetime="${esc(row.at)}">${esc(Number.isFinite(at.getTime()) ? at.toLocaleString() : "")}</time></div>`;
  }).join("");
  openDlg({ title: t("window.p17d.watchdog-log"), body: `<p class="hint">${esc(t("window.p17d.watchdog-log-hint"))}</p>${rows || `<p class="empty">${esc(t("window.p17d.watchdog-log-empty"))}</p>`}` });
}

/* Each switch: the field it saves. */
const SW = { "f15-edited-messages": "edited", "f15-photo-albums-as-one-message": "albums", "f15-watch-for-a-chat-app-that-stops-receivin": "watchdog", "f15-show-online-or-offline-in-the-app": "presence" };
const onOf = (field) => A.intake?.[field] === true;
/* The watchdog's line for one connected app: when it last answered, and how often it was started again today. */
function watchLine(c) {
  const w = c.watchdog;
  if (!w) return "";
  const ago = Math.max(0, Math.round((Date.now() - Date.parse(w.lastContactAt)) / 1000));
  const [cls, word] = stateOf(c.health);
  return `<div class="prow">${logo(kindOf(c), nameOf(kindOf(c)), 24)}<span class="grow"><b>${esc(nameOf(kindOf(c)))}</b><small>${esc(c.health?.state === "needs attention" ? c.health.reason ?? "" : t("window.p17d.watchdog-line", { ago, count: w.reconnectsToday }))}</small></span>${pill17d(cls, word)}</div>`;
}
async function saveIntake(change) {
  try { A.intake = (await api("channels/intake", change)).intake; } catch (error) { toast(error.message); }
  await loadApps();
}
function advanced(on) {
  const seen = sec15(t("window.p17d.trunk-sees"), sw15("Edited messages", "When you edit a message, the Trunk sees the latest version and answers that one.", onOf("edited"))
    + sw15("Photo albums as one message", "Ten photos sent together arrive as one message, not ten.", onOf("albums"))
    + seg15(t("window.p17d.split-wait"), t("window.p17d.split-wait-hint"), [[0, t("accounts.switch.off")], [1000, t("window.p17d.one-second")], [3000, t("window.p17d.three-seconds")]], A.intake?.splitWaitMs ?? null, "ca-split"));
  const watching = on.filter((c) => c.watchdog).map(watchLine).join("");
  const staying = sec15(t("window.p17d.staying-connected"), sw15("Watch for a chat app that stops receiving", "If no update arrives for a while, Branch reconnects it and tells you if that fails.", onOf("watchdog"))
    + seg15(t("window.p17d.reconnect-after"), t("window.p17d.reconnect-hint"), [[1, t("window.p17d.one-minute")], [3, t("window.p17d.three-minutes")], [10, t("window.p17d.ten-minutes")]], A.intake?.reconnectMinutes ?? null, "ca-reconnect")
    + sw15("Show online or offline in the app", "The bot’s description says “Online” or “Offline, back soon”, so people know.", onOf("presence"))
    + (watching ? `<div class="rows wd17d">${watching}</div>` : ""));
  const connected = new Set(on.map(kindOf));
  const fmt = [...new Set([...connected, "slack", "discord", "whatsapp"])].map((id) => { const name = esc(nameOf(id));
    return `<div class="ctl"><b>${name}${connected.has(id) ? "" : ` <small>${esc(t("window.p17d.when-connected"))}</small>`}</b><span class="right"><span class="seg" role="group" aria-label="${esc(t("window.p17d.formatting-in", { name: nameOf(id) }))}">${formatButtons(id, nativeFormat(id))}</span></span><small>${esc(t("window.p17d.formatting-in-hint", { name: nameOf(id) }))}</small></div>`; }).join("");
  return seen + staying + `<div class="sec x15-sec"><h2>${esc(t("window.p17d.formatting-each"))}</h2><p class="hint">${esc(t("window.p17d.formatting-each-hint"))}</p>${fmt}</div>`;
}

/** Inbox › Needs you: a prompt while Telegram refuses its token. Read again at most every half minute; the owner's only. */
export function revokedPrompts() {
  if (E.profiles?.isOwner === false) return "";
  if (Date.now() - A.at > 30_000) loadApps();
  return (A.channels ?? []).filter(revoked).map((c) => `<div class="rev17d" role="status">${logo("telegram", "Telegram", 34)}<span class="grow"><b>${esc(t("window.p17d.revoked-title"))}</b><small>${esc(c.health.reason ?? "")}</small></span><button class="btn ghost sm" type="button" data-act="revoff17d" data-v="${esc(c.id)}">${esc(t("window.p17d.turn-telegram-off"))}</button><button class="btn pri sm" type="button" data-act="revfix17d">${esc(t("window.p17d.paste-the-new-token"))}</button></div>`).join("");
}
/** Customize › Channels: whether a connected app is offline because its token was refused. */
export const offlineIn = (connected, id) => connected.some((c) => kindOf(c) === id && revoked(c));

let telegramControlBusy = false;
/* Turning Telegram off reads the card first; the switch is sent only if the same person is still here, unlocked, with the
   card's button still on screen. Its note (with Undo) shows after the page is read again only if nothing moved on: the
   same person on the same page, unlocked. */
async function turnTelegramOff(el) {
  const profile = activeId(), channel = el.dataset.v, view = S.view;
  const still = () => sameOwner(profile) && S.view === view;
  if (!still() || telegramControlBusy || !channel) return;
  telegramControlBusy = true;
  try {
    const before = await api("never-break/telegram");
    if (!still() || !el.isConnected) return;
    if (before.card?.channel !== channel || before.mode === "off") throw new Error(t("window.p17d.telegram-card-only"));
    const done = await api("never-break/telegram", { action: "off", channel, revision: before.card.revision, expectedMode: before.mode, expectedSettingsRevision: before.settingsRevision });
    if (!still()) return;
    await loadApps();
    if (still()) toast(done.note, () => undoTelegramOff(done.receipt, profile));
  } catch (error) { if (still()) toast(error.message); }
  finally { telegramControlBusy = false; }
}
async function undoTelegramOff(receipt, profile) {
  const view = S.view, still = () => sameOwner(profile) && S.view === view;
  if (!receipt || !still() || telegramControlBusy) return;
  telegramControlBusy = true;
  try {
    const done = await api("never-break/telegram", { action: "undo", receipt });
    if (!still()) return;
    await loadApps();
    if (still()) toast(done.note);
  } catch (error) { if (still()) toast(error.message); }
  finally { telegramControlBusy = false; }
}

/** owner-dm-full: the switch saves the engine's own value, then the page is read again from the engine. */
async function saveOwnFull(on) {
  try { await api("channels/permissions", { ownerChats: on }); } catch (error) { toast(error.message); }
  await loadApps();
}
/** The steps switch saves the engine's own value, then the page is read again from the engine. */
async function saveSteps(on) {
  try { await api("channels/live", { steps: on ? "on" : "off" }); } catch (error) { toast(error.message); }
  await loadApps();
}

export function init() {
  on("ca-watchdog-log", showWatchdogLog);
  initFormatting();
  initReplyStyle();
  markLive(["sw:f15-show-steps-in-chats", "sw:" + id15(OWN_FULL), "ca-split", "ca-reconnect", "sw:ca-stall17d", "ca-watchdog-log", "revoff17d", ...Object.keys(SW).map((id) => "sw:" + id)]);
  on("revoff17d", (el) => turnTelegramOff(el));
  on("ca-split", (el) => saveIntake({ splitWaitMs: Number(el.dataset.v) }));
  on("ca-reconnect", (el) => saveIntake({ reconnectMinutes: Number(el.dataset.v) }));
  document.addEventListener("change", (e) => {
    if (e.target.id === "f15-show-steps-in-chats") saveSteps(e.target.checked);
    else if (e.target.id === id15(OWN_FULL)) saveOwnFull(e.target.checked);
    else if (SW[e.target.id]) saveIntake({ [SW[e.target.id]]: e.target.checked });
    else if (e.target.id === "ca-stall17d") {
      const typed = e.target.value.trim();
      if (/^\d+$/.test(typed)) saveIntake({ stalledAfterSeconds: Number(typed) });
      else render(); // not a whole number: the box shows the engine's figure again
    }
  });
  loadApps();
  initOwnerCommands(A, loadApps);
  initRouting(A, loadApps);
  initSteps(loadApps);
  initPhoneAccess(loadApps);
}
export function load() { return loadApps(); }
