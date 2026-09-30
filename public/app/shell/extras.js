/* The smaller pieces around the window, 1:1 with the prototype's: the gateway popover in the status bar (GET/POST
   /api/never-break), the keyboard shortcuts list, and the conversation menu, whose export adds the engine's Markdown
   copy of the conversation to Library › Documents (and, in the desktop app, offers its archive to the Save dialog). The shortcuts the engine keeps (its "keys" card,
   shell/keys.js) are set by pressing the keys (#179); the fixed ones are only the keys this window answers to. */

import { esc, renderNow } from "../core/dom.js";
import { openPop, closePop, openDlg, mi, toast, ic } from "../core/ui.js";
import { S, E, ownerHere } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on, run, has } from "../core/actions.js";
import { markLive, isLive } from "../core/features.js";
import { chatKeys } from "../chat/chat.js";
import { chatMenuTop } from "../chat/beside.js";
import { pinnedCount } from "../chat/messages.js";
import { pinItem } from "../chat/putaway.js"; // batch A: pin an ordinary conversation from its menu
import { trunkMenu, trunkMenuEnd } from "../flows/trunk.js";
import { binding, defaultOf, pressed, comboOf, kbd, spoken, saveKey } from "./keys.js";
import { toggleSide, hiddenNow } from "./resize.js";
import { initMachines } from "./machines.js";
import { initFileView } from "./fileview.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

/* The saved choice and the worker actually running behind a gateway are separate facts. */
let gw = null;

function gatewayPop() {
  const saved = (gw?.mode ?? "off") !== "off", running = gw?.underGateway === true;
  const line = gw?.problem ? String(gw.problem) : running && !saved ? t(gw.stopsWhenOff === true ? "gatewayChoice.stopping" : "gatewayChoice.offLater") : running ? t("gatewayChoice.running")
    : saved ? t("gatewayChoice.saved") : t("gatewayChoice.off");
  const note = gw?.note ? `<p class="pp">${esc(gw.note)}</p>` : "";
  return `<div class="pt">${t("window.settings.gateway.gateway")}</div><p class="pp">${esc(line)}</p>${note}<div class="row-in"><span>${t("gatewayChoice.preference")}</span><input class="sw" type="checkbox" id="gwpop-sw" data-sw="gwpop-sw" ${saved ? "checked" : ""} aria-label="${t("window.settings.gateway.gateway")}"></div><hr>${mi("setgo", "sliders", t("window.shell.extras.gateway-settings"), "", 'data-v="gateway"')}`;
}

/* The status bar reports the actual worker, not the next-start preference. */
export const gatewayOn = () => (gw ? gw.underGateway === true : null);
/** Settings › Gateway hands over what it just read, so the status bar says the same at once. */
export function noteGateway(read) {
  const was = gatewayOn();
  gw = read;
  if (gatewayOn() !== was) renderNow();
}
let gwFor = null, gwReading = false;
export async function readGateway() {
  if (!E.state || E.state === gwFor || gwReading || !ownerHere()) return;
  gwFor = E.state;
  gwReading = true;
  const was = gatewayOn();
  try { gw = await api("never-break"); } catch (error) { console.warn(error.message); } finally { gwReading = false; }
  if (gatewayOn() !== was) renderNow();
}

async function openGateway(el) {
  gw = await api("never-break").catch(() => gw);
  openPop(el, gatewayPop(), { right: true });
}

async function setGateway(v) {
  try { gw = await api("never-break", { mode: v }); } catch (error) { toast(error.message); }
  renderNow();
  const anchor = document.querySelector('[data-act="gwpop"]');
  if (anchor) openPop(anchor, gatewayPop(), { right: true, force: true });
  setTimeout(() => { gwFor = null; void readGateway(); }, 1200);
}

/* ---------- keyboard shortcuts ---------- */
/* The engine's changeable shortcuts this window answers to, by the engine's names, with the prototype's words. */
/* Lockdown's shortcut only turns it on; turning it off stays with its banner or Settings. */
const KEYS = [["palette", "Find anything"], ["newConversation", "New conversation"], ["appearance", "Settings"], ["sidePane", "Show or hide the side panel"], ["focusMode", "Focus mode"], ["talkLive", "Talk live"], ["stopTask", "Stop the current task"], ["openInbox", "Open the Inbox"], ["nextConversation", "Next conversation"], ["previousConversation", "Previous conversation"],
  ["searchHistory", "Search the history"], ["focusPrompt", "Focus the message box"], ["lookInside", "Look inside the latest task"], ["newTrunk", "Start a new Trunk"],
  ["switchPerson", "Who is using Branch"], ["sideList", "Show or hide the list"], ["quickAsk", "Quick ask, from any app"], ["lockdownOn", "Turn Lockdown on"]];
const FIXED = [["Open conversation 1 to 9 in the list", "Ctrl+1…9"], ["New line in a message", "Shift+Enter"], ["Call a Trunk in a message", "@"], ["Use a skill", "/"], ["This list", "?"], ["Close anything", "Esc"]];
let listening = null;
const nameOf = (action) => KEYS.find(([a]) => a === action)?.[1] ?? "";

function keyRow([action, words]) {
  const now = binding(action), was = defaultOf(action);
  const set = `<button type="button" class="k-set15 ${listening === action ? "listen15" : ""}" data-act="key15" data-v="${action}" aria-label="${esc(t("window.shell.extras.action-keys-change", { action: say(words), keys: spoken(now) }))}">${listening === action ? `<em>${t("window.shell.extras.press-the-keys")}</em>` : kbd(now, esc)}</button>`;
  const back = now !== was ? `<button type="button" class="icon-btn" aria-label="${t("activityLog.action.putBack")} ${esc(spoken(was))}" data-act="keyreset15" data-v="${action}">${ic("x", "s")}</button>` : "<span></span>";
  return `<div class="k-row15"><span>${esc(say(words))}</span>${set}${back}</div>`;
}
function showShortcuts() {
  closePop();
  openDlg({ title: t("comfort.keys.title"), body: `<p class="hint" data-css="margin:0 0 10px">${t("window.shell.extras.click-a-shortcut-then-press-the")}</p><div class="keys15">${KEYS.map(keyRow).join("")}</div><div class="shortcuts" data-css="margin-top:14px">${FIXED.map(([a, b]) => `<span>${esc(say(a))}</span><span>${kbd(b, esc)}</span>`).join("")}</div>` });
  document.querySelector(".listen15")?.focus();
}
/* The next keys pressed while a shortcut listens become its keys, kept by the engine. Ctrl or Alt is needed so typing
   never sets one off; keys another shortcut here already has are refused, as the prototype does. */
async function takeKeys(e) {
  if (!listening || !document.querySelector(".scrim .keys15")) return;
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const action = listening, combo = comboOf(e);
  listening = null;
  if (e.key === "Escape") { showShortcuts(); return; }
  if (!/^(Ctrl|Control|Alt)\+/.test(combo)) { showShortcuts(); toast(t("window.shell.extras.use-ctrl-or-alt-with-it")); return; }
  const clash = KEYS.find(([a]) => a !== action && spoken(binding(a)).toLowerCase() === spoken(combo).toLowerCase());
  if (clash) { showShortcuts(); toast(t("window.shell.extras.combo-already-does-value", { combo: spoken(combo), value: clash[1] })); return; }
  try {
    await saveKey(action, combo);
    showShortcuts();
    toast(`${nameOf(action)}: ${spoken(binding(action))}.`);
  } catch (error) { showShortcuts(); toast(error.message); }
}
async function putBack(action) {
  try { await saveKey(action, defaultOf(action)); } catch (error) { toast(error.message); }
  showShortcuts();
}

/* A Trunk's or a room's own conversation gets its items from flows/trunk.js; any other is pinned through the engine's
   own marks (chat/putaway.js pinItem, batch A).
   Before a new conversation's first message the menu opens too: what needs a conversation (its last reply, its export)
   is drawn greyed with the reason as its tip. */
const later = (icon, text) => `<button class="mi soon" type="button" role="menuitem" aria-disabled="true" tabindex="-1" data-tip="${t("window.shell.extras.after-first-message")}"><span class="ico">${ic(icon, "s")}</span><span class="mi-t">${text}</span></button>`;
function chatMenu() {
  const inspect = t("window.shell.extras.look-inside-the-last-reply"), exported = t("window.shell.extras.export-conversation");
  /* Q262: the export goes to the owner's Library › Documents, so a household person has it only where the desktop saves a file. */
  const exports = ownerHere() || desktopExport();
  const own = S.chat ? mi("inspect", "eye", inspect) + (exports ? mi("export-conv", "copy", exported) : "")
    : later("eye", inspect) + (exports ? later("copy", exported) : "");
  /* The prototype's "Pinned messages N", while the conversation has pins (chat/messages.js, GET /api/sessions/<id>/pins). */
  const pins = S.chat ? pinnedCount(S.chat) : 0;
  const pinned = pins ? mi("pinlist15", "pin", t("window.chat.msg.pinned-messages"), esc(String(pins))) : "";
  return pinned + chatMenuTop() + (trunkMenu() || (S.chat ? pinItem(S.chat) : later("pin", t("window.shell.extras.pin-to-top")))) + mi("call", "wave", t("window.shell.extras.talk-out-loud")) + own + trunkMenuEnd();
}

/* The prototype's export: the engine's Markdown copy of the conversation (GET /api/sessions/<id>/export?format=markdown)
   is added to Library › Documents (POST /api/documents { name, text }), under the name the engine gives it. */
async function toDocuments(id) {
  const response = await fetch(`/api/sessions/${id}/export?format=markdown`, { cache: "no-store", headers: token.get() ? { authorization: "Bearer " + token.get() } : {} });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
  await api("documents", { ...(name ? { name } : {}), text: await response.text() });
  toast(t("window.shell.extras.saved-as-markdown-to-documents"));
}

/* The desktop app drops every download, so there the engine's own copy (GET /api/sessions/<id>/export) is also offered
   to the operating system's Save dialog through the desktop's guarded export (window.branchDesktop.exportConversation). */
async function toFile(id) {
  await window.branchDesktop.exportConversation(JSON.stringify(await api(`sessions/${id}/export`)));
}

/* Q262: Library › Documents is the owner's, so a household person's export goes only to the desktop's Save dialog. */
const desktopExport = () => typeof window.branchDesktop?.exportConversation === "function";
async function exportConversation() {
  closePop();
  if (!S.chat) return;
  const id = encodeURIComponent(S.chat), desktop = desktopExport();
  await Promise.all([ownerHere() ? toDocuments(id) : null, desktop ? toFile(id) : null].map((job) => Promise.resolve(job).catch((error) => toast(error.message))));
}

const typing = (e) => e.target.closest?.("input, textarea, select, [contenteditable]");
/* The conversations in the list's own order (Pinned, then Recent). */
const listed = () => [...document.querySelectorAll("#side .row[data-id]")].map((row) => row.dataset.id).filter((id) => id !== "new");
function openRow(id) {
  if (!id) return;
  const el = document.createElement("button");
  el.dataset.id = id;
  run("chat", el);
}
/* The conversation after (or before) the one open, round to the first (or the last). */
function nextConversation(step = 1) {
  const ids = listed();
  if (!ids.length) return;
  const at = ids.indexOf(S.chat);
  openRow(ids[((at < 0 ? (step > 0 ? -1 : 0) : at) + step + ids.length) % ids.length]);
}
/* Ctrl+1…9: the Nth conversation in the list, as tabs in a browser. */
function nthConversation(e) {
  if (!/^Ctrl\+[1-9]$/.test(comboOf(e))) return false;
  const id = listed()[Number(comboOf(e).slice(-1)) - 1];
  if (!id) return false;
  e.preventDefault();
  openRow(id);
  return true;
}
/* The list's own search (Telegram-style: names, words in replies, documents), brought into view first. */
function searchList() {
  closePop();
  if (S.view === "settings") { S.view = "chat"; renderNow(); } // Settings stands in for the list
  if (hiddenNow()) toggleSide();
  else if (!document.getElementById("app")?.classList.contains("side-open") && document.querySelector('[data-act="side"]')?.checkVisibility?.()) toggleSide();
  const box = document.getElementById("side-q");
  box?.focus();
  box?.select();
}
function focusPrompt() {
  if (S.view !== "chat") { S.view = "chat"; closePop(); renderNow(); }
  document.getElementById("prompt")?.focus();
}
const live = (act) => has(act) && isLive(act);

export function initExtras() {
  markLive(["gwpop", "sw:gwpop-sw", "shortcuts", "chatmenu", "export-conv", "key15", "keyreset15"]);
  initMachines();
  initFileView();
  on("gwpop", (el) => openGateway(el));
  document.addEventListener("change", (e) => { if (e.target.id === "gwpop-sw") setGateway(e.target.checked ? "when-needed" : "off"); });
  on("shortcuts", () => showShortcuts());
  on("key15", (el) => { listening = el.dataset.v; showShortcuts(); });
  on("keyreset15", (el) => putBack(el.dataset.v));
  on("chatmenu", (el) => openPop(el, chatMenu(), { right: true }));
  on("export-conv", () => exportConversation());
  document.addEventListener("keydown", takeKeys, true);
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "appearance")) { e.preventDefault(); S.view = "settings"; closePop(); renderNow(); }
    else if (pressed(e, "focusMode")) { e.preventDefault(); run("focus"); }
    /* In a text box Ctrl+Shift+V pastes as plain text and Ctrl+I may be the box's own: there those keys stay the box's. */
    else if (pressed(e, "talkLive") && !typing(e) && has("call") && isLive("call")) { e.preventDefault(); run("call"); }
    else if (pressed(e, "stopTask") && S.view === "chat") { e.preventDefault(); chatKeys.stop(); }
    else if (pressed(e, "openInbox") && !typing(e)) { e.preventDefault(); S.view = "inbox"; closePop(); renderNow(); }
    else if (pressed(e, "nextConversation")) { e.preventDefault(); nextConversation(1); }
    else if (pressed(e, "previousConversation")) { e.preventDefault(); nextConversation(-1); }
    else if (pressed(e, "searchHistory")) { e.preventDefault(); searchList(); }
    else if (pressed(e, "focusPrompt")) { e.preventDefault(); focusPrompt(); }
    else if (pressed(e, "lookInside") && S.view === "chat" && S.chat && live("inspect")) { e.preventDefault(); run("inspect"); }
    else if (pressed(e, "newTrunk") && live("new-trunk")) { e.preventDefault(); run("new-trunk"); }
    else if (pressed(e, "switchPerson")) { const who = document.querySelector('#side [data-act="owner"]'); if (who && live("owner")) { e.preventDefault(); run("owner", who); } }
    else if (!e.defaultPrevented && nthConversation(e)) { /* opened */ }
    else if (e.key === "?" && !typing(e) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showShortcuts(); }
  });
}
