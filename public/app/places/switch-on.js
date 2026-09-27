/* A feature that is switched off says so where the owner meets it, with its real on-switch right there (the stress test's
   B001, B005, B006, B007). Each switch is the engine's own route, set to "when needed" (the window's way of switching a
   feature on), and read back through the engine's GET before the window believes it:
     recordings  POST /api/recordings {mode}                              GET /api/recordings settings.mode
     prompts     POST /api/prompts/settings {mode}                        GET /api/prompts settings.mode
     procedures  POST /api/autonomy/switch {part:"procedures", mode}      GET /api/autonomy modes.procedures
                 (this one loosens approvals, so the engine asks for the owner's yes first: see switchOn)
     board       POST /api/flows-boards/switch {part:"kanban", mode}      GET /api/flows-boards modes.kanban
   The switch is drawn only for the owner (GET /api/profiles isOwner); the engine refuses anybody else anyway. Anyone
   else reads that only the owner can switch it on. When the engine keeps it off (Lockdown), its own words are shown. */

import { esc, renderNow } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { toast, openDlg, closeDlg, closePop } from "../core/ui.js";
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

/* Procedures that start themselves run their steps without a yes each time, so the engine refuses switching them on
   unless the owner says yes to loosening (src/autonomy/api.ts). It is sent first without that yes; when the engine says
   it makes Branch less careful, its words are shown in a confirm and only "Yes, make it less careful" there sends it
   again with confirmLoosening. Any other refusal (Lockdown's among them) is shown as the engine says it. */
async function switchOn(el, confirmLoosening = false) {
  const key = el.dataset.v, s = SWITCHES[key];
  if (!s) return;
  el.disabled = true;
  try {
    const [path, body] = s.post;
    await api(path, confirmLoosening ? { ...body, confirmLoosening: true } : body);
    const mode = await s.read();
    if (mode === "off") throw new Error(t("window.switch-on.stayed-off"));
    document.dispatchEvent(new CustomEvent("branch-switched", { detail: { key, mode } }));
  } catch (error) {
    el.disabled = false;
    if (!confirmLoosening && /less careful/.test(error.message)) { askLoosening(key, error.message); return; }
    toast(error.message);
    return;
  }
  renderNow();
}
function askLoosening(key, words) {
  openDlg({ title: t("addons.switch.on"), body: `<p>${esc(words)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="switch-on-yes" data-v="${esc(key)}">${t("settings-kit.confirm")}</button>` });
}

/* Stress test B008: the engine says, per connection, the sentence a Trunk's call on it is refused with, or null
   (GET /api/state models.presets[].trunkRefusal). Where a Trunk's model is picked, a connection is greyed only on that
   answer, never because it is a sign-in by itself, and this line gives the engine's own words with the way to add a
   connection a Trunk can use. With no refusal from the engine nothing is greyed ahead; a call it refuses after sending
   says so in the conversation in its words. */
export const trunkCanUse = (preset) => !preset?.trunkRefusal;
export function trunkModelNote(models) {
  const words = [...new Set((models?.presets ?? []).map((p) => p.trunkRefusal).filter(Boolean))].join(" ");
  if (!words) return "";
  return `<p class="hint tm-why">${esc(words)} <button class="btn ghost sm" type="button" data-act="api-key-go">${t("window.switch-on.api-key")}</button></p>`;
}

export function initSwitchOn() {
  markLive(["switch-on", "switch-on-yes", "api-key-go"]);
  on("switch-on", (el) => switchOn(el));
  on("switch-on-yes", (el) => { closeDlg(); switchOn(el, true); });
  /* Settings › Models, where a connection with an API key is added; what was typed in a conversation stays its draft. */
  on("api-key-go", () => {
    closeDlg();
    closePop();
    const go = document.createElement("button");
    go.dataset.v = "models";
    run("setgo", go);
  });
}
