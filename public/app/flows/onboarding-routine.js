/* Optional owner words become the existing, unsaved schedule proposal. */
import { $, esc } from "../core/dom.js";
import { S, activeId, ownerHere } from "../core/state.js";
import { token } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { proposeScheduleText } from "../places/schedule-card.js";
import { t } from "../../i18n.js";

export function firstRoutinePrompt(o) {
  return `<section class="sec"><label class="fld"><span>${t("onboarding.routine.question")}</span><textarea class="inp" id="ob-routine" maxlength="2000" rows="2" placeholder="${esc(t("onboarding.routine.example"))}">${esc(o.routine)}</textarea></label><p class="hint">${t("onboarding.routine.hint")}</p><button class="btn" type="button" data-act="ob-routine-review">${t("onboarding.routine.review")}</button></section>`;
}

const unlocked = () => ownerHere() && !document.querySelector(".lockscreen, .lockscreen-b17") && !document.hidden;
let busy = false;
async function review(close) {
  const o = S.ob, text = $("#ob-routine")?.value.trim();
  if (busy || !o?.mine || !o.trust || !unlocked()) return;
  if (!text) { $("#ob-routine")?.focus(); return; }
  const actor = token.get(), profile = activeId();
  const current = () => actor === token.get() && profile === activeId() && unlocked();
  busy = true;
  try {
    await close();
    if (S.ob || !current()) return;
    run("view", { dataset: { v: "automations", tab: "scheduled" } });
    const box = $("#nl-in");
    if (box) { box.value = text; box.dispatchEvent(new Event("input", { bubbles: true })); }
    await proposeScheduleText(text, () => current() && !S.ob && S.view === "automations" && S.tabs.automations === "scheduled");
  } catch (error) { if (current()) toast(error.message); }
  finally { busy = false; }
}

export function initFirstRoutine(close) {
  markLive(["ob-routine-review", "sw:ob-routine"]);
  on("ob-routine-review", () => review(close));
  document.addEventListener("input", (event) => {
    if (event.target.id === "ob-routine" && S.ob) S.ob.routine = event.target.value.slice(0, 2000);
  });
}
