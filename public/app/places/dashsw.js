/* Customize › Everywhere: "Dashboard in the browser", the engine's switch for its web dashboard (GET/POST
   /api/dashboard/settings { mode }), in the engine's own words (the old window's card). While it is off the engine
   serves no /dashboard page and refuses its summary (GET /api/dashboard), whose refusal names this place. Automations'
   Pause all (GET/POST /api/dashboard/automations) and Restart the engine (POST /api/dashboard/restart) do not wait on it:
   the key of this computer, and while the dashboard is off the app on this computer only (src/dashboard-api.ts). Only the key of the computer
   Branch runs on may switch it (the engine refuses a short-lived key in its own words), and it is the owner's alone: a
   household person is not shown it. "When needed" reads as on; the switch saves on or off. */

import { esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { ic, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let mode = null;

/** Reads the switch; answers true when what is drawn changed. */
export async function readDash() {
  if (E.profiles?.isOwner !== true) { const was = mode; mode = null; return was !== null; }
  const was = mode;
  try { mode = (await api("dashboard/settings")).mode ?? null; } catch (error) { toast(error.message); }
  return was !== mode;
}

export function dashTile() {
  if (mode == null) return "";
  const on = mode !== "off";
  const open = on ? `<a class="btn sm" href="/dashboard" target="_blank" rel="noopener">${esc(t("dashboard.card.open"))}</a>` : "";
  return `<div class="tile"><div class="th"><span class="ico-tile">${ic("globe", "s")}</span><b>${esc(t("dashboard.card.title"))}</b></div><p>${esc(t("dashboard.card.purpose"))}</p><div class="acts"><input class="sw" type="checkbox" id="dash-b6" ${on ? "checked" : ""} aria-label="${esc(t("dashboard.card.switch"))}">${open}</div></div>`;
}

async function flip(box) {
  box.disabled = true;
  try { mode = (await api("dashboard/settings", { mode: box.checked ? "on" : "off" })).mode ?? mode; } catch (error) { toast(error.message); }
  renderNow();
}

export function initDash() {
  markLive(["sw:dash-b6"]);
  document.addEventListener("change", (e) => { if (e.target.id === "dash-b6") flip(e.target); });
}
