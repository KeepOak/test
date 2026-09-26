/* "Show tips and pop-ups" (the owner's ask): one switch, at the bottom of the Guide menu and in Settings › Notifications,
   kept by the engine with how far setup got (settings/onboarding popups, GET /api/state onboarding, POST
   /api/onboarding { popups }), so it holds after a reload and on every device. Off keeps away the first-run setup, the
   New to Branch? card (flows/first.js) and achievement pop-ups (the engine hands the window none to celebrate while it
   is off, src/delight.ts). Approvals, questions, Lockdown and errors are not pop-ups and always show. Only the owner has
   the switch: anybody else's window reads it as on and draws no switch. */

import { $, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

/** Whether tips and pop-ups may show: on unless the owner switched them off. */
export const popupsOn = () => E.state?.onboarding?.popups !== false;
const mine = () => E.state?.onboarding?.mine === true;

/** The switch as the Guide menu's last row; nothing for somebody who cannot change it. */
export function popupsRow() {
  if (!mine()) return "";
  const name = t("window.flows.guides.popups");
  return `<hr><div class="row-in"><span>${name}</span><input class="sw" type="checkbox" id="guide-popups" data-sw="guide-popups" ${popupsOn() ? "checked" : ""} aria-label="${name}"></div>`;
}

/** The same switch as a Settings row (Settings › Notifications). */
export function popupsSetting() {
  if (!mine()) return "";
  const name = t("window.flows.guides.popups");
  return `<div class="ctl"><b>${name}</b><input class="sw" type="checkbox" id="set-popups" data-sw="set-popups" ${popupsOn() ? "checked" : ""} aria-label="${name}"><small>${t("window.flows.guides.popups-hint")}</small></div>`;
}

async function setPopups(on, box) {
  try {
    E.state.onboarding = await api("onboarding", { popups: on });
  } catch (error) {
    toast(error.message);
    box.checked = popupsOn();
    return;
  }
  if (!on) $(".welcome10")?.remove();
  render();
}

export function init() {
  markLive(["sw:guide-popups", "sw:set-popups"]);
  document.addEventListener("change", (e) => {
    if (e.target.id === "guide-popups" || e.target.id === "set-popups") setPopups(e.target.checked, e.target);
  });
}
