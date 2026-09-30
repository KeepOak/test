import { switchRow, segmentedRow } from "../row-kit.js";
/* Settings › Notifications, 1:1 with the prototype's page, from the engine: how Branch gets your attention and whether
   it updates itself (the comfort card "notify", POST /api/comfort { card, values }, merged), and quiet hours
   (GET /api/calendar), named in the status line only while they are on. "A Trunk needs a yes" and "A long task finishes"
   are the notify card's needsYes and taskDone (shell/notify.js follows them). "Days off" are whole days of the week
   with no notifications (quietHours.days, saved with POST /api/calendar, the whole calendar record as read). */
import { api, token } from "../../core/api.js";
import { E, S, activeId } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { esc, render } from "../../core/dom.js";
import { toast } from "../../core/ui.js";
import { t, language } from "../../../i18n.js";
import { readQuiet } from "../../chat/comfort.js";
import { popupsSetting } from "../../flows/guides.js"; // setup-resume: the Guide menu's "Show tips and pop-ups", here too

let notify = null;
let quiet = null;
let calendar = null;
let epoch = 0, writing = false, displayed = null;
const locked = () => ["locked", "locked-b17"].some(name => document.getElementById("app")?.classList.contains(name));
const owner = () => E.profiles?.isOwner === true && S.signedIn && !locked();
const scope = () => ({profile:E.profiles, id:activeId(), key:token.get(), epoch});
const valid = state => owner() && state.epoch === epoch && state.profile === E.profiles && state.id === activeId() && state.key === token.get();
async function freshOwner(state) {
  const profiles = await api("profiles");
  if (!valid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) throw new Error(t("settings.catalogue.changed"));
}
const ctl = (id, title, description, checked) => switchRow({id, title, description, checked:!!notify && checked, attributes:`data-sw="set"${owner() && notify ? "" : " disabled"}`});

async function loadNotify() {
  const state = scope(); if (!valid(state)) { notify = quiet = calendar = null; render(); return; }
  try {
    const [comfort, cal] = await Promise.all([api("comfort"), api("calendar")]);
    if (!valid(state)) return;
    displayed = state;
    notify = comfort.values?.notify ?? null;
    calendar = cal.settings ?? null;
    quiet = calendar?.quietHours ?? null;
  } catch (error) { toast(error.message); }
  render();
}

/* A whole day off from notifications, pressed on or off; "None" clears them. The record is sent whole, as read. */
async function toggleDay(v) {
  const state = scope(); if (!calendar || !valid(state) || writing || !["1","2","3","4","5","6","7","none"].includes(v)) return;
  writing = true;
  try {
    await freshOwner(state);
    const fresh = await api("calendar"); if (!valid(state)) return;
    const card = fresh.settings, days = new Set(card.quietHours.days);
    if (v === "none") days.clear(); else if (days.has(+v)) days.delete(+v); else days.add(+v);
    if (days.size > 6) throw new Error(t("settings.notify.days-limit"));
    const got = await api("calendar", { ...card, quietHours: { ...card.quietHours, days: [...days].sort() } });
    if (!valid(state)) return;
    calendar = got;
    quiet = calendar.quietHours;
    readQuiet();
  } catch (error) { if (valid(state)) toast(error.message); }
  finally { writing = false; if (valid(state)) render(); }
}
const dayPressed = (v) => (v === "none" ? !(quiet?.days ?? []).length : (quiet?.days ?? []).includes(+v));
const daysRow = () => segmentedRow({title:t("window.settings.notifications.days-off"), description:t("settings.notify.days-help"), options:[...Array.from({length:7}, (_, i) => [String(i+1),new Intl.DateTimeFormat(language(), {weekday:"short", timeZone:"UTC"}).format(new Date(Date.UTC(2024,0,1+i)))]),["none",t("comfort.placeholder.none")]], selected:dayPressed, action:"n-day", attributes:()=>owner() && calendar && !writing ? "" : "disabled"});

async function saveNotify(part) {
  const state = scope(); if (!valid(state) || writing) return;
  writing = true;
  try { await freshOwner(state); const got = await api("comfort", { card:"notify", values:part }); if (valid(state)) notify = got.values?.notify ?? notify; }
  catch (error) { if (valid(state)) toast(error.message); }
  finally { writing = false; if (valid(state)) render(); }
}

const seg = (title, sub, act, opts, cur) => segmentedRow({title, description: sub, options: opts, current: cur, action: act, attributes:()=>owner() && notify && !writing ? "" : "disabled"});

/* "21:00" as the prototype says it ("10 PM"), in this computer's own way of writing a time. */
const clock = (hm) => { const [h, m] = String(hm).split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(language(), { hour: "numeric", minute: m ? "2-digit" : undefined }); };
const status = () => (quiet?.enabled ? `<div class="status"><span class="sdot "></span><div><b>${t("window.settings.notifications.quiet-hours-are-from-to-to", { from: esc(clock(quiet.from)), to: esc(clock(quiet.to)) })}</b><p>${t("window.settings.notifications.approvals-still-wait-in-the-inbox")}</p></div></div>` : "");

export function draw() {
  if (displayed && (!owner() || displayed.id !== activeId() || displayed.key !== token.get())) {
    notify = quiet = calendar = displayed = null;
  }
  const n = notify ?? {};
  return `<h1>${t("settings.page.notifications")}</h1><p class="lede">${t("window.settings.notifications.when-branch-may-interrupt-you")}</p>${status()}
    <div class="sec"><h2>${t("window.settings.notifications.tell-me-when")}</h2>${ctl("n-need", t("window.settings.notifications.a-trunk-needs-a-yes"), t("window.settings.notifications.shows-in-the-window-and-computer"), n.needsYes !== false)}${ctl("n-done", t("window.settings.notifications.a-long-task-finishes"), t("window.settings.notifications.only-tasks-over-two-minutes"), n.taskDone !== false)}
      ${seg(t("settings.page.notifications"), t("window.settings.notifications.in-the-app-only-or-also"), "n-method", [["window", t("window.settings.notifications.in-the-app")], ["system", t("window.settings.notifications.and-on-the-computer")]], n.method)}
      ${seg(t("window.settings.notifications.play-a-sound"), t("window.settings.notifications.when-branch-needs-your-attention"), "n-sound", [["off", t("autonomy.needs.no")], ["chime", t("window.settings.notifications.a-chime")], ["knock", t("window.settings.notifications.a-knock")]], n.sound)}${popupsSetting()}</div>
    <div class="sec"><h2>${t("window.settings.notifications.quiet")}</h2>${daysRow()}</div>
    <div class="sec"><h2>${t("comfort.field.autoUpdate")}</h2>${seg(t("action.check-for-updates"), t("window.settings.notifications.stable-releases-keep-things-working-beta"), "n-update", [["off", t("window.settings.advanced.never")], ["check", t("window.settings.notifications.daily")], ["install", t("window.settings.notifications.install-when-idle")]], n.autoUpdate)}
      ${seg(t("window.settings.notifications.release-channel"), t("settings.help.release-channel"), "n-channel", [["stable", t("updates.channel.stable")], ["beta", t("updates.channel.beta")]], n.releaseChannel)}</div>`;
}

export function init() {
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (locked()) { epoch++; notify = quiet = calendar = null; } }).observe(app, {attributes:true, attributeFilter:["class"]});
  loadNotify();
  on("n-method", (el) => saveNotify({ method: el.dataset.v }));
  on("n-sound", (el) => saveNotify({ sound: el.dataset.v }));
  on("n-update", (el) => saveNotify({ autoUpdate: el.dataset.v }));
  on("n-channel", (el) => saveNotify({ releaseChannel: el.dataset.v }));
  on("n-day", (el) => toggleDay(el.dataset.v));
  document.addEventListener("change", (e) => {
    if (e.target.id === "n-need") saveNotify({ needsYes: e.target.checked });
    else if (e.target.id === "n-done") saveNotify({ taskDone: e.target.checked });
  });
  markLive(["n-method", "n-sound", "n-update", "n-channel", "n-day", "sw:n-need", "sw:n-done"]);
}

export function load() { return loadNotify(); }

export const live = { "n-method": true, "n-sound": true, "n-update": true, "n-channel": true, "n-day": true, "sw:n-need": true, "sw:n-done": true };
