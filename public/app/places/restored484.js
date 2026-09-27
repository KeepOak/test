/* #484 (the lead's call): the Trunks a restore brought back cut down (paused, look-only, no tool servers or chat apps),
   one owner-only card on Overview. Each Trunk's line is the engine's own words (GET /api/restore/trunks: title "Give
   <Trunk> back what it had" and what it would regain). Giving it back is POST /api/restore/trunks {id, answer: "give"}
   with the owner's separate yes, the settings kit's own tick (confirmLoosening); the engine refuses it under Lockdown and
   says so. "Keep it" leaves the Trunk as the restore made it ({answer: "keep"}). */
import { esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast } from "../core/ui.js";
import { ownerHere } from "../core/state.js";
import { t } from "../../i18n.js";

const R = { trunks: [], shown: "", readAt: 0, yes: new Set() }; // yes: the Trunks whose tick is on, so a redraw keeps it

/* Read at most every 30 seconds while Overview is drawn; true when the card changed. */
export async function loadRestored() {
  if (!ownerHere() || Date.now() - R.readAt < 30000) return false;
  R.readAt = Date.now();
  try { R.trunks = (await api("restore/trunks")).trunks ?? []; } catch (error) { toast(error.message); R.trunks = []; }
  const now = JSON.stringify(R.trunks);
  if (now === R.shown) return false;
  R.shown = now;
  return true;
}

const row = (trunk) => `<div class="rt484-row"><b>${esc(trunk.title)}</b><ul class="may6">${trunk.regains.map((line) => `<li>${ic("check", "s")}${esc(line)}</li>`).join("")}</ul>`
  + `<label class="chk"><input type="checkbox" data-sw="rt484-yes" data-v="${esc(trunk.id)}"${R.yes.has(trunk.id) ? " checked" : ""}><span>${t("settings-kit.confirm")}</span></label>`
  + `<div class="acts"><button class="btn sm" type="button" data-act="rt484-keep" data-v="${esc(trunk.id)}">${t("action.keep-it")}</button>`
  + `<button class="btn pri sm" type="button" data-act="rt484-give" data-v="${esc(trunk.id)}">${esc(trunk.title)}</button></div></div>`;

/* The card, drawn in Overview's own markup; nothing when no restored Trunk waits. */
export function restoredTile() {
  if (!ownerHere() || !R.trunks.length) return "";
  return `<section class="tile rt484">${R.trunks.map(row).join("")}</section>`;
}

async function answer(el, what) {
  const yes = R.yes.has(el.dataset.v);
  try {
    const view = await api("restore/trunks", { id: el.dataset.v, answer: what, ...(what === "give" && yes ? { confirmLoosening: true } : {}) });
    R.trunks = view.trunks ?? [];
    R.shown = JSON.stringify(R.trunks);
  } catch (error) { toast(error.message); return; }
  renderNow();
}

export function initRestored() {
  markLive(["rt484-give", "rt484-keep", "sw:rt484-yes"]);
  on("rt484-give", (el) => answer(el, "give"));
  on("rt484-keep", (el) => answer(el, "keep"));
  document.addEventListener("change", (e) => {
    if (e.target?.dataset?.sw !== "rt484-yes") return;
    if (e.target.checked) R.yes.add(e.target.dataset.v); else R.yes.delete(e.target.dataset.v);
  });
}
