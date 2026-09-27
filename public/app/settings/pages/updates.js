/* Settings › updates: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api, isDesktop } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";
import { updates17 } from "../p17-more.js";
import { t } from "../../../i18n.js";
import { channelSection, initChannel, loadChannel } from "../updates-channel.js";

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
function removalRows(steps) {
  const goes = (plan?.items ?? []).filter((x) => x.goes && x.bytes > 0);
  const rows = goes.map((x) => `<div class="prow"><span class="grow"><b data-css="font-weight:500">${esc(x.what)}</b></span><span class="meta">${esc(t("danger.item.goes", { size: size(x.bytes) }))}</span></div>`).join("");
  // With the plain steps below, the engine's one-line note about Windows is said by them instead.
  return rows + (plan?.instead && !steps ? `<p class="hint">${esc(plan.instead)}</p>` : "");
}

/* Removing Branch, in plain steps (the owner's words): Windows' own Add or remove programs, or the exact line to paste,
   with the real path the engine names (GET /api/deployment `uninstall`: the uninstaller in the program's folder, or the
   `branch` command). The window never runs it: Open Add or remove programs opens Windows' own page through the desktop
   app's exact list (src/os-permissions.ts), and Copy only puts the line on the clipboard. Owner only, like the survey. */
let removal = null;
async function loadRemoval() {
  if (notOwner()) { removal = null; return; }
  try { const got = await api("deployment"); removal = notOwner() ? null : { platform: got.platform, uninstall: got.uninstall ?? null }; } catch (e) { toast(e.message); }
  render();
}
const rm = (k) => t(`window.settings.remove.${k}`);
const canOpenApps = () => isDesktop && Boolean(globalThis.branchDesktop?.openExternal) && Boolean(removal?.uninstall?.settingsLink);
const cmdBlock = (which, line) => `<div class="rm-cmd"><code>${esc(line)}</code><button class="btn sm" type="button" data-act="rmcopy" data-v="${which}" aria-label="${esc(rm("copy-label"))}">${esc(rm("copy"))}</button></div>`;
function terminalSteps(platform) {
  const open = platform === "win32" ? "step-terminal-win" : platform === "darwin" ? "step-terminal-mac" : "step-terminal-linux";
  return `<li>${esc(rm(open))}</li><li>${esc(rm(platform === "darwin" ? "step-paste-return" : "step-paste-enter"))}</li>`;
}
function keepSteps(platform, line) {
  if (platform !== "win32") return `<ol class="rm-steps">${terminalSteps(platform)}</ol>${cmdBlock("keep", line)}`;
  const open = canOpenApps() ? `<li><button class="btn sm" type="button" data-act="rmapps">${esc(rm("open-apps"))}</button></li>` : `<li>${esc(rm("step-open-apps-words"))}</li>`;
  return `<ol class="rm-steps">${open}<li>${esc(rm("step-find"))}</li></ol><p class="rm-or">${esc(rm("or-paste"))}</p>${cmdBlock("keep", line)}`;
}
function removalChoices(kept) {
  const cmds = removal?.uninstall, platform = removal?.platform;
  if (!cmds) return "";
  const keptNote = kept ? `${esc(t("danger.item.kept", { size: size(kept.bytes) }))}. ` : "";
  return `<div class="rm-choice"><b>${esc(t("danger.field.keep"))}</b><small>${keptNote}${esc(t("window.settings.updates.branch-finds-them-again-if-you"))}</small>${keepSteps(platform, cmds.keep)}</div>`
    + `<div class="rm-choice rm-danger"><b>${esc(rm("delete"))}</b><small>${esc(rm("cannot-undo"))}</small><ol class="rm-steps">${terminalSteps(platform)}</ol>${cmdBlock("deleteData", cmds.deleteData)}</div>`;
}
async function copyRemoval(el) {
  const line = el.dataset.v === "deleteData" ? removal?.uninstall?.deleteData : el.dataset.v === "keep" ? removal?.uninstall?.keep : null;
  if (!line) return;
  try { await navigator.clipboard.writeText(line); toast(t("window.core.copied")); } catch (e) { toast(e.message); }
}
async function openApps() {
  const link = removal?.uninstall?.settingsLink;
  if (!canOpenApps() || !/^ms-settings:/.test(link)) return;
  try { await globalThis.branchDesktop.openExternal(link); } catch (e) { toast(e.message); }
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
    comfortData = (await api("comfort", { card: "notify", values: { autoUpdate: on ? "check" : "off" } })).values ?? comfortData;
  } catch (e) {
    toast(e.message);
  }
  render();
}

export function init() {
  loadComfort();
  loadPlan();
  loadRemoval();
  on("rmcopy", (el) => copyRemoval(el));
  on("rmapps", () => openApps());
  markLive(["rmcopy", "rmapps"]);
  document.addEventListener("change", (e) => { if (e.target.id === "u-auto") saveAutoUpdate(e.target.checked); });
  markLive(["sw:u-auto"]);
  initChannel();
}

export async function load() {
  loadPlan();
  loadRemoval();
  await loadComfort();
}

function draw() {
  const s = E.state || {};
  const version = s.version;
  const autoUpdate = Boolean(comfortData?.notify?.autoUpdate) && comfortData.notify.autoUpdate !== "off";

  let html = `<h1>${esc(t("settings.page.about"))}</h1>`;
  if (version) html += "<p class=\"lede\">Branch Agent " + esc(version) + ".</p>";

  /* Installing and undoing an update go through the desktop app's updater (IPC), not an engine route, so they stay greyed.
     What's new opens the notes this build ships (GET /api/release-notes, flows/whatsnew.js), not a page in the browser. */
  html += `<div class=\"acts\" data-css=\"margin-top:12px\"><button class=\"btn pri\" type=\"button\" data-act=\"install\">${t("window.settings.updates.install-when-nothing-is-running")}</button><button class=\"btn ghost\" type=\"button\" data-act=\"whatsnew13\">${t("window.settings.updates.whats-new")}</button></div>`;
  html += `<div class=\"sec\"><h2>${t("window.settings.updates.updating")}</h2>`;
  html += `<div class=\"ctl\"><b>${t("comfort.update.install")}</b><input class=\"sw\" type=\"checkbox\" id=\"u-auto\" ` + (autoUpdate ? "checked" : "") + ` aria-label=\"${t("comfort.update.install")}\" data-sw=\"set\"><small>${t("window.settings.updates.checks-every-day")}</small></div>`;
  html += `<div class=\"ctl\"><b>${t("window.settings.updates.undo-the-last-update")}</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">${t("strip.undo")}</button></span><small></small></div>`;
  html += "</div>";
  html += channelSection();

  if (notOwner()) { plan = null; removal = null; } // switched to a household person: the owner's survey is not shown
  const kept = (plan?.items ?? []).find((x) => !x.goes);
  const rows = removalRows(Boolean(removal?.uninstall));
  html += `<div class=\"sec danger8\"><h2>${t("window.settings.updates.remove-branch")}</h2>${rows ? `<div class=\"rows\">${rows}</div>` : ""}`;
  html += removalChoices(kept);
  html += "</div>";

  return html + updates17(level());
}

export { draw };
