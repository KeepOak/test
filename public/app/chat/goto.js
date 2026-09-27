/* Where an engine command's { do: "go", home } answer leads (POST /api/commands/run). The engine names homes
   "<place>:<tab>" or "settings:<page>" with its own map (src/terminal-places.ts); a few of its names differ from the
   window's, and a page or place the window does not have leaves the view where it is. */

import { S } from "../core/state.js";
import { hasPage } from "../settings/settings.js";

const PLACES = ["inbox", "automations", "library", "customize", "overview", "team"];
/* The engine's name → the window's, where they differ. */
const PLACE_OF = { household: "team" };
const TAB_OF = { customize: { skills: "tools", plugins: "tools", connections: "tools" }, overview: { here: "" } };
const PAGE_OF = { data: "usage", about: "updates" };

/** Moves the window to the home the engine named. Returns false when the window has no such place. */
export function goHome(home) {
  const [head, rest = ""] = String(home ?? "").split(":");
  if (head === "chat") { S.view = "chat"; return true; }
  if (head === "settings") {
    const page = PAGE_OF[rest] ?? rest;
    S.view = "settings";
    if (hasPage(page)) S.setPage = page;
    return true;
  }
  const place = PLACE_OF[head] ?? head;
  if (!PLACES.includes(place)) return false;
  S.view = place;
  const tab = TAB_OF[place]?.[rest] ?? rest;
  if (tab) S.tabs[place] = tab;
  return true;
}
