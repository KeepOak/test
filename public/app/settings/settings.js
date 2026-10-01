/* Settings area: one nav panel, one page at a time. Every page is in pages/<id>.js; parts.js has shared helpers.
   Search uses a module variable (not S.setQ) to persist between draws without rebuilding state. */

import { $, esc, renderNow, paint, afterDraw } from "../core/dom.js";
import { S, E, level, save, ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { ic, closePop } from "../core/ui.js";
import { calm17 } from "../core/art17.js";
import { ROWS, rowKey, indexFor, forgetIndex, search } from "./find.js";
import { answers } from "../core/api.js";
import { markLive } from "../core/features.js";
import { lockBanner } from "../chat/dockinfo.js"; // shell-031: Lockdown's banner above Settings too, as on every place

/* Import every page */
import * as general from "./pages/general.js";
import * as people from "./pages/people.js";
import * as appearance from "./pages/appearance.js";
import * as notifications from "./pages/notifications.js";
import * as instructions from "./pages/instructions.js";
import * as models from "./pages/models.js";
import * as local from "./pages/local.js";
import * as accounts from "./pages/accounts.js";
import * as voice from "./pages/voice.js";
import * as permissions from "./pages/permissions.js";
import * as computer from "./pages/computer.js";
import * as secrets from "./pages/secrets.js";
import * as usage from "./pages/usage.js";
import * as gateway from "./pages/gateway.js";
import * as updates from "./pages/updates.js";
import * as advanced from "./pages/advanced.js";
import * as developer from "./pages/developer.js";
import * as achievements from "./pages/achievements.js";
import * as self from "./pages/self.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { levelChosen } from "../shell/simple.js"; // RES-704: the Simple / Advanced switch remembers the advanced level
import * as chatapps from "./pages/chatapps.js"; // pass 17 part D §8
import * as data from "./pages/data.js"; // privacy: Settings › Your data
import { noticed } from "../shell/scene.js";
import { initKit } from "./kit17.js";
import { initDemosB5 } from "./demos-b5.js";

const PAGES = {
  general, people, appearance, notifications, instructions, models, local,
  accounts, voice, permissions, computer, secrets, usage, gateway, updates,
  advanced, developer, achievements, self, chatapps, data
};

/* Whether the window has a Settings page by this id (an engine command may name one). */
export const hasPage = (id) => Object.hasOwn(PAGES, id);

/* Pass 18: five plain groups (You, Assistant, Reach, Safety, Care); the pages "How much to show" adds join Care. */
export const NAV = [
  ["You", [["general", "General"], ["people", "People"], ["appearance", "Appearance"], ["notifications", "Notifications"], ["achievements", "Achievements"]]],
  ["Assistant", [["instructions", "Instructions & personality"], ["models", "Models"], ["accounts", "Accounts"], ["local", "On this computer"], ["voice", "Voice"]]],
  ["Reach", [["chatapps", "Chat apps"], ["gateway", "Gateway"]]],
  ["Safety", [["permissions", "Permissions"], ["computer", "Computer & browser"], ["secrets", "Saved sign-ins"]]],
  ["Care", [["usage", "Data & usage"], ["data", "Your data"], ["self", "Branch itself"], ["updates", "Updates & about"]]]
];

let searchText = "";

/* Settings search (settings/find.js): every page's rows, the owner's only. The pages not opened yet are started once, the
   first time something is searched, so the rows waiting on the engine can be found too. */
const pageName = (id) => id === "advanced" ? t("settings.page.advanced") : id === "developer" ? t("settings.card.developer")
  : say(NAV.flatMap(([, items]) => items).find(([p]) => p === id)?.[1] ?? id);
function indexPages() {
  return [...NAV.flatMap(([, items]) => items.map(([id]) => id)), "advanced", "developer"].map((id) => ({
    id, name: pageName(id), least: id === "advanced" ? 1 : id === "developer" ? 2 : 0, draw: () => PAGES[id].draw(),
    tabs: id === "models" ? models.TAB_LIST().map((tab) => ({ ...tab, draw: () => models.drawTab(tab.id) })) : undefined,
  }));
}
let primed = false;
export function primeSearch() {
  if (primed || !E.loaded || !ownerHere()) return;
  primed = true;
  for (const id of Object.keys(PAGES)) if (!started.has(id)) open(id);
}
/** The settings rows matching `text`, best first; none for anybody but the owner (never a setting of the owner's). */
export function findSettings(text, limit) {
  if (!ownerHere() || !text.trim()) { forgetIndex(); return []; }
  primeSearch();
  const key = [E.state, E.profiles, answers.n, document.documentElement.lang, S.level, S.setPage];
  return search(indexFor(indexPages(), key), text, limit);
}
let hits = [];

/* A found row: its page (and tab) opened at a level that shows it, then the row scrolled to and marked until it is left. */
let jumping = null, marked = null;
export async function openSetting(row) {
  searchText = "";
  S.view = "settings";
  closePop();
  if (level() < row.level) { S.level = ["regular", "advanced", "technical"][row.level]; levelChosen(S.level); save(); }
  if (row.tab) models.showTab(row.tab);
  jumping = { ...row, until: Date.now() + 5000 }; // set before the page is drawn: a redraw with nothing new calls no after()
  await go(row.page);
}
function land(col) {
  const want = jumping ?? marked;
  if (!want || !col || S.setPage !== want.page) return;
  const key = `${want.card}\u001f${want.title}`;
  const row = [...col.querySelectorAll(ROWS)].find((el) => rowKey(el) === key);
  if (!row) { if (jumping && Date.now() > jumping.until) jumping = null; return; }
  row.classList.add("found18");
  if (!jumping) return;
  jumping = null;
  marked = want;
  row.classList.add("in18"); // the brief glow plays once, when the row is reached, never on a later redraw
  row.scrollIntoView({ block: "center", behavior: calm17() ? "auto" : "smooth" });
  row.querySelector("input,button,select,textarea")?.focus({ preventScroll: true });
}

const hitRow = (row, i) => `<li><button class="set-hit" type="button" data-act="sethit" data-i="${i}"${row.note ? ` data-tip="${esc(row.note)}"` : ""}><b>${esc(row.title)}</b><small>${esc([row.pageName, row.tabName, row.card].filter(Boolean).join(" › "))}</small>${row.level > level() ? `<span class="pill idle">${esc(row.level === 2 ? t("settingsGrown.level.technical") : t("settings.page.advanced"))}</span>` : ""}</button></li>`;
function found(q, rows) {
  hits = rows.slice(0, 40);
  return hits.length ? `<ul class="set-found" aria-label="${esc(t("window.settings.settings.found", { query: q.trim() }))}">${hits.map(hitRow).join("")}</ul>`
    : `<p class="hint set-none">${t("window.settings.settings.nothing-found")}</p>`;
}

/* A page starts (registers its actions, fetches its data) the first time it is opened after sign-in, and re-reads its
   data each time it is opened again; nothing is fetched before the engine has accepted the window. A page that draws a
   choice from what the engine keeps (waitFirst) is shown once its read has come back, so it never shows none pressed. */
const started = new Set();
let shownPage = null; // cleared outside Settings: returning through the gear must read the page again
function open(id) {
  const page = PAGES[id];
  if (!page || !E.loaded) return undefined;
  if (!started.has(id)) { started.add(id); return page.init?.(); }
  return page.load?.();
}
/* Each page opened is told to the engine once per session, for the "Every page" achievements (shell/scene.js noticed:
   POST /api/delight/noticed { what: "page" }, sent only while achievements are on; the engine keeps only what is new). */
const told = new Set();
function notice(id) {
  // Before the window is let in there is nothing to tell (and every request is refused); the page is told when opened.
  if (told.has(id) || !hasPage(id) || !E.loaded) return;
  told.add(id);
  noticed({ what: "page", page: id });
}
/* Only the latest choice is shown: a page still reading when another is picked does not pull the person back. */
let asked = null;
async function go(id) {
  asked = id;
  searchText = ""; // a page asked for is shown, never the rows an earlier search found
  marked = null;
  notice(id);
  const reading = open(id);
  if (PAGES[id]?.waitFirst) await reading;
  if (asked !== id) return;
  shownPage = id;
  S.setPage = id;
  renderNow();
}
/** A Settings page opened from elsewhere (an engine command's or a link's home, chat/goto.js) goes the way the page list
    goes: a page drawn from what the engine keeps (waitFirst) is shown once its read is back. */
export const openPage = (id) => go(id);

export function draw() {
  const lv = level();
  if (!started.has(S.setPage) || shownPage !== S.setPage) {
    shownPage = S.setPage; // before reading: a read may schedule another draw
    open(S.setPage);
  }
  const q = searchText.trim().toLowerCase();
  const rows = findSettings(searchText); // none, and the index let go, while the box is empty
  const extra = [lv >= 1 ? ["advanced", t("settings.page.advanced")] : null, lv >= 2 ? ["developer", t("settings.card.developer")] : null].filter(Boolean);
  const groups = NAV.map(([g, items]) => [g, g === "Care" ? [...items, ...extra] : items])
    .map(([g, items]) => [g, items.filter(([id, l]) => !q || say(l).toLowerCase().includes(q) || rows.some((r) => r.page === id))])
    .filter(([, items]) => items.length);
  if ((S.setPage === "advanced" && lv < 1) || (S.setPage === "developer" && lv < 2)) S.setPage = "general";

  const nav = groups
    .map(([g, items]) =>
      `<div class="grp">${esc(say(g))}</div>${items
        .map(([id, l]) => `<button class="nav" type="button" data-act="setpage" data-v="${id}" aria-current="${S.setPage === id}">${esc(say(l))}</button>`)
        .join("")}`
    )
    .join("") || `<p class="hint" data-css="padding:0 10px">${t("window.settings.settings.no-page-matches")}</p>`;

  const page = PAGES[S.setPage];
  const pageContent = q && ownerHere() ? found(searchText, rows) : page?.draw?.() ?? "";

  return `${lockBanner()}<div class="settings">
    <nav class="set-nav" aria-label="${t("dashboard.pages.title")}">
      <button class="set-back" type="button" data-act="chat" ${S.chat ? `data-id="${esc(S.chat)}"` : ""}>${ic("back", "s")}${t("window.settings.settings.back-to-value", { value: esc(E.state?.identity?.name || "Branch") })}</button>
      <label class="set-search">${ic("search", "s")}<input id="set-q" placeholder="${t("settings.search")}" value="${esc(searchText)}" aria-label="${t("settings.search")}"></label>
      ${nav}
      <div class="set-level" data-css="display:grid;gap:6px">
        <span>${t("appearance.howMuch")}</span>
        <span class="seg" role="group" aria-label="${t("appearance.howMuch")}">
          ${[["regular", t("settingsGrown.level.regular")], ["advanced", t("settings.page.advanced")], ["technical", t("settingsGrown.level.technical")]]
            .map(([v, l]) => `<button type="button" data-act="setlevel" data-v="${v}" aria-pressed="${S.level === v}" data-tip="${
              v === "regular" ? t("settingsGrown.level.regular.note")
              : v === "advanced" ? t("settingsGrown.level.advanced.note")
              : t("window.settings.settings.file-paths-raw-keys-launch-variables")
            }">${esc(l)}</button>`)
            .join("")}
        </span>
      </div>
    </nav>
    <div class="set-page"><div class="set-col">${pageContent}</div></div>
  </div>`;
}

/* Where the person was before Settings (a conversation or a place), so Esc takes them back there: the "?" list's
   "Close anything: Esc" (QA pass 2). Read after every drawing, so it is whatever was last on screen outside Settings. */
let before = "chat";
afterDraw(() => { if (S.view !== "settings") { before = S.view; shownPage = null; } });
export function leaveSettings() {
  S.view = before;
  renderNow();
}

export function init() {
  if (has("setpage")) return;
  initKit();
  initDemosB5();
  notice(S.setPage);

  on("setpage", (el) => {
    closePop();
    go(el.dataset.v);
  });

  on("setgo", (el) => {
    S.view = "settings";
    closePop();
    go(el.dataset.v);
  });

  /* The status bar's update menu: close it and open Settings › Updates & about (navigation only). The menu is drawn
     by the shell (shell/usage.js), which marks the item live when it draws it. */
  on("updmenu-go", () => {
    closePop();
    S.view = "settings";
    S.setPage = "updates";
    searchText = "";
    shownPage = S.setPage;
    open(S.setPage);
    renderNow();
  });

  on("gw-restart", () => self.restart());

  on("setlevel", (el) => {
    S.level = el.dataset.v;
    levelChosen(S.level); // RES-704: an advanced level is remembered for the Simple switch, and leaves Simple
    save(); // the level is one of the window's kept choices (core/state.js SAVED)
    renderNow();
  });

  on("sethit", (el) => { const row = hits[Number(el.dataset.i)]; if (row) openSetting(row); });
  /* Enter in the search box opens the best row found. */
  document.addEventListener("keydown", (e) => {
    if (e.target?.id !== "set-q" || e.key !== "Enter" || !searchText.trim()) return;
    const best = findSettings(searchText, 1)[0];
    if (best) { e.preventDefault(); openSetting(best); }
  });

  on("set-q-input", (el) => {
    searchText = el.value;
    renderNow();
  });

  /* Delegate search input to avoid rebuilding the input itself on every keystroke. */
  document.addEventListener("input", (e) => {
    if (e.target.id === "set-q") {
      searchText = e.target.value;
      const pos = e.target.selectionStart;
      renderNow();
      const box = $("#set-q");
      box?.focus();
      box?.setSelectionRange(pos, pos);
    }
  });


  /* Mark the controls that are live. */
  const live = [];
  for (const page of Object.values(PAGES)) {
    live.push(...(page.live ? Object.keys(page.live) : []));
  }
  markLive(["setpage", "setgo", "setlevel", "sw:set-q", "sethit", ...live]);
}

export function after(main) {
  for (const page of Object.values(PAGES)) page.after?.($(".set-col", main));
  land($(".set-col", main));
}
