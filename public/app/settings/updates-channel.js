/* Settings › Updates, the channel section: Stable (published releases, each checked against its fingerprint) or Beta
   (every merged change built on this computer), the comfort card "notify" field releaseChannel (POST /api/comfort
   merges the one value). Only the owner, in the app window on this computer, may change it. What the updater says,
   the change this copy was built from and Beta's newest change come from the desktop app's updater (IPC), so "Check
   now" and moving to a change that does not contain this copy's are live only in the desktop app; that move needs the
   owner's yes in a dialog naming the exact change.
   The copies of the data folder taken before each update (GET /api/updates/data-copies) are offered here too:
   putting one back is asked of the engine (POST, { name }) and happens at the next start. */
import { E } from "../core/state.js";
import { api, goingAway } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc, render } from "../core/dom.js";
import { markLive } from "../core/features.js";
import { closeDlg, openDlg, toast } from "../core/ui.js";
import { t, language } from "../../i18n.js";

let notify = null, desktop = null, copies = null, copiesRefused = null;
const bridge = () => window.branchDesktop ?? null;
const short = (commit) => (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : "");

export async function loadChannel() {
  if (E.profiles?.isOwner === false) return;
  try {
    // On a paired phone the engine refuses the copies (403, only in the window on this computer): its words are shown in their row.
    const [comfort, kept] = await Promise.all([api("comfort"), api("updates/data-copies").catch((error) => {
      if (error.status !== 403) throw error;
      copiesRefused = error.message;
      return null;
    })]);
    notify = comfort.values?.notify ?? null;
    copies = kept;
    desktop = bridge() ? await bridge().updateStatus() : null;
  } catch (error) { toast(error.message); }
  render();
}

async function saveNotify(part) {
  try {
    notify = (await api("comfort", { card: "notify", values: part })).values?.notify ?? notify;
    if (bridge()) desktop = await bridge().updateStatus();
  } catch (error) { toast(error.message); }
  render();
}

const seg = (title, act, opts, cur, note) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="${act}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</span></span><small>${esc(note)}</small></div>`;

/* The updater's status as this page last read it (the status card prefers the one shell/updating.js hears live). */
export const channelStatus = () => desktop;

/* Beta's two changes, once the updater has looked (desktop app only). What the updater says, and Check now, are in the
   status card at the top of the page; moving to another line is offered there too, only when the line diverged. */
function betaStatus() {
  const release = desktop?.release?.channel === "beta" ? desktop.release : null;
  const mine = short(desktop?.installed?.commit), newest = short(release?.commit);
  if (!mine && !newest) return "";
  return `<div class="ctl"><b>${t("updates.channel.beta")}</b><span class="right"></span><small>${mine ? esc(t("window.settings.updates.this-copy", { commit: mine })) : ""}${mine && newest ? " · " : ""}${newest ? esc(t("window.settings.updates.newest-on-line", { commit: newest })) : ""}</small></div>`;
}

/* The newest copy of the data folder, and whether it is to be put back at the next start. */
function copyRow() {
  if (copiesRefused) return `<div class="ctl"><b>${t("window.settings.updates.data-copy")}</b><span class="right"></span><small>${esc(copiesRefused)}</small></div>`;
  const newest = copies?.copies?.[0];
  if (!newest) return "";
  const when = new Date(newest.savedAt).toLocaleString(language());
  const pending = copies.pending === newest.name;
  const act = pending ? `<button class="btn sm" type="button" data-act="u-keep">${t("window.settings.updates.keep-data")}</button>`
    : `<button class="btn sm" type="button" data-act="u-restore" data-name="${esc(newest.name)}">${t("window.settings.updates.put-back")}</button>`;
  return `<div class="ctl"><b>${t("window.settings.updates.data-copy")}</b><span class="right">${act}</span><small>${esc(t(pending ? "window.settings.updates.data-copy-pending" : "window.settings.updates.data-copy-from", { when, version: newest.version }))}</small></div>`;
}

export function channelSection() {
  if (!notify) return "";
  const beta = notify.releaseChannel === "beta";
  return `<div class="sec"><h2>${t("updates.channel.label")}</h2>${seg(t("window.settings.notifications.release-channel"), "u-channel", [["stable", t("updates.channel.stable")], ["beta", t("updates.channel.beta")]], notify.releaseChannel, t("updates.channel.note"))}${beta && bridge() ? betaStatus() : ""}${copyRow()}</div>`;
}

async function check() {
  try { desktop = await bridge().checkForUpdates(); } catch (error) { toast(ownWords(error)); }
  render();
}

/* Electron puts "Error invoking remote method '…': Error: " before what the desktop threw. */
const ownWords = (error) => String(error?.message ?? error ?? "").replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "").trim();

/* Update now: the ready update, installed the way update by itself installs it (the updater's own checks, the copy of
   the data folder, the safety copy); the update screen follows it. A wait or a failure is said in the updater's words. */
async function updateNow() {
  try { desktop = await bridge().installUpdate(false); } catch (error) { toast(ownWords(error)); }
  render();
}

/* The owner's yes to a change that does not contain this copy's, in a dialog naming it and what the updater said. */
function askOther(commit) {
  const body = `<p>${esc(desktop?.message ?? "")}</p><p>${esc(t("window.settings.updates.move-to-line-note", { commit: short(commit) }))}</p>`;
  openDlg({ title: t("window.settings.updates.move-to-line"), body,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="u-other-yes" data-commit="${esc(commit)}">${t("window.settings.updates.move-to-line")}</button>` });
}

async function moveToOther(commit) {
  closeDlg();
  goingAway(); // the engine restarts into that version: the swap screen covers it
  try { desktop = await bridge().installUpdate(false, commit); if (desktop.waitingForTasks || desktop.phase === "available") goingAway(false); }
  catch (error) { goingAway(false); toast(error.message); }
  render();
}

async function askRestore(name) {
  try {
    copies = await api("updates/data-copies", { name });
    if (copies.message) toast(copies.message);
  } catch (error) { toast(error.message); }
  render();
}

export function initChannel() {
  on("u-channel", (el) => saveNotify({ releaseChannel: el.dataset.v }));
  on("u-restore", (el) => askRestore(el.dataset.name));
  on("u-keep", () => askRestore(null));
  markLive(["u-channel", "u-restore", "u-keep"]);
  on("u-check", () => check());
  on("u-now", () => updateNow());
  on("u-other", (el) => askOther(el.dataset.commit));
  on("u-other-yes", (el) => moveToOther(el.dataset.commit));
  if (bridge()) markLive(["u-check", "u-now", "u-other", "u-other-yes"]);
}
