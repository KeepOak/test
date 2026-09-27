/* Settings › Advanced, pass 17 (prototype patch17b): "What it can do", the model tools that only need a switch.
   A switch shows the engine's own mode (on unless "off"), turns on as "when-needed" and off as "off":
   Read links you paste is POST /api/web-pages { mode } (web.page and web.crawl); Smart home is
   POST /api/personal/switch { part: "home-control", mode }. Deep research, exact document edits and tables from
   spreadsheets have no switch of their own in the engine, and GitLab has no connection, so those stay greyed.
   The Memory and Health rows have no readout in the window yet (greyed). */
import { render } from "../core/dom.js";
import { api } from "../core/api.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { id15, sw15 } from "./rows15.js";
import { demos17, demo17, sec17 } from "./rows17.js";
import { t } from "../../i18n.js";

const A = { web: null, personal: null };
const onMode = (mode) => (mode ? mode !== "off" : false);
const mode = (on) => (on ? "when-needed" : "off");

const WIRES = {
  "f15-read-links-you-paste": [() => onMode(A.web?.mode), (on) => api("web-pages", { mode: mode(on) })],
  "f15-smart-home": [() => onMode(A.personal?.modes?.["home-control"]), (on) => api("personal/switch", { part: "home-control", mode: mode(on) })],
};
const sw = (title, sub) => sw15(title, sub, WIRES[id15(title)]?.[0]() ?? false);

export async function load17() {
  const [web, personal] = await Promise.all(["web-pages", "personal"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(A, { web: web?.settings ?? null, personal });
  render();
}

export function sections17(lv) {
  if (lv < 1) return "";
  let html = sec17(t("window.settings.p17-advanced.what-it-can-do"),
    sw("Read links you paste", "Opens the page and reads it, including PDFs and videos with captions.")
    + sw("Deep research reports", "Many searches, then a brief with numbered sources.")
    + sw("Edit documents exactly", "Word, Excel and PowerPoint changes that leave everything else as it was.")
    + sw("Tables and charts from spreadsheets", "Read-only questions over CSV and Excel files, answered with a chart.")
    + sw("GitLab", "Issues and merge requests, like the GitHub connection.")
    + sw("Smart home", "Lights, heating and sensors through Home Assistant.")
    + demo17("claims"), t("window.settings.p17-advanced.model-tools-each-one-is-used"));
  html += sec17(t("window.settings.p17-advanced.memory-more"), demos17(["consolidate", "wsmem", "followup", "scratch", "kcards", "reachnotes"]));
  if (lv >= 2) html += sec17(t("dashboard.area.health"), demos17(["health", "fixhints"]));
  return html;
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  markLive(["sw:f15-read-links-you-paste", "sw:f15-smart-home"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await load17();
  });
  load17();
}
