/* Words to a schedule, confirmed (the prototype's proposal card under Automations › Scheduled "Describe it").
   The engine reads the sentence (POST /api/schedules/propose {text}): what to do, when it repeats, and when it first
   runs. Every change on the card is read again by the engine ({edit}), so the first run and the cron line are always
   the engine's. Nothing is saved until "Confirm the schedule", which is the ordinary POST /api/schedules. "Who does it"
   stays greyed: a schedule the owner adds runs as the owner, and the engine has no field for another Trunk. */

import { $, esc, renderNow } from "../core/dom.js";
import { E, refresh, level } from "../core/state.js";
import { ic, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { t, language } from "../../i18n.js";

const DAYN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const zone = () => E.profiles?.owner?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone; // your-profile: the owner's chosen time zone
let P = null; // { proposal, what, days, day, time }

/* The engine's schedule on the card's own terms: repeats, which day, and the time (null when the words said none). */
function fromProposal(proposal, what) {
  const s = proposal.schedule, w = (s.weekdays ?? []).join();
  const days = s.intervalMs ? null : s.monthDay ? "monthly" : w === "1,2,3,4,5" ? "weekdays" : w === "0,6" ? "weekends" : s.weekdays?.length === 1 ? "weekly" : s.weekdays ? null : "daily";
  return { proposal, what: what ?? s.prompt, days, day: s.weekdays?.length === 1 ? s.weekdays[0] : null, time: proposal.time === "none" ? null : s.dailyAt ?? null };
}
const hm = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" }); };
/* A weekday's name in the language chosen (0 is Sunday; 7 January 2024 was one). */
const dayName = (i, weekday) => new Date(2024, 0, 7 + i).toLocaleDateString(language(), { weekday });
function whenWords(p) {
  const monthDay = p.proposal.schedule.monthDay;
  if (!p.days || (p.days === "monthly" && monthDay !== 1)) return p.proposal.words;
  const head = { weekdays: t("window.places.schedule-card.weekdays"), weekends: t("window.places.schedule-card.weekends"), monthly: t("window.places.schedule-card.the-1st-of-each-month"),
    weekly: p.day == null ? "" : t("window.places.schedule-card.every-day-of-the-week", { day: dayName(p.day, "long") }), daily: t("window.places.schedule-card.every-day") }[p.days];
  return t("window.places.schedule-card.when-at-time", { when: head, time: hm(p.time) });
}
function firstRun(iso) {
  const d = new Date(iso), today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86_400_000);
  const day = days === 0 ? t("dashboard.today.title") : days === 1 ? t("window.places.schedule-card.tomorrow") : d.toLocaleDateString(language(), { weekday: "long" });
  return t("window.places.schedule-card.day-date-at-time", { day, date: d.toLocaleDateString(language(), { month: "short", day: "numeric" }), time: d.toLocaleTimeString(language(), { hour: "numeric", minute: "2-digit" }) });
}
/* "Every so often" has no day or time on the card; it is ready as the engine read it, until a Repeats button is pressed. */
const everySoOften = (p) => !p.days && !!p.proposal.schedule.intervalMs;
const ready = (p) => everySoOften(p) || (!!p.days && !!p.time);

const seg = (k, v, label, pressed) => `<button type="button" data-act="ppset17d" data-k="${k}" data-v="${v}" aria-pressed="${pressed}">${label}</button>`;
function whoField() {
  const off = ` disabled aria-disabled="true" data-tip="${t("window.places.automations.coming-soon")}"`;
  return `<div class="fld"><span>${t("window.places.schedule-card.who-does-it")}</span><span class="seg">${(Array.isArray(E.trunks) ? E.trunks : []).slice(0, 5).map((t) => `<button type="button" class="soon" aria-pressed="false"${off}>${esc(t.name)}</button>`).join("")}</span></div>`;
}

/* The card under the box, while a proposal is open. */
export function propCard() {
  const p = P;
  if (!p) return "";
  const repeats = [["daily", t("window.places.schedule-card.every-day")], ["weekdays", t("window.places.schedule-card.weekdays")], ["weekends", t("window.places.schedule-card.weekends")], ["weekly", t("window.places.schedule-card.once-a-week")], ["monthly", t("window.places.schedule-card.monthly")]].map(([v, l]) => seg("days", v, l, p.days === v)).join("");
  const on = p.days === "weekly" ? `<div class="fld"><span>${t("accounts.switch.on")}</span><span class="seg">${DAYN.map((d, i) => seg("day", i, cap1(dayName(i, "short")), p.day === i)).join("")}</span></div>` : "";
  const need = !everySoOften(p) && !p.time;
  const first = ready(p) ? t("window.places.schedule-card.when-first-run-date", { when: `<b>${esc(whenWords(p))}</b>`, date: esc(firstRun(p.proposal.firstRunAt)) }) : t("window.places.schedule-card.pick-a-time-to-see-when");
  const cron = level() >= 2 && p.proposal.cron ? `<code class="pp-cron17d">cron ${esc(p.proposal.cron)} · ${esc(p.proposal.schedule.timezone)}</code>` : "";
  return `<div class="prop17d" role="region" aria-label="${t("window.places.schedule-card.proposed-schedule")}"><div class="pp-h17d">${ic("clock", "s")}<b>${t("window.places.schedule-card.heres-the-schedule-branch-understood")}</b><span class="pill idle"><i></i>${t("window.places.schedule-card.not-saved-yet")}</span></div>
    <label class="fld"><span>${t("window.places.schedule-card.it-does")}</span><input class="inp" id="pp-what17d" value="${esc(p.what)}"></label>
    <div class="fld"><span>${t("window.places.schedule-card.repeats")}</span><span class="seg" role="group" aria-label="${t("window.places.schedule-card.repeats")}">${repeats}</span></div>${on}
    <div class="pp-g17d"><label class="fld ${need ? "need17d" : ""}"><span>${t("window.places.schedule-card.at")}${need ? ` · ${t("window.places.schedule-card.it-didnt-say-when")}` : ""}</span><input class="inp" type="time" id="pp-time17d" value="${esc(p.time ?? "")}"></label>${whoField()}</div>
    <p class="pp-first17d" id="pp-first17d">${first}${p.proposal.time === "guessed" ? ` · ${t("window.places.schedule-card.branch-guessed-part-of-this-check")}` : ""}</p>${cron}
    <div class="acts"><button class="btn ghost sm" type="button" data-act="ppno17d">${t("first-run-steps.restore-no")}</button><button class="btn pri sm" type="button" data-act="ppok17d" ${ready(p) ? "" : "disabled"}>${t("window.places.schedule-card.confirm-the-schedule")}</button></div>
    <p class="hint" data-css="margin:0">${t("window.places.schedule-card.it-runs-only-after-you-confirm")}</p></div>`;
}

const keepWhat = () => { const w = document.getElementById("pp-what17d"); if (P && w) P.what = w.value; };

/* The box's words, read by the engine; its refusal is shown in its own words. */
export async function proposeWords() {
  const text = $("#nl-in")?.value.trim();
  if (!text) return;
  try { P = fromProposal((await api("schedules/propose", { text, timezone: zone() })).proposal); } catch (error) { toast(error.message); return; }
  renderNow();
  document.getElementById("pp-what17d")?.focus();
}

/* A change on the card, read again by the engine so the first run is its own. Without a time yet, only the card moves. */
async function reread() {
  keepWhat();
  const p = P;
  if (!p.days || !p.time) return renderNow();
  const weekdays = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], weekly: [p.day ?? 5] }[p.days];
  const edit = { prompt: p.what.trim() || p.proposal.schedule.prompt, dailyAt: p.time, ...(weekdays ? { weekdays } : {}), ...(p.days === "monthly" ? { monthDay: p.proposal.schedule.monthDay ?? 1 } : {}) };
  try { P = fromProposal((await api("schedules/propose", { edit, timezone: p.proposal.schedule.timezone })).proposal, p.what); } catch (error) { toast(error.message); }
  renderNow();
}

async function confirm() {
  keepWhat();
  const p = P;
  if (!p || !ready(p)) return;
  // Read once more just before saving, so the first run is worked out from now and not from when the card opened.
  const s = p.proposal.schedule, when = Object.fromEntries(["dailyAt", "weekdays", "monthDay", "intervalMs"].filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  try {
    const fresh = (await api("schedules/propose", { edit: { prompt: p.what.trim() || s.prompt, ...when }, timezone: s.timezone })).proposal;
    p.proposal = fresh;
    await api("schedules", fresh.schedule);
  } catch (error) { toast(error.message); return; }
  P = null;
  const box = $("#nl-in");
  if (box) box.value = "";
  await refresh().catch((error) => toast(error.message));
  renderNow();
  toast(t("window.places.schedule-card.scheduled-first-run-firstrunat", { firstRunAt: firstRun(p.proposal.firstRunAt) }));
}

export function initScheduleCard() {
  markLive(["nl-add", "sw:nl-in", "ppset17d", "ppno17d", "ppok17d", "sw:pp-what17d", "sw:pp-time17d"]);
  on("nl-add", () => proposeWords());
  on("ppset17d", (el) => {
    if (!P) return;
    const k = el.dataset.k;
    P[k] = k === "day" ? +el.dataset.v : el.dataset.v;
    if (k === "days" && el.dataset.v === "weekly" && P.day == null) P.day = 5;
    reread();
  });
  on("ppno17d", () => { P = null; renderNow(); toast(t("window.places.schedule-card.nothing-was-saved")); });
  on("ppok17d", () => confirm());
  document.addEventListener("change", (e) => {
    if (e.target.id !== "pp-time17d" || !P || !e.target.value) return;
    P.time = e.target.value;
    P.days ??= "daily";
    reread();
  });
}
