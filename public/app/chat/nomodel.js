/* No model set up yet: the message box says so in the engine's own words (GET /api/state modelNeeded, the refusal every
   task gets until one is set up) and offers the way to set one up: setup's Models step while setup is not done
   (GET /api/state onboarding.done), Settings › Models after it. Both are the existing "onboard" and "setgo" actions. */

import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { t } from "../../i18n.js";

export function noModelRow() {
  const words = E.state?.modelNeeded;
  if (!words) return "";
  const go = E.state?.onboarding?.done ? 'data-act="setgo" data-v="models"' : 'data-act="onboard" data-v="2"';
  return `<div class="dockrow15" role="status"><span class="hint">${esc(words)}</span><button class="btn pri sm" type="button" ${go}>${t("channel-setup.row-button")}</button></div>`;
}
