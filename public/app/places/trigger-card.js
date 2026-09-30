/* Words to a trigger, confirmed (the prototype's proposal card under Automations › Triggers "Describe it").
   The engine reads the sentence with the model (POST /api/triggers/propose {text}). The start it can offer here is one of
   the owner's own tasks finishing (optionally one about certain words): a procedure that starts after a task and asks
   before it starts. An app's message (its trigger needs an address and secret no screen shows yet) and anything else,
   such as a file landing in a folder, are refused in the engine's words, and with no model the engine says that too.
   The card shows what Branch understood; "When" is the engine's reading and stays as read; "It does" can be changed.
   Nothing is saved until "Confirm the trigger": POST /api/autonomy/procedures. The prototype's "Who does it" is drawn
   under an action nobody registers (trig-who), so it greys itself with its reason (window.why.trig-who): a procedure has
   no field for a Trunk (src/autonomy/procedures.ts ProcedureSchema). A second press of Confirm while the first is on its way sends nothing. */

import { $, esc, renderNow } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { ic, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { t } from "../../i18n.js";

let T = null; // the proposal on show: { kind: "task", when, what, name, words }
let sending = false;

/* The card under the box, while a proposal is open. */
export function trigCard() {
  if (!T) return "";
  return `<div class="prop17d" role="region" aria-label="${t("window.places.trigger-card.proposed-trigger")}"><div class="pp-h17d">${ic("bolt", "s")}<b>${t("window.places.trigger-card.heres-the-trigger")}</b><span class="pill idle"><i></i>${t("window.places.schedule-card.not-saved-yet")}</span></div>
    <div class="pp-g17d"><label class="fld"><span>${t("window.flows.flow.when")}</span><input class="inp" id="pp-when17d" value="${esc(T.when)}" readonly></label><label class="fld"><span>${t("window.places.schedule-card.it-does")}</span><input class="inp" id="pp-twhat17d" value="${esc(T.what)}"></label></div>
    <div class="fld"><span>${t("window.places.schedule-card.who-does-it")}</span><span class="seg">${(Array.isArray(E.trunks) ? E.trunks : []).map((tr) => `<button type="button" aria-pressed="false" data-act="trig-who" disabled>${esc(tr.name)}</button>`).join("")}</span></div>
    <div class="acts"><button class="btn ghost sm" type="button" data-act="trig-no">${t("first-run-steps.restore-no")}</button><button class="btn pri sm" type="button" data-act="trig-ok">${t("window.places.trigger-card.confirm-the-trigger")}</button></div></div>`;
}

const keepWhat = () => { const w = document.getElementById("pp-twhat17d"); if (T && w) T.what = w.value; };

/* The box's words, read by the engine; its refusal is shown in its own words. */
async function propose() {
  const text = $("#nl-in")?.value.trim();
  if (!text) { $("#nl-in")?.focus(); return; } // B002: nothing to read yet; the box is where the words go
  try { T = (await api("triggers/propose", { text })).proposal; } catch (error) { toast(error.message); return; }
  renderNow();
  document.getElementById("pp-twhat17d")?.focus();
}

async function confirm() {
  keepWhat();
  const p = T, what = p?.what.trim();
  if (!p || sending) return;
  if (!what) { document.getElementById("pp-twhat17d")?.setAttribute("aria-invalid", "true"); return; }
  sending = true;
  try {
    await api("autonomy/procedures", { name: p.name, start: { kind: "after-task", words: p.words }, steps: [{ title: p.name, prompt: what }] });
  } catch (error) { toast(error.message); return; } finally { sending = false; }
  T = null;
  const box = $("#nl-in");
  if (box) { box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); } // the page keeps the box's words (automations.js)
  await refresh().catch((error) => toast(error.message));
  renderNow();
  toast(t("window.places.trigger-card.saved-and-on"));
}

export function initTriggerCard() {
  markLive(["trig-add", "trig-no", "trig-ok", "sw:pp-twhat17d"]);
  on("trig-add", () => propose());
  on("trig-no", () => { T = null; renderNow(); toast(t("window.places.schedule-card.nothing-was-saved")); });
  on("trig-ok", () => confirm());
}
