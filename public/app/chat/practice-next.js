import { renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { markLive } from "../core/features.js";
import { closePop, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let enabled = false, next = false;
/* Availability, read afresh; an open + menu's row follows it in place (the menu itself opens at once, never after this). */
export async function loadPractice() {
  try { enabled = (await api("practice-runs")).enabled === true; }
  catch (error) { enabled = false; toast(error.message); }
  const box = document.getElementById("pm-practice");
  if (!box) return;
  box.disabled = !enabled;
  if (!enabled) { box.checked = false; next = false; }
  const hint = box.closest(".row-in")?.nextElementSibling;
  if (hint?.classList.contains("ph")) hint.textContent = t(enabled ? "practice.next-hint" : "practice.off");
}
export const practiceNext = () => next;
export const practiceSent = () => { next = false; };
export const practiceFlag = () => next ? `<span class="flag">${t("practice.task")}</span>` : "";
export const practiceMenu = () => `<div class="row-in"><span>${t("practice.task")}</span><input class="sw" type="checkbox" id="pm-practice" data-sw="practice" ${next ? "checked" : ""} ${enabled ? "" : "disabled"} aria-label="${t("practice.task")}"></div><div class="ph">${t(enabled ? "practice.next-hint" : "practice.off")}</div>`;
/** Routes that do not carry a task flag cannot safely start a practice task. */
export function refusePracticeRoute(prompt, busy, routed) {
  if (!next) return false;
  if (!busy && !routed && !prompt.startsWith("/")) return false;
  toast(t("practice.ordinary-chat"));
  return true;
}
export function initPractice() {
  markLive(["sw:pm-practice"]);
  document.addEventListener("change", (event) => {
    if (event.target?.id !== "pm-practice") return;
    next = enabled && event.target.checked;
    closePop();
    renderNow();
  });
}
