/* Pairing a phone or another computer with this one, through the engine's Devices (src/devices/), 1:1 with the
   prototype's "Pair a phone" and "Pair another computer" dialogs and the "With a code" tab of "Add a computer or phone".
   POST /api/devices/invite makes the invitation: a six-digit number and a link, shown on this computer only, good once
   and for five minutes (the countdown is the engine's expiresAt). A device that answers it with the right number is
   not let in: it waits in GET /api/devices, and this dialog shows the request with the check code the device shows
   while it waits. "Let it in" stays disabled until the owner ticks that the codes match, and sends that tick as the
   engine's codeMatches, which refuses a yes without it; "Refuse" sends no. Only requests that arrive after this
   invitation are offered. Closing the dialog cancels the invitation (POST /api/devices/invite/cancel) while it is
   still the one on offer. Devices ships off: the engine's refusal is shown, with "Switch it on" (POST
   /api/devices/mode when-needed) unless Lockdown is on. The engine keeps the guards: the owner alone (a household
   person and a short-lived key are refused), five tries per invitation, the check-code confirmation.
   While the invitation's link only answers on this computer, the dialog says so and, unless Lockdown is on, offers to
   open Branch to Tailscale (POST /api/deployment/remote { enabled: true }): the engine's own words say what is missing
   when it cannot (Tailscale not installed, not signed in), and once it opens a new invitation carries the Tailscale
   address. "Open it to Tailscale" is the door's switch: on while the door is open (GET /api/deployment remote.enabled),
   and turning it off closes the door ({ enabled: false }), which always works, Lockdown or not. One change at a time:
   the switch is drawn busy until the engine answers. Listeners of onPaired hear { approve, kind, request }: the dialog
   that asked ("phone", "computer" or "code") and the engine's answer (its deviceId once let in).
   Words the prototype lacks (the request, the check code, Let it in, Refuse) are the product's own locale words.
   B6: "Pair a phone" asks for a phone invitation ({phone: true}). A phone that answers it, once let in, collects its
   session over the open door (POST /api/devices/pair/session, signed with its pairing key, once): the same session the
   Tailscale invitation hands over. The engine marks such a request `phone`; it shows no "can do nothing" note. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { qr } from "../core/qr.js";
import { nameNewComputer } from "./name-device.js";
import { t } from "../../i18n.js";
import { initChatPairing } from "./chat-pairing.js";

const P = { kind: null, frame: null, dlg: null, invite: null, request: null, seen: new Set(), error: null, canSwitch: false, triedOn: false, timer: null, stopping: null, canOpen: false, doorError: null, doorOn: false, opening: false };
/* Told after a device is let in or refused ({ approve, kind, request }), so a page listing devices reads them again. */
export const onPaired = new Set();

const PHONES = ["ios", "android"];
const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
const loopback = (link) => /^(localhost|127\.|\[::1\])/.test(new URL(link).hostname);
function left() {
  const s = Math.max(0, Math.round((Date.parse(P.invite?.expiresAt ?? "") - Date.now()) / 1000));
  return s ? t("window.flows.pair.left", { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` }) : t("window.flows.pair.expired");
}
const clock = () => `<p class="hint" data-css="margin:0">${t("window.flows.pair.works-once")} <span class="count12">${left()}</span></p>`;
function doorSwitch() {
  const label = esc(t("pair.onlyHere.tailscale"));
  const busy = P.opening ? ' disabled aria-busy="true"' : "";
  return `<div class="ctl"><b>${label}</b><input class="sw" type="checkbox" id="pair-door" aria-label="${label}"${P.doorOn ? " checked" : ""}${busy}></div>`;
}
function here() {
  const refused = P.doorError ? `<p class="hint" role="alert" data-css="margin:0">${esc(P.doorError)}</p>` : "";
  if (P.doorOn) return `${refused}${doorSwitch()}`;
  if (!loopback(P.invite.link)) return "";
  return `<p class="hint" data-css="margin:0">${esc(t("pair.onlyHere"))}</p>${refused}${P.canOpen ? doorSwitch() : ""}`;
}

/* No camera: the link and the code each on their own labelled row with one Copy, never run together in a sentence. The
   link sits in a read-only field on one line (it scrolls, it never breaks mid-word); the code is large and spaced. */
const copyBtn = (which) => `<button class="btn sm pair-copy15" type="button" data-act="pair-copy" data-v="${which}">${ic("copy", "s")}<span>${t("pair.copy")}</span></button>`;
function phoneBody() {
  const link = t("window.flows.pair.link"), code = t("window.settings.computer.code");
  return `<div class="qr-wrap pair-qr15">${qr(P.invite.qr, 176)}<ol class="steps-list"><li>${t("window.flows.pair.open-app")}</li><li>${t("window.flows.pair.tap", { what: `<b>${t("window.flows.pair.with-computer")}</b>` })}</li><li>${t("window.flows.pair.point")}</li></ol></div>
    <div class="alt12 pair-alt15"><b>${t("window.flows.pair.no-camera")}</b>
      <div class="pair-row15"><label class="pair-lab15" for="pair-link">${link}</label><input class="inp pair-link15" id="pair-link" type="text" readonly spellcheck="false" value="${esc(P.invite.link)}">${copyBtn("link")}</div>
      <div class="pair-row15"><span class="pair-lab15" id="pair-code-lab">${code}</span><output class="pair-code15" id="pair-code" aria-labelledby="pair-code-lab">${esc(spaced(P.invite.code))}</output>${copyBtn("code")}</div></div>${clock()}${here()}<p class="hint pair-wait" role="status" data-css="margin:0"></p>`;
}

/* Copies the link, or the code's six digits without the space, with the clipboard; where the browser refuses, the text is
   selected for copying by hand and the product's words say so. The button says Copied for a moment. */
async function copy(which) {
  const text = which === "code" ? P.invite?.code : P.invite?.link;
  const button = P.dlg?.querySelector(`[data-act="pair-copy"][data-v="${which}"]`);
  if (!text || !button) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    selectText(which);
    toast(t("pair.copyFailed"));
    return;
  }
  button.classList.add("done15");
  button.querySelector("span").textContent = t("pair.copied");
  setTimeout(() => { button.classList.remove("done15"); button.querySelector("span").textContent = t("pair.copy"); }, 1600);
}
function selectText(which) {
  if (which === "link") { const field = $("#pair-link"); field?.focus(); field?.select(); return; }
  const out = $("#pair-code");
  if (!out) return;
  const range = document.createRange();
  range.selectNodeContents(out);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}
function computerBody(waiting) {
  const command = `branch node pair "${P.invite.link}" ${P.invite.code}`;
  return `<p data-css="margin:0">${esc(t("devices.invite.computer"))}</p><code class="ko-code">${esc(spaced(P.invite.code))}</code><code class="pair-cmd15">${esc(command)}</code>${clock()}${here()}
    ${waiting ? `<p class="hint">${ic("spin", "s spin")} ${t("window.flows.pair.waiting")}</p>` : ""}`;
}
function askBody() {
  const r = P.request;
  const kind = t(`devices.platform.${r.platform}`);
  // B6: the engine marks a phone that will collect a session. The prototype's Pair a phone has no note here, and the
  // device note ("can do nothing until you switch something on") is not true of a phone that gets this window's key,
  // so a phone's request shows none.
  const note = r.phone === true ? "" : `<p class="hint" data-css="margin:0">${esc(t("pair.asks.note"))}</p>`;
  return `<p data-css="margin:0"><b>${esc(t("pair.asks", { name: r.name, kind }))}</b></p>${note}
    <p data-css="margin:0">${esc(t("pair.check", { check: r.check }))}</p><label class="pair-match15"><input type="checkbox" id="pair-match"><span>${esc(t("pair.check.matches"))}</span></label>`;
}
function errorBody() {
  const turnOn = P.canSwitch ? `<p class="hint" data-css="margin:0">${esc(t("pair.off.note"))}</p><div class="acts"><button class="btn pri sm" type="button" data-act="pair-on">${esc(t("pair.off.on"))}</button></div>` : "";
  return `<p data-css="margin:0" role="alert">${esc(P.error)}</p>${turnOn}`;
}

const CANCEL = () => `<button class="btn ghost" type="button" data-act="pair-cancel">${t("first-run-steps.restore-no")}</button>`;
function foot() {
  if (P.request) return `<button class="btn ghost" type="button" data-act="pair-refuse">${esc(t("devices.request.refuse"))}</button><button class="btn pri" type="button" data-act="pair-letin" disabled>${esc(t("devices.request.allow"))}</button>`;
  if (P.kind === "phone" && P.invite) return `${CANCEL()}<button class="btn pri" type="button" data-act="ph-paired-dlg">${t("window.flows.pair.phone-says")}</button>`;
  return CANCEL();
}
function body() {
  if (P.request) return askBody();
  if (!P.invite) return P.error ? errorBody() : "";
  return P.kind === "phone" ? phoneBody() : computerBody(P.kind === "computer");
}
const TITLES = { phone: "window.flows.pair.title", computer: "window.flows.pair.title-computer" };
function draw() {
  /* The phone dialog is wide, so the QR and its steps sit side by side and the whole link fits its one-line field. */
  P.dlg = P.frame ? P.frame({ body: body(), foot: foot() }) : openDlg({ title: t(TITLES[P.kind]), body: body(), foot: foot(), wide: P.kind === "phone" });
}

/* Stops watching. With cancel, the invitation stops working too, but only while it is still the one on offer: the
   engine's cancel takes no id, and a newer invitation must not be cancelled by an older dialog. */
function stop(cancel) {
  clearInterval(P.timer);
  P.timer = null;
  const mine = P.invite?.id;
  P.invite = null;
  P.request = null;
  if (!cancel || !mine) return;
  P.stopping = api("devices").then((view) => (view.invitation?.id === mine ? api("devices/invite/cancel", {}) : null))
    .catch((error) => toast(error.message)).finally(() => { P.stopping = null; });
}

/* A waiting request that arrived after this invitation was made. */
async function look(now = false) {
  if (dialog() !== P.dlg) { stop(true); return; }
  const tick = P.dlg?.querySelector(".count12");
  if (tick) tick.textContent = left();
  P.ticks = (P.ticks ?? 0) + 1;
  if (P.request || !P.invite || (!now && P.ticks % 2)) return;
  let view;
  try { view = await api("devices"); } catch (error) { toast(error.message); return; }
  const request = (view.requests ?? []).find((r) => r.status === "waiting" && !P.seen.has(r.id));
  if (!request || dialog() !== P.dlg) return;
  P.request = request;
  draw();
}

async function begin() {
  if (P.stopping) await P.stopping;
  P.error = null;
  let view;
  try {
    view = await api("devices");
    P.seen = new Set((view.requests ?? []).map((r) => r.id));
    // B6: "Pair a phone" makes a phone invitation, the only kind whose phone collects its session after the yes.
    const proposalId = P.proposalId;
    P.invite = await api("devices/invite", { ...(P.kind === "phone" ? { phone: true } : {}), ...(proposalId ? { proposalId } : {}) });
    P.proposalId = null;
  } catch (error) {
    P.error = error.message;
    const lockdown = await api("lockdown").then((l) => l.on === true, (e) => { toast(e.message); return true; });
    P.canSwitch = view?.mode === "off" && !P.triedOn && !lockdown;
  }
  // A link that only answers here: Tailscale is offered unless Lockdown, which shuts every door past this computer, is on.
  if (P.invite && loopback(P.invite.link)) P.canOpen = await api("lockdown").then((l) => l.on !== true, (e) => { toast(e.message); return false; });
  // A link past this computer: whether it is the phone door's, so its switch can close it.
  P.doorOn = Boolean(P.invite) && !loopback(P.invite.link)
    && await api("deployment").then((d) => d.remote?.enabled === true, (e) => { toast(e.message); return false; });
  draw();
  if (P.invite) P.timer = setInterval(look, 1000);
}

/* Starts pairing: kind is "phone", "computer" or "code" (the tab); frame draws the body into another dialog. */
export function startPairing(kind, frame = null, proposalId = null) {
  stop(false);
  Object.assign(P, { kind, frame, proposalId, triedOn: false, canOpen: false, doorError: null, doorOn: false });
  return begin();
}

/* Switched on, opens Branch to Tailscale, then makes a new invitation, whose link is the Tailscale address; switched
   off, closes it and cancels the invitation that carried that address. When the engine cannot (Tailscale missing or
   signed out, or Lockdown), its own words stay under the note, the switch shows the door as it is, and the invitation
   on offer is kept. A change while one is still being answered is undone and not sent. */
async function door(el) {
  if (P.opening) { el.checked = P.doorOn; return; }
  P.opening = true;
  const enabled = el.checked;
  draw();
  try {
    await api("deployment/remote", { enabled });
    P.doorError = null;
  } catch (error) { P.doorError = error.message; }
  P.opening = false;
  if (P.doorError) { draw(); return; }
  stop(!enabled);
  await begin();
}
/* Leaving the "With a code" tab for another tab: the invitation stops working. */
export function stopPairing() { stop(true); }
/* find-computers: the invitation on offer in this dialog, if any, so a computer found on the network can be handed its link. */
export const pairingInvite = () => (P.invite ? { id: P.invite.id, link: P.invite.link } : null);

async function decide(approve) {
  const r = P.request, kind = P.kind;
  if (!r) return;
  const matches = $("#pair-match")?.checked === true;
  let answer;
  try {
    answer = await api(`devices/requests/${encodeURIComponent(r.id)}`, approve ? { approve, codeMatches: matches } : { approve });
  } catch (error) { toast(error.message); return; }
  stop(false);
  closeDlg();
  for (const listener of onPaired) listener({ approve, kind, request: answer?.request ?? r });
  if (!approve) toast(t("pair.refused"));
  else if (PHONES.includes(r.platform)) toast(t("window.flows.pair.phone-paired"));
  else if (answer?.request?.deviceId) nameNewComputer(answer.request.deviceId, r.name); // finish-soon-a: Name your new computer
  else toast(t("pair.paired", { name: r.name }));
}

async function switchOn() {
  P.triedOn = true;
  try { await api("devices/mode", { mode: "when-needed" }); } catch (error) { toast(error.message); }
  await begin();
}

async function phoneSaysPaired() {
  await look(true);
  const wait = P.dlg?.querySelector(".pair-wait");
  if (!P.request && wait) wait.textContent = t("pair.waiting.phone");
}

/* B6: Get Branch on your phone, from Settings › Computer. The same download `branch phone` opens
   (src/phone-app/): GET /api/phone-app says whether this copy of Branch carries the app, in the engine's words when it
   does not; Show the code (POST /api/phone-app/share) opens the download link on this computer's home network or
   Tailscale address for fifteen minutes and answers its square code; Stop the link (POST /api/phone-app/stop) closes it.
   The app is not in an app store, so there is no store link to offer. Leaving the pair dialog for this one cancels the
   invitation, as closing it does. */
const A = { view: null };
const appTime = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function appBody() {
  const v = A.view, share = v.share;
  const reason = !v.available && v.reason ? `<p data-css="margin:0" role="alert">${esc(v.reason)}</p>` : "";
  const code = share ? `<div class="qr-wrap pair-qr15">${qr(share.qr, 176)}<p data-css="margin:0">${esc(t("phoneApp.scan"))}</p></div>
    <div class="pair-row15"><label class="pair-lab15" for="phone-app-link">${t("window.flows.pair.link")}</label><input class="inp pair-link15" id="phone-app-link" type="text" readonly spellcheck="false" value="${esc(share.url)}"></div>
    <p class="hint" data-css="margin:0">${esc(t("phoneApp.expires", { time: appTime(share.expiresAt) }))}</p><p class="hint" data-css="margin:0">${esc(t("phoneApp.sameWifi"))}</p>` : "";
  return `<p data-css="margin:0">${esc(t("phoneApp.purpose"))}</p>${reason}${code}`;
}
function appFoot() {
  const v = A.view;
  const go = v.share ? `<button class="btn" type="button" data-act="phone-app-stop">${esc(t("phoneApp.stop"))}</button>`
    : v.available ? `<button class="btn pri" type="button" data-act="phone-app-show">${esc(t("phoneApp.show"))}</button>` : "";
  return `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>${go}`;
}
const drawApp = () => openDlg({ title: t("phoneApp.title"), body: appBody(), foot: appFoot(), wide: true });
export async function openPhoneApp() {
  if (P.dlg && dialog() === P.dlg) stop(true);
  try { A.view = await api("phone-app"); } catch (error) { toast(error.message); return; }
  drawApp();
}
async function phoneAppShare(open) {
  try {
    const answer = await api(open ? "phone-app/share" : "phone-app/stop", {});
    A.view = { ...A.view, share: answer.share };
  } catch (error) { toast(error.message); return; }
  drawApp();
}

export function init() {
  initChatPairing((kind, id) => startPairing(kind, null, id));
  markLive(["pair", "pair-cancel", "pair-letin", "pair-refuse", "pair-on", "ph-paired-dlg", "sw:pair-match", "sw:pair-door", "pair-copy",
    "phone-app", "phone-app-show", "phone-app-stop"]);
  on("phone-app", () => openPhoneApp());
  on("phone-app-show", () => phoneAppShare(true));
  on("phone-app-stop", () => phoneAppShare(false));
  on("pair", () => startPairing("phone"));
  on("pair-copy", (el) => copy(el.dataset.v));
  on("pair-cancel", () => { stop(true); closeDlg(); });
  on("pair-letin", () => decide(true));
  on("pair-refuse", () => decide(false));
  on("pair-on", () => switchOn());
  on("ph-paired-dlg", () => phoneSaysPaired());
  // "Let it in" waits for the owner's tick that the check codes match.
  document.addEventListener("change", (e) => {
    if (e.target?.id === "pair-door") { door(e.target); return; }
    if (e.target?.id !== "pair-match") return;
    const allow = P.dlg?.querySelector('[data-act="pair-letin"]');
    if (allow) allow.disabled = !e.target.checked;
  });
}
