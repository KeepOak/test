/* Automations: scheduled, triggers, procedures, check-ins, and Orchard (places/orchard.js) in the board's tab - matches redesign prototype.
   Real data from: GET /api/state (schedules, triggers, procedures), /api/heartbeat,
   /api/flows-boards, /api/prompts. Switches and buttons wired to real routes. */

import { $, esc, renderNow } from "../core/dom.js";
import { S, E, refresh, ownerHere } from "../core/state.js";
import { ic, av, toast, openDlg, closeDlg } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { initRecipeRun, recipeRunLive } from "./recipe-run.js";
import { api } from "../core/api.js";
import { propCard, initScheduleCard, repeatWords } from "./schedule-card.js";
import { initScheduledDashboard } from "../flows/scheduled-dashboard.js";
import { trigCard, initTriggerCard } from "./trigger-card.js";
import { ordersSection, onItsOwnSection, hooksSection, readAutomations17, initAutomations17 } from "./automations17.js";
import { t, language, plural } from "../../i18n.js";
import { faceOf, nameOf } from "./inbox17.js";
import { say } from "../core/words.js";
import { offTile, initSwitchOn } from "./switch-on.js";
import { empty18 } from "../core/p18.js"; // pass 18: an empty list is a welcome
import { orchardTab, loadOrchard, initOrchard } from "./orchard.js"; // Orchard, in the tab the shared board had

let heartbeat = null;
let prompts = null;
/* stress test B006: whether procedures that start themselves are switched on (GET /api/autonomy modes.procedures); a
   trigger is kept as one, so while it is off the Triggers tab says so with its switch. */
let proceduresMode = null;
let autonomyLabel = "";

/* The design's idea catalogue: [group, title, what it does, the words put in the Scheduled box]. Window text; nothing is
   saved until the person presses Add. */
const IDEAS = [
  ["Money", "Receipts into folders", "When a receipt lands in email, file it by the month it was paid.", "when a receipt arrives by email, file it in Receipts by the month it was paid"],
  ["Money", "Subscription watch", "Tell me when a subscription price goes up.", "every month, check my card statement and tell me if a subscription price went up"],
  ["Money", "Bill reminders", "A nudge three days before each bill is due.", "three days before a bill is due, remind me in Telegram"],
  ["Mornings", "Morning brief", "Weather, calendar and anything that needs you, at 7:30.", "every weekday at 7:30, send me the weather, my calendar and what needs me"],
  ["Mornings", "Inbox triage", "Sort new mail into needs-me, later and noise.", "every morning at 8, sort new mail into needs me, later and noise"],
  ["Home", "Tidy Downloads", "Anything older than six months goes to an archive.", "every Friday at 5, move files older than six months from Downloads to Downloads/Archive"],
  ["Home", "Backup check", "Make sure last night’s backup finished.", "every night at 2, check the backup finished and tell me only if it did not"],
  ["Home", "Photo clean-up", "Find blurry shots and duplicates, and ask before removing.", "every Sunday, find blurry and duplicate photos and ask me before removing any"],
  ["Research", "Price tracker", "Watch a product page and report only a real drop.", "every day, check the price on a product page and tell me only when it drops"],
  ["Research", "News on a topic", "A short weekly digest with sources.", "every Monday, send me a short digest on a topic with sources"],
  ["Research", "Page change alert", "Tell me what changed on a page, not that it changed.", "every hour, check a page and tell me only what changed since last time"],
  ["Work", "Meeting notes", "After each meeting, notes and follow-ups in Library.", "after each calendar meeting, write notes and follow-ups into Library"],
  ["Work", "Weekly report", "Friday summary of what your Trunks did.", "every Friday at 4, summarise what my Trunks did this week"],
];
const ideaCard = (x, i) => `<button type="button" class="idea15" data-act="idea15" data-i="${i}"><small>${esc(say(x[0]))}</small><b>${esc(say(x[1]))}</b><span>${esc(say(x[2]))}</span></button>`;

/* A schedule (state.schedules): the Trunk that made it (data.startedBy) or Branch, its words, when it next comes round and
   who does it, how it has been doing (the time each of its recorded turns took, and how many needed you: the engine's
   history), its switch (the engine's own schedules.pause through POST /api/action, which pauses a pending one and resumes a
   paused one, and refuses to start a job whose check script waits for the owner's yes) and Run. */
const trunkWith = (id) => (id ? (Array.isArray(E.trunks) ? E.trunks : []).find((tr) => tr.id === id) : undefined);
const spark = (v) => { const mx = Math.max(...v) || 1, w = 64, h = 18; return `<svg class="spark15" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${v.map((x, i) => `${(v.length > 1 ? (i / (v.length - 1)) * w : w / 2).toFixed(1)},${(h - 2 - (x / mx) * (h - 4)).toFixed(1)}`).join(" ")}"/></svg>`; };
function health(s) {
  const turns = (Array.isArray(s.data?.history) ? s.data.history : []).filter((h) => h.finishedAt && h.startedAt);
  if (!turns.length) return "";
  const times = turns.map((h) => Math.max(0, new Date(h.finishedAt).getTime() - new Date(h.startedAt).getTime()));
  /* "needed you" only for a turn that stopped to ask (the question Inbox › Needs you lists); one that failed says it hit a
     snag instead, so the row never claims something waits for the owner that Inbox does not show (dogfood D15). */
  const asked = turns.filter((h) => h.status === "needs_input" || h.status === "waiting").length;
  const failed = turns.filter((h) => !["completed", "quiet", "needs_input", "waiting"].includes(h.status)).length;
  const words = asked ? t("window.places.automations.count-needed-you", { count: asked }) : failed ? t("window.chat.agent.snag") : t("window.places.automations.all-fine");
  return `<span class="health15 ${asked || failed ? "warn15" : ""}" title="${esc(plural(turns.length, { one: "window.places.automations.time-per-run-last-count-runs.one", other: "window.places.automations.time-per-run-last-count-runs" }))}">${spark(times)}<small>${plural(turns.length, { one: "window.places.automations.count-runs-words.one", other: "window.places.automations.count-runs-words" }, { words })}</small></span>`;
}
function scheduleRow(s, i) {
  /* A Trunk's routine (GET /api/state schedules[].routine) is that Trunk's, listed by its own name; any other schedule is
     the one that made it (data.startedBy) or Branch's, listed by the first line of what it does. */
  const trunk = trunkWith(s.routine?.trunkId) ?? trunkWith(s.data?.startedBy);
  const what = s.routine?.name ?? String(s.data?.prompt ?? "").split("\n")[0].slice(0, 80);
  /* How often it runs, in words (Q017: a daily one read as its next run's weekday, "Sun 8:00 AM"); the next run only for
     what has no words of its own. */
  const due = repeatWords(s.data) ?? (s.data?.dueAt ? new Date(s.data.dueAt).toLocaleString(language(), { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");
  const who = trunk?.name ?? E.state?.identity?.name ?? "";
  const on = s.data?.status !== "paused";
  /* QA retest 2026-09-28 (m5): Open goes to the schedule's own conversation, where every turn is. */
  return `<div class="prow">${trunk ? av(trunk, 34) : `<span class="ico-tile">${ic("clock", "s")}</span>`}<span class="grow"><b>${esc(what)}</b><small>${esc([due, who].filter(Boolean).join(" · "))}</small></span>${health(s)}${s.data?.dashboard && ownerHere() ? `<button class="btn sm ghost" type="button" data-act="schedule-dashboard" data-id="${esc(s.id || "")}">${t("scheduleddash.title")}</button>` : ""}${s.data?.threadId ? `<button class="btn sm ghost" type="button" data-act="chat" data-id="${esc(s.data.threadId)}">${t("ov.open")}</button>` : ""}<button class="btn sm" type="button" data-act="sched-run" data-id="${esc(s.id || "")}">${t("autonomy.orders.run")}</button><input class="sw" type="checkbox" id="auto-scheduled-${i}" data-sw="schedule" data-id="${esc(s.id || "")}" ${on ? 'checked=""' : ""} aria-label="${t("window.places.automations.value-on-or-off", { value: esc(what) })}"></div>`;
}

/* A saved prompt (GET /api/prompts), every one of them: its name and command, then its group and the first 80 characters of
   what it asks. Use puts the words in the message box of the open conversation (chat/messages.js, on("prompt-use")). */
const clip80 = (text) => { const s = String(text ?? ""); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };
function promptRow(p) {
  return `<div class="prow"><span class="ico-tile">${ic("star", "s")}</span><span class="grow"><b>${esc(p.title ?? "")}${p.command ? ` <code>/${esc(p.command)}</code>` : ""}</b><small>${esc([p.group, clip80(p.body)].filter(Boolean).join(" · "))}</small></span><button class="btn sm" type="button" data-act="prompt-use" data-v="${esc(p.id ?? "")}">${t("prompts.action.use")}</button></div>`;
}

/* A saved recipe: its name, how many steps and the engine's status. Open shows its steps (flow-editor.js). Run shows
   every call it will make, its checks, its clean-up and its tries first, and runs it as the owner only from that dialog
   (./recipe-run.js). */
function procedureRow(p) {
  const steps = Array.isArray(p.data?.definition?.steps) ? p.data.definition.steps.length : 0;
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(p.data?.definition?.name ?? '')}</b><small>${esc([t(steps === 1 ? "window.chat.steps.one" : "window.places.automations.steps-steps", { steps }), p.data?.status].filter(Boolean).join(' · '))}</small></span><button class="btn sm" type="button" data-act="recipe-run" data-id="${esc(p.id)}">${t("autonomy.orders.run")}</button><button class="btn sm" type="button" data-act="flow" data-id="${esc(p.id)}">${t("ov.open")}</button></div>`;
}
/* A procedure that starts itself (GET /api/autonomy/procedures): its steps, its version once changed, and when it starts in
   the engine's words, with "Change suggested" while a change to it waits for the owner's yes (GET /api/autonomy/ledger,
   kind "procedure"). Open edits its steps as a proposal (flow-editor.js, data-v="auto"). Run now (proc-run) starts it
   the way its level says (POST /api/autonomy/procedures/<id>/run): at "auto" it runs within its own permissions and the
   approval rules; otherwise it asks first in Inbox › Needs you. The engine's reason is shown when it did not start. */
let autoProcedures = [];
let changing = new Set();
function autoRow(p) {
  const small = [t(p.procedure.steps.length === 1 ? "window.chat.steps.one" : "window.places.automations.steps-steps", { steps: p.procedure.steps.length }), p.version > 1 ? t("window.places.automations.version-version", { version: p.version }) : "", p.starts].filter(Boolean).join(" · ");
  const pill = changing.has(p.id) ? ` <span class="pill work pp-pill17d"><i></i>${t("window.places.automations.change-suggested")}</span>` : "";
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(p.procedure.name)}${pill}</b><small>${esc(small)}</small></span><button class="btn sm" type="button" data-act="proc-run" data-id="${esc(p.id)}">${t("autonomy.orders.run")}</button><button class="btn sm" type="button" data-act="flow" data-id="${esc(p.id)}" data-v="auto">${t("ov.open")}</button></div>`;
}

/* QA retest 2026-09-28 (S2): the box's words are kept for each tab and drawn back into it. The page is drawn anew whenever
   the engine's state moves (it does while a model reads the words), and a box drawn without them came back empty, so words
   the engine could not read were gone before the person could fix them. */
const NL = { scheduled: "", triggers: "" };
const nlTab = () => (S.tabs.automations === "triggers" ? "triggers" : "scheduled");
const nlValue = () => ` value="${esc(NL[nlTab()])}"`;
/* B002: Add is drawn pressable only while the box has words (a redraw keeps what was typed). */
const boxEmpty = () => (NL[nlTab()].trim() ? "" : " disabled");
const promptsOff = () => prompts?.settings?.mode === "off";
async function modeOfProcedures() {
  const a = await api("autonomy");
  return { mode: a.modes?.procedures ?? null, label: a.labels?.procedures ?? "" };
}

export function draw() {
  const tab = S.tabs.automations || "scheduled";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const schedules = E.state.schedules || [];
  const triggers = E.state.triggers || [];
  const procedures = E.state.procedures || [];

  let html = `<main class="main enter11" id="main"><div class="lock-banner">${ic('lock', 's')}${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div><div class="scroll"><div class="place">
    <h1>${t("dashboard.automations.title")}</h1><p class="lede">${t("window.places.automations.work-your-trunks-do-on-their")}</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === 'scheduled' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="scheduled">${t("place.automations.scheduled")}</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'procedures' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="procedures">${t("nav.procedures")}</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'triggers' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="triggers">${t("asks.board.triggers")}</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'checkins' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="checkins">${t("window.places.automations.check-ins")}</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'board' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="board">${t("window.places.orchard.tab")}</button></div>`;

  if (tab === "scheduled") {
    html += `<p class="hint" data-css="margin:4px 0 8px">${t("window.places.automations.work-a-trunk-does-on-a")}</p>
    <form class="nl" data-form="nl"><input class="inp" id="nl-in"${nlValue()} placeholder="${esc(t("window.places.automations.describe-it-every-weekday-at-8"))}" aria-label="${t("window.places.automations.describe-a-new-automation")}"><button class="btn pri" type="submit" data-act="nl-add"${boxEmpty()}>${t("asks.runtimes.add")}</button></form>${propCard()}
    ${schedules.length ? `<div class="rows" data-css="margin-top:8px">${schedules.map(scheduleRow).join('')}</div>` : empty18("automations:scheduled")}
  <div class="sec ideas15"><div class="sec-h15"><h2>${t("window.places.automations.ideas")}</h2><button type="button" class="link15" data-act="ideas15">${t("window.places.automations.see-all-count", { count: IDEAS.length })}</button></div><div class="idea-row15">${IDEAS.slice(0, 3).map(ideaCard).join('')}</div></div>${ordersSection()}${onItsOwnSection()}`;

    markLive(schedules.map((_, i) => `sw:auto-scheduled-${i}`));
  } else if (tab === "procedures") {
    html += `<p class="hint" data-css="margin:4px 0 8px">${t("window.places.automations.saved-step-by-step-routines-including")}</p>
    <div class="acts" data-css="margin:6px 0"><button class="btn" type="button" data-act="teach-start" ${E.trunks.length ? "" : `disabled data-tip="${esc(t("window.switch-on.needs-trunk"))}"`}>${ic('play', 's')}${t("window.places.automations.show-a-trunk-how-once")}</button></div>
    <div class="rows" data-css="margin-top:8px">${autoProcedures.map(autoRow).join('')}${procedures.map(procedureRow).join('')}</div>
  <div class="sec"><h2>${t("prompts.card.title")}</h2><p class="hint" data-css="margin:0 0 8px">${t("window.places.automations.things-you-ask-for-often-each")}</p>${promptsOff() ? offTile("prompts", t("window.switch-on.off", { label: t("prompts.card.title") })) : ""}<div class="rows">${(prompts?.prompts ?? []).map(promptRow).join('')}</div><div class="acts" data-css="margin-top:10px"><button class="btn" type="button" data-act="prompt-new"${promptsOff() ? ` disabled data-tip="${esc(t("window.switch-on.off", { label: t("prompts.card.title") }))}"` : ""}>${ic('plus', 's')}${t("window.places.automations.new-prompt")}</button></div></div>`;

  } else if (tab === "triggers") {
    html += `<p class="hint" data-css="margin:4px 0 8px">${t("window.places.automations.work-that-starts-when-something-happens")}</p>${proceduresMode === "off" ? offTile("procedures", t("window.switch-on.off", { label: autonomyLabel }), t("window.switch-on.triggers-why")) : ""}
    <form class="nl" data-form="nl"><input class="inp" id="nl-in"${nlValue()} placeholder="${esc(t("window.places.automations.describe-it-when-a-task-finishes"))}" aria-label="${t("window.places.automations.describe-a-new-automation")}"><button class="btn pri" type="submit" data-act="trig-add"${boxEmpty()}>${t("asks.runtimes.add")}</button></form>${trigCard()}
    ${triggers.length ? "" : empty18("automations:triggers")}<div class="rows" data-css="margin-top:8px">${triggers.length ? triggers.map((tr, i) => `<div class="prow">${tr.sessionId ? faceOf(tr.sessionId, 34) : `<span class="ico-tile">${ic("bolt", "s")}</span>`}<span class="grow"><b>${esc(tr.name ?? '')}</b><small>${esc([String(tr.prompt ?? '').split('\n')[0], tr.sessionId ? nameOf(tr.sessionId) : E.state?.identity?.name].filter(Boolean).join(' · '))}</small></span><input class="sw" type="checkbox" id="auto-triggers-${i}" data-sw="trigger" data-id="${esc(tr.id || '')}" ${tr.enabled ? 'checked=""' : ''} aria-label="${t("window.places.automations.value-on-or-off", { value: esc(tr.name ?? '') })}"></div>`).join('') : ''}</div>${hooksSection()}`;

    markLive(triggers.map((_, i) => `sw:auto-triggers-${i}`));
  } else if (tab === "checkins") {
    html += checkinsTile(heartbeat);
  } else if (tab === "board") {
    html += orchardTab();
  }

  html += `</div></div></div></main>`;
  return html;
}

export async function after() {
  const tab = S.tabs.automations || "scheduled";
  const p17 = await readAutomations17(tab);
  if (p17.error) toast(p17.error.message);
  if (p17.changed) renderNow();

  if (tab === "checkins") {
    const fresh = await api("heartbeat").catch(() => null);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(heartbeat)) {
      heartbeat = fresh;
      renderNow();
    }
  } else if (tab === "board") {
    if (await loadOrchard()) renderNow();
  } else if (tab === "triggers") {
    let modes = null;
    try { modes = await modeOfProcedures(); } catch (error) { toast(error.message); }
    if (modes && (modes.mode !== proceduresMode || modes.label !== autonomyLabel)) {
      proceduresMode = modes.mode;
      autonomyLabel = modes.label;
      renderNow();
    }
  } else if (tab === "procedures") {
    const [fresh, auto, ledger] = await Promise.all([api("prompts").catch(() => null), api("autonomy/procedures").catch(() => null), api("autonomy/ledger").catch(() => null)]);
    const autoFresh = auto?.procedures ?? autoProcedures;
    const waitingFresh = new Set((ledger?.entries ?? []).filter((e) => e.kind === "procedure").map((e) => e.payload?.procedureId));
    if ((fresh && JSON.stringify(fresh) !== JSON.stringify(prompts)) || JSON.stringify(autoFresh) !== JSON.stringify(autoProcedures) || [...waitingFresh].join() !== [...changing].join()) {
      prompts = fresh ?? prompts;
      autoProcedures = autoFresh;
      changing = waitingFresh;
      renderNow();
    }
  }
}

/* Check in on its own, from GET /api/heartbeat: whether it is on (the checkIn switch), how often, which hours, whether
   weekends are quiet (quietWeekends), what it checks (the checklist, one line each) and the last check-ins. Settings are
   saved whole (POST /api/heartbeat). "Work hours" is the span 9 AM to 5 PM (activeHours 09:00–17:00), pressed when
   that is the span kept; any other span shows as itself. */
const hhmm = (t) => { const [h, m] = String(t).split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(language(), { hour: "numeric", minute: m ? "2-digit" : undefined }); };
const settingsOf = (hb) => hb?.heartbeat?.settings ?? null;
const linesOf = (hb) => String(settingsOf(hb)?.checklist ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

const WORK_HOURS = { from: "09:00", to: "17:00" };
function checkinsTile(hb) {
  const set = settingsOf(hb), mode = hb?.switches?.checkIn ?? "off", on = mode !== "off";
  const every = on ? String(set?.everyMinutes ?? "") : "off";
  const hours = set?.activeHours ?? null;
  const work = !!hours && hours.from === WORK_HOURS.from && hours.to === WORK_HOURS.to;
  const seg = (act, v, label, pressed) => `<button type="button" aria-pressed="${pressed}" data-act="${act}" data-v="${v}">${label}</button>`;
  const history = (hb?.heartbeat?.state?.history ?? []).slice(-5).reverse();
  return `<div class="tile"><div class="th"><b>${t("window.places.automations.check-in-on-its-own")}</b><span class="pill ${on ? "ok" : "idle"} ml"><i></i>${on ? t("accounts.switch.on") : t("accounts.switch.off")}</span></div><p>${t("window.places.automations.branch-looks-at-the-list-below")}</p>
    <div class="ctl"><b>${t("settingsIndex.metering-every.2")}</b><span class="right"><span class="seg" role="group" aria-label="${t("settingsIndex.metering-every.2")}">${seg("hb-every", 15, t("window.places.automations.every-15-min"), every === "15")}${seg("hb-every", 30, t("window.places.automations.every-30-min"), every === "30")}${seg("hb-every", 60, t("window.places.automations.every-hour"), every === "60")}${seg("hb-every", "off", t("accounts.switch.off"), every === "off")}</span></span><small>${t("window.places.automations.quiet-background-work-no-news-no")}</small></div>
    <div class="ctl"><b>${t("window.places.automations.which-hours")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.places.automations.which-hours")}">${hours && !work ? seg("hb-hours", "kept", `${esc(hhmm(hours.from))} – ${esc(hhmm(hours.to))}`, true) : ""}${seg("hb-hours", "always", t("window.places.automations.always"), !hours)}${seg("hb-hours", "work", t("window.places.automations.work-hours"), work)}</span></span><small>${t("window.places.automations.outside-these-hours-it-waits")}${work ? ` ${esc(hhmm(WORK_HOURS.from))} – ${esc(hhmm(WORK_HOURS.to))}` : ""}</small></div>
    <div class="ctl"><b>${t("window.places.automations.quiet-on-weekends")}</b><input class="sw" type="checkbox" id="hb-wk" aria-label="${t("window.places.automations.quiet-on-weekends")}" data-sw="hb-wk" ${set?.quietWeekends ? 'checked=""' : ""} ${set ? "" : "disabled"}><small>${t("window.places.automations.it-still-tells-you-if-a")}</small></div>
    <div class="sec"><h2>${t("window.places.automations.what-it-checks")}</h2><div class="rows">${linesOf(hb).map((c) => `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg></span><span class="grow"><b data-css="font-weight:500">${esc(c)}</b></span><button class="icon-btn" type="button" aria-label="${t("accounts.action.remove")}" data-act="hb-rm" data-v="${esc(c)}" data-css="width:28px;height:28px"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>`).join("")}</div><form class="nl" data-form="hb" data-css="margin-top:8px"><input class="inp" id="hb-in" placeholder="${esc(t("window.places.automations.add-something-to-check-a-reply"))}" aria-label="${t("window.places.automations.add-something-to-check")}"><button class="btn" type="submit">${t("asks.runtimes.add")}</button></form></div>
    <div class="sec"><h2>${t("window.places.automations.last-check-ins")}</h2><ol class="tl">${history.map((h) => `<li class="${h.outcome === "failed" ? "" : "ok"}"><span>${esc(h.outcome)}<small>${esc(h.reason ?? "")}</small></span><time>${esc(new Date(h.startedAt).toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</time></li>`).join("")}</ol></div></div>${gateTiles(hb)}`;
}

/* Each job whose check script waits for the owner's yes (GET /api/heartbeat schedules, gate.approved false): the job and
   the exact program. Allow stays greyed for separate review: a yes lets a program on this computer run before every turn
   (POST /api/schedules/<id>/gate). Cancel stays greyed too: a job with a check script is saved paused until the script is
   allowed (src/scheduler.ts create), so the engine's "no" changes nothing. Both carry one reason (window.why.gate-script),
   since the tile shows one line under it. */
function gateTiles(hb) {
  const waiting = (hb?.schedules ?? []).filter((s) => s.gate && !s.gate.approved);
  return waiting.map((s) => `<div class="tile" data-css="margin-top:14px"><div class="th"><b>${t("window.places.automations.a-check-script-wants-your-yes")}</b><span class="pill work ml"><i></i>${t("dashboard.needs.title")}</span></div><p>${t("window.places.automations.prompt-wants-to-run-command-before", { prompt: esc(s.prompt), command: `<code>${esc([s.gate.executable, ...(s.gate.args ?? [])].join(" "))}</code>` })}</p><div class="acts"><button class="btn pri sm" type="button" data-act="gate-yes" data-why="gate-script" data-id="${esc(s.id)}">${t("trunks.room.allow")}</button><button class="btn ghost sm" type="button" data-act="gate-no" data-why="gate-script" data-id="${esc(s.id)}">${t("updates.busy.cancel")}</button></div></div>`).join("");
}

async function saveHeartbeat(change, switchOn) {
  try {
    const set = settingsOf(heartbeat);
    if (change && set) await api("heartbeat", { ...set, ...change });
    if (switchOn !== undefined) await api("heartbeat/switches", { checkIn: switchOn });
    heartbeat = await api("heartbeat");
  } catch (error) { toast(error.message); }
  renderNow();
}

/* Remove takes away the line by its words, from the checklist as the engine has it now: a list read again under a held
   press (core/dom.js pressIn) or changed from another window never loses a line other than the one pressed, and a
   line already gone takes nothing away. */
async function removeLine(text) {
  try { heartbeat = await api("heartbeat"); } catch (error) { toast(error.message); return; }
  const lines = linesOf(heartbeat), at = lines.indexOf(text);
  if (at < 0) { renderNow(); return; }
  lines.splice(at, 1);
  await saveHeartbeat({ checklist: lines.join("\n") });
}

export function init() {
  initAutomations17();
  initSwitchOn();
  /* B002: Add waits for words: it is pressable once the box has some (typed, or put there from an idea). */
  document.addEventListener("input", (e) => {
    if (e.target.id !== "nl-in") return;
    NL[nlTab()] = e.target.value;
    const add = e.target.closest("form.nl")?.querySelector('button[type="submit"]');
    if (add) add.disabled = !e.target.value.trim();
  });
  markLive(["sw:hb-in", "sw:hb-wk", "ptab", "hb-every", "hb-hours", "hb-rm", "sched-run", "ideas15", "idea15", "prompt-use", "proc-run", ...recipeRunLive]);
  initRecipeRun();
  on("ideas15", () => openDlg({ title: t("window.places.automations.ideas-for-automations"), wide: true, body: [...new Set(IDEAS.map((x) => x[0]))].map((g) => `<div class="idea-g15"><h3>${esc(say(g))}</h3><div class="idea-row15">${IDEAS.map((x, i) => (x[0] === g ? ideaCard(x, i) : "")).join("")}</div></div>`).join("") }));
  /* Fills the Scheduled box with the idea's words; nothing is saved here. */
  on("idea15", (el) => {
    closeDlg();
    S.view = "automations";
    S.tabs.automations = "scheduled";
    renderNow();
    const box = $("#nl-in");
    if (box) { box.value = say(IDEAS[+el.dataset.i]?.[3] ?? ""); box.dispatchEvent(new Event("input", { bubbles: true })); box.focus(); }
  });
  initOrchard();
  /* Run now on a procedure that starts itself; the engine says why when it did not start (asked first, already running). */
  on("proc-run", async (el) => {
    el.disabled = true;
    try {
      const answer = await api(`autonomy/procedures/${encodeURIComponent(el.dataset.id)}/run`, {});
      if (answer?.reason) toast(answer.reason);
      autoProcedures = (await api("autonomy/procedures")).procedures ?? autoProcedures;
    } catch (error) { toast(error.message); }
    renderNow();
  });
  /* A schedule's own switch: off holds it (pause), on lets it come round again (resume); the engine's refusal puts it back. */
  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset?.sw !== "schedule" || !el.dataset.id) return;
    try { await api("action", { tool: "schedules.pause", args: { id: el.dataset.id, paused: !el.checked } }); await refresh(); } catch (error) { el.checked = !el.checked; toast(error.message); }
    renderNow();
  });
  on("sched-run", async (el) => { try { await api(`schedules/${encodeURIComponent(el.dataset.id)}/trigger`, {}); await refresh(); renderNow(); } catch (error) { toast(error.message); } });
  on("hb-every", (el) => (el.dataset.v === "off" ? saveHeartbeat(null, "off") : saveHeartbeat({ everyMinutes: +el.dataset.v }, "on")));
  on("hb-hours", (el) => (el.dataset.v === "always" ? saveHeartbeat({ activeHours: null }) : el.dataset.v === "work" ? saveHeartbeat({ activeHours: WORK_HOURS }) : null));
  on("hb-rm", (el) => removeLine(el.dataset.v));
  // Scheduled: "Add" (and Enter, which presses it) asks the engine to read the words into a proposal card
  // (schedule-card.js). Triggers: the same, read into a trigger (trigger-card.js). The page itself is never submitted.
  initScheduleCard();
  initScheduledDashboard();
  initTriggerCard();
  document.addEventListener("submit", (e) => { if (e.target.dataset?.form === "nl") e.preventDefault(); });
  document.addEventListener("submit", (e) => {
    if (e.target.dataset?.form !== "hb") return;
    e.preventDefault();
    const text = document.getElementById("hb-in")?.value.trim();
    if (text) saveHeartbeat({ checklist: [...linesOf(heartbeat), text].join("\n") });
  });
  /* Quiet on weekends: saved with the rest of the check-in's settings. */
  document.addEventListener("change", (e) => { if (e.target.id === "hb-wk") saveHeartbeat({ quietWeekends: e.target.checked }); });
  /* A trigger's own switch: POST /api/triggers/<id>/enabled. */
  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset?.sw !== "trigger" || !el.dataset.id) return;
    try { await api(`triggers/${encodeURIComponent(el.dataset.id)}/enabled`, { enabled: el.checked }); } catch (error) { el.checked = !el.checked; toast(error.message); }
  });
}
