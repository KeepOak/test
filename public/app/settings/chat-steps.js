/* Settings › Chat apps › Show steps in chats: how the steps message looks, for every chat app and for each connected
   one (src/channels/steps-display.ts, read from GET /api/channels `steps`, saved with POST /api/channels/steps one knob
   at a time). How much each step says, one message or one a step, commands as code, what a long list does, removing
   the message after a good answer, apps that cannot edit, groups, and pictures of Branch's browser while a task works in it. Each connected app can follow every app or have
   its own amount of detail, and its line says what it will show there (the engine's words). Every word goes through
   t(); a switch keeps its English title (its id is made from it) and shows through say(). */

import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { sw15, sec15, seg15 } from "./rows15.js";
import { t } from "../../i18n.js";

const COMMANDS = "Show commands as code", CLEANUP = "Remove the steps after a good answer", GROUPS = "Step counts in groups";
const PICTURES = "Pictures of the browser", PICTURES_SUB = "While a task works in Branch's browser, a picture of the page now and then, with password boxes covered. Never in a group.";
const SW = { "f15-show-commands-as-code": ["commands", "show", "hide"], "f15-remove-the-steps-after-a-good-answer": ["cleanup", true, false],
  "f15-step-counts-in-groups": ["groups", "kinds", "off"], "f15-pictures-of-the-browser": ["pictures", "browser", "off"] };
const detailChoices = () => [["new", t("window.chat-steps.detail-new")], ["all", t("window.chat-steps.detail-all")], ["verbose", t("window.chat-steps.detail-verbose")]];

/* The card, under the "Show steps in chats" switch while it is on. The finer knobs show from the Advanced level. */
export function stepsCard(state, level) {
  const steps = state.steps, all = steps?.settings?.all ?? {};
  if (!steps || state.live?.steps === "off") return "";
  const knob = (field, fallback) => all[field] ?? fallback;
  let body = seg15(t("window.chat-steps.detail"), t("window.chat-steps.detail-hint"), detailChoices(), knob("detail", "all"), "cs-detail")
    + sw15(PICTURES, PICTURES_SUB, knob("pictures", "browser") === "browser");
  if (level >= 1) {
    body += seg15(t("window.chat-steps.grouping"), t("window.chat-steps.grouping-hint"),
      [["one", t("window.chat-steps.grouping-one")], ["each", t("window.chat-steps.grouping-each")]], knob("grouping", "one"), "cs-grouping")
      + sw15(COMMANDS, "Each command shows as code with a copy button; off, the line only says a command ran.", knob("commands", "show") === "show")
      + seg15(t("window.chat-steps.overflow"), t("window.chat-steps.overflow-hint"),
        [["roll", t("window.chat-steps.overflow-roll")], ["trim", t("window.chat-steps.overflow-trim")]], knob("overflow", "roll"), "cs-overflow")
      + sw15(CLEANUP, "Once the answer arrives, the steps message is removed where the app allows it. A task that went wrong keeps it.", knob("cleanup", false) === true)
      + seg15(t("window.chat-steps.no-edit"), t("window.chat-steps.no-edit-hint"),
        [["summary", t("window.chat-steps.no-edit-summary")], ["each", t("window.chat-steps.grouping-each")], ["off", t("accounts.switch.off")]], knob("noEdit", "summary"), "cs-noedit")
      + sw15(GROUPS, "In a group, a short message counts the kinds of step and never names a file or command.", knob("groups", "kinds") === "kinds")
      + `<div class="ctl"><b>${esc(t("window.chat-steps.line"))}</b><span class="right num15"><input class="inp" id="cs-line" inputmode="numeric" value="${esc(knob("lineChars", 120))}" aria-label="${esc(t("window.chat-steps.line"))}"><small>${esc(t("window.chat-steps.characters"))}</small></span><small>${esc(t("window.chat-steps.line-hint"))}</small></div>`;
    const apps = (steps.apps ?? []).map((app) => {
      const own = steps.settings?.apps?.[app.id]?.detail ?? "";
      const opts = [["", t("window.chat-steps.same-as-all")], ["off", t("accounts.switch.off")], ...detailChoices()];
      return `<div class="ctl"><b>${esc(app.name)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(t("window.chat-steps.app-detail", { name: app.name }))}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${own === v}" data-act="cs-app" data-v="${esc(`${app.id}:${v}`)}">${esc(l)}</button>`).join("")}</span></span><small>${esc(app.shows)}</small></div>`;
    }).join("");
    if (apps) return sec15(t("window.chat-steps.title"), body) + sec15(t("window.chat-steps.each-app"), apps);
  }
  return sec15(t("window.chat-steps.title"), body);
}

async function save(change, reload) {
  try { await api("channels/steps", change); } catch (error) { toast(error.message); }
  await reload();
}
export function initSteps(reload) {
  markLive(["cs-detail", "cs-grouping", "cs-overflow", "cs-noedit", "cs-app", "sw:cs-line", ...Object.keys(SW).map((id) => "sw:" + id)]);
  on("cs-detail", (el) => save({ all: { detail: el.dataset.v } }, reload));
  on("cs-grouping", (el) => save({ all: { grouping: el.dataset.v } }, reload));
  on("cs-overflow", (el) => save({ all: { overflow: el.dataset.v } }, reload));
  on("cs-noedit", (el) => save({ all: { noEdit: el.dataset.v } }, reload));
  on("cs-app", (el) => {
    const at = el.dataset.v.lastIndexOf(":"), app = el.dataset.v.slice(0, at), detail = el.dataset.v.slice(at + 1);
    save({ apps: { [app]: detail ? { detail } : null } }, reload);
  });
  document.addEventListener("change", (e) => {
    const sw = SW[e.target.id];
    if (sw) save({ all: { [sw[0]]: e.target.checked ? sw[1] : sw[2] } }, reload);
    else if (e.target.id === "cs-line") {
      const typed = Number(e.target.value.trim());
      if (Number.isInteger(typed) && typed >= 40 && typed <= 400) save({ all: { lineChars: typed } }, reload);
      else { toast(t("window.chat-steps.line-range")); render(); }
    }
  });
}
