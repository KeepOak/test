/* UI-033 / UI-202: the window tells the engine what it saw that earns an achievement (POST /api/delight/noticed through
   shell/scene.js noticed, which sends nothing while achievements are off and each flag once). After every drawing it
   looks at what is on screen and tells only what changed since:
   - the theme worn, in Daylight or Moonlight, with the oak's season when the painted grove shows one ("N themes tried",
     "Every leaf on the tree"); one of your own themes is not the engine's, so it is not told;
   - the oak's season on its own ("The oak in spring", "Four seasons");
   - Keep things still on ("Still life"), a language other than the one Branch opened in ("Multilingual"), and every part
     Settings › Appearance can hide, hidden ("It's lonely over here");
   - the old window's acorn and "Show everything", re-mapped to this one (src/achievements.ts): the tree at the foot of the
     list shown ("Keeper of the tree"), Technical chosen under How much to show ("Everything, everywhere"). Turning the
     season yourself ("Turn of the season") is told where it is chosen (settings/pages/appearance.js). */
import { afterDraw } from "../core/dom.js";
import { E, S } from "../core/state.js";
import { language } from "../../i18n.js";
import { D, W, noticed, oakSeason } from "./scene.js";
import { effMode, wornId } from "./look.js";
import { HIDEABLE } from "../settings/pages/appearance.js";

let told = "", openedIn = null;
function look() {
  const hidden = E.state?.preferences?.hidden ?? [];
  return { theme: wornId(), mode: effMode(), season: oakSeason(), still: !!E.state?.preferences?.reduceMotion,
    tree: W.scenery && !!document.querySelector(".side > .scenery"), technical: S.level === "technical",
    language: language(), lonely: HIDEABLE.length > 0 && HIDEABLE.every((k) => hidden.includes(k)) };
}
function tell() {
  // Nothing before the engine answers, and nothing while achievements are known to be off: a switched-off delight asks
  // nothing and runs nothing. What changed meanwhile is told once they are on again.
  if (!E.state || !D.settings?.achievements?.on) return;
  const now = look(), key = JSON.stringify(now);
  if (key === told) return;
  told = key;
  openedIn ??= now.language;
  if (!now.theme.startsWith("my-")) noticed({ what: "theme", mode: now.mode, theme: now.theme, ...(now.season ? { season: now.season } : {}) });
  if (now.season) noticed({ what: "season", season: now.season });
  if (now.still) noticed({ what: "flag", flag: "still" });
  if (now.language !== openedIn) noticed({ what: "flag", flag: "language" });
  if (now.lonely) noticed({ what: "flag", flag: "lonely" });
  if (now.tree) noticed({ what: "flag", flag: "acorn-shown" });
  if (now.technical) noticed({ what: "flag", flag: "everything" });
}
export function initNotices() { afterDraw(tell); }
