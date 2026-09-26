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
   address. Listeners of onPaired hear { approve, kind, request }: the dialog that asked ("phone", "computer" or "code")
   and the engine's answer (its deviceId once let in).
   Words the prototype lacks (the request, the check code, Let it in, Refuse) are the product's own locale words. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { qr } from "../core/qr.js";
import { t } from "../../i18n.js";

const P = { kind: null, frame: null, dlg: null, invite: null, request: null, seen: new Set(), error: null, canSwitch: false, triedOn: false, timer: null, stopping: null, canOpen: false, doorError: null };
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
function here() {
  if (!loopback(P.invite.link)) return "";
  const open = P.canOpen ? `<div class="acts"><button class="btn sm" type="button" data-act="pair-door">${esc(t("pair.onlyHere.tailscale"))}</button></div>` : "";
  const refused = P.doorError ? `<p class="hint" role="alert" data-css="margin:0">${esc(P.doorError)}</p>` : "";
  return `<p class="hint" data-css="margin:0">${esc(t("pair.onlyHere"))}</p>${refused}${open}`;
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
  return `<p data-css="margin:0"><b>${esc(t("pair.asks", { name: r.name, kind }))}</b></p><p class="hint" data-css="margin:0">${esc(t("pair.asks.note"))}</p>
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
    P.invite = await api("devices/invite", {});
  } catch (error) {
    P.error = error.message;
    const lockdown = await api("lockdown").then((l) => l.on === true, (e) => { toast(e.message); return true; });
    P.canSwitch = view?.mode === "off" && !P.triedOn && !lockdown;
  }
  // A link that only answers here: Tailscale is offered unless Lockdown, which shuts every door past this computer, is on.
  if (P.invite && loopback(P.invite.link)) P.canOpen = await api("lockdown").then((l) => l.on !== true, (e) => { toast(e.message); return false; });
  draw();
  if (P.invite) P.timer = setInterval(look, 1000);
}

/* Starts pairing: kind is "phone", "computer" or "code" (the tab); frame draws the body into another dialog. */
export function startPairing(kind, frame = null) {
  stop(false);
  Object.assign(P, { kind, frame, triedOn: false, canOpen: false, doorError: null });
  return begin();
}

/* Opens Branch to Tailscale, then makes a new invitation, whose link is the Tailscale address. When the engine cannot
   (Tailscale missing or signed out), its own words stay under the note and the invitation on offer is kept. */
async function openDoor() {
  try { await api("deployment/remote", { enabled: true }); } catch (error) { P.doorError = error.message; draw(); return; }
  P.doorError = null;
  stop(false);
  await begin();
}
/* Leaving the "With a code" tab for another tab: the invitation stops working. */
export function stopPairing() { stop(true); }

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

export function init() {
  markLive(["pair", "pair-cancel", "pair-letin", "pair-refuse", "pair-on", "pair-door", "ph-paired-dlg", "sw:pair-match", "pair-copy"]);
  on("pair", () => startPairing("phone"));
  on("pair-door", () => openDoor());
  on("pair-copy", (el) => copy(el.dataset.v));
  on("pair-cancel", () => { stop(true); closeDlg(); });
  on("pair-letin", () => decide(true));
  on("pair-refuse", () => decide(false));
  on("pair-on", () => switchOn());
  on("ph-paired-dlg", () => phoneSaysPaired());
  // "Let it in" waits for the owner's tick that the check codes match.
  document.addEventListener("change", (e) => {
    if (e.target?.id !== "pair-match") return;
    const allow = P.dlg?.querySelector('[data-act="pair-letin"]');
    if (allow) allow.disabled = !e.target.checked;
  });
}
