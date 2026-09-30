/* No model set up yet: the message box says so in the engine's own words, in the window's language (say()) (GET /api/state modelNeeded, the refusal every
   task gets until one is set up) and offers the way to set one up: setup's Models step while setup is not done
   (GET /api/state onboarding.done), Settings › Models after it. Both are the existing "onboard" and "setgo" actions. */

import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { run } from "../core/actions.js";

export function recoverNoModel(error) {
  if (E.profiles?.isOwner === false) return;
  const words = String(error?.message ?? "");
  if (!E.state?.modelNeeded && !words.includes("No model yet. Choose one in setup or in Settings › Models.")) return;
  const button = document.createElement("button"); button.dataset.v = "1";
  run(E.state?.onboarding?.done ? "addacct" : "onboard", button);
}

export function noModelRow() {
  const words = E.state?.modelNeeded;
  if (!words) return "";
  const go = E.state?.onboarding?.done ? 'data-act="setgo" data-v="models"' : 'data-act="onboard" data-v="1"';
  return `<div class="dockrow15" role="status"><span class="hint">${esc(say(words))}</span><button class="btn pri sm" type="button" ${go}>${t("channel-setup.row-button")}</button></div>`;
}
