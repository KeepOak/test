/* Settings › General, 1:1 with the prototype's page. Whether Branch starts with Windows and keeps working with the
   window closed are the engine's (GET /api/deployment autostart, daemon), shown and greyed: changing them changes this
   computer's own start-up. The projects are the engine's (places/project.js: GET /api/projects, each with its conversation
   count, and Edit opens that project's instructions editor); every other
   row is drawn in place and greyed until its engine setting is wired. */
import { esc, renderNow } from "../../core/dom.js";
import { level, projectName, ownerHere } from "../../core/state.js";
import { api } from "../../core/api.js";
import { toast } from "../../core/ui.js";
import { ctl, ctlSeg } from "../parts.js";
import { startKey, startsWithWindows } from "../signin.js";
import { t } from "../../../i18n.js";
import { P, loadProjects as readProjects, conversationsWord } from "../../places/project.js"; // area projects: counts and the editor

let deployment = null;

async function loadProjects() {
  try {
    const [, d] = await Promise.all([ownerHere() ? readProjects() : null, api("deployment")]);
    deployment = d;
  } catch (error) { toast(error.message); }
  renderNow();
}

const FOLDER = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"></path></svg>';
const project = (p) => `<div class="prow"><span class="ico-tile">${FOLDER}</span><span class="grow"><b>${esc(projectName(p))}</b><small>${[conversationsWord(p.id), p.instructions ? t("window.settings.general.its-own-instructions") : ""].filter(Boolean).join(" · ")}</small></span><button class="btn sm" type="button" data-act="proj-edit" data-v="${esc(p.id)}">${t("prompts.action.edit")}</button></div>`;
const num = (id, title, sub, unit) => `<div class="ctl"><b>${esc(title)}</b><span class="right num15"><input class="inp" id="${id}" aria-label="${esc(title)}" data-sw="set"><small>${esc(unit)}</small></span><small>${esc(sub)}</small></div>`;

function advanced() {
  return `<div class="sec x15-sec"><h2>${t("onscreen.group.middle")}</h2>${ctl("f15-vim-keys-in-the-message-box", t("comfort.field.vim"), t("window.settings.general.normal-and-insert-modes-for-people"), false)}${ctlSeg(t("window.settings.general.message-times"), t("window.settings.general.when-a-message-was-sent-and"), [t("window.settings.general.on-hover"), t("window.places.automations.always"), t("window.settings.advanced.never")], "")}</div>
    <div class="sec x15-sec"><h2>${t("window.settings.general.summaries-of-older-turns")}</h2>${ctl("f15-summarise-older-turns-by-themselves", t("window.settings.general.summarise-older-turns-by-themselves"), t("window.settings.general.keeps-long-conversations-fast-the-summary"), false)}${num("f15-summarise-when", t("window.settings.general.summarise-when-its-this-full"), t("window.settings.general.of-the-models-room-for-this"), "%")}${num("f15-keep-latest", t("window.settings.general.always-keep-the-latest"), t("window.settings.general.messages-kept-word-for-word"), "messages")}</div>`;
}

function technical() {
  return `<div class="sec x15-sec"><h2>${t("window.settings.general.summaries-technical")}</h2>${ctlSeg(t("window.settings.general.room-to-plan-for"), t("window.settings.general.overrides-what-the-model-says-it"), [t("window.settings.general.models-own"), "128k", "200k", "1M"], "")}${ctl("f15-repair-the-history-before-each-call", t("window.settings.general.repair-the-history-before-each-call"), t("window.settings.general.fixes-a-broken-tool-call-or"), false)}</div>`;
}

export function draw() {
  const lv = level(), starts = !!deployment?.autostart?.enabled, platform = deployment?.platform;
  return `<h1>${t("settings.page.general")}</h1><p class="lede">${t("window.settings.general.how-branch-starts-and-behaves-on")}</p>
    ${starts && startsWithWindows(platform) ? `<div class="status"><span class="sdot "></span><div><b>${t("window.settings.general.branch-starts-with-windows")}</b><p>${t("window.settings.general.it-waits-in-the-tray-and")}</p></div></div>` : ""}
    <div class="sec"><h2>${t("window.settings.general.starting-up")}</h2>${ctl("g-start", t(startKey(platform)), t("window.settings.general.opens-quietly-in-the-tray"), starts)}${ctl("g-tray", t("window.settings.general.keep-working-when-the-window-closes"), t("window.settings.general.trunks-finish-what-they-started"), !!deployment?.daemon?.installed)}</div>
    <div class="sec"><h2>${t("memory.movein.kind.project")}</h2><div class="rows">${ownerHere() ? P.all.map(project).join("") : ""}</div></div>
    <div class="sec"><h2>${t("window.settings.general.keyboard")}</h2><div class="ctl"><b>${t("comfort.keys.title")}</b><span class="right"><button class="btn sm" type="button" data-act="shortcuts">${t("window.settings.general.show-all")}</button></span><small>${t("window.settings.general.ctrl-k-to-find-anything-ctrl")}</small></div></div>
    ${lv >= 1 ? advanced() : ""}${lv >= 2 ? technical() : ""}`;
}

export function init() { loadProjects(); }

export function load() { return loadProjects(); }

export const live = {};
