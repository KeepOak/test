/* Set up Branch (pass 18c): three steps, Welcome (with the safety promise), Models and Your first Trunk, against the
   engine: models from GET /api/accounts (each account's switch is POST /api/accounts/update) and the shared local-model picker (flows/localpick.js), a hello through
   POST /api/models/test, and Trunks made with POST /api/trunks. Models can be left for later ("Choose the model later").
   The other steps wait on Overview in "Finish setting up" (places/overview.js), each opening its own page.
   Nothing here resets anything: every step is drawn from what the engine has now (load(), and adapt() for the
   switches a step draws unset), a step saves only what the person changes, and how far setup got (the step, the steps
   done, the trust box) is the engine's (GET/POST /api/onboarding, merged), so leaving halfway loses nothing.
   "Set up Branch" opens at Welcome and Guide › Onboarding where the person left off, both with everything kept. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { ic, av, app, toast, hex, SHAPE_NAMES } from "../core/ui.js";
import { lookOf } from "./trunk.js";
import { S, E, refresh } from "../core/state.js";
import { api, origin } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t, language, LANGUAGES } from "../../i18n.js";
import { canSpeak, chooseLanguage } from "../shell/language.js";
import { localPicker, freshPick, initLocalPick, helloAgain } from "./localpick.js";
import { newConversationMode } from "../chat/chips.js"; // the mode a new conversation's first message carries
import { sendBackup } from "../settings/more18.js"; // "Bring back your Branch", the same restore Settings › Accounts offers
import { gsel } from "../core/gsel.js";
import { say } from "../core/words.js";

/* The wizard's steps: each one's short name in the engine's record, and its name on the rail. */
const WIZARD = ["welcome", "models", "trunks"];
const STEPS = ["window.flows.setup.step-welcome", "layout.modelTabs", "window.p18.ob.step-trunk"];
/* Every step the engine's record (GET/POST /api/onboarding) keeps: the wizard's three, and the eight that wait on Overview. */
const IDS = ["welcome", "where", "models", "yours", "trunks", "reach", "tools", "keep", "people", "more", "check"];
/* Overview's "Finish setting up", in this order: the steps not asked in the wizard. */
export const FINISH = IDS.filter((id) => !WIZARD.includes(id));
/* A template's name and job are keys: shown in the chosen language, and the Trunk it makes is named in those words. Its
   colour and shape are the prototype's jobs' (flows/trunk.js TEMPLATES): the card draws that face, and the Trunk made
   from it is given the same face. */
const TEMPLATES = [
  ["window.flows.tmpl.inbox", "window.flows.tmpl.inbox-job", "#4F6FA8", 0],
  ["window.flows.tmpl.expense", "window.flows.tmpl.expense-job", "#D8612A", 2],
  ["window.flows.tmpl.researcher", "window.flows.tmpl.researcher-job", "#2F8C86", 1],
  ["window.flows.tmpl.chief", "window.flows.tmpl.chief-job", "#56616B", 3],
  ["window.flows.tmpl.bug", "window.flows.tmpl.bug-job", "#B84A6B", 4],
  ["window.flows.tmpl.trip", "window.flows.tmpl.trip-job", "#8A5AA8", 3],
];
/* The language comes first (the owner's call). Only languages with words on file are listed (i18n.js LANGUAGES, the
   locale files), so one appears as soon as its file does; each is named in its own language by the browser
   (Intl.DisplayNames), never written here. The one shown is the one in force. */
const ownName = (code) => {
  const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
};

const pressed = (on) => `aria-pressed="${on}"`;
const pose = (i) => i ? `<span class="mark mark-face ob-pose11" data-css="animation:none" aria-hidden="true"></span>` : "";

function languageControl() {
  const now = language();
  return `<div class="ctl ob-lang"><b>${t("appearance.language")}</b><span class="right">${gsel({ id: "ob-lang", sw: "ob-lang", label: t("appearance.language"), options: LANGUAGES.map(({ id }) => [id, ownName(id)]), value: now })}</span></div>`;
}

function welcome(o) {
  return `${languageControl()}<div class="ob-stage11"><span class="mark mark-face ob-art11" data-css="width:96px;height:96px" aria-hidden="true"></span></div><h2>${t("window.flows.first.hi")}</h2><p>${t("window.flows.setup.hi-lede")}</p><div class="ob-trust"><b>${t("window.flows.setup.safe")}</b><ul class="may6"><li>${ic("check", "s")}${t("window.flows.setup.safe-asks")}</li><li>${ic("check", "s")}${t("window.flows.setup.safe-stay")}</li><li>${ic("check", "s")}${t("window.flows.setup.safe-stop")}</li></ul><label class="chk ob-agree"><input type="checkbox" id="ob-trust" ${o.trust ? "checked" : ""}><span class="ob-box" aria-hidden="true">${ic("check", "s")}</span><span>${t("window.flows.setup.understand")}</span></label></div>${bringBack(o)}`;
}

/* The lead's call for #484: Welcome offers "Bring back your Branch" (the prototype's tile), a backup file sent to POST
   /api/restore. The engine brings it back only while this Branch holds nothing the person wrote (the new Trunks'
   own introductions do not count, src/backup.ts hasState) and says why otherwise; nothing here replaces anything. */
function bringBack(o) {
  const label = o.restoring ? t("first-run-steps.restore-working") : t("window.flows.setup.backup");
  return `<div class="ob-two15"><div class="tile"><div class="th"><span class="ico-tile">${ic("clock", "s")}</span><b>${t("first-run-steps.restore-title")}</b></div><p>${t("window.flows.setup.bring-back-hint")}</p><div class="acts"><button class="btn sm" type="button" data-act="ob-restore" ${o.restoring ? "disabled" : ""}>${ic("folder", "s")}${label}</button></div><input type="file" id="ob-restore-file" accept=".json,application/json" hidden></div></div>`;
}

async function restoreFrom(file) {
  const o = S.ob;
  if (!o || o.restoring) return;
  o.restoring = true;
  draw();
  if (await sendBackup(file)) await refresh().catch((error) => toast(error.message));
  o.restoring = false;
  if (S.ob === o) draw();
}

/* Each account the engine has, its switch on while that account may answer (POST /api/accounts/update { disabled }, the
   way Settings › Accounts pauses one; an account switched off is never asked). One still to sign in says so under its
   name. With no accounts, the model chosen now is listed; it has no account to switch, so its switch says why. */
function modelRows(o) {
  const rows = [];
  for (const p of o.pools) for (const a of p.accounts ?? []) {
    /* MODEL-045: the account by who it is (its verified email or name, #605) and the connection by its own name, never its id. */
    const signedOut = p.signedIn?.[a.id] === false || (a.signIn !== false && a.ready === false && a.signedIn === false);
    const sub = [p.name ?? p.pool, p.answering && p.defaultAccount === a.id ? t("glance.usedNext") : "", signedOut ? t("window.flows.first.sign-in") : ""].filter(Boolean).join(" · ");
    rows.push([p.pool, a.label || p.name || p.pool, sub, a.disabled !== true, `data-sw="ob-brain" data-pool="${esc(p.pool)}" data-account="${esc(a.id)}"`]);
  }
  if (!rows.length && E.state?.activeModel) rows.push([E.state.activeModel.presetName, E.state.activeModel.presetName, E.state.activeModel.model ?? "", true, 'data-sw="ob-brain-model"']);
  return rows.map(([id, name, sub, on, which]) => `<div class="prow">${logo(id, name, 30)}<span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span><input class="sw" type="checkbox" ${which} data-on="${on ? 1 : 0}" aria-label="${esc(name)}"></div>`).join("");
}

function testOut(o) {
  const res = o.test;
  if (!res) return "";
  if (res === "wait") return `<div class="status"><span class="sdot"></span><div><b>${t("window.flows.setup.saying-hello")}</b></div></div>`;
  if (!res.ok) return `<div class="status"><span class="sdot bad"></span><div><b>${t("window.flows.setup.no-answer")}</b><p>${esc(res.error ?? res.reply ?? "")}</p></div></div>`;
  return `<div class="status"><span class="sdot"></span><div><b>${t("window.flows.setup.answered-in", { s: (res.ms / 1000).toFixed(1) })}</b><p>“${esc(res.reply)}” · ${esc(res.presetName)} · ${esc(res.model)} ${res.accountLabel ? `· ${esc(res.accountLabel)}` : ""}</p><button class="btn sm" type="button" data-act="setgo" data-v="models">Change</button></div></div>`;
}

function models(o) {
  /* Accounts found are listed under the prototype's line; what runs on this computer is the picker's (it says plainly
     when nothing was found), so the line never stands over an empty list. */
  const rows = modelRows(o);
  return `<h2 tabindex="-1">${t("window.flows.setup.models")}</h2>${rows ? `<p>${t("window.flows.setup.found")}</p><div class="rows">${rows}</div>` : ""}${localPicker()}<div class="acts" data-css="margin-top:10px"><button class="btn sm" type="button" data-act="addacct">${ic("plus", "s")}${t("window.flows.setup.add-account")}</button><button class="btn sm" type="button" data-act="ob-test">${t("window.flows.setup.say-hello")}</button></div><div id="ob-test-out">${testOut(o)}</div>${later(o)}`;
}

/* Pass 18c: the model can wait. "Choose the model later" moves on to the next step; nothing is chosen, so Models is not
   counted as done, and no account is changed. */
const later = (o) => `<div class="later18c">${ic("clock", "s")}<span class="grow">${o.later ? t("window.p18.ob.later-chosen") : t("window.p18.ob.later")}</span><button class="btn" type="button" data-act="oblater18c">${t("window.p18.ob.later-button")}</button></div>`;

/* What Branch proposed from the owner's words (trunk.propose), each a card picked like a template, with the face its
   name gives (the face the Trunk is made with). */
function proposed(o, made) {
  if (!o.proposals.length) return "";
  const card = (p, i) => `<button class="ob-tpl" type="button" data-act="ob-prop" data-i="${i}" ${pressed(o.picks.has(p.name) || made.has(p.name))}>${av({ name: p.name }, 34)}<b>${esc(p.name)}</b><small>${esc(p.description || p.title)}</small></button>`;
  return `<div class="ob-props15"><b>${t("window.chat.mktrunk.proposed")}</b><div class="ob-tr">${o.proposals.map(card).join("")}</div></div>`;
}

function trunks(o) {
  const made = new Set(E.trunks.map((tr) => tr.name));
  const face = (n, col, sh) => av({ kind: "trunk", name: t(n), color: col, shape: sh }, 34);
  const busy = o.proposing ? ` disabled aria-busy="true"` : "";
  return `<h2 tabindex="-1">${t("window.flows.setup.step-trunks")}</h2><p>${t("window.flows.setup.trunks-lede")}</p><div class="ob-tr">${TEMPLATES.map(([n, s, col, sh], i) => `<button class="ob-tpl" type="button" data-act="ob-tpl" data-i="${i}" ${pressed(o.tpls.has(i) || made.has(t(n)))}>${face(n, col, sh)}<b>${esc(t(n))}</b><small>${esc(t(s))}</small></button>`).join("")}</div>${proposed(o, made)}<label class="fld" data-css="margin-top:12px"><span>${t("window.flows.setup.describe")}</span><textarea class="inp" id="ob-life" rows="2" placeholder="${t("window.flows.setup.describe-hint")}">${esc(o.life)}</textarea></label><button class="btn sm" type="button" data-act="ob-propose"${busy}>${ic(o.proposing ? "spin" : "spark", o.proposing ? "s spin" : "s")}${t("window.flows.setup.propose")}</button>${o.note ? `<p class="hint" role="status">${esc(o.note)}</p>` : ""}${o.error ? `<p class="hint" role="alert">${esc(o.error)}</p>` : ""}`;
}

const BODIES = [welcome, models, trunks];

function frame(o) {
  const i = o.i, last = i === STEPS.length - 1;
  const ticked = (j) => j !== i && o.completed.has(WIZARD[j]); // the engine's steps done, not merely the ones before this one
  const rail = STEPS.map((l, j) => `<li class="${ticked(j) ? "done" : j === i ? "now" : ""}"><button type="button" data-act="ob-go" data-v="${j}" ${j > i && !o.trust ? "disabled" : ""}><em>${ticked(j) ? ic("check", "s") : j + 1}</em>${t(l)}</button></li>`).join("");
  const next = !last ? `<button class="btn pri" type="button" data-act="ob-next" ${i === 0 && !o.trust ? 'data-wait="trust"' : ""}>${i === 0 ? t("personal.tunnel.start") : t("window.flows.chw.continue")}</button>`
    : `<button class="btn pri" type="button" data-act="ob-done">${t("window.flows.setup.open-walkthrough")}</button>`;
  return `<aside class="ob-rail"><span class="ob-brand"><span class="mark mark-face" data-css="width:26px;height:26px"></span>${t("window.setup.label")}</span><ol>${rail}</ol>${o.i > 0 ? `<button class="link ob-skip" type="button" data-act="ob-close">${t("window.flows.first.skip")}</button>` : ""}</aside>
    <section class="ob-main"><div class="ob-body">${pose(i)}${BODIES[i](o)}</div><footer class="ob-foot">${i ? `<button class="btn ghost" type="button" data-act="ob-go" data-v="${i - 1}">${t("action.back")}</button>` : "<span></span>"}<span class="grow"></span>${next}</footer></section>`;
}

function draw() {
  const o = S.ob;
  if (!o) return;
  let el = $(".ob9");
  const fresh = !el;
  if (fresh) {
    el = document.createElement("div");
    el.className = "ob9";
    el.setAttribute("role", "dialog");
    app().appendChild(el);
  } else el.classList.add("ob-still12");
  el.setAttribute("aria-label", t("window.setup.label")); // named on every draw, so a language picked here renames it
  /* A choice within a step redraws the step in place: the moving picture, where the page is scrolled and the control the
     person just pressed all stay as they were, so a click never looks like the screen starting over. Only a new step
     starts at its heading. */
  const sameStep = !fresh && el.dataset.step === String(o.i);
  const keptArt = sameStep ? [...el.querySelectorAll("video, img.pose11")] : [];
  const scrolled = sameStep ? [...el.querySelectorAll(".ob-main, .ob-body, [data-scroll]")].map((n) => [n.scrollTop, n.scrollLeft]) : [];
  const pressed = sameStep ? document.activeElement : null;
  const pressedKey = pressed && el.contains(pressed) ? [pressed.id, pressed.dataset?.act, pressed.dataset?.k, pressed.dataset?.v, pressed.dataset?.i] : null;
  el.innerHTML = frame(o);
  el.dataset.step = String(o.i);
  const fresh11 = [...el.querySelectorAll("video, img.pose11")];
  for (const old of keptArt) {
    const at = fresh11.findIndex((n) => n.tagName === old.tagName && n.getAttribute("src") === old.getAttribute("src"));
    if (at >= 0) { fresh11[at].replaceWith(old); fresh11.splice(at, 1); }
  }
  [...el.querySelectorAll(".ob-main, .ob-body, [data-scroll]")].forEach((n, i) => { if (scrolled[i]) [n.scrollTop, n.scrollLeft] = scrolled[i]; });
  /* A new step's rows that scroll sideways open with the picked card in the middle. */
  if (!sameStep) el.querySelectorAll("[data-scroll] > [aria-pressed='true']").forEach((b) => { b.parentElement.scrollLeft = b.offsetLeft - (b.parentElement.clientWidth - b.offsetWidth) / 2; });
  applyCss(el);
  greyOut(el);
  ADAPT[WIZARD[o.i]]?.(el, o);
  if (!fresh && !sameStep) el.querySelector("h2")?.focus({ preventScroll: true });
  else if (pressedKey) {
    const [id, act, k, v, i] = pressedKey;
    const again = id ? el.querySelector(`#${CSS.escape(id)}`) : [...el.querySelectorAll(`[data-act="${act}"]`)].find((n) => n.dataset.k === k && n.dataset.v === v && n.dataset.i === i);
    again?.focus({ preventScroll: true });
  }
}

/* What the engine has now, for every step. A read that fails leaves its step's choice unpicked, never a setup default
   shown as if it were saved. */
async function load(o) {
  /* The models on this computer are the shared picker's own read (flows/localpick.js), so setup is not held for them. */
  const [accounts, progress] = await Promise.all([api("accounts").catch(() => ({})), api("onboarding")]);
  o.pools = accounts.pools ?? [];
  keepProgress(o, progress);
}

/* A record saved before setup kept its progress: done, with no step, nothing completed and no finishedAt. That setup was
   finished; a record with progress in it is still being walked (done is also set by the first real answer). */
const olderFinished = (p) => p.done === true && !p.finishedAt && !p.step && !(p.completed ?? []).length;

/* How far setup got, from the engine's record: the trust box once ticked stays ticked. A step saved that is not one of
   the wizard's (an older setup's eleven) is no step here. */
function keepProgress(o, p) {
  if (E.state) E.state.onboarding = p;
  Object.assign(o, { mine: p.mine === true, trust: p.trust === true, trustKept: p.trust === true,
    step: WIZARD.indexOf(p.step), completed: new Set(p.completed ?? []), finished: !!p.finishedAt || olderFinished(p) });
}

/* After each draw, the step's controls that its own drawing leaves unset are set to what the engine has. */
const ADAPT = {
  models: (el) => el.querySelectorAll('.ob-body input[data-sw^="ob-brain"]').forEach((sw) => { sw.checked = sw.dataset.on === "1"; }), // as the engine has it
};

/* Where Guide › Onboarding picks up: the last step once setup is finished, else the step the person was on, else the
   first one not done. Nothing past Welcome until the trust box is ticked. */
function resumeAt(o) {
  if (!o.trust) return 0;
  if (o.finished) return STEPS.length - 1;
  if (o.step > 0) return o.step;
  const next = WIZARD.findIndex((id) => !o.completed.has(id));
  return next < 0 ? STEPS.length - 1 : next;
}

/* jump: the step "Start" goes to once the trust box is ticked; the message box's "Set up" (chat/nomodel.js) asks for the
   Models step when no model is set up yet. how: "start" opens at Welcome, "resume" (Guide › Onboarding) where the
   person left off. Either way the engine is read first, so nothing is drawn as a default and then changed. */
export async function openSetup(jump = 1, how = "start") {
  origin.setup = true;
  const o = S.ob = { i: 0, jump, trust: false, trustKept: false, pools: [], tpls: new Set(), test: null, error: "", later: false,
    life: "", proposals: [], picks: new Set(), proposing: false, note: "",
    mine: false, step: -1, completed: new Set(), finished: false, restoring: false };
  freshPick();
  try { await load(o); } catch (error) { toast(error.message); }
  if (S.ob !== o) return;
  if (!o.mine) { S.ob = null; origin.setup = false; return; } // setup is the owner's: the engine's refusal was shown above, nothing opens empty
  o.i = how === "resume" ? resumeAt(o) : 0;
  draw();
  if (o.i) progress(o, { step: WIZARD[o.i] });
  if (E.state?.onboarding?.skipped) progress(o, { skipped: false }); // open again: a reload comes back to it until it is left
}

/* One change to how far setup got, sent in order and merged by the engine; its answer is what the Guide menu and
   Overview's "Finish setting up" read. saveProgress is Overview's way in too, so both go through the one queue. */
let sending = Promise.resolve();
export function saveProgress(change) {
  const saved = sending.then(() => api("onboarding", change)).then((view) => { if (E.state) E.state.onboarding = view; return view; });
  sending = saved.catch(() => undefined); // the queue goes on; the caller is told why this one was refused
  return saved;
}
function progress(o, change) {
  for (const id of change.completed ?? []) o.completed.add(id);
  if (!o.mine) return;
  saveProgress(change).catch((error) => toast(error.message));
}
const doneWith = (o, id) => progress(o, { completed: [id] });

/* Guide › Onboarding's hint: how many of Overview's "Finish setting up" steps the engine has as done (the count that
   card shows), and Done only once every one is. Nothing for somebody who is not the owner (setup is the owner's). */
export function onboardingHint() {
  const p = E.state?.onboarding;
  if (!p?.mine) return "";
  const done = FINISH.filter((id) => (p.completed ?? []).includes(id)).length;
  return done === FINISH.length ? t("window.shell.shell.all-done") : t("window.shell.shell.steps-done", { done, total: FINISH.length });
}

/* "Skip for now", Escape: everything chosen is already saved; the engine notes setup was skipped, so a reload lands in
   the window rather than back in setup (flows/flows.js). */
async function close() {
  const o = S.ob;
  if (!o) return;
  if (!(await leaveTrunks(o))) return; // Trunks picked and not yet made are made on leaving, as Continue does
  progress(o, { skipped: true });
  $(".ob9")?.remove();
  S.ob = null;
  origin.setup = false;
}

/* Leaving "Your first Trunks" makes each picked template a Trunk, skipping names that already exist. Picking one is
   asking for Trunks, so they are switched on first if they are off. */
async function makeTrunks(o) {
  if (E.trunkModes.trunks === "off") await api("trunks/switch", { part: "trunks", mode: "on" });
  const have = new Set(E.trunks.map((tr) => tr.name));
  for (const i of o.tpls) {
    const [name, description] = TEMPLATES[i].slice(0, 2).map((key) => t(key));
    const [, , colour, shape] = TEMPLATES[i];
    if (have.has(name)) continue;
    /* The create takes name, title and description; the template's face follows as an edit, as flows/trunk.js does. */
    const { trunk } = await api("trunks", { name, description });
    await api(`trunks/${encodeURIComponent(trunk.id)}`, { chosenColour: hex(colour), look: { ...lookOf(null), shape: SHAPE_NAMES[shape] } });
  }
  /* A proposal is made with exactly the fields Branch proposed, the owner's own create (as chat/mktrunk.js). */
  for (const p of o.proposals) {
    if (o.picks.has(p.name) && !have.has(p.name)) await api("trunks", { name: p.name, title: p.title, description: p.description });
  }
  o.tpls.clear();
  o.picks.clear();
  await refresh().catch(() => {});
}

/* The trunk.propose calls in a conversation's replies, with their arguments; one whose arguments are not JSON proposed
   nothing (chat/mktrunk.js reads the same calls). */
function proposalsIn(messages) {
  return (messages ?? []).flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : [])).filter((call) => call.name === "trunk.propose").map((call) => {
    let args;
    try { args = JSON.parse(call.arguments || "{}"); } catch { return null; } // not JSON: nothing was proposed
    const name = typeof args?.name === "string" ? args.name.trim().slice(0, 40) : "";
    return name ? { name, title: String(args.title ?? "").slice(0, 80), description: String(args.description ?? "").slice(0, 1000) } : null;
  }).filter(Boolean);
}

/* "Or describe what you do": the owner's words start a real task, "Make me a Trunk: <words>" (the + menu's ask), in a
   temporary conversation that is discarded once read. What Branch proposes with trunk.propose becomes cards, picked. With
   no model yet, the engine's own words say so and nothing is asked; a reply with no proposal is shown as it came. */
async function propose() {
  const o = S.ob, what = ($("#ob-life")?.value ?? o.life).trim();
  o.life = what;
  if (!what || o.proposing) { $("#ob-life")?.focus(); return; }
  await refresh().catch(() => {});
  if (E.state?.modelNeeded) { o.note = say(E.state.modelNeeded); draw(); return; } // the engine's English, in the window's language
  Object.assign(o, { proposing: true, note: "", error: "" });
  draw();
  try {
    // A conversation of its own, so it starts on what new conversations start on, as the composer's first message does.
    const task = await api("run", { prompt: t("window.chat.mktrunk.ask", { what }), temporary: true, ...(await newConversationMode()) });
    const view = await api(`sessions/${encodeURIComponent(task.sessionId)}`);
    const found = proposalsIn(view.messages).filter((p) => !o.proposals.some((q) => q.name === p.name));
    for (const p of found) { o.proposals.push(p); o.picks.add(p.name); }
    if (!found.length) o.note = task.status === "completed" ? [...view.messages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? task.output : task.output;
    await api(`sessions/${encodeURIComponent(task.sessionId)}/discard`, {});
  } catch (error) { o.error = error.message; }
  o.proposing = false;
  if (S.ob === o) draw();
}

async function go(i) {
  const o = S.ob;
  if (!o || i < 0 || i >= STEPS.length || (i > 0 && !o.trust)) return;
  if (!(await leaveTrunks(o))) return;
  o.i = i;
  draw();
  progress(o, { step: WIZARD[i] });
}

/* Leaving "Your first Trunk" with Trunks picked and not yet made makes them; false (the engine's words shown) when it
   could not, so the step stays. */
async function leaveTrunks(o) {
  if (WIZARD[o.i] !== "trunks" || !(o.tpls.size || o.picks.size)) return true;
  try { await makeTrunks(o); o.error = ""; doneWith(o, "trunks"); return true; } catch (error) { o.error = error.message; draw(); return false; }
}

/* The last step ends setup: the Trunks picked are made, then the engine's record says setup was finished. The steps
   left wait on Overview in "Finish setting up", and the Guide menu counts those (onboardingHint). */
async function finish() {
  const o = S.ob;
  if (!o || !(await leaveTrunks(o))) return;
  try {
    await saveProgress({ done: true, finished: true, completed: ["trunks"] });
  } catch (error) {
    toast(error.message);
    return;
  }
  close();
  await refresh().catch(() => {});
  toast(t("window.flows.setup.ready"));
  setTimeout(() => run("tour"), 700);
}

/* An account's switch: saved at once, and drawn from the engine's answer; a refusal says why and puts it back. */
async function answerWith(sw) {
  const o = S.ob, { pool, account } = sw.dataset;
  if (!o || !pool || !account) return;
  sw.disabled = true;
  try {
    const view = await api("accounts/update", { pool, account, disabled: !sw.checked });
    o.pools = o.pools.map((p) => (p.pool === view.pool ? { ...p, ...view } : p));
    if (sw.checked && S.ob === o) await accountHello(pool, account, o);
  } catch (error) { toast(error.message); }
  if (S.ob === o) draw();
}

async function test() {
  const o = S.ob;
  /* Q072: while the picker above shows the hello it just said, Say hello says it again there, so setup shows one time. */
  if (await helloAgain()) { o.test = null; if (S.ob === o) draw(); return; }
  o.test = "wait";
  draw();
  o.test = await api("models/test", {}).catch((error) => ({ ok: false, error: error.message }));
  if (S.ob === o) draw();
}

async function accountHello(pool, account, o = S.ob) {
  if (!o || o.i !== 1 || E.profiles?.isOwner === false) return;
  const token = o.helloToken = (o.helloToken ?? 0) + 1;
  o.test = "wait"; draw();
  const result = await api("models/account-hello", { pool, account }).catch(error => ({ ok: false, error: error.message }));
  if (S.ob !== o || o.i !== 1 || o.helloToken !== token || E.profiles?.isOwner === false) return;
  o.test = result; draw();
}

/* The language picked at the top of Welcome: saved the way Settings › Appearance saves it (the engine's look and this
   browser, shell/language.js), then setup is drawn again in its words. One that cannot be picked changes nothing. */
async function pickLanguage(code) {
  if (canSpeak(code)) {
    try { await chooseLanguage(code); } catch (error) { toast(error.message); }
  }
  renderNow(); // the window behind setup, in the same words
  draw();
}

export function init() {
  document.addEventListener("model-account-connected", event => {
    if (S.ob?.i === 1 && event.detail?.pool && event.detail?.account) void accountHello(event.detail.pool, event.detail.account);
  });
  initLocalPick();
  markLive(["sw:ob-brain", "sw:ob-trust", "sw:ob-lang", "onboard", "onboard-resume", "ob-go", "ob-next", "ob-close", "ob-done", "ob-test", "oblater18c", "ob-tpl", "ob-propose", "ob-prop", "sw:ob-life", "ob-restore", "sw:ob-restore-file"]);
  on("ob-restore", () => document.getElementById("ob-restore-file")?.click());
  document.addEventListener("change", (e) => {
    if (e.target?.id !== "ob-restore-file" || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    e.target.value = "";
    restoreFrom(file);
  });
  on("onboard", (el) => openSetup(Number(el?.dataset?.v) || 1));
  on("onboard-resume", () => openSetup(1, "resume")); // Guide › Onboarding: where the person left off
  on("ob-go", (el) => go(+el.dataset.v));
  on("ob-next", () => { if (S.ob.i === 0 && !S.ob.trust) { nudgeTrust(); return; } doneWith(S.ob, WIZARD[S.ob.i]); go(S.ob.i === 0 ? S.ob.jump : S.ob.i + 1); });
  on("ob-close", () => close());
  on("ob-done", () => finish());
  on("ob-test", () => test());
  on("oblater18c", () => { S.ob.later = true; go(S.ob.i + 1); }); // Models waits: on to the next step, nothing chosen
  on("ob-tpl", (el) => { const i = +el.dataset.i; if (S.ob.tpls.has(i)) S.ob.tpls.delete(i); else S.ob.tpls.add(i); draw(); });
  on("ob-propose", () => propose());
  on("ob-prop", (el) => { const name = S.ob.proposals[+el.dataset.i]?.name; if (!name) return; if (S.ob.picks.has(name)) S.ob.picks.delete(name); else S.ob.picks.add(name); draw(); });
  document.addEventListener("input", (e) => { if (e.target.id === "ob-life" && S.ob) S.ob.life = e.target.value; });
  /* The trust box: ticking it is saved with when; once the engine has it, it stays ticked. */
  document.addEventListener("change", (e) => {
    const o = S.ob;
    if (e.target.id !== "ob-trust" || !o) return;
    if (o.trustKept && !e.target.checked) { e.target.checked = true; return; }
    o.trust = e.target.checked;
    if (o.trust) progress(o, { trust: true, completed: ["welcome"] });
    if (o.trust && o.mine) o.trustKept = true;
    draw();
  });
  document.addEventListener("change", (e) => { if (e.target.id === "ob-lang" && S.ob) pickLanguage(e.target.value); });
  document.addEventListener("change", (e) => { if (e.target.dataset?.sw === "ob-brain" && S.ob) answerWith(e.target); });
  /* The language can also change while setup is open without it being picked here (the engine's saved choice arriving
     after the first draw, or another window): setup is drawn again in the words now in force. */
  document.addEventListener("branch-language", () => { if (S.ob) draw(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.ob && !document.querySelector(".scrim")) close(); });
}

/* Start before the box is ticked: the box and its line light up and shake once, and the keyboard lands on the box, so the
   one thing between the person and the next step is plain. Pressed again, it does it again. */
function nudgeTrust() {
  const box = document.querySelector(".ob-trust");
  if (!box) return;
  box.classList.remove("nudge");
  void box.offsetWidth;
  box.classList.add("nudge");
  document.getElementById("ob-trust")?.focus();
}
