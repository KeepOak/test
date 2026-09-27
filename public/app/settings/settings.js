/* Settings area: one nav panel, one page at a time. Every page is in pages/<id>.js; parts.js has shared helpers.
   Search uses a module variable (not S.setQ) to persist between draws without rebuilding state. */

import { $, esc, renderNow, paint } from "../core/dom.js";
import { S, E, level, save } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { ic, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";

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

/* A page starts (registers its actions, fetches its data) the first time it is opened after sign-in, and re-reads its
   data each time it is opened again; nothing is fetched before the engine has accepted the window. A page that draws a
   choice from what the engine keeps (waitFirst) is shown once its read has come back, so it never shows none pressed. */
const started = new Set();
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
  notice(id);
  const reading = open(id);
  if (PAGES[id]?.waitFirst) await reading;
  if (asked !== id) return;
  S.setPage = id;
  renderNow();
}

export function draw() {
  const lv = level();
  if (!started.has(S.setPage)) open(S.setPage);
  const q = searchText.trim().toLowerCase();
  const extra = [lv >= 1 ? ["advanced", t("settings.page.advanced")] : null, lv >= 2 ? ["developer", t("settings.card.developer")] : null].filter(Boolean);
  const groups = NAV.map(([g, items]) => [g, g === "Care" ? [...items, ...extra] : items])
    .map(([g, items]) => [g, items.filter(([, l]) => !q || say(l).toLowerCase().includes(q))])
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
  const pageContent = page?.draw?.() ?? "";

  return `<div class="settings">
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
    open(S.setPage);
    renderNow();
  });

  on("setlevel", (el) => {
    S.level = el.dataset.v;
    save(); // the level is one of the window's kept choices (core/state.js SAVED)
    renderNow();
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
  markLive(["setpage", "setgo", "setlevel", "sw:set-q", ...live]);
}

export function after(main) {

  for (const page of Object.values(PAGES)) page.after?.($(".set-col", main));
}
