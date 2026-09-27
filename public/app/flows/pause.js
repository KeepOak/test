/* Pausing a Trunk, or all of them (src/trunks/pause.ts): POST /api/trunks/{id}/pause|resume and
   POST /api/trunks/pause-all|resume-all. A paused Trunk starts nothing new; a task it is running finishes, unless the
   owner stops it too ({now: true}). That choice is offered only while the engine says a Trunk is working
   (GET /api/trunks `running`: tasks running as that Trunk), in the prototype's own words. The engine writes each pause in the activity log. */

import { esc } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const trunkById = (id) => E.trunks.find((tr) => tr.id === id);
export const allPaused = () => E.trunks.length > 0 && E.trunks.every((tr) => tr.paused);

/* The two ways to pause something that is working: let its task finish, or stop it now. */
function choose(title, target) {
  const pick = (now, words) => `<button type="button" class="upd-o15" data-act="pause-go" data-target="${esc(target)}" data-now="${now}"><b>${words}</b></button>`;
  openDlg({ title, body: `<div class="upd15">${pick("0", t("window.flows.pause.finish"))}${pick("1", t("window.flows.pause.stop-current"))}</div>` });
}

async function send(target, now) {
  closePop();
  closeDlg();
  try {
    if (target === "all") {
      await api("trunks/pause-all", { now });
      toast(t("window.flows.pause.all-paused"));
    } else {
      const { trunk } = await api(`trunks/${encodeURIComponent(target)}/pause`, { now });
      toast(t("window.flows.pause.paused", { name: trunk.name }));
    }
    await refresh();
  } catch (error) { toast(error.message); }
}

async function pauseTrunk(id) {
  closePop();
  const tr = trunkById(id);
  if (!tr) return;
  if (!tr.paused && tr.running > 0) return choose(t("window.flows.pause.this"), id);
  if (!tr.paused) return send(id, false);
  try {
    await api(`trunks/${encodeURIComponent(id)}/resume`, {});
    toast(t("strip.shown", { name: tr.name }));
    await refresh();
  } catch (error) { toast(error.message); }
}

async function pauseAll() {
  closePop();
  if (!allPaused() && E.trunks.some((tr) => !tr.paused && tr.running > 0)) return choose(t("window.flows.pause.all"), "all");
  if (!allPaused()) return send("all", false);
  try {
    await api("trunks/resume-all", {});
    toast(t("window.flows.pause.all-back"));
    await refresh();
  } catch (error) { toast(error.message); }
}

export function initPause() {
  markLive(["pausetrunk", "pauseall", "pause-go"]);
  on("pausetrunk", (el) => pauseTrunk(el.dataset.id));
  on("pauseall", () => pauseAll());
  on("pause-go", (el) => send(el.dataset.target, el.dataset.now === "1"));
}
