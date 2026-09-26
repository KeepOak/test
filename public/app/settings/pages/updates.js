/* Settings › updates: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";
import { updates17 } from "../p17-more.js";
import { t } from "../../../i18n.js";

let comfortData = null;

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
  document.addEventListener("change", (e) => { if (e.target.id === "u-auto") saveAutoUpdate(e.target.checked); });
  markLive(["sw:u-auto"]);
}

export async function load() {
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

  html += `<div class=\"sec danger8\"><h2>${t("window.settings.updates.remove-branch")}</h2><div class=\"rows\">`;
  html += `<div class=\"ctl\"><b>${t("danger.field.keep")}</b><input class=\"sw\" type=\"checkbox\" id=\"dz-keep\" aria-label=\"${t("danger.field.keep")}\" data-sw=\"set\"><small>${t("window.settings.updates.branch-finds-them-again-if-you")}</small></div>`;
  html += "</div>";
  html += `<div class=\"ctl\"><b>${t("danger.field.confirm")}</b><span class=\"right\"><input class=\"inp\" id=\"dz-confirm\" data-sw=\"set\" disabled autocomplete=\"off\" data-css=\"width:180px\" aria-label=\"${t("danger.field.confirm")}\"></span><small>${t("window.settings.updates.it-is-there-so-a-misclick")}</small></div>`;
  html += `<div class=\"acts\"><button class=\"btn dz\" type=\"button\" id=\"dz-go\" data-act=\"uninstall\" disabled>${t("danger.action.remove")}</button></div>`;
  html += "</div>";

  return html + updates17(level());
}

export { draw };
