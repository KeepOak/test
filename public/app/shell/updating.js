/* The update screen, in the desktop app: what an install is doing, from the updater itself (src/desktop/updater.ts
   stages, pushed by updater-ipc.ts as they change). It names the version being installed and the one it replaces, lists
   the real steps with the time each took (the one running counts up), and never draws a progress bar it cannot back:
   only a Stable download has a fraction, its bytes. A failure says where it stopped, in plain words with the line of the
   build's output that says why, and that the version running now was kept.
   "Keep working" folds it into the strip the prototype draws for an install (.upd-walk), whose track fills by the steps
   done; the strip opens it again. Branch's static logo sits above the measured steps.
   An install update by itself starts stays in the background while it fetches, installs and builds: a small live item
   in the status bar says so and opens Settings › Updates, and the screen comes up only for the swap and the restart
   (seconds). One the owner pressed (Update now, a confirmed move) shows the screen from the start. A background install
   that fails is said by update by itself (a toast) and in Settings › Updates, not over the owner's work. */

import { applyCss, esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { S } from "../core/state.js";
import { t } from "../../i18n.js";

let status = null, folded = false, closedAt = null, layer = null, ticker = null, lastKey = "", pulledUp = false;
const bridge = () => window.branchDesktop ?? null;

/* The latest status the updater sent, for Settings › Updates' status card. */
export const updateNow = () => status;
/* An install is under way: a step is running (the Settings card and the screen both show it). */
export const installing = (s = status) => s?.phase !== "error" && Boolean(s?.stages?.some((stage) => stage.state === "running"));
/* A failed install that still has its steps (the updater clears them at the next look). */
const failedInstall = (s = status) => s?.phase === "error" && Boolean(s?.stages) && Boolean(s?.outcome);
/* The swap and the restart: the only part of an automatic install the screen comes up for. */
const swapping = (s) => Boolean(s?.stages?.some((stage) => ["swapping", "restarting"].includes(stage.id) && stage.state === "running"));
/* An install update by itself started, still fetching, installing, building, checking or copying, that the owner has not
   asked to see: it stays in the status bar. */
export const inBackground = (s = status) => installing(s) && s.automatic === true && !swapping(s) && !pulledUp;

/* The status bar's item while an update works in the background: the step and its time; it opens Settings › Updates. */
export function statusItem() {
  if (!inBackground()) return "";
  const running = status.stages.find((stage) => stage.state === "running");
  const paused = status.paused ? ` · ${esc(t(`window.updates.paused.${status.paused}`))}` : "";
  return `<button class="sb upd18-sb" type="button" data-act="upd18-bg" data-tip="${esc(targetWords())}"><i class="lit10"></i>${esc(t("window.updates.bar", { step: stageWords(running) }))} ${stageTime(running)}${paused}</button>`;
}
/* Why an install under way is slower than it could be, in plain words: it holds back for the owner (typing, a task at
   work), or, for a Beta build (the only install that builds), it builds at low priority so the computer stays quick
   (src/desktop/quiet-build.ts). Nothing once it swaps. */
export function gentleWords(s = status) {
  if (!installing(s)) return "";
  if (s.paused === "typing" || s.paused === "task") return t(`window.updates.card.paused-${s.paused}`);
  const running = s.stages.find((stage) => stage.state === "running");
  const builds = s.stages.some((stage) => stage.id === "building");
  return builds && !["swapping", "restarting"].includes(running?.id) ? t("window.updates.card.gentle") : "";
}

/* m:ss, or h:mm:ss past an hour. */
export function clock(ms) {
  const all = Math.max(0, Math.round(ms / 1000)), h = Math.floor(all / 3600), m = Math.floor((all % 3600) / 60), s = all % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
const since = (iso) => Date.now() - Date.parse(iso);
export const stageWords = (stage) => t(stage.id === "installing" && stage.state === "skipped" ? "window.updates.stage.installing-skipped" : `window.updates.stage.${stage.id}`);
/* A step's time: its own length once it ended; the running one is filled in by the ticker. */
export function stageTime(stage) {
  if (stage.state === "running") return `<time data-upd-since="${esc(stage.startedAt)}">${clock(since(stage.startedAt))}</time>`;
  if ((stage.state === "done" || stage.state === "failed") && stage.startedAt && stage.endedAt)
    return `<time>${clock(Date.parse(stage.endedAt) - Date.parse(stage.startedAt))}</time>`;
  return "";
}
/* A Beta build's version is long (0.19.4-dev.<time>-g<change>), so it is named by its change; the whole string is in
   the tooltip. A release's version reads as it is. */
const devChange = (version) => /-dev\.\d+-g([0-9a-f]{7,40})$/.exec(String(version ?? ""))?.[1]?.slice(0, 7) ?? null;
export const versionWords = (version) => {
  const change = devChange(version);
  return change ? t("window.updates.screen.beta", { commit: change }) : String(version ?? "");
};
const tip = (version) => (devChange(version) ? ` data-tip="${esc(version)}"` : "");
/* What is being installed: the version once known, else the Beta change (its version is known once its source is here). */
export function targetWords(s = status) {
  const version = s?.target?.version, commit = s?.target?.commit;
  const change = devChange(version) ?? (version ? null : commit?.slice(0, 7));
  if (change) return t("window.updates.screen.to-change", { commit: change });
  return version ? t("window.updates.screen.to", { version }) : t("window.settings.updates.updating");
}
/* A failed install's first line, in plain words by the step it stopped at; the updater's own words go under Details. */
const why = { fetching: "fetch", downloading: "download", installing: "build", building: "build", checking: "check", copying: "copy" };
export const failedWords = (s) => t(why[s?.failure?.stage] ? `window.updates.why.${why[s.failure.stage]}` : "window.updates.failed");
export const keptWords = (s) => t("window.updates.screen.kept", { version: versionWords(s.outcome.kept) });
/* The updater's message and the line of the build's output that says why (once, when the message does not hold it). */
export function failDetail(s) {
  const said = String(s?.message ?? ""), line = s?.failure?.line;
  const body = `${said ? `<p>${esc(said)}</p>` : ""}${line && !said.includes(line) ? `<code>${esc(line)}</code>` : ""}`;
  return body ? `<details class="upd18-why"><summary>${esc(t("window.updates.screen.details"))}</summary>${body}</details>` : "";
}
const firstStart = (s) => s?.stages?.find((stage) => stage.startedAt)?.startedAt ?? null;

const icon = { done: "✓", skipped: "–", failed: "✕", running: "", waiting: "" };
function steps(s) {
  return `<ol class="upd18-steps">${s.stages.map((stage) => `<li class="st-${esc(stage.state)}"><i aria-hidden="true">${icon[stage.state] ?? ""}</i><span>${esc(stageWords(stage))}</span>${stageTime(stage)}</li>`).join("")}</ol>`;
}
/* A Stable download is the one step with a real fraction: its bytes. */
function bytes(s) {
  const b = s.bytes;
  if (!b?.total) return "";
  const mb = (n) => Math.round(n / 1048576);
  return `<p class="upd18-bytes">${esc(t("window.updates.screen.bytes", { received: mb(b.received), total: mb(b.total) }))}</p>`;
}
const logo = () => `<img src="/assets/icon-192.png" alt="" width="72" height="72">`;
function failure(s) {
  return `<div class="upd18-err" role="alert"><p>${esc(keptWords(s))}</p>${failDetail(s)}</div>`;
}

function screenCard(s) {
  const failed = failedInstall(s), start = firstStart(s);
  const head = `<div class="upd18-head"><h2 id="upd18-title"${failed ? "" : tip(s.target?.version)}>${esc(failed ? failedWords(s) : targetWords(s))}</h2><p${tip(s.installed?.version)}>${esc(t("window.updates.screen.from", { version: versionWords(s.installed?.version) }))}${!failed && start ? ` · <time data-upd-since="${esc(start)}">${clock(since(start))}</time>` : ""}</p></div>`;
  const restarting = s.stages.find((stage) => stage.id === "restarting")?.state === "running";
  const note = restarting ? `<p class="upd18-note">${esc(t("window.updates.screen.restarting"))}</p>` : "";
  const acts = failed
    ? `<button class="btn pri sm" type="button" data-act="upd18-close">${esc(t("delight.ach.close"))}</button>`
    : restarting ? "" : `<button class="btn ghost sm" type="button" data-act="upd18-fold">${esc(t("window.updates.screen.keep-working"))}</button>`;
  return `${head}${failed ? failure(s) : ""}${steps(s)}${bytes(s)}${note}${acts ? `<div class="acts">${acts}</div>` : ""}`;
}
/* The prototype's install strip: the step running, its time, and a track filled by the steps done (never by time). */
function strip(s) {
  const running = s.stages.find((stage) => stage.state === "running");
  const done = s.stages.filter((stage) => ["done", "skipped"].includes(stage.state)).length, share = Math.round((done / s.stages.length) * 100);
  return `<button class="upd-walk upd18-strip" type="button" data-act="upd18-open" aria-label="${esc(targetWords(s))}"><span>${esc(running ? stageWords(running) : targetWords(s))} ${running ? stageTime(running) : ""}</span><span class="track"><u data-css="width:${share}%"></u><span class="mark mark-full walker" data-css="left:${share}%" aria-hidden="true"></span></span><span>${esc(t("window.updates.screen.steps", { done, total: s.stages.length }))}</span></button>`;
}

function drawScreen() {
  const s = status;
  const shown = (installing(s) && !inBackground(s)) || (failedInstall(s) && s.automatic !== true && closedAt !== s.updatedAt);
  layer.hidden = !shown;
  if (!shown) {
    layer.replaceChildren();
    lastKey = "";
    if (installing(s)) startTicking(); else stopTicking(); // the status bar's time still counts
    return;
  }
  const key = JSON.stringify([folded && !failedInstall(s), s.phase, s.message, s.stages, s.target, s.failure, s.bytes && Math.round((s.bytes.received / (s.bytes.total || 1)) * 100)]);
  if (key !== lastKey) {
    lastKey = key;
    const small = folded && !failedInstall(s);
    layer.className = small ? "upd18 folded" : "upd18";
    layer.setAttribute("role", small ? "status" : "dialog");
    if (small) layer.removeAttribute("aria-modal"); else layer.setAttribute("aria-modal", "true");
    // The static logo stays in place while the measured steps change.
    const body = layer.querySelector(".upd18-body");
    if (small) layer.innerHTML = strip(s);
    else if (body) body.innerHTML = screenCard(s);
    else layer.innerHTML = `<div class="upd18-card"><div class="upd18-art" data-css="display:grid;place-items:center" aria-hidden="true">${logo()}</div><div class="upd18-body">${screenCard(s)}</div></div>`;
    applyCss(layer); // the strip's track and walker, placed by the steps done
  }
  startTicking();
}

/* Only the running times move, once a second; nothing else is redrawn for them. */
function tick() {
  const times = document.querySelectorAll("[data-upd-since]");
  // Nothing left counting (the install ended and the page redrew after it): the ticker sleeps until the next one.
  if (!times.length && !installing()) { clearInterval(ticker); ticker = null; return; }
  for (const el of times) el.textContent = clock(since(el.dataset.updSince));
}
function startTicking() { if (!ticker) ticker = setInterval(tick, 1000); }
function stopTicking() { if (ticker && !document.querySelector("[data-upd-since]")) { clearInterval(ticker); ticker = null; } }

/* Each status the updater sends: the screen follows it, and the rest of the window redraws only when a step, the phase
   or the version changed (Settings › Updates' card), never for a byte count. */
function heard(next) {
  if (!next || typeof next !== "object") return;
  const was = status;
  status = next;
  if (!installing(was) && installing(next)) folded = pulledUp = false; // a new install starts as its kind does
  drawScreen();
  const changed = (s) => JSON.stringify([s?.phase, s?.stages?.map((stage) => stage.state), s?.target, s?.failure, s?.automatic, s?.paused]);
  if (changed(was) !== changed(next)) render();
}

/* Opened from Settings › Updates ("Show progress"). */
export function openUpdateScreen() {
  folded = false;
  pulledUp = true;
  lastKey = "";
  if (status) drawScreen();
}

export function initUpdating() {
  const desktop = bridge();
  if (!desktop?.onUpdateStatus) return;
  layer = document.createElement("div");
  layer.id = "upd18";
  layer.hidden = true;
  layer.setAttribute("aria-labelledby", "upd18-title");
  document.body.append(layer);
  on("upd18-fold", () => { folded = true; lastKey = ""; drawScreen(); });
  on("upd18-open", () => openUpdateScreen());
  on("upd18-close", () => { closedAt = status?.updatedAt ?? null; drawScreen(); render(); });
  on("upd18-bg", () => { S.view = "settings"; S.setPage = "updates"; render(); });
  markLive(["upd18-fold", "upd18-open", "upd18-close", "upd18-bg"]);
  desktop.onUpdateStatus(heard);
  // A window opened (or reloaded) during an install shows it at once.
  desktop.updateStatus().then(heard, (error) => console.warn(error.message));
}
