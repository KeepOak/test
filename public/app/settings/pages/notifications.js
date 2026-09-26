/* Settings › Notifications, 1:1 with the prototype's page, from the engine: how Branch gets your attention and whether
   it updates itself (the comfort card "notify", POST /api/comfort { card, values }, merged), and quiet hours
   (GET /api/calendar), named in the status line only while they are on. "A Trunk needs a yes", "A long task finishes"
   and "Days off" have no engine setting of their own (the engine's working days are a set, not one day), so they are
   drawn greyed. */
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { esc, render } from "../../core/dom.js";
import { toast } from "../../core/ui.js";
import { ctl, ctlSeg } from "../parts.js";
import { t, language } from "../../../i18n.js";
import { popupsSetting } from "../../flows/guides.js"; // setup-resume: the Guide menu's "Show tips and pop-ups", here too

let notify = null;
let quiet = null;

async function loadNotify() {
  try {
    const [comfort, calendar] = await Promise.all([api("comfort"), api("calendar")]);
    notify = comfort.values?.notify ?? null;
    quiet = calendar.settings?.quietHours ?? null;
  } catch (error) { toast(error.message); }
  render();
}

async function saveNotify(part) {
  try { notify = (await api("comfort", { card: "notify", values: part })).values?.notify ?? notify; } catch (error) { toast(error.message); }
  render();
}

const seg = (title, sub, act, opts, cur) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="${act}" data-v="${v}">${esc(l)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;

/* "21:00" as the prototype says it ("10 PM"), in this computer's own way of writing a time. */
const clock = (hm) => { const [h, m] = String(hm).split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(language(), { hour: "numeric", minute: m ? "2-digit" : undefined }); };
const status = () => (quiet?.enabled ? `<div class="status"><span class="sdot "></span><div><b>${t("window.settings.notifications.quiet-hours-are-from-to-to", { from: esc(clock(quiet.from)), to: esc(clock(quiet.to)) })}</b><p>${t("window.settings.notifications.approvals-still-wait-in-the-inbox")}</p></div></div>` : "");

export function draw() {
  const n = notify ?? {};
  return `<h1>${t("settings.page.notifications")}</h1><p class="lede">${t("window.settings.notifications.when-branch-may-interrupt-you")}</p>${status()}
    <div class="sec"><h2>${t("window.settings.notifications.tell-me-when")}</h2>${ctl("n-need", t("window.settings.notifications.a-trunk-needs-a-yes"), t("window.settings.notifications.shows-on-this-computer-and-your"), false)}${ctl("n-done", t("window.settings.notifications.a-long-task-finishes"), t("window.settings.notifications.only-tasks-over-two-minutes"), false)}
      ${seg(t("settings.page.notifications"), t("window.settings.notifications.in-the-app-only-or-also"), "n-method", [["window", t("window.settings.notifications.in-the-app")], ["system", t("window.settings.notifications.and-on-the-computer")]], n.method)}
      ${seg(t("window.settings.notifications.play-a-sound"), t("window.settings.notifications.when-branch-needs-your-attention"), "n-sound", [["off", t("autonomy.needs.no")], ["chime", t("window.settings.notifications.a-chime")], ["knock", t("window.settings.notifications.a-knock")]], n.sound)}${popupsSetting()}</div>
    <div class="sec"><h2>${t("window.settings.notifications.quiet")}</h2>${ctlSeg(t("window.settings.notifications.days-off"), t("window.settings.notifications.no-notifications-at-all-on-these"), [t("window.settings.notifications.sat"), t("window.settings.notifications.sun"), t("comfort.placeholder.none")], "")}</div>
    <div class="sec"><h2>${t("comfort.field.autoUpdate")}</h2>${seg(t("action.check-for-updates"), t("window.settings.notifications.stable-releases-keep-things-working-beta"), "n-update", [["off", t("window.settings.advanced.never")], ["check", t("window.settings.notifications.daily")], ["install", t("window.settings.notifications.install-when-idle")]], n.autoUpdate)}
      ${seg(t("window.settings.notifications.release-channel"), "", "n-channel", [["stable", t("updates.channel.stable")], ["beta", t("updates.channel.beta")], ["dev", t("updates.channel.dev")]], n.releaseChannel)}</div>`;
}

export function init() {
  loadNotify();
  on("n-method", (el) => saveNotify({ method: el.dataset.v }));
  on("n-sound", (el) => saveNotify({ sound: el.dataset.v }));
  on("n-update", (el) => saveNotify({ autoUpdate: el.dataset.v }));
  on("n-channel", (el) => saveNotify({ releaseChannel: el.dataset.v }));
  markLive(["n-method", "n-sound", "n-update", "n-channel"]);
}

export function load() { return loadNotify(); }

export const live = { "n-method": true, "n-sound": true, "n-update": true, "n-channel": true };
