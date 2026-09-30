/* Settings › General, 1:1 with the prototype's page, from the engine:
   Starting up: GET /api/deployment (autostart, daemon). Start with Windows is POST /api/deployment/autostart { enabled };
   Keep working when the window closes is the same saved gateway mode used on Settings › Gateway and the footer;
   it never installs the separate scheduled daemon or claims the gateway is running until underGateway is true.
   Where Branch runs: "Add a computer" is Settings › Computer's own (flows/computers.js comp-add).
   Projects: places/project.js (GET /api/projects, each with its conversation count; Edit opens that project's
   instructions editor).
   The shared commands: the settings kit's command-catalog switch (kit17.js), which is this computer's own window's (the
   engine reads and saves it for the window alone, src/commands/settings.ts windowCommands); the phone and the chat apps
   keep theirs off, and the row says so.
   Summaries of older turns and the room to plan for are the engine's compaction knobs (POST /api/knobs { card:
   "compaction" }); repairing the history before each call is the kit's safety-history-repair switch.
   The conversation: vim keys in the message box and message times are the engine's comfort cards (GET /api/comfort
   values.keys.vim and values.display.timestamps; POST /api/comfort { card, values } lays the change over what is kept),
   read by the message box and the conversation (chat/comfort.js). The engine keeps a time on every message on or off:
   off is On hover (the time in each message's action row), on is Always; Never has no setting, so it stays greyed with
   why. A household person may not read the owner's cards, so the rows are drawn only once the engine has answered. */
import { esc, renderNow } from "../../core/dom.js";
import { level, projectName, ownerHere } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { toast } from "../../core/ui.js";
import { ctl } from "../parts.js";
import { startKey, startsWithWindows } from "../signin.js";
import { K, kitOn, knob, numBox, knobSeg, changed, loadKit } from "../kit17.js";
import { onPhone } from "../surface17.js";
import { t } from "../../../i18n.js";
import { P, loadProjects as readProjects, conversationsWord } from "../../places/project.js"; // area projects: counts and the editor

let deployment = null;
let gateway = null;
let comfort = null; // the engine's comfort cards (values), the owner's only

async function loadProjects() {
  try {
    const [, d, g, c] = await Promise.all([ownerHere() ? readProjects() : null, api("deployment"), ownerHere() ? api("never-break").catch(() => null) : null,
      ownerHere() ? api("comfort").catch((error) => { toast(error.message); return null; }) : null]);
    deployment = d;
    gateway = g;
    comfort = c?.values ?? null;
  } catch (error) { toast(error.message); }
  renderNow();
}

/* Saves one comfort card's change and draws what the engine now keeps (a refused switch goes back, since an unchanged
   page is not drawn again). */
async function saveComfort(card, values) {
  try { comfort = (await api("comfort", { card, values })).values ?? comfort; } catch (error) { toast(error.message); }
  const box = document.getElementById("f15-vim-keys-in-the-message-box");
  if (box && comfort) box.checked = comfort.keys?.vim === true;
  renderNow();
}

const FOLDER = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"></path></svg>';
const project = (p) => `<div class="prow"><span class="ico-tile">${FOLDER}</span><span class="grow"><b>${esc(projectName(p))}</b><small>${[conversationsWord(p.id), p.instructions ? t("window.settings.general.its-own-instructions") : ""].filter(Boolean).join(" · ")}</small></span><button class="btn sm" type="button" data-act="proj-edit" data-v="${esc(p.id)}">${t("prompts.action.edit")}</button></div>`;

/* The switches and boxes this page saves, each the engine's own setting (kit17.js changed()). */
const pct = (el) => (/^\d+$/.test(el.value.trim()) ? Number(el.value) : el.value.trim() === "" ? null : undefined);
const count = (el) => (/^\d+$/.test(el.value.trim()) ? Number(el.value) : undefined);
const BOUND = {
  "g-cmds": { key: "command-catalog", field: "mode" },
  "f15-summarise-older-turns-by-themselves": { card: "compaction", field: "autoCompact", set: (el) => el.checked },
  "f15-summarise-when": { card: "compaction", field: "compactAtPercent", set: pct },
  "f15-keep-latest": { card: "compaction", field: "keepRecentMessages", set: count },
  "f15-repair-the-history-before-each-call": { key: "safety-history-repair", field: "mode" },
};
const num = (id, title, sub, unit, value) => `<div class="ctl"><b>${esc(title)}</b>${numBox(id, title, value, unit)}<small>${esc(sub)}</small></div>`;

/* Message times: On hover, Always and Never are the display card's timestamps and hideTimes (Never hides the time in a
   message's action row too, chat/messages.js). */
function times() {
  const always = comfort.display?.timestamps === true, never = !always && comfort.display?.hideTimes === true, title = t("window.settings.general.message-times");
  const opt = (v, words, pressed) => `<button type="button" aria-pressed="${pressed}" data-act="mtimes15" data-v="${v}">${esc(words)}</button>`;
  return `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opt("hover", t("window.settings.general.on-hover"), !always && !never)}${opt("always", t("window.places.automations.always"), always)}${opt("never", t("window.settings.advanced.never"), never)}</span></span><small>${esc(t("window.settings.general.when-a-message-was-sent-and"))}</small></div>`;
}

function advanced() {
  const c = K.knobs?.values?.compaction;
  const vim = comfort && !onPhone() ? ctl("f15-vim-keys-in-the-message-box", t("comfort.field.vim"), t("window.settings.general.normal-and-insert-modes-for-people"), comfort.keys?.vim === true) : "";
  return `${comfort ? `<div class="sec x15-sec"><h2>${t("onscreen.group.middle")}</h2>${vim}${times()}</div>` : ""}
    <div class="sec x15-sec"><h2>${t("window.settings.general.summaries-of-older-turns")}</h2>${ctl("f15-summarise-older-turns-by-themselves", t("window.settings.general.summarise-older-turns-by-themselves"), t("window.settings.general.keeps-long-conversations-fast-the-summary"), c?.autoCompact === true)}${c ? num("f15-summarise-when", t("window.settings.general.summarise-when-its-this-full"), t("window.settings.general.of-the-models-room-for-this"), "%", c.compactAtPercent) + num("f15-keep-latest", t("window.settings.general.always-keep-the-latest"), t("window.settings.general.messages-kept-word-for-word"), "messages", c.keepRecentMessages) : ""}</div>`;
}

function technical() {
  const room = knob("compaction", "contextWindowTokens");
  return `<div class="sec x15-sec"><h2>${t("window.settings.general.summaries-technical")}</h2>${knobSeg(t("window.settings.general.room-to-plan-for"), t("window.settings.general.overrides-what-the-model-says-it"), "compaction", "contextWindowTokens", [[null, t("window.settings.general.models-own")], [128000, "128k"], [200000, "200k"], [1000000, "1M"]], room)}${ctl("f15-repair-the-history-before-each-call", t("window.settings.general.repair-the-history-before-each-call"), t("window.settings.general.fixes-a-broken-tool-call-or"), kitOn("safety-history-repair"))}</div>`;
}

function backgroundStatus() {
  if (!gateway) return t("gatewayChoice.unavailable");
  const saved = gateway.mode !== "off";
  if (gateway.underGateway === true) return saved ? t("gatewayChoice.running") : t(gateway.stopsWhenOff === true ? "gatewayChoice.stopping" : "gatewayChoice.offLater");
  return saved ? t("gatewayChoice.saved") : t("gatewayChoice.off");
}

export function draw() {
  const lv = level(), starts = !!deployment?.autostart?.enabled, platform = deployment?.platform, computer = !onPhone();
  return `<h1>${t("settings.page.general")}</h1><p class="lede">${t("window.settings.general.how-branch-starts-and-behaves-on")}</p>
    ${computer && starts && startsWithWindows(platform) ? `<div class="status"><span class="sdot "></span><div><b>${t("window.settings.general.branch-starts-with-windows")}</b><p>${t("window.settings.general.it-waits-in-the-tray-and")}</p></div></div>` : ""}
    ${computer ? `<div class="sec"><h2>${t("window.settings.general.starting-up")}</h2>${ctl("g-start", t(startKey(platform)), t("window.settings.general.opens-quietly-in-the-tray"), starts)}${ctl("g-tray", t("window.settings.general.keep-working-when-the-window-closes"), backgroundStatus(), gateway ? gateway.mode !== "off" : false)}</div>` : ""}
    ${ownerHere() ? where() : ""}
    <div class="sec"><h2>${t("memory.movein.kind.project")}</h2><div class="rows">${ownerHere() ? P.all.map(project).join("") : ""}</div></div>
    <div class="sec"><h2>${t("window.settings.general.keyboard")}</h2>${computer ? `<div class="ctl"><b>${t("comfort.keys.title")}</b><span class="right"><button class="btn sm" type="button" data-act="shortcuts">${t("window.settings.general.show-all")}</button></span><small>${t("window.settings.general.ctrl-k-to-find-anything-ctrl")}</small></div>` : ""}${K.kit ? ctl("g-cmds", t("commands.card.switch"), t("window.settings.general.commands-here"), kitOn("command-catalog")) : ""}</div>
    ${lv >= 1 ? advanced() : ""}${lv >= 2 ? technical() : ""}`;
}

/* Where Branch runs (Overview's Finish setting up opens this page for it): this computer, or another one added through
   the Settings › Computer flow's own "Add a computer" (flows/computers.js comp-add, pairing through the engine). */
const where = () => `<div class="sec"><h2>${t("window.flows.setup.step-where")}</h2><div class="ctl"><b>${t("window.p18.ob.fin-where")}</b><span class="right"><button class="btn sm" type="button" data-act="comp-add">${t("window.settings.computer.add-a-computer")}</button></span><small>${t("window.settings.explain.where")}</small></div></div>`;

/* ---------- starting up ---------- */
async function startUp(el) {
  // An unread gateway is never switched blind: the row stays off and says it could not be verified.
  if (el.id === "g-tray" && !gateway) { el.checked = false; toast(t("gatewayChoice.unavailable")); return; }
  try {
    if (el.id === "g-start") await api("deployment/autostart", { enabled: el.checked });
    else await api("never-break", { mode: el.checked ? "on" : "off" });
  } catch (error) { toast(error.message); }
  await loadProjects();
}

export function init() {
  document.addEventListener("change", (e) => {
    if (e.target?.id === "g-start" || e.target?.id === "g-tray") startUp(e.target);
    else if (e.target?.id === "f15-vim-keys-in-the-message-box") saveComfort("keys", { vim: e.target.checked });
    else changed(e.target, BOUND);
  });
  on("mtimes15", (el) => saveComfort("display", { timestamps: el.dataset.v === "always", hideTimes: el.dataset.v === "never" }));
  // The kit and knobs are read as General first opens (Settings no longer reads them before sign-in), as on each reopen.
  loadKit();
  loadProjects();
}

export function load() { loadKit(); return loadProjects(); }

export const live = {
  "sw:g-start": true, "sw:g-tray": true, "sw:g-cmds": true,
  "sw:f15-summarise-older-turns-by-themselves": true, "sw:f15-summarise-when": true, "sw:f15-keep-latest": true,
  "sw:f15-repair-the-history-before-each-call": true, knobseg17: true,
  "sw:f15-vim-keys-in-the-message-box": true, mtimes15: true,
};
