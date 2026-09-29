/* The same Seasons switches that settings.find/settings.change expose, saved with history and the kit's guards. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { kitVal, kitSeg, numBox, changed, spec } from "./kit17.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const bindings = Object.fromEntries(["nightFrom", "nightTo", "idleMinutes", "minGainPercent"]
  .map((field) => [`season-${field}`, { key: "seasons", field, num: true }]));
bindings["season-paidModels"] = { key: "seasons", field: "paidModels" };

function numberRow(field, title, hint, unit) {
  return `<div class="ctl"><b>${esc(title)}</b>${numBox(`season-${field}`, title, kitVal("seasons", field), unit)}<small>${esc(hint)}</small></div>`;
}

export function seasonsSettingsRows() {
  if (!spec("seasons") || E.profiles?.isOwner !== true) return "";
  const positions = [["off", t("switch.off")], ["on", t("switch.on")]];
  const paid = kitVal("seasons", "paidModels");
  return `<section class="sec"><h2>${t("seasons.settings-title")}</h2>`
    + kitSeg(t("seasons.settings-rings"), t("seasons.settings-rings-hint"), "seasons", "rings", positions)
    + kitSeg(t("seasons.settings-gardener"), t("seasons.settings-gardener-hint"), "seasons", "gardener", positions)
    + numberRow("nightFrom", t("seasons.settings-from"), t("seasons.settings-hours-hint"), "0–23")
    + numberRow("nightTo", t("seasons.settings-to"), t("seasons.settings-hours-hint"), "0–23")
    + numberRow("idleMinutes", t("seasons.settings-idle"), t("seasons.settings-idle-hint"), "5–720")
    + `<div class="ctl"><b>${t("seasons.settings-paid")}</b><input class="sw" type="checkbox" id="season-paidModels" data-sw="set" ${paid ? "checked" : ""} aria-label="${t("seasons.settings-paid")}"><small>${t("seasons.settings-paid-hint")}</small></div>`
    + numberRow("minGainPercent", t("seasons.settings-gain"), t("seasons.settings-gain-hint"), "1–100")
    + "</section>";
}

export function initSeasonsSettings() {
  markLive(Object.keys(bindings).map((id) => `sw:${id}`));
  document.addEventListener("change", (event) => {
    if (E.profiles?.isOwner === true) changed(event.target, bindings);
  });
}
