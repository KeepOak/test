/* Simple masks instrumentation without overwriting workspace preferences. Explicit panel opens are temporary
   reveals; mode/profile changes discard reveals. The resolver lives in core/interface-mode.js. */

import { S, save } from "../core/state.js";
import { renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic } from "../core/ui.js";
import { t } from "../../i18n.js";
import { clearModeReveals } from "../core/interface-mode.js";

export const isSimple = () => S.simple === true;
const ADVANCED = new Set(["advanced", "technical"]);

/** A level chosen anywhere else (Settings' "How much to show", a found setting): the last advanced one is remembered,
    and choosing one leaves Simple, whose level is Regular. */
export function levelChosen(value) {
  if (!ADVANCED.has(value)) return;
  S.advLevel = value;
  if (isSimple()) { S.simple = false; clearModeReveals(); mark(); }
}

/** Simple on or off (the title row's button). */
export function toggleSimple() {
  S.simple = !isSimple();
  clearModeReveals();
  save();
  mark();
  renderNow();
}

const mark = () => document.getElementById("app")?.classList.toggle("simple19", isSimple());

/** The title row's button: pressed while Simple is on. */
export function simpleButton() {
  const words = isSimple() ? t("window.shell.simple.off") : t("window.shell.simple.on");
  return `<button class="tb-btn simple19-btn" type="button" data-act="simple19" aria-pressed="${isSimple()}" aria-label="${t("window.shell.simple.label")}" data-tip="${words}">${ic("layers", "s")}</button>`;
}

export function initSimple() {
  markLive(["simple19"]);
  on("simple19", () => toggleSimple());
  mark();
}
