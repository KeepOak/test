/* The scoped morning receipt belongs on Overview as well as in its learning journal. */
import { api } from "../core/api.js";
import { activeId } from "../core/state.js";
import { esc, renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { goHome } from "../chat/goto.js";
import { t } from "../../i18n.js";

let receipt = null, scope, readAt = 0, saving = false;

export function morningTile() {
  if (scope !== activeId() || !receipt) return "";
  return `<section class="tile"><h2>${t("seasons.morning")}</h2><p>${esc(receipt.kept.map((fact) => fact.text).join(" · "))}</p>`
    + `<p>${t("seasons.waiting", { count: receipt.staged })}</p><div class="acts">`
    + `<button class="btn sm" type="button" data-act="morning-open">${t("ov.open")}</button>`
    + `<button class="btn ghost sm" type="button" data-act="morning-seen" ${saving ? "disabled" : ""}>${t("first-run-steps.done")}</button></div></section>`;
}

export async function readMorning() {
  const requested = activeId(), now = Date.now();
  if (scope === requested && now - readAt < 30_000) return false;
  const fresh = await api("seasons/morning").catch(() => null);
  if (!fresh || requested !== activeId()) return false;
  const changed = scope !== requested || JSON.stringify(receipt) !== JSON.stringify(fresh.morning);
  scope = requested; readAt = now; receipt = fresh.morning;
  return changed;
}

async function markSeen() {
  if (saving || scope !== activeId() || !receipt) return;
  const requested = scope, night = receipt.night;
  saving = true; renderNow();
  try {
    await api("seasons/morning/seen", { night });
    if (requested === activeId() && scope === requested && receipt?.night === night) {
      receipt = null; readAt = 0;
    }
  } catch (error) { toast(error.message); }
  finally { saving = false; renderNow(); }
}

export function initMorning() {
  markLive(["morning-open", "morning-seen"]);
  on("morning-open", () => { goHome("library:seasons"); renderNow(); });
  on("morning-seen", markSeen);
}
