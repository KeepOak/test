/* No model set up yet: the message box says so in the engine's own words, in the window's language (say()) (GET /api/state modelNeeded, the refusal every
   task gets until one is set up) and offers the way to set one up: setup's Models step while setup is not done
   (GET /api/state onboarding.done), Settings › Models after it. Both are the existing "onboard" and "setgo" actions. */

import { esc } from "../core/dom.js";
import { E, S, ownerHere, activeId } from "../core/state.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { token } from "../core/api.js";
import { run } from "../core/actions.js";
import { dialog } from "../core/ui.js";

export function noModelRow() {
  const words = E.state?.modelNeeded;
  if (!words) return "";
  const go = E.state?.onboarding?.done ? 'data-act="setgo" data-v="models"' : 'data-act="onboard" data-v="1"';
  return `<div class="dockrow15" role="status"><span class="hint">${esc(say(words))}</span><button class="btn pri sm" type="button" ${go}>${t("channel-setup.row-button")}</button></div>`;
}

/* An actual no-model failure exposes recovery actions in that turn; no error-text heuristics. */
export function modelRecovery(run) {
  if (!ownerHere() || run?.status !== "failed" || (!run.modelRecovery && !E.state?.modelNeeded)) return "";
  const setup = E.state?.onboarding?.done ? "" : `<button class="btn sm" type="button" data-act="onboard" data-v="1">${t("window.flows.setup.models")}</button>`;
  return `<div class="acts"><button class="btn sm" type="button" data-act="addacct">${t("window.flows.setup.add-account")}</button>${setup}</div>`;
}

const opened = new Set();
export const recoveryActor = () => ({ token: token.get(), profile: activeId() });

/* Only a newly submitted direct owner turn can open recovery; history never opens dialogs. */
export async function recoverFailedSend(id, sessionId, actor) {
  if (!id || !ownerHere() || actor.token !== token.get() || actor.profile !== activeId()
    || S.view !== "chat" || S.chat !== sessionId || S.ob || dialog() || document.getElementById("app")?.classList.contains("locked-b17")) return;
  const failed = E.state?.runs?.find((item) => item.id === id && item.sessionId === sessionId);
  if (failed?.status !== "failed" || !failed.modelRecovery || opened.has(id)) return;
  opened.add(id);
  if (opened.size > 64) opened.delete(opened.values().next().value);
  await run(E.state?.onboarding?.done ? "addacct" : "onboard-model-recovery");
}
