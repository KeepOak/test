/* The smaller pieces around the window, 1:1 with the prototype's: the gateway popover in the status bar (GET/POST
   /api/never-break), the keyboard shortcuts list, and the conversation menu, whose export adds the engine's Markdown
   copy of the conversation to Library › Documents (and, in the desktop app, offers its archive to the Save dialog). The shortcuts the engine keeps (its "keys" card,
   shell/keys.js) are set by pressing the keys (#179); the fixed ones are only the keys this window answers to. */

import { esc, renderNow } from "../core/dom.js";
import { openPop, closePop, openDlg, mi, toast, ic } from "../core/ui.js";
import { S } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { chatMenuTop } from "../chat/beside.js";
import { trunkMenu, trunkMenuEnd } from "../flows/trunk.js";
import { binding, defaultOf, pressed, comboOf, kbd, spoken, saveKey } from "./keys.js";
import { initMachines } from "./machines.js";
import { initFileView } from "./fileview.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

/* The gateway is on or off: "when-needed" and "on" both run it (src/never-break/gateway-config.ts), so a file saved as
   "when-needed" reads as on, and the switch saves "on" or "off". */
const SAID = { off: "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again.", on: "On. Telegram, your phone and automations keep working when the window is closed." };
let gw = null;

function gatewayPop() {
  const on = (gw?.mode ?? "off") !== "off";
  const line = gw?.problem ? String(gw.problem) : say(SAID[on ? "on" : "off"]) ?? "";
  const note = gw?.note ? `<p class="pp">${esc(gw.note)}</p>` : "";
  return `<div class="pt">${t("window.settings.gateway.gateway")}</div><p class="pp">${esc(line)}</p>${note}<div class="row-in"><span>${t("field.never-break-mode")}</span><input class="sw" type="checkbox" id="gwpop-sw" data-sw="gwpop-sw" ${on ? "checked" : ""} aria-label="${t("window.settings.gateway.gateway")}"></div><hr>${mi("setgo", "sliders", t("window.shell.extras.gateway-settings"), "", 'data-v="gateway"')}`;
}

async function openGateway(el) {
  gw = await api("never-break").catch(() => gw);
  openPop(el, gatewayPop(), { right: true });
}

async function setGateway(v) {
  try { gw = await api("never-break", { mode: v }); } catch (error) { toast(error.message); }
  const anchor = document.querySelector('[data-act="gwpop"]');
  if (anchor) openPop(anchor, gatewayPop(), { right: true, force: true });
}

/* ---------- keyboard shortcuts ---------- */
/* The engine's changeable shortcuts this window answers to, by the engine's names, with the prototype's words. */
const KEYS = [["palette", "Find anything"], ["newConversation", "New conversation"], ["appearance", "Settings"], ["sideList", "Show or hide the list"], ["sidePane", "Show or hide the side panel"], ["quickAsk", "Quick ask, from any app"]];
const FIXED = [["Focus mode", "Ctrl+."], ["New line in a message", "Shift+Enter"], ["This list", "?"], ["Close anything", "Esc"]];
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

/* A Trunk's or a room's own conversation gets its items from flows/trunk.js; pinning any other conversation stays greyed. */
function chatMenu() {
  return chatMenuTop() + (trunkMenu() || mi("pin-conv", "pin", t("window.shell.extras.pin-to-top"))) + mi("call", "wave", t("window.shell.extras.talk-out-loud")) + mi("inspect", "eye", t("window.shell.extras.look-inside-the-last-reply")) + mi("export-conv", "copy", t("window.shell.extras.export-conversation")) + trunkMenuEnd();
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

async function exportConversation() {
  closePop();
  if (!S.chat) return;
  const id = encodeURIComponent(S.chat), desktop = typeof window.branchDesktop?.exportConversation === "function";
  await Promise.all([toDocuments(id), desktop ? toFile(id) : null].map((job) => Promise.resolve(job).catch((error) => toast(error.message))));
}

const typing = (e) => e.target.closest?.("input, textarea, select, [contenteditable]");

export function initExtras() {
  markLive(["gwpop", "sw:gwpop-sw", "shortcuts", "chatmenu", "export-conv", "key15", "keyreset15"]);
  initMachines();
  initFileView();
  on("gwpop", (el) => openGateway(el));
  document.addEventListener("change", (e) => { if (e.target.id === "gwpop-sw") setGateway(e.target.checked ? "on" : "off"); });
  on("shortcuts", () => showShortcuts());
  on("key15", (el) => { listening = el.dataset.v; showShortcuts(); });
  on("keyreset15", (el) => putBack(el.dataset.v));
  on("chatmenu", (el) => (S.chat ? openPop(el, chatMenu(), { right: true }) : null));
  on("export-conv", () => exportConversation());
  document.addEventListener("keydown", takeKeys, true);
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "appearance")) { e.preventDefault(); S.view = "settings"; closePop(); renderNow(); }
    else if (e.key === "?" && !typing(e) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showShortcuts(); }
  });
}
