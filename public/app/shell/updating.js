/* The update screen, in the desktop app: what an install is doing, from the updater itself (src/desktop/updater.ts
   stages, pushed by updater-ipc.ts as they change). It names the version being installed and the one it replaces, lists
   the real steps with the time each took (the one running counts up), and never draws a progress bar it cannot back:
   only a Stable download has a fraction, its bytes. A failure says where it stopped, in plain words with the line of the
   build's output that says why, and that the version running now was kept.
   "Keep working" folds it into the strip the prototype draws for an install (.upd-walk), whose track fills by the steps
   done; the strip opens it again. The art is Branch building with pebbles (public/art/update, made for this screen):
   a loop, or its still when motion is reduced (core/art17.js media17). */

import { applyCss, esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { media17 } from "../core/art17.js";
import { t } from "../../i18n.js";

let status = null, folded = false, closedAt = null, layer = null, ticker = null, lastKey = "";
const bridge = () => window.branchDesktop ?? null;

/* The latest status the updater sent, for Settings › Updates' status card. */
export const updateNow = () => status;
/* An install is under way: a step is running (the Settings card and the screen both show it). */
export const installing = (s = status) => s?.phase !== "error" && Boolean(s?.stages?.some((stage) => stage.state === "running"));
/* A failed install that still has its steps (the updater clears them at the next look). */
const failedInstall = (s = status) => s?.phase === "error" && Boolean(s?.stages) && Boolean(s?.outcome);

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
/* What is being installed: the version once known, else the Beta change (its version is known once its source is here). */
export function targetWords(s = status) {
  const version = s?.target?.version, commit = s?.target?.commit;
  if (version) return t("window.updates.screen.to", { version });
  return commit ? t("window.updates.screen.to-change", { commit: commit.slice(0, 7) }) : t("window.settings.updates.updating");
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
/* The look's own art: the night scene in the dark look, the morning one in the light look. */
function artName() {
  const dark = document.documentElement.dataset.theme === "dark"
    || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  return dark ? "building-dark" : "building-light";
}
const art = (name) => media17(`/art/update/${name}.webp`, `/art/update/${name}.webm`, "upd18-pic");
function failure(s) {
  const line = s.failure?.line;
  return `<div class="upd18-err" role="alert"><b>${esc(s.message)}</b>${line ? `<code>${esc(line)}</code>` : ""}<p>${esc(t("window.updates.screen.kept", { version: s.outcome.kept }))}</p></div>`;
}

function screenCard(s) {
  const failed = failedInstall(s), start = firstStart(s);
  const head = `<div class="upd18-head"><h2 id="upd18-title">${esc(failed ? t("window.updates.failed") : targetWords(s))}</h2><p>${esc(t("window.updates.screen.from", { version: s.installed?.version ?? "" }))}${!failed && start ? ` · <time data-upd-since="${esc(start)}">${clock(since(start))}</time>` : ""}</p></div>`;
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
  const shown = installing(s) || (failedInstall(s) && closedAt !== s.updatedAt);
  layer.hidden = !shown;
  if (!shown) { layer.replaceChildren(); stopTicking(); return; }
  const key = JSON.stringify([folded && !failedInstall(s), s.phase, s.message, s.stages, s.target, s.failure, s.bytes && Math.round((s.bytes.received / (s.bytes.total || 1)) * 100)]);
  if (key !== lastKey) {
    lastKey = key;
    const small = folded && !failedInstall(s);
    layer.className = small ? "upd18 folded" : "upd18";
    layer.setAttribute("role", small ? "status" : "dialog");
    if (small) layer.removeAttribute("aria-modal"); else layer.setAttribute("aria-modal", "true");
    // The card's art stays as it is while the words under it change, so its loop plays on without starting again.
    const name = artName(), body = layer.querySelector(".upd18-body");
    if (small) layer.innerHTML = strip(s);
    else if (body && layer.querySelector(".upd18-art")?.dataset.art === name) body.innerHTML = screenCard(s);
    else layer.innerHTML = `<div class="upd18-card"><div class="upd18-art" data-art="${name}" aria-hidden="true">${art(name)}</div><div class="upd18-body">${screenCard(s)}</div></div>`;
    applyCss(layer); // the strip's track and walker, placed by the steps done
  }
  startTicking();
}

/* Only the running times move, once a second; nothing else is redrawn for them. */
function tick() {
  for (const el of document.querySelectorAll("[data-upd-since]")) el.textContent = clock(since(el.dataset.updSince));
}
function startTicking() { if (!ticker) ticker = setInterval(tick, 1000); }
function stopTicking() { if (ticker && !document.querySelector("[data-upd-since]")) { clearInterval(ticker); ticker = null; } }

/* Each status the updater sends: the screen follows it, and the rest of the window redraws only when a step, the phase
   or the version changed (Settings › Updates' card), never for a byte count. */
function heard(next) {
  if (!next || typeof next !== "object") return;
  const was = status;
  status = next;
  if (!installing(was) && installing(next)) folded = false; // a new install opens the screen
  drawScreen();
  const changed = (s) => JSON.stringify([s?.phase, s?.stages?.map((stage) => stage.state), s?.target, s?.failure]);
  if (changed(was) !== changed(next)) render();
}

/* Opened from Settings › Updates ("Show progress"). */
export function openUpdateScreen() {
  folded = false;
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
  markLive(["upd18-fold", "upd18-open", "upd18-close"]);
  desktop.onUpdateStatus(heard);
  // A window opened (or reloaded) during an install shows it at once.
  desktop.updateStatus().then(heard, (error) => console.warn(error.message));
}
