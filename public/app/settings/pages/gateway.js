/* Settings › Gateway, 1:1 with the prototype at each level, from GET /api/never-break. "Carry on interrupted work by
   itself" is the gateway's own mode (POST /api/never-break): "on" carries interrupted work on after a restart, "when-needed"
   only offers it (src/never-break/resume.ts), so the switch saves "on" or "when-needed"; turned on while the gateway is off
   it turns the gateway on as well, since only the gateway carries work on. The tray icon (the desktop app's own, always
   shown) and push (no route) stay greyed with their reasons. Pausing a chat app from the chat (POST /api/reach/switch)
   and sending files into chats (POST /api/personal/switch) are live three-way switches: on unless "off", turned on as
   "when-needed". The relay holds the owner's chat-app accounts, so it stays greyed and only shows the engine's mode. */
import { level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render, esc } from "../../core/dom.js";
import { toast, ic } from "../../core/ui.js";
import { id15, sw15, code15, sec15 } from "../rows15.js";
import { gateway17, initMore17 } from "../p17-more.js";
import { t, language } from "../../../i18n.js";
import { noteGateway } from "../../shell/extras.js";

let gwData = null;
const D = { reach: null, personal: null, health: null };
const onMode = (mode) => (mode ? mode !== "off" : false);
/* The gateway is on or off: "when-needed" and "on" both run it (src/never-break/gateway-config.ts), so a file saved as
   "when-needed" reads as on. The Gateway switch saves "when-needed" or "off", so switching it on leaves "Carry on
   interrupted work" as it was (QA retest 2026-09-28, G1: switching the gateway on also ticked that one); only the Carry
   switch saves "on". */
const gwOn = onMode;
const mode = (on) => (on ? "when-needed" : "off");

const WIRES = {
  "f15-pause-a-chat-app-from-the-chat": [() => onMode(D.reach?.modes?.["platform-pause"]), (on) => api("reach/switch", { part: "platform-pause", mode: mode(on) })],
  "f15-send-files-into-chats": [() => onMode(D.personal?.modes?.["chat-files"]), (on) => api("personal/switch", { part: "chat-files", mode: mode(on) })],
};
/* Shown as the engine holds it, never changed from here (security-greyed). */
const SHOWN = {
  "f15-relay-for-chat-app-accounts": () => onMode(D.reach?.modes?.relay),
};
const sw = (title, sub) => sw15(title, sub, (WIRES[id15(title)]?.[0] ?? SHOWN[id15(title)])?.() ?? false);

async function loadGateway() {
  const [gw, reach, personal] = await Promise.all(["never-break", "reach", "personal"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  /* QA retest 2026-09-28 (m14): the gateway's own account of itself (GET /gateway/health on the address the window is
     served from: the gateway answers it without the engine), read only while this engine runs under it. */
  const health = gw?.underGateway ? await fetch("/gateway/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
  gwData = gw; Object.assign(D, { reach, personal, health });
  if (gw) noteGateway(gw); // the status bar says the same as this page
  render();
}

/* A change the assistant suggested (the gateway.propose tool): timings only; the engine keeps the owner's switch and
   the engine's own settings as they are, and refuses a change that did not start cleanly on its throwaway try. */
async function answerProposal(use) {
  try {
    const done = await api(use ? "never-break/proposal/accept" : "never-break/proposal/discard", {});
    toast(use ? done.note : t("window.settings.gateway.discarded-nothing-changed"));
  } catch (e) {
    toast(e.message);
  }
  await loadGateway();
}

export function init() {
  initMore17();
  const reading = loadGateway();
  on("gw-prop", (el) => answerProposal(el.dataset.v === "use"));
  markLive(["sw:gw-mode", "sw:gw-carry", "sw:gw-keep-awake", "gw-prop", "sw:f15-pause-a-chat-app-from-the-chat", "sw:f15-send-files-into-chats"]);
  document.addEventListener("change", async (e) => {
    if (e.target.id === "gw-keep-awake") {
      try { await api("never-break", { keepAwake: e.target.checked }); } catch (error) { toast(error.message); }
      await loadGateway();
      return;
    }
    if (e.target.id === "gw-mode") {
      try { await api("never-break", { mode: e.target.checked ? "when-needed" : "off" }); } catch (error) { toast(error.message); }
      await loadGateway();
      return;
    }
    if (e.target.id === "gw-carry") {
      try { await api("never-break", { mode: e.target.checked ? "on" : "when-needed" }); } catch (error) { toast(error.message); }
      await loadGateway();
      return;
    }
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadGateway();
  });
  return reading;
}

/* The Gateway switch is the saved preference; the status above it comes from the running engine. */
export const waitFirst = true;

export async function load() {
  await loadGateway();
}

const BASE = () => `<h1>${t("window.settings.gateway.gateway")}</h1><p class="lede">${t("window.settings.gateway.a-small-helper-that-keeps-branch")}</p>`;

/* QA retest 2026-09-28 (G1): the switch is what the owner chose; whether the gateway runs is the engine's own word
   (`underGateway`: this engine was started by it). It takes over only at the next start (src/cli.ts,
   runGatewayIfSwitchedOn), so just after the switch goes on the page says so rather than that it is running. */
function statusSection(gw) {
  if (!gw) return "";
  const saved = gwOn(gw.mode), running = gw.underGateway === true;
  // What runs now, not only what is saved: running (or still stopping after OFF), switched on for the next start, or off.
  const [title, desc, dot] = running && saved
    ? [t("window.settings.gateway.the-gateway-is-on"), t("window.settings.gateway.on-telegram-your-phone-and-automations"), "ok"]
    : running
      ? [t("window.settings.gateway.the-gateway-is-on"), t(gw.stopsWhenOff === true ? "gatewayChoice.stopping" : "gatewayChoice.offLater"), "ok"]
      : saved
        ? [t("window.settings.gateway.the-gateway-is-switched-on"), t("window.settings.gateway.switched-on-takes-over-next-start"), "warn"]
        : [t("window.settings.gateway.the-gateway-is-off"), t("window.settings.gateway.off-when-you-close-branch-your"), "bad"];
  return `<div class="status"><span class="sdot ${dot}"></span><div><b>${title}</b><p>${desc}</p></div></div>`;
}

function modeSection(gw) {
  const mode = gw?.mode ?? null;
  return `<div class="sec"><h2>${t("field.never-break-mode")}</h2><div class="ctl"><b>${t("window.settings.gateway.gateway")}</b><input class="sw" type="checkbox" id="gw-mode" data-sw="gw-mode" ${gwOn(mode) ? "checked" : ""} ${gw ? "" : "disabled"} aria-label="${t("window.settings.gateway.gateway")}"><small>${t("window.settings.gateway.recommended-on-telegram-your-phone-and")}</small></div>`
    + `<div class="ctl"><b>${t("window.settings.gateway.carry-on-interrupted-work-by-itself")}</b><input class="sw" type="checkbox" id="gw-carry" data-sw="gw-carry" ${mode === "on" ? "checked" : ""} ${gw ? "" : "disabled"} aria-label="${t("window.settings.gateway.carry-on-interrupted-work-by-itself")}"><small>${t("window.settings.gateway.after-a-restart-safe-steps-carry")}</small></div>`
    + keepAwakeRow(gw)
    + `<div class="ctl"><b>${t("window.settings.gateway.show-the-gateway-in-the-tray")}</b><input class="sw" type="checkbox" id="gw-tray" aria-label="${t("window.settings.gateway.show-the-gateway-in-the-tray")}" data-sw="set"><small>${t("window.settings.gateway.a-small-branch-icon-by-the")}</small></div></div>`;
}

function keepAwakeRow(gw) {
  const runtime = gw?.keepAwakeRuntime;
  const state = runtime?.error ? `${t("gatewayPower.failed")} ${runtime.error}` : runtime?.suspended ? t("gatewayPower.suspended")
    : runtime?.active ? t("gatewayPower.active") : gw?.config?.keepAwake ? t("gatewayPower.waiting") : t("gatewayPower.off");
  return `<div class="ctl"><b>${t("gatewayPower.title")}</b><input class="sw" type="checkbox" id="gw-keep-awake" data-sw="gw-keep-awake" ${gw?.config?.keepAwake ? "checked" : ""} ${gw ? "" : "disabled"} aria-label="${t("gatewayPower.title")}"><small>${t("gatewayPower.description")} ${esc(state)}</small></div>`;
}

/* What it has been doing: while the gateway is off the prototype's one line is simply true. While it runs, its own notes,
   newest first, in its own words: an engine it started again, an update it kept or put back (src/never-break/gateway.ts
   note). QA retest 2026-09-28 (m14): a restarted engine used to leave this empty. */
const at = (iso) => new Date(iso).toLocaleString(language(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function gatewayNotes() {
  const notes = D.health?.notes ?? [];
  if (!D.health) return "";
  if (!notes.length) return `<li class="ok">${ic("check", "s")}<span>${t("window.settings.gateway.nothing-to-report")}</span><time></time></li>`;
  return [...notes].reverse().map((n) => `<li>${ic("info", "s")}<span>${esc(n.text)}</span><time datetime="${esc(n.at)}">${esc(at(n.at))}</time></li>`).join("");
}
function doing(gw) {
  const rows = gw && gw.underGateway !== true ? `<li class="">${ic("info", "s")}<span>${t("window.settings.gateway.nothing-is-watching-branch")}<small>${t("window.settings.gateway.the-gateway-is-off-so-a")}</small></span><time></time></li>` : gatewayNotes();
  return `<div class="sec"><h2>${t("window.settings.gateway.what-it-has-been-doing")}</h2><ol class="tl">${rows}</ol></div>`;
}

/* 1:1 with the prototype's tile, shown while the gateway is not off: the reason is the assistant's own words, and the
   pill only when the engine's throwaway try passed. */
function proposalTile(gw) {
  const p = gw?.proposal;
  if (!p || (gw.mode ?? "off") === "off") return "";
  const passed = p.check?.ok ? `<span class="pill ok ml">${t("window.settings.gateway.tried-on-a-test-gateway-passed")}</span>` : "";
  return `<div class="tile" data-css="margin-top:22px"><div class="th"><b>${t("window.settings.gateway.a-change-branch-suggested")}</b>${passed}</div><p>${esc(p.why)}</p><div class="acts"><button class="btn pri sm" type="button" data-act="gw-prop" data-v="use">${t("lmore.switch.label")}</button><button class="btn ghost sm" type="button" data-act="gw-prop" data-v="no">${t("window.settings.gateway.discard")}</button></div></div>`;
}

const ACTIONS = () => `<div class="acts" data-css="margin-top:16px"><button class="btn" type="button" data-act="gw-restart">${ic("retry", "s")}${t("window.settings.gateway.restart-the-engine")}</button></div>`;

/* The gateway's own settings, as the engine holds them. */
function technical(gw) {
  const c = gw?.config ?? {};
  const rows = [["mode", gw?.mode], ["startSeconds", c.startSeconds], ["holdSeconds", c.holdSeconds], ["maxQuickCrashes", c.maxQuickCrashes], ["gapSeconds", c.gapSeconds]]
    .filter(([, v]) => v != null).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  return `<div class="sec"><h2>${t("settingsGrown.level.technical")}</h2><dl class="kv">${rows}</dl></div>`;
}

const chatMore = () => sec15(t("window.settings.gateway.chat-apps-more"), sw("Pause a chat app from the chat", "/pause and /resume in that app."));
const fromScripts = () => sec15(t("window.settings.gateway.from-scripts"),
  code15(t("window.settings.gateway.send-a-message"), t("window.settings.gateway.from-any-script-or-scheduled-job"), "branch send --to telegram \"Backup done\"")
  + code15(t("window.settings.gateway.connect-a-chat-app"), t("window.settings.gateway.in-one-command"), "branch connect telegram"));
const chatEvenMore = () => sec15(t("window.settings.gateway.chat-apps-even-more"),
  sw("Send files into chats", "A Trunk can reply with the file itself, not a link.")
  + sw("Relay for chat-app accounts", "Your phone number stays with Branch, not the bot service.")
  + sw("Push to your phone and browser", "When a Trunk needs you and no chat app is set up."));

export function draw() {
  const gw = gwData;
  const lev = level();
  let html = BASE() + statusSection(gw) + modeSection(gw) + doing(gw) + proposalTile(gw) + ACTIONS();
  if (lev < 2) html += `<p class="hint">${t("window.settings.computer.switch-to-technical-bottom-left-to")}</p>`;
  else html += technical(gw);
  if (lev >= 1) html += chatMore();
  if (lev >= 2) html += fromScripts();
  if (lev >= 1) html += chatEvenMore();
  return html + gateway17(lev);
}
