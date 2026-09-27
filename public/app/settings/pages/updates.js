/* Settings › updates: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { toast, ic } from "../../core/ui.js";
import { waiting } from "../../flows/whatsnew.js";
import { updates17 } from "../p17-more.js";
import { t } from "../../../i18n.js";
import { channelSection, initChannel, loadChannel } from "../updates-channel.js";
import { holdingTasks, lastLook, waitingLine } from "../../shell/autoupdate.js";

let comfortData = null;
/* What removing Branch would take away and keep, as the engine surveys it (POST /api/remove-branch/plan, which only
   looks; removing is POST /api/remove-branch and stays with the desktop app's own flow). The owner's alone. */
let plan = null;
const notOwner = () => E.profiles?.isOwner === false;
async function loadPlan() {
  if (notOwner()) { plan = null; return; }
  try { const got = await api("remove-branch/plan", { keepConversations: true }); plan = notOwner() ? null : got; } catch (e) { toast(e.message); }
  render();
}
const size = (n) => (n >= 2 ** 30 ? t("danger.size.gb", { gb: (n / 2 ** 30).toFixed(1) }) : n >= 2 ** 20 ? t("danger.size.mb", { mb: Math.round(n / 2 ** 20) }) : t("danger.size.nothing"));
function removalRows() {
  const goes = (plan?.items ?? []).filter((x) => x.goes && x.bytes > 0);
  const rows = goes.map((x) => `<div class="prow"><span class="grow"><b data-css="font-weight:500">${esc(x.what)}</b></span><span class="meta">${esc(t("danger.item.goes", { size: size(x.bytes) }))}</span></div>`).join("");
  return rows + (plan?.instead ? `<p class="hint">${esc(plan.instead)}</p>` : "");
}

async function loadComfort() {
  /* Q261: the update choice is kept in the owner's comfort card, which a household person may not read. */
  if (E.profiles?.isOwner === false) return;
  try {
    const res = await api("comfort");
    comfortData = res.values || {};
    render();
  } catch (e) {
    toast(e.message);
  }
  await loadChannel();
}

/* The switch is drawn after init, so its change is caught on the document (POST /api/comfort merges the one value
   into the notify card). */
async function saveAutoUpdate(on) {
  try {
    // "Keep Branch up to date by itself" installs (the plan still waits for idle tasks and a failed release).
    comfortData = (await api("comfort", { card: "notify", values: { autoUpdate: on ? "install" : "off" } })).values ?? comfortData;
  } catch (e) {
    toast(e.message);
  }
  render();
}

export function init() {
  loadComfort();
  loadPlan();
  document.addEventListener("change", (e) => { if (e.target.id === "u-auto") saveAutoUpdate(e.target.checked); });
  markLive(["sw:u-auto"]);
  initChannel();
}

/* The Release notes row (flows/whatsnew.js): the installed version, and the one the desktop's updater found, if any. */
let next = null;
const notesRow = (version) => `<div class="rn-row17d">${ic("news17d", "s")}<span class="grow">${esc(next ? t("window.flows.whatsnew.have-next", { version, next: next.version }) : t("window.flows.whatsnew.have", { version }))}</span><button class="btn sm" type="button" data-act="relnotes17d">${t("window.flows.whatsnew.release-notes")}</button></div>`;

export async function load() {
  loadPlan();
  next = await waiting().catch((e) => { toast(e.message); return null; });
  await loadComfort();
}

/* The prototype's status box: what update by itself last found, from shell/autoupdate.js's last look. A failure is said
   in the updater's or engine's own words; a ready update that waits says what it waits for, in the engine's words, and
   names the owner's tasks holding it, each opening its conversation. Nothing is drawn before a look has happened. */
const statusBox = (title, text, bad) => `<div class="status"><span class="sdot ${bad ? "bad" : ""}"></span><div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`;
function selfStatus() {
  const problem = lastLook.problem, waiting = waitingLine(), plan = lastLook.plan;
  let html = problem?.message ? statusBox(t("window.updates.failed"), problem.message, true) : "";
  if (waiting) {
    html += statusBox(waiting, plan?.until ? plan.reason : lastLook.status?.message ?? "");
    const tasks = holdingTasks().filter((task) => task.name);
    if (tasks.length) html += `<div class="acts">${tasks.map((task) => `<button class="btn sm" type="button" data-act="chat" data-id="${esc(task.sessionId)}">${esc(task.name)}</button>`).join("")}</div>`;
  } else if (plan?.reason && !problem?.message) html += statusBox(lastLook.status?.message || plan.reason, lastLook.status?.message ? plan.reason : "");
  return html;
}

function draw() {
  const s = E.state || {};
  const version = s.version;
  const autoUpdate = comfortData?.notify?.autoUpdate === "install";

  let html = `<h1>${esc(t("settings.page.about"))}</h1>`;
  if (version) html += "<p class=\"lede\">Branch Agent " + esc(version) + ".</p>" + notesRow(version);
  if (!notOwner()) html += selfStatus();

  /* Installing and undoing an update go through the desktop app's updater (IPC), not an engine route, so they stay greyed.
     What's new opens the notes this build ships (GET /api/release-notes, flows/whatsnew.js), not a page in the browser. */
  html += `<div class=\"acts\" data-css=\"margin-top:12px\"><button class=\"btn pri\" type=\"button\" data-act=\"install\">${t("window.settings.updates.install-when-nothing-is-running")}</button><button class=\"btn ghost\" type=\"button\" data-act=\"whatsnew13\">${t("window.settings.updates.whats-new")}</button></div>`;
  html += `<div class=\"sec\"><h2>${t("window.settings.updates.updating")}</h2>`;
  html += `<div class=\"ctl\"><b>${t("comfort.update.install")}</b><input class=\"sw\" type=\"checkbox\" id=\"u-auto\" ` + (autoUpdate ? "checked" : "") + ` aria-label=\"${t("comfort.update.install")}\" data-sw=\"set\"><small>${t("window.settings.updates.checks-every-day")}</small></div>`;
  html += `<div class=\"ctl\"><b>${t("window.settings.updates.undo-the-last-update")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("strip.undo")}</button></span><small></small></div>`;
  html += "</div>";
  html += channelSection();

  if (notOwner()) plan = null; // switched to a household person: the owner's survey is not shown
  const kept = (plan?.items ?? []).find((x) => !x.goes);
  html += `<div class=\"sec danger8\"><h2>${t("window.settings.updates.remove-branch")}</h2><div class=\"rows\">${removalRows()}`;
  html += `<div class=\"ctl\"><b>${t("danger.field.keep")}</b><input class=\"sw\" type=\"checkbox\" id=\"dz-keep\" aria-label=\"${t("danger.field.keep")}\" data-sw=\"set\"><small>${kept ? `${esc(t("danger.item.kept", { size: size(kept.bytes) }))}. ` : ""}${t("window.settings.updates.branch-finds-them-again-if-you")}</small></div>`;
  html += "</div>";
  html += `<div class=\"ctl\"><b>${t("danger.field.confirm")}</b><span class=\"right\"><input class=\"inp\" id=\"dz-confirm\" data-sw=\"set\" disabled autocomplete=\"off\" data-css=\"width:180px\" aria-label=\"${t("danger.field.confirm")}\"></span><small>${t("window.settings.updates.it-is-there-so-a-misclick")}</small></div>`;
  html += `<div class=\"acts\"><button class=\"btn dz\" type=\"button\" id=\"dz-go\" data-act=\"uninstall\" disabled>${t("danger.action.remove")}</button></div>`;
  html += "</div>";

  return html + updates17(level());
}

export { draw };
