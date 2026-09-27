/* The dashboard wears exactly what the window wears: the owner's light or dark choice (saved with
   the workspace), and the KeepOak theme, season and contrast this browser remembers (the same local
   storage keys public/layout.js writes). The theme's colours reach Branch's token names through
   /theme-bridge.js, the same module the window uses. */
import { applyAppearance } from "/dashboard/appearance.js";
import { DEFAULT_THEME, solid, themeById, tokensFor, wearTokens } from "/dashboard/theme-bridge.js";
import { paint as paintGrove, seasonToday } from "/dashboard/grove.js";

const root = document.documentElement;
const remembered = (key) => { try { return localStorage.getItem(key); } catch { return null; } };

/** Writes the chosen theme's colours for the mode showing, then paints the oak in its season. */
function applyTheme() {
  const family = themeById(remembered("branch-palette") || DEFAULT_THEME);
  const mode = root.dataset.theme === "daylight" ? "light" : "dark";
  const tokens = tokensFor(family, mode, remembered("branch-contrast") === "more" ? "more" : "standard");
  wearTokens(root, family, tokens);
  const light = mode === "light";
  /* Toward the theme's own paper in light mode, so no colour is written down in this file. */
  root.style.setProperty("--surface", solid(tokens["--ground"], light ? tokens["--paper-2"] : tokens["--text"], light ? 0.55 : 0.07));
  paintGrove({ mode, season: remembered("branch-season") || seasonToday() });
}

let saved = null;
/** Called with the workspace's appearance record whenever the summary brings one. */
export function wearLook(appearance) {
  const key = JSON.stringify(appearance ?? {});
  if (key === saved) return;
  saved = key;
  applyAppearance(appearance ?? {});
  applyTheme();
}

/* Following the computer's light or dark means changing with it, as the window does. */
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (saved === null) return;
  const appearance = JSON.parse(saved);
  if (appearance.followSystem) { applyAppearance(appearance); applyTheme(); }
});
/* Another tab of this browser picked a theme: wear it here too. */
addEventListener("storage", (event) => {
  if (["branch-palette", "branch-season", "branch-contrast"].includes(event.key ?? "")) applyTheme();
});
wearLook(null);
