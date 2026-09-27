/* A feature that is switched off says so where the owner meets it, with its real on-switch right there (the stress test's
   B001, B005, B006, B007). Each switch is the engine's own route, set to "when needed" (the window's way of switching a
   feature on), and read back through the engine's GET before the window believes it:
     recordings  POST /api/recordings {mode}                              GET /api/recordings settings.mode
     prompts     POST /api/prompts/settings {mode}                        GET /api/prompts settings.mode
     procedures  POST /api/autonomy/switch {part:"procedures", mode}      GET /api/autonomy modes.procedures
     board       POST /api/flows-boards/switch {part:"kanban", mode}      GET /api/flows-boards modes.kanban
   The switch is drawn only for the owner (GET /api/profiles isOwner); the engine refuses anybody else anyway. Anyone
   else reads that only the owner can switch it on. When the engine keeps it off (Lockdown), its own words are shown. */

import { esc, renderNow } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { toast, closeDlg, closePop } from "../core/ui.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { t } from "../../i18n.js";

const SWITCHES = {
  recordings: { post: ["recordings", { mode: "when-needed" }], read: async () => (await api("recordings")).settings?.mode },
  prompts: { post: ["prompts/settings", { mode: "when-needed" }], read: async () => (await api("prompts")).settings?.mode },
  procedures: { post: ["autonomy/switch", { part: "procedures", mode: "when-needed" }], read: async () => (await api("autonomy")).modes?.procedures },
  board: { post: ["flows-boards/switch", { part: "kanban", mode: "when-needed" }], read: async () => (await api("flows-boards")).modes?.kanban },
};

/* The line a switched-off feature shows: its sentence, then the switch (the owner) or who can switch it on (anyone else). */
export function offTile(key, sentence, more = "") {
  if (!SWITCHES[key]) return "";
  const act = ownerHere()
    ? `<button class="btn pri sm" type="button" data-act="switch-on" data-v="${esc(key)}">${t("addons.switch.on")}</button>`
    : `<small>${t("window.switch-on.owner-only")}</small>`;
  return `<div class="tile off-sw" role="note" data-off="${esc(key)}"><p>${esc(sentence)}</p>${more ? `<p class="hint">${more}</p>` : ""}<div class="acts">${act}</div></div>`;
}

/* Whether a feature is on, as the engine says now. */
export const modeOf = (key) => SWITCHES[key].read();

async function switchOn(el) {
  const s = SWITCHES[el.dataset.v];
  if (!s) return;
  el.disabled = true;
  try {
    await api(...s.post);
    const mode = await s.read();
    if (mode === "off") throw new Error(t("window.switch-on.stayed-off"));
    document.dispatchEvent(new CustomEvent("branch-switched", { detail: { key: el.dataset.v, mode } }));
  } catch (error) { toast(error.message); el.disabled = false; return; }
  renderNow();
}

/* Stress test B008: a Trunk answers only through an API key (src/accounts/trunk-guard.ts). The engine marks each connection
   that answers through somebody's sign-in (GET /api/state models.presets[].signIn) and gives the sentence a Trunk's call
   is refused with (models.trunkSignIn). Where a Trunk's model is picked, such a connection is drawn greyed, and this line
   says why with the way to fix it: with no connection a Trunk can use, the engine's own sentence; with some, which ones
   are greyed and why. */
export const trunkCanUse = (preset) => !preset.signIn;
export function trunkModelNote(models) {
  const presets = models?.presets ?? [];
  const usable = presets.some(trunkCanUse);
  if (usable && !presets.some((p) => p.signIn)) return "";
  const words = usable ? t("window.switch-on.signin-greyed") : models?.trunkSignIn ?? "";
  return `<p class="hint tm-why">${esc(words)} <button class="btn ghost sm" type="button" data-act="api-key-go">${t("window.switch-on.api-key")}</button></p>`;
}

export function initSwitchOn() {
  markLive(["switch-on", "api-key-go"]);
  on("switch-on", (el) => switchOn(el));
  /* Settings › Models, where a connection with an API key is added; what was typed in a conversation stays its draft. */
  on("api-key-go", () => {
    closeDlg();
    closePop();
    const go = document.createElement("button");
    go.dataset.v = "models";
    run("setgo", go);
  });
}
