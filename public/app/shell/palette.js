/* Ctrl K, 1:1 with the prototype's palette: one box that finds an action, a conversation (the engine's list), a place
   a settings page or any row on one (settings/find.js), moved through with the arrows and opened with Enter. Only actions this window answers to are
   offered. Dogfood D13: it also finds words inside conversations (a reply's too) and Library documents by name or words,
   from the engine's own search (GET /api/search, asked once typing pauses): a message opens its conversation with the
   words found, a document opens to read (places/docread.js). */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { S, E, ownName, chatFace } from "../core/state.js";
import { setLockdown } from "../chat/approvals.js";
import { on, run, has } from "../core/actions.js";
import { markLive, isLive } from "../core/features.js";
import { app, ic, closePop, closeDlg, toast } from "../core/ui.js";
import { openConversation, startFresh } from "../chat/chat.js";
import { api } from "../core/api.js";
import { FIND } from "../chat/find.js";
import { plain } from "../chat/markdown.js";
import { openDocument } from "../places/docread.js";
import { NAV, findSettings, openSetting } from "../settings/settings.js";
import { pressed, binding, spoken } from "./keys.js";
import { PLACES } from "./shell.js"; // every place the sidebar lists, Team included
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { allOf } from "../chat/putaway.js";

const P = { el: null, sel: 0, items: [], archived: [], opened: 0, asked: -1 };
/* What the engine found for the words last asked: its conversation and document hits (owner only; anybody else is refused
   the search, and then only the lists below are searched). */
const PQ = { q: "", hits: [], timer: null };
const go = (label, sub, icon, fn) => ({ label, sub, icon, fn });
const ACTIONS = [["Switch light or dark", "", "moon", "theme-flip"], ["Focus mode", "Ctrl .", "eye", "focus"], ["Keyboard shortcuts", "?", "keyboard", "shortcuts"],
  ["Replay the first run", "", "spark", "firstrun"], ["Browse skins", "", "sun", "skins"], ["Take the tour", "", "spark", "tour"]];
function openPage(id) {
  const b = document.createElement("button");
  b.dataset.v = id;
  S.view = "settings";
  run("setpage", b);
}

/* A conversation's line, as the prototype's: a room is "Room", a Trunk's own shows what the Trunk is for (its description),
   anything else is the assistant on this computer. */
function convo(s) {
  const id = s.sessionId ?? s.id, face = chatFace(id), room = face.kind === "room";
  const sub = room ? t("window.settings.advanced.room") : face.kind === "main" ? t("window.chat.plus.assistant") : String(face.description ?? "").split(/\r?\n/)[0].slice(0, 60);
  return go(ownName(id) || s.opening || s.title || "", sub, room ? "room" : "chat", () => openConversation(id));
}
/* An archived conversation is found too, marked Archived (GET /api/sessions/put-away?kind=archived, read once typing starts). */
const archivedConvo = (row) => go(ownName(row.sessionId) || row.title || row.opening || "", t("window.chat.putaway.archived"), "folder", () => openConversation(row.sessionId));
/* "Turn Lockdown on" only while it is off: turning it off loosens, which stays with its own banner (chat/approvals.js). */
const lockdownOn = () => (document.getElementById("app")?.classList.contains("locked") ? [] : [go(t("dashboard.controls.lockdownOn"), "", "lock", () => setLockdown(true))]);

/* Words inside conversations and Library documents, from the engine's search for exactly the words in the box. */
function engineHits(q) {
  if (!q || PQ.q !== q) return [[], []];
  const idOf = (h) => String(h.link ?? "").split("/").pop();
  const titleOf = (id) => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return ownName(id) || s?.title || plain(s?.opening) || ""; };
  const seen = new Set();
  const messages = PQ.hits.filter((h) => h.kind === "conversation" && idOf(h) && !seen.has(idOf(h)) && seen.add(idOf(h)))
    .map((h) => ({ ...go(titleOf(idOf(h)) || plain(h.snippet).slice(0, 60), plain(h.snippet).slice(0, 80), "chat", () => { Object.assign(FIND, { on: true, q, i: 0 }); openConversation(idOf(h)); }), found: true }));
  const docs = PQ.hits.filter((h) => h.kind === "document" && idOf(h))
    .map((h) => ({ ...go(h.title ?? "", plain(h.snippet).slice(0, 80), "doc", () => openDocument(idOf(h))), found: true }));
  return [messages, docs];
}
function askEngine(value) {
  clearTimeout(PQ.timer);
  const q = value.trim();
  if (q.length < 2) return;
  PQ.timer = setTimeout(async () => {
    const got = await api("search?q=" + encodeURIComponent(q)).catch(() => null);
    if (!P.el || $("#pal-in")?.value.trim() !== q) return;
    Object.assign(PQ, { q, hits: got?.results ?? [] });
    paint($("#pal-in").value);
  }, 220);
}

function all(searching, q = "") {
  const [messages, docs] = engineHits(q);
  const actions = [go(t("comfort.field.newConversation"), spoken(binding("newConversation")), "chat", () => startFresh()),
    ...(has("new-trunk") && isLive("new-trunk") ? [go(t("studio.newName"), "", "plus", () => run("new-trunk"))] : []), ...lockdownOn(),
    ...ACTIONS.filter(([, , , a]) => has(a) && isLive(a)).map(([l, sub, i, a]) => go(say(l), sub, i, () => run(a)))];
  return [
    [t("terminal.palette.actions"), actions],
    [t("people.home.list"), [...E.sessions.map(convo), ...(searching ? P.archived.map(archivedConvo) : [])]],
    [t("window.shell.search.messages"), messages],
    [t("nav.documents"), docs],
    [t("ew.places"), PLACES.map(([v, i, l]) => go(say(l), t("window.shell.palette.place"), i, () => { S.view = v; renderNow(); }))],
    [t("memory.movein.kind.setting"), [...NAV.flatMap((g) => g[1]).map(([id, l]) => go(say(l), t("memory.movein.kind.setting"), "gear", () => openPage(id))),
      /* Every settings row too (settings/find.js), the owner's only: a row opens its page and is marked there. */
      ...findSettings(q, 8).map((row) => ({ ...go(row.title, [row.pageName, row.card].filter(Boolean).join(" › "), "gear", () => openSetting(row)), found: true }))]],
  ];
}

function paint(q) {
  const ql = q.trim().toLowerCase();
  P.items = [];
  let html = "";
  for (const [group, items] of all(!!ql, q.trim())) {
    const found = items.filter((i) => i.label && (i.found || !ql || i.label.toLowerCase().includes(ql) || i.sub.toLowerCase().includes(ql)));
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
  P.el.innerHTML = `<div class="palette" role="dialog" aria-label="${t("comfort.field.palette")}"><div class="pin-in">${ic("search")}<input id="pal-in" placeholder="${t("window.shell.palette.find-a-trunk-a-conversation-a")}" aria-label="${t("comfort.field.palette")}" autocomplete="off"></div><div class="pal-list" id="pal-list" role="listbox" aria-label="${t("comfort.field.palette")}"></div><div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> ${t("window.shell.palette.move")}</span><span><kbd>Enter</kbd> ${t("window.shell.palette.open")}</span><span><kbd>Esc</kbd> ${t("window.shell.palette.close")}</span></div></div>`;
  app().appendChild(P.el);
  paint("");
  $("#pal-in").focus();
}
/* Archived conversations are read once per opening, when the first words are typed, and only for whoever is at the
   window then: an answer for an earlier opening, or for another profile, is dropped. */
function loadArchived() {
  if (P.asked === P.opened) return;
  const opened = (P.asked = P.opened), who = E.profiles?.active?.id ?? null;
  if (!E.putAway?.archived) return;
  allOf("archived").then((rows) => {
    if (opened !== P.opened || who !== (E.profiles?.active?.id ?? null)) return;
    P.archived = rows;
    if ($("#pal-in")?.value.trim()) paint($("#pal-in").value);
  }, (error) => { if (opened === P.opened) toast(error.message); });
}
/* Closing forgets what the last opening read, so the next one never shows it. */
export function closePalette() { P.el?.remove(); P.el = null; P.opened++; P.archived = []; }

function pick(n) {
  const item = P.items[n];
  closePalette();
  item?.fn();
}

export function initPalette() {
  markLive(["palette", "pal", "sw:pal-in"]);
  on("palette", () => openPalette());
  on("pal", (el) => pick(+el.dataset.i));
  document.addEventListener("input", (e) => { if (e.target.id === "pal-in") { P.sel = 0; paint(e.target.value); askEngine(e.target.value); if (e.target.value.trim()) loadArchived(); } });
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "palette")) { e.preventDefault(); openPalette(); return; }
    if (!P.el) return;
    if (e.key === "Escape") { e.stopPropagation(); closePalette(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); P.sel = Math.max(0, Math.min(P.items.length - 1, P.sel + (e.key === "ArrowDown" ? 1 : -1))); paint($("#pal-in").value); }
    else if (e.key === "Enter" && e.target.id === "pal-in") { e.preventDefault(); pick(P.sel); }
  }, true);
  document.addEventListener("pointerdown", (e) => { if (P.el && e.target === P.el) closePalette(); });
}
