/* Settings › Updates, the channel section: which channel Branch updates from and, on Dev, which of Branch's own lines
   of work it follows (the comfort card "notify": releaseChannel and devLine, POST /api/comfort merges the one value).
   The engine checks the line against its own list and only the owner may change it. What the updater says, the change
   this copy was built from and the newest change on that line come from the desktop app's updater (IPC), so "Check
   now" and moving to another line of work are live only in the desktop app. Moving to another line of work, when its
   newest change does not contain this copy's, needs the owner's yes in a dialog naming that exact change.
   The copies of the data folder taken before each update (GET /api/updates/data-copies) are offered here too:
   putting one back is asked of the engine (POST, { name }) and happens at the next start. */
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { esc, render } from "../core/dom.js";
import { markLive } from "../core/features.js";
import { closeDlg, openDlg, toast } from "../core/ui.js";
import { t, language } from "../../i18n.js";

let notify = null, desktop = null, copies = null;
const bridge = () => window.branchDesktop ?? null;
const lines = () => [["mac/cross-platform", t("window.settings.updates.line-main")], ["redesign/window", t("window.settings.updates.line-redesign")]];
const short = (commit) => (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : "");

export async function loadChannel() {
  if (E.profiles?.isOwner === false) return;
  try {
    const [comfort, kept] = await Promise.all([api("comfort"), api("updates/data-copies")]);
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

const seg = (title, act, opts, cur) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="${act}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</span></span><small></small></div>`;

/* What the updater says about the line followed, with both changes, once it has looked (desktop app only). */
function devStatus() {
  const release = desktop?.release?.channel === "dev" && desktop.release.line === notify?.devLine ? desktop.release : null;
  const mine = short(desktop?.installed?.commit), newest = short(release?.commit);
  const other = release?.otherLine === true && newest;
  return `<div class="ctl"><b>${esc(desktop?.message ?? "")}</b><span class="right"><button class="btn sm" type="button" data-act="u-check">${t("window.settings.updates.check-now")}</button>${other ? `<button class="btn sm" type="button" data-act="u-other" data-commit="${esc(release.commit)}">${t("window.settings.updates.move-to-line")}</button>` : ""}</span><small>${mine ? esc(t("window.settings.updates.this-copy", { commit: mine })) : ""}${mine && newest ? " · " : ""}${newest ? esc(t("window.settings.updates.newest-on-line", { commit: newest })) : ""}</small></div>`;
}

/* The newest copy of the data folder, and whether it is to be put back at the next start. */
function copyRow() {
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
  const dev = notify.releaseChannel === "dev";
  return `<div class="sec"><h2>${t("updates.channel.label")}</h2>${seg(t("window.settings.notifications.release-channel"), "u-channel", [["stable", t("updates.channel.stable")], ["beta", t("updates.channel.beta")], ["dev", t("updates.channel.dev")]], notify.releaseChannel)}${dev ? seg(t("window.settings.updates.follows"), "u-line", lines(), notify.devLine) : ""}${dev && bridge() ? devStatus() : ""}${copyRow()}</div>`;
}

async function check() {
  try { desktop = await bridge().checkForUpdates(); } catch (error) { toast(error.message); }
  render();
}

/* The owner's yes to another line of work, in a dialog naming the exact change and what the updater said about it. */
function askOther(commit) {
  const body = `<p>${esc(desktop?.message ?? "")}</p><p>${esc(t("window.settings.updates.move-to-line-note", { commit: short(commit) }))}</p>`;
  openDlg({ title: t("window.settings.updates.move-to-line"), body,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="u-other-yes" data-commit="${esc(commit)}">${t("window.settings.updates.move-to-line")}</button>` });
}

async function moveToOther(commit) {
  closeDlg();
  try { desktop = await bridge().installUpdate(false, commit); } catch (error) { toast(error.message); }
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
  on("u-line", (el) => saveNotify({ devLine: el.dataset.v }));
  on("u-restore", (el) => askRestore(el.dataset.name));
  on("u-keep", () => askRestore(null));
  markLive(["u-channel", "u-line", "u-restore", "u-keep"]);
  on("u-check", () => check());
  on("u-other", (el) => askOther(el.dataset.commit));
  on("u-other-yes", (el) => moveToOther(el.dataset.commit));
  if (bridge()) markLive(["u-check", "u-other", "u-other-yes"]);
}
