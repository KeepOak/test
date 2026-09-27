/* Ctrl K, 1:1 with the prototype's palette: one box that finds an action, a conversation (the engine's list), a place
   or a settings page, moved through with the arrows and opened with Enter. Only actions this window answers to are
   offered. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { S, E, ownName } from "../core/state.js";
import { on, run, has } from "../core/actions.js";
import { markLive, isLive } from "../core/features.js";
import { app, ic, closePop, closeDlg } from "../core/ui.js";
import { openConversation, startConversation } from "../chat/chat.js";
import { NAV } from "../settings/settings.js";
import { pressed, binding, spoken } from "./keys.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

const P = { el: null, sel: 0, items: [] };
const PLACES = [["overview", "Overview", "home"], ["inbox", "Inbox", "inbox"], ["automations", "Automations", "clock"], ["library", "Library", "book"], ["customize", "Customize", "sliders"]];
const go = (label, sub, icon, fn) => ({ label, sub, icon, fn });
const ACTIONS = [["Switch light or dark", "", "moon", "theme-flip"], ["Focus mode", "Ctrl .", "eye", "focus"], ["Keyboard shortcuts", "?", "keyboard", "shortcuts"],
  ["Replay the first run", "", "spark", "firstrun"], ["Browse skins", "", "sun", "skins"], ["Take the tour", "", "spark", "tour"]];
function openPage(id) {
  const b = document.createElement("button");
  b.dataset.v = id;
  S.view = "settings";
  run("setpage", b);
}

function all() {
  const actions = [go(t("comfort.field.newConversation"), spoken(binding("newConversation")), "chat", () => startConversation()),
    ...ACTIONS.filter(([, , , a]) => has(a) && isLive(a)).map(([l, sub, i, a]) => go(say(l), sub, i, () => run(a)))];
  return [
    [t("terminal.palette.actions"), actions],
    [t("people.home.list"), E.sessions.map((s) => go(ownName(s.sessionId ?? s.id) || s.opening || s.title || "", "", "chat", () => openConversation(s.sessionId ?? s.id)))],
    [t("ew.places"), PLACES.map(([v, l, i]) => go(say(l), t("window.shell.palette.place"), i, () => { S.view = v; renderNow(); }))],
    [t("memory.movein.kind.setting"), NAV.flatMap((g) => g[1]).map(([id, l]) => go(say(l), t("memory.movein.kind.setting"), "gear", () => openPage(id)))],
  ];
}

function paint(q) {
  const ql = q.trim().toLowerCase();
  P.items = [];
  let html = "";
  for (const [group, items] of all()) {
    const found = items.filter((i) => i.label && (!ql || i.label.toLowerCase().includes(ql) || i.sub.toLowerCase().includes(ql)));
    if (!found.length) continue;
    html += `<div class="ph">${esc(group)}</div>`;
    for (const i of found) {
      const n = P.items.push(i) - 1;
      html += `<button class="mi" type="button" role="option" data-act="pal" data-i="${n}" aria-selected="${n === P.sel}"><span class="ico">${ic(i.icon, "s")}</span><span class="mi-t">${esc(i.label)}</span><span class="r">${esc(i.sub)}</span></button>`;
    }
  }
  const list = $("#pal-list");
  list.innerHTML = html || `<p class="empty" data-css="padding:20px">${t("window.shell.palette.nothing-matches-try-a-trunks-name")}</p>`;
  applyCss(list);
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

export function openPalette() {
  closePop();
  closeDlg();
  closePalette();
  P.sel = 0;
  P.el = Object.assign(document.createElement("div"), { className: "scrim top" });
  P.el.innerHTML = `<div class="palette" role="dialog" aria-label="${t("comfort.field.palette")}"><div class="pin-in">${ic("search")}<input id="pal-in" placeholder="${t("window.shell.palette.find-a-trunk-a-conversation-a")}" aria-label="${t("comfort.field.palette")}" autocomplete="off"></div><div class="pal-list" id="pal-list" role="listbox"></div><div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> ${t("window.shell.palette.move")}</span><span><kbd>Enter</kbd> ${t("window.shell.palette.open")}</span><span><kbd>Esc</kbd> ${t("window.shell.palette.close")}</span></div></div>`;
  app().appendChild(P.el);
  paint("");
  $("#pal-in").focus();
}
export function closePalette() { P.el?.remove(); P.el = null; }

function pick(n) {
  const item = P.items[n];
  closePalette();
  item?.fn();
}

export function initPalette() {
  markLive(["palette", "pal", "sw:pal-in"]);
  on("palette", () => openPalette());
  on("pal", (el) => pick(+el.dataset.i));
  document.addEventListener("input", (e) => { if (e.target.id === "pal-in") { P.sel = 0; paint(e.target.value); } });
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "palette")) { e.preventDefault(); openPalette(); return; }
    if (!P.el) return;
    if (e.key === "Escape") { e.stopPropagation(); closePalette(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); P.sel = Math.max(0, Math.min(P.items.length - 1, P.sel + (e.key === "ArrowDown" ? 1 : -1))); paint($("#pal-in").value); }
    else if (e.key === "Enter" && e.target.id === "pal-in") { e.preventDefault(); pick(P.sel); }
  }, true);
  document.addEventListener("pointerdown", (e) => { if (P.el && e.target === P.el) closePalette(); });
}
