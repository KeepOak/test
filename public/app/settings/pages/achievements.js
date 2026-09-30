/* Settings › Achievements, from GET /api/delight/achievements: how many are earned of how many, each tier's share, and
   every achievement as the engine shows it (the higher the tier, the less a locked one gives away; an earned one says the
   day it was earned in its tooltip). The category tabs are
   the engine's own kinds; picking one only filters the list. With achievements switched off the engine says so and no
   list is drawn. */
import { esc, renderNow } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { toast } from "../../core/ui.js";
import { markLive } from "../../core/features.js";
import { t, language } from "../../../i18n.js";
import { say } from "../../core/words.js";

const TIERS = [["Bronze", "#A86A3D"], ["Silver", "#8C959E"], ["Gold", "#C9982E"], ["Diamond", "#4F8FB8"], ["Godly", "#8A5AA8"], ["SSS+", "#C2412D"]];
const COLOUR = Object.fromEntries(TIERS);
const MEDAL = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="14" r="5.5"></circle><path d="M8.5 9.5L6 3h4l2 4 2-4h4l-2.5 6.5"></path></svg>`;
const LOCK = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"></rect><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"></path></svg>`;

let view = null;
let category = "All";

let quiet = false;

/* The list from GET /api/delight/achievements; the quiet switch from GET /api/delight, which has it even while they are off. */
async function loadAchievements() {
  try {
    const [list, summary] = await Promise.all([api(`delight/achievements?lang=${language()}`), api("delight")]);
    view = list;
    quiet = summary?.settings?.achievements?.quiet === true;
  } catch (error) { toast(error.message); }
  renderNow();
}

/* "Keep achievements quiet": POST /api/delight/settings merges { achievements: { quiet } } into the owner's switches. */
async function saveQuiet(on) {
  try { await api("delight/settings", { achievements: { quiet: on } }); } catch (error) { toast(error.message); }
  await loadAchievements();
}

export function init() {
  on("achcat", (el) => { category = el.dataset.v; renderNow(); });
  document.addEventListener("change", (e) => { if (e.target.id === "ach-q") saveQuiet(e.target.checked); });
  markLive(["sw:ach-q"]);
  loadAchievements();
}
export async function load() { await loadAchievements(); }

function tierChips(list) {
  return TIERS.map(([tier, colour]) => {
    const all = list.filter((a) => a.tier === tier);
    return all.length ? `<span class="tierc"><i data-css="background:${colour}"></i>${esc(say(tier))} · ${all.filter((a) => a.got).length}/${all.length}</span>` : "";
  }).join("");
}

/* The day an achievement was earned, as the engine wrote it down (YYYY-MM-DD, this computer's own date), in the
   window's language; anything else is left out. */
function earnedOn(got) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(got ?? ""));
  if (!m) return "";
  return new Intl.DateTimeFormat(language(), { dateStyle: "medium" }).format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function card(a) {
  const when = a.got ? earnedOn(a.got) : "";
  return `<div class="ach ${a.got ? "" : "locked"}" title="${esc(say(a.tier))}${when ? ` · ${esc(when)}` : ""}"><span class="medal" data-css="background:${COLOUR[a.tier] ?? "var(--ink-3)"}">${a.got ? MEDAL : LOCK}</span><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div>`;
}

/* The engine answers { on: false } while achievements are switched off: no list then, but the quiet switch is still its. */
function settingsSec() {
  return `<div class="sec"><h2>${t("memory.movein.kind.setting")}</h2><div class="ctl"><b>${t("window.settings.achievements.keep-achievements-quiet")}</b><input class="sw" type="checkbox" id="ach-q" ${quiet ? "checked" : ""} aria-label="${t("window.settings.achievements.keep-achievements-quiet")}" data-sw="achquiet"><small>${t("window.settings.achievements.no-pop-ups-they-still-unlock")}</small></div><p class="hint">${t("window.settings.achievements.hints-bronze-and-silver-get-a")}</p></div>`;
}

export function draw() {
  let html = `<h1>${t("delight.ach.title")}</h1>`;
  if (!view?.on) return html + (view ? `<p class="lede">${t("window.settings.achievements.private-to-you-never-nagging")}</p>${settingsSec()}` : "");
  const all = view.list ?? [];
  const list = all.filter((a) => !a.bonus);
  const bonuses = all.filter((a) => a.bonus);
  const kinds = ["All", ...new Set(list.map((a) => a.kind))];
  if (!kinds.includes(category)) category = "All";
  const shown = category === "All" ? list : list.filter((a) => a.kind === category);
  html += `<p class="lede">${t("window.settings.achievements.private-to-you-never-nagging-earned", { earned: esc(view.earned), total: esc(view.total) })}</p>`;
  // The quiet switch stays at the top, where it is while they are off, rather than below all 505 (the lead's call).
  html += settingsSec();
  html += `<div class="ach-sum">${tierChips(list)}</div>`;
  if (bonuses.length) html += `<div class="sec"><h2>${t("window.settings.achievements.connection-bonuses")}</h2><p class="hint">${t("window.settings.achievements.bonuses-outside-rank", { earned: bonuses.filter((a) => a.got).length, total: bonuses.length })}</p><div class="achs">${bonuses.map(card).join("")}</div></div>`;
  html += `<div class="tabs" role="tablist" data-css="margin-top:6px">${kinds.map((k) => `<button class="tab" role="tab" type="button" aria-selected="${category === k}" data-act="achcat" data-v="${esc(k)}">${esc(k === "All" ? t("look.filter.all") : say(k))}</button>`).join("")}</div>`;
  html += `<div class="achs">${shown.map(card).join("")}</div>`;
  return html;
}

export const live = { achcat: true, "sw:ach-q": true };
