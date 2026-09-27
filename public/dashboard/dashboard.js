/* The owner's dashboard (wave mac3): one page, served by Branch itself, that shows at a glance what
   Branch is doing, whether its parts are healthy, what it has cost and what is happening now, with the
   few controls worth reaching from a phone or a screen on the wall. It reads one summary
   (/api/dashboard) and acts only through routes the window already uses — Stop, Lockdown — plus the
   two the dashboard adds (pause every automation, restart). The key is the one this browser tab
   already holds, exactly as in the window; a key that may only look gets a page that only looks. */
import { initLanguage, applyLanguage, formatDate } from "/dashboard/i18n.js";
import { wearLook } from "/dashboard/look.js";
import { controlsCards, healthCards, nowCards, restartWords, say, spendCards } from "/dashboard/sections.js";
import { activityCard, startLive, stopLive } from "/dashboard/feed.js";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 10000;
let key = "";
try { key = sessionStorage.getItem("branch-token") || ""; } catch { /* a locked-down browser keeps nothing */ }
let mode = "on";
let timer = null;
let busy = false;

class Refused extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Refused(response.status, data.error || say("dashboard.failed", "That did not work."));
  return data;
}

function say2(message) {
  const line = $("db-message");
  line.textContent = message;
  line.hidden = !message;
}

/** Shows exactly one of: the sign-in card, the "switched off" card, or the dashboard itself. */
function show(which) {
  $("db-signin").hidden = which !== "signin";
  $("db-off").hidden = which !== "off";
  $("db-grid").hidden = which !== "grid";
  $("db-refresh").hidden = which !== "grid";
}

function draw(summary) {
  const actions = { stop, pause, lockdown, restart };
  const live = summary.mode === "on";
  $("db-area-now").replaceChildren(...nowCards(summary, actions));
  $("db-area-health").replaceChildren(...healthCards(summary));
  $("db-area-spend").replaceChildren(...spendCards(summary));
  $("db-area-activity").replaceChildren(activityCard(summary, live));
  $("db-area-controls").replaceChildren(...controlsCards(summary, actions));
  if (summary.assistant) $("db-name").textContent = summary.assistant;
  $("db-mode").textContent = live ? say("dashboard.live", "Live") : say("dashboard.readOnce", "Read when opened");
  $("db-mode").dataset.t = live ? "dashboard.live" : "dashboard.readOnce";
  $("db-updated").textContent = say("dashboard.updated", "Updated {time}", { time: formatDate(new Date(), { timeStyle: "short" }) });
  $("db-status").className = `lx-chip lx-chip-${summary.now.needsYou.total ? "warn" : "ok"}`;
  $("db-status").textContent = summary.now.needsYou.total
    ? say("dashboard.status.waiting", "Waiting for you: {count}", { count: summary.now.needsYou.total })
    : say("dashboard.running", "Running");
  document.body.classList.toggle("db-locked", Boolean(summary.now.lockdown));
  $("db-lockbanner").hidden = !summary.now.lockdown;
  $("db-lock-off").hidden = summary.access !== "full";
}

/** Reads the summary and draws it; says plainly when Branch does not answer. */
async function load() {
  if (busy) return;
  busy = true;
  try {
    const summary = await api("dashboard");
    mode = summary.mode;
    wearLook(summary.appearance);
    draw(summary);
    show("grid");
    say2("");
    if (mode === "on") void startLive(key); else stopLive();
    schedule();
  } catch (error) {
    handleFailure(error);
  } finally {
    busy = false;
  }
}

function handleFailure(error) {
  if (error instanceof Refused && (error.status === 401 || error.status === 403)) {
    stopLive(); clearTimeout(timer);
    try { sessionStorage.removeItem("branch-token"); } catch { /* nothing kept */ }
    key = "";
    show("signin");
    say2(error.message);
    return;
  }
  if (error instanceof Refused && error.status === 404) {
    stopLive(); clearTimeout(timer);
    show("off");
    return;
  }
  say2(say("dashboard.offline", "Branch did not answer. Trying again…"));
  schedule();
}

/** On: every few seconds while the page is in view. When needed: only when Refresh is pressed. */
function schedule() {
  clearTimeout(timer);
  if (mode !== "on") return;
  timer = setTimeout(() => { if (document.hidden) schedule(); else void load(); }, REFRESH_MS);
}

/* ---------- controls ---------- */
async function acting(button, work) {
  button.disabled = true;
  try { await work(); await load(); }
  catch (error) { say2(error.message); button.disabled = false; }
}
function stop(runId, button) {
  return acting(button, () => api(`runs/${encodeURIComponent(runId)}/cancel`, {}));
}
function pause(paused, button) {
  return acting(button, () => api("dashboard/automations", { paused }));
}
function lockdown(on, button) {
  return acting(button, () => api("lockdown", { on }));
}
/** Asks once more before restarting, on the same button, so a stray tap does nothing. */
function restart(button) {
  if (button.dataset.armed !== "yes") {
    button.dataset.armed = "yes";
    button.textContent = say("dashboard.controls.restartConfirm", "Press again to restart");
    setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.armed;
      button.textContent = say("dashboard.controls.restart", "Restart Branch");
    }, 5000);
    return Promise.resolve();
  }
  button.disabled = true;
  return api("dashboard/restart", {}).then(() => {
    say2(say("dashboard.controls.restarting", "Restarting… this page reconnects by itself."));
    stopLive();
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 6000);
  }, (error) => { say2(error.message || restartWords("restart.window")); button.disabled = false; });
}

/* ---------- signing in ---------- */
function wireSignIn() {
  $("db-signin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    key = $("db-key").value.trim();
    $("db-key").value = "";
    try { sessionStorage.setItem("branch-token", key); } catch { /* this tab only, then */ }
    void load();
  });
  $("db-refresh").addEventListener("click", () => void load());
  $("db-lock-off").addEventListener("click", (event) => void lockdown(false, event.currentTarget));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && mode === "on" && key) void load(); });
}

async function start() {
  await initLanguage().catch(() => undefined);
  applyLanguage();
  wireSignIn();
  if (key) await load();
  else show("signin");
}
/* Tests and screenshots wait for this: the first answer has been drawn, whatever it was. */
void start().finally(() => document.body.classList.add("db-ready"));
