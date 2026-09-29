/* Set up a chat app (design doc 6.5), 1:1 with the prototype's wizard: Create, Paste, Check, Pair, Save, following each
   app's recipe from GET /api/channel-setup/<id>. POST /api/channel-setup/<id>/check checks what was pasted, saves it
   and switches the app on in one step; a six-digit code goes to POST /api/channels/pairings/approve. Pasted secrets
   live only in this module until they are sent, are never drawn back, and are cleared at once. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { qr } from "../core/qr.js";
import { t } from "../../i18n.js";
import { manage17d, fixNote17d } from "./chatapps17d.js"; // pass 17 part D §8

let vals = {};
/* owner-dm-signin: the App lock PIN typed to name the sender as the owner's own; sent once with the approval, then cleared. */
let pin = "";
/* Apps whose servers vouch for who sent each message (src/channels/owner-commands.ts vouchedSenderKinds), as far as the
   "Commands from your own chat" dialog lists them: a Matrix owner named here would be dropped by that dialog's next Save. */
const VOUCHED = ["telegram", "discord", "slack"];
const FAMILY = { core: "window.flows.chw.popular", chat: "window.flows.chw.work-chat" };
/* The steps are named in English in the code (BODIES, the checks below); these are the words each one shows. */
const STEP_WORD = { Create: "action.create", Paste: "window.flows.chw.paste", Check: "safety.scan.run", Pair: "pair.step.pair", Save: "action.save" };

const inputs = (c) => [...(c.fields ?? []).map((f) => ({ key: f.name, what: f.what, optional: f.optional, secret: false })),
  ...(c.paste ?? []).map((f) => ({ key: f.secret, what: f.what, optional: f.optional, secret: true }))];
const filled = (c) => inputs(c).every((f) => f.optional || (vals[f.key] ?? "").trim());

function stepsOf(c) {
  return [c.create?.url || c.steps?.length || c.create?.how ? "Create" : null, inputs(c).length ? "Paste" : null, c.hasCheck || c.noCheck ? "Check" : null, c.pairing ? "Pair" : null, "Save"].filter(Boolean);
}

function create(c) {
  const how = c.create?.how || (c.steps ?? []).join(" ") || t("window.flows.chw.make-first");
  const open = c.create?.url ? `<a class="btn pri sm" href="${esc(c.create.url)}" target="_blank" rel="noopener">${ic("globe", "s")}${c.create.prefilled ? t("window.flows.chw.open-filled", { name: esc(c.name) }) : t("window.flows.chw.open", { name: esc(c.name) })}</a>` : "";
  const app = c.app?.download ? `<a class="btn ghost sm" href="${esc(c.app.download)}" target="_blank" rel="noopener">${t("window.flows.chw.get-app", { name: esc(c.app.name || c.name) })}</a>` : "";
  const code = c.codes?.create ? `<div class="chw-qr12">${qr(c.codes.create, 148)}<small>${t("window.flows.chw.scan")}</small></div>` : "";
  return `<div class="chw-create12"><div><p>${esc(how)}</p>${c.steps?.length ? `<ol class="steps-list">${c.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}<div class="acts">${open}${app}</div></div>${code}</div>`;
}

function paste(c, w) {
  const rows = inputs(c).map((f) => `<label class="fld chf12"><span>${esc(f.what)}</span><span class="chf-in12"><input class="inp" data-sw="chf" data-chf="${esc(f.key)}" type="${f.secret ? "password" : "text"}" value="${f.secret ? "" : esc(vals[f.key] ?? "")}" autocomplete="off" spellcheck="false" placeholder="${f.secret ? t("pair.join.link.hint") : ""}">${f.secret ? `<button type="button" class="icon-btn" data-act="chf-eye" data-k="${esc(f.key)}" aria-label="${t("window.flows.chw.show-hide")}">${ic("eye", "s")}</button>` : ""}</span></label>`).join("");
  return `${w?.fixing ? fixNote17d() : ""}<p data-css="margin:0 0 6px">${t("window.flows.chw.paste-what", { name: esc(c.name) })}</p>${rows || `<p class="hint">${t("window.flows.chw.nothing")}</p>`}`;
}

function check(c, w) {
  if (!c.hasCheck && !w.result && !w.error) return `<p class="hint12">${esc(c.noCheck)}</p>`;
  if (w.error) return `<div class="status"><span class="sdot bad"></span><div><b>${t("window.flows.chw.not-accepted", { name: esc(c.name) })}</b><p>${esc(w.error)}</p></div></div>`;
  if (!w.result) return `<div class="chw-ok12 run12"><span class="spin12"></span><span><b>${t("window.flows.chw.checking", { name: esc(c.name) })}</b><small>${t("window.flows.chw.read-only")}</small></span></div>`;
  const said = w.result.botName ? t("window.flows.chw.found-bot", { name: w.result.botName }) : w.result.checkNote || t("window.flows.chw.accepted");
  return `<div class="chw-ok12">${ic("check", "s")}<span><b>${t("window.flows.chw.answers")}</b><small>${esc(said)}</small></span></div>${liveLine(c, w.result)}`;
}

/* CHAT-147: what connecting it to the running Branch came to, as the engine said it. Connected needs no restart; an app
   that posts to Branch is listening but needs its address pasted in; anything else says why it is not connected. */
function liveLine(c, r) {
  if (!r || r.connected == null) return "";
  if (!r.connected) return `<div class="status" role="alert"><span class="sdot bad"></span><div><b>${t("window.flows.chw.not-connected", { name: esc(c.name) })}</b><p>${esc(r.connectNote ?? "")}</p></div></div>`;
  const note = r.address ? `<small>${esc(r.connectNote ?? "")}</small>` : `<small>${t("window.flows.chw.no-restart")}</small>`;
  return `<div class="chw-ok12" role="status">${ic("check", "s")}<span><b>${r.address ? t("window.flows.chw.listening", { name: esc(c.name) }) : t("window.flows.chw.live-now", { name: esc(c.name) })}</b>${note}</span></div>`;
}

function pair(c, w) {
  return `<p data-css="margin:0 0 10px">${esc(c.pairing)}</p><div class="code12">${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" maxlength="1" data-sw="code" data-code="${i}" value="${esc(w.code[i] ?? "")}" aria-label="${t("window.flows.chw.digit", { n: i + 1 })}">`).join("")}</div>${w.error ? `<p class="hint" role="alert">${esc(w.error)}</p>` : `<p class="hint">${t("window.flows.chw.code-once")}</p>`}${mine(w)}`;
}
/* owner-dm-signin: "This is my own account", offered only while no chat account is named as the owner's yet, on an app
   that vouches for its senders (after OpenClaw's "Also make this sender the first command owner", MIT). The engine
   checks both again, and asks for the App lock PIN where one is set. */
function mine(w) {
  if (w.ownerNamed !== false || !VOUCHED.includes(w.id)) return "";
  const box = `<label class="ctl"><input type="checkbox" data-sw="chw-mine" ${w.mine ? "checked" : ""}><span>${t("window.flows.chw.mine")}</span><small>${t("window.flows.chw.mine-hint")}</small></label>`;
  return box + (w.mine && w.pinSet ? `<label>${t("window.chat-command.pin")}<input class="inp" data-sw="chw-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>` : "");
}

/* Who answers: the owner's Trunks, the default one chosen, never a brand-voiced "Branch" (owner rule). Routing a chat,
   group or topic to another Trunk is set later under "Who answers here". */
function whoAnswers() {
  const trunks = E.trunks ?? [], home = trunks.find((tr) => tr.id === E.defaultTrunkId)?.id ?? trunks[0]?.id;
  if (!trunks.length) return `<small>${t("window.flows.chw.default-answers")}</small>`;
  return trunks.map((tr) => `<button type="button" data-act="chw-who" data-v="${esc(tr.id)}" aria-pressed="${tr.id === home}">${esc(tr.name)}${tr.id === E.defaultTrunkId ? ` · ${t("window.flows.chw.default-trunk")}` : ""}</button>`).join("");
}

function save(c, w) {
  const who = whoAnswers();
  const may = [t("window.flows.chw.only-me"), t("window.flows.chw.approved"), t("window.flows.chw.workspace")].map((l, i) => `<button type="button" aria-pressed="${i === 0}" data-act="chw-may">${l}</button>`).join("");
  /* Telegram always keeps forum topics apart (src/channels/telegram.ts topicAddress) and always passes photos and files on
     to the task; the engine has no switch for either, so both are drawn on and greyed. */
  const tg = c.id === "telegram" ? `<div class="tg15"><div class="ctl"><b>${t("window.flows.chw.topics")}</b><input class="sw" type="checkbox" id="tg-topics15" checked aria-label="${t("window.flows.chw.topics")}" data-sw="set"><small>${t("window.flows.chw.topics-hint")}</small></div><div class="ctl"><b>${t("window.flows.chw.media")}</b><input class="sw" type="checkbox" id="tg-media15" checked aria-label="${t("window.flows.chw.media")}" data-sw="set"><small>${t("window.flows.chw.media-hint")}</small></div></div>` : ""; // state: both are how the Telegram adapter always works
  return `<div class="chw-ok12">${ic("check", "s")}<span><b>${t("window.flows.chw.ready", { name: esc(c.name) })}</b><small>${t("window.flows.chw.choose")}</small></span></div>
    <div class="fld"><span>${t("window.flows.chw.who-answers", { name: esc(c.name) })}</span><span class="seg">${who}</span></div>
    <div class="ctl"><b>${t("window.flows.chw.who-may")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.flows.chw.who-may")}">${may}</span></span><small>${t("window.flows.chw.no-answer")}</small></div>${tg}${w?.result ? liveLine(c, w.result) : ""}${w?.connected ? manage17d(c, w.health) : ""}${c.setUpHere ? `<div class="acts"><button class="btn ghost sm" type="button" data-act="chw-remove">${t("window.flows.chw.remove", { name: esc(c.name) })}</button></div>` : ""}`; // pass 17 part D §8: the app's own page
}

const BODIES = { Create: create, Paste: paste, Check: check, Pair: pair, Save: save };

function draw() {
  const w = S.chw, c = w?.recipe;
  if (!c) return;
  const steps = stepsOf(c), cur = steps[Math.min(w.step, steps.length - 1)];
  const dots = `<div class="chw-steps12">${steps.map((s, i) => `<span class="${i < w.step ? "done" : i === w.step ? "now" : ""}"><em>${i < w.step ? "✓" : i + 1}</em>${t(STEP_WORD[s])}</span>`).join("")}</div>`;
  const canNext = !c.unavailableReason && (cur === "Paste" ? filled(c) : cur === "Check" ? !!w.result || (!c.hasCheck && !w.error) : cur === "Pair" ? /^\d{6}$/.test(w.code) : true);
  const back = w.step ? `<button class="btn ghost" type="button" data-act="chw-back">${t("action.back")}</button>` : `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>`;
  const next = cur === "Save" ? `<button class="btn pri" type="button" data-act="chw-save">${t("action.save")}</button>` : `<button class="btn pri" type="button" data-act="chw-next" ${canNext ? "" : "disabled"}>${cur === "Pair" ? t("action.approve") : t("window.flows.chw.continue")}</button>`;
  const head = `<div class="chw-head12">${logo(c.id, c.name, 40)}<span><b>${esc(c.name)}</b><small>${t(FAMILY[c.family] ?? "window.flows.chw.more-apps")}${c.app?.name ? " · " + esc(c.app.name) : ""}</small></span></div>`;
  const prerequisites = `<p class="hint">${esc(c.prerequisites ?? "")}</p>${c.unavailableReason ? `<p role="alert">${esc(c.unavailableReason)}</p>` : ""}`;
  openDlg({ title: w.connected ? t("window.flows.chw.manage", { name: c.name }) : t("window.flows.chw.set-up", { name: c.name }), wide: true, body: `${head}${prerequisites}${dots}<div class="chw-body12">${BODIES[cur](c, w)}</div>`, foot: back + next });
  if (cur === "Pair") setTimeout(() => $('.code12 input[value=""]')?.focus(), 30);
}

export async function openChatWizard(id, at = null) {
  vals = {};
  let recipe, live;
  try {
    [recipe, live] = await Promise.all([api(`channel-setup/${encodeURIComponent(id)}`), api("channels").catch(() => ({}))]);
  } catch (error) { toast(error.message); return; }
  const here = (live.channels ?? []).find((c) => c.id === id || c.kind === id), connected = !!here;
  const ownerNamed = live.ownerNamed !== false, pinSet = !ownerNamed && (await api("lock").catch(() => ({}))).pinSet === true;
  // pass 17 part D §8: "Paste a new token" opens a connected app at Paste, saying why.
  const step = at ? Math.max(0, stepsOf(recipe).indexOf(at)) : connected ? stepsOf(recipe).length - 1 : 0;
  S.chw = { id, recipe, connected, health: here?.health ?? null, fixing: connected && at === "Paste", step, result: null, error: "", code: "", ownerNamed, pinSet, mine: false };
  draw();
}

/* Check, save and switch on, in the engine's one step. Setting an app up here is asking for guided setup, so it is
   switched on first if it is off. The pasted values are cleared whatever the answer. Each check is numbered: an answer
   that comes back after the wizard went Back (or closed) belongs to a check it has left, so it is not drawn over what
   is being typed now; drawing it wiped the new token from its field while it was still being pasted. */
async function runCheck(w) {
  const sent = vals, ask = (w.ask = (w.ask ?? 0) + 1);
  vals = {};
  let result = null, error = "";
  try {
    if ((await api("channel-setup")).mode === "off") await api("channel-setup", { mode: "on" });
    result = await api(`channel-setup/${encodeURIComponent(w.id)}/check`, { values: sent, enable: "on" });
  } catch (e) { error = e.message; }
  if (S.chw !== w || w.ask !== ask) return;
  if (result && result.connected != null) w.recipe.setUpHere = true; // kept by the engine, so it can be disconnected here
  w.result = result;
  w.error = error;
  draw();
}

async function approve(w) {
  try {
    const own = w.mine ? { firstOwner: true, ...(w.pinSet ? { pin } : {}) } : {};
    pin = "";
    const done = await api("channels/pairings/approve", { code: w.code, ...own });
    if (w.mine && !done.madeOwner) toast(t("window.flows.chw.mine-kept"));
    if (done.madeOwner) w.ownerNamed = true;
    w.error = "";
    return true;
  } catch (error) { w.error = error.message; w.code = ""; draw(); return false; }
}

async function next() {
  const w = S.chw, steps = stepsOf(w.recipe), cur = steps[w.step];
  if (w.recipe.unavailableReason) { toast(w.recipe.unavailableReason); return; }
  if (cur === "Pair" && !(await approve(w))) return;
  w.step = Math.min(w.step + 1, steps.length - 1);
  if (steps[w.step] === "Check") { w.result = null; w.error = ""; draw(); await runCheck(w); return; }
  draw();
}

/* The toast says what really happened: connected, listening for an app that posts to Branch, or saved but not connected. */
async function finish() {
  const name = S.chw.recipe.name, r = S.chw.result;
  S.chw = null;
  vals = {};
  closeDlg();
  await refresh().catch(() => {});
  toast(r?.connected === false ? t("window.flows.chw.saved-not-connected", { name }) : r?.address ? t("window.flows.chw.listening", { name }) : t("window.flows.chw.connected", { name }));
}

/* Disconnects an app set up here (DELETE /api/channel-setup/<id>); what was pasted stays in the locker. */
async function remove() {
  const w = S.chw;
  if (!w) return;
  try { await api(`channel-setup/${encodeURIComponent(w.id)}`, undefined, "DELETE"); }
  catch (error) { toast(error.message); return; }
  S.chw = null;
  vals = {};
  closeDlg();
  await refresh().catch(() => {});
  toast(t("window.flows.chw.removed", { name: w.recipe.name }));
}

function onInput(e) {
  const el = e.target, w = S.chw;
  if (!w) return;
  if (el.dataset.chf) {
    vals[el.dataset.chf] = el.value;
    const btn = $('.dlg [data-act="chw-next"]');
    if (btn) btn.disabled = !filled(w.recipe);
  }
  if (el.dataset.sw === "chw-mine") { w.mine = el.checked; pin = ""; draw(); return; }
  if (el.dataset.sw === "chw-pin") { pin = el.value; return; }
  if (el.dataset.code != null) {
    const boxes = [...document.querySelectorAll(".code12 input")];
    el.value = el.value.replace(/\D/g, "").slice(-1);
    w.code = boxes.map((x) => x.value).join("");
    const btn = $('.dlg [data-act="chw-next"]');
    if (btn) btn.disabled = !/^\d{6}$/.test(w.code);
    if (el.value) boxes[+el.dataset.code + 1]?.focus();
  }
}

export function init() {
  markLive(["sw:chf", "sw:code", "sw:chw-mine", "sw:chw-pin", "ch-open", "chw-next", "chw-back", "chw-save", "chf-eye", "revfix17d", "chw-remove"]); // the eye shows only what the owner just pasted, never a saved secret
  on("ch-open", (el) => openChatWizard(el.dataset.v));
  on("revfix17d", () => openChatWizard(S.chw?.id ?? "telegram", "Paste")); // pass 17 part D §8: the app whose page this is
  on("chw-remove", () => remove());
  on("chw-next", () => next());
  on("chw-back", () => { const w = S.chw; vals = {}; w.ask = (w.ask ?? 0) + 1; w.step = Math.max(0, w.step - 1); w.error = ""; w.result = null; draw(); });
  on("chw-save", () => finish());
  on("chf-eye", (el) => { const field = document.querySelector(`[data-chf="${CSS.escape(el.dataset.k)}"]`); if (field) field.type = field.type === "password" ? "text" : "password"; });
  document.addEventListener("input", onInput);
  document.addEventListener("paste", (e) => {
    if (e.target.dataset?.code == null || !S.chw) return;
    const digits = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
    if (!digits) return;
    e.preventDefault();
    S.chw.code = digits;
    draw();
  });
  document.addEventListener("click", (e) => { if (e.target.closest?.('[data-act="dlg-close"]')) { vals = {}; pin = ""; S.chw = null; } }, true);
}
