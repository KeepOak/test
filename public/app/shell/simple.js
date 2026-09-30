/* RES-704, Hermes' Simple mode: one click in the title row hides the developer instrumentation, and one more brings the
   workspace back exactly as it was. It is laid over "How much to show" (core/state.js LEVELS): Simple is Regular with
   the side panel shut and the header's, composer's and status bar's instruments out of sight (styles/simple.css); back
   out, the level, the side panel and every registered part are put back as they were when Simple was switched on. With
   nothing kept to put back (a save from before this switch), the level is the last Advanced or Technical one chosen.
   Another area keeps its own part of the workspace through simplePart({ name, take, hide, give }): take() says how it
   is now, hide() puts it away for Simple, give(value) puts back what take() said. */

import { S, save } from "../core/state.js";
import { renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic } from "../core/ui.js";
import { t } from "../../i18n.js";

/* The side panel beside a conversation (chat/pane.js) and the Settings page open (an Advanced or Developer page gives way
   to General at Regular, settings/settings.js) are put back too. */
const PARTS = [
  { name: "pane", take: () => S.pane ?? null, hide: () => { S.pane = null; }, give: (value) => { S.pane = value; } },
  { name: "setPage", take: () => S.setPage, hide: () => {}, give: (value) => { if (typeof value === "string") S.setPage = value; } },
];
export const simplePart = (part) => { PARTS.push(part); };
export const isSimple = () => S.simple === true;
const ADVANCED = new Set(["advanced", "technical"]);

/** A level chosen anywhere else (Settings' "How much to show", a found setting): the last advanced one is remembered,
    and choosing one leaves Simple, whose level is Regular. */
export function levelChosen(value) {
  if (!ADVANCED.has(value)) return;
  S.advLevel = value;
  if (isSimple()) { S.simple = false; S.simpleFrom = null; mark(); }
}

function toSimple() {
  const kept = { level: S.level };
  for (const part of PARTS) kept[part.name] = part.take();
  if (ADVANCED.has(S.level)) S.advLevel = S.level;
  S.simpleFrom = kept;
  S.simple = true;
  S.level = "regular";
  for (const part of PARTS) part.hide();
}
function toAdvanced() {
  const kept = S.simpleFrom && typeof S.simpleFrom === "object" ? S.simpleFrom : null;
  S.simple = false;
  S.simpleFrom = null;
  if (!kept) { S.level = ADVANCED.has(S.advLevel) ? S.advLevel : "advanced"; return; }
  S.level = typeof kept.level === "string" ? kept.level : "regular";
  for (const part of PARTS) if (part.name in kept) part.give(kept[part.name]);
}

/** Simple on or off (the title row's button). */
export function toggleSimple() {
  if (isSimple()) toAdvanced(); else toSimple();
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
