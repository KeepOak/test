/* The first run, 1:1 with the prototype's shorter sequence ("Replay the first run" in the person menu): hello, how Branch
   should think, the accounts the engine has (GET /api/accounts), chat apps (GET /api/channel-setup), the two
   recommendations (the gateway through POST /api/never-break, updating by itself through POST /api/comfort), a first
   Trunk made from a job template (POST /api/trunks), and the end. Downloading a model and signing in to an account on
   its own site open over the first run (the local-model picker, the Add an account wizard), which carries on when they
   close; the prototype's timed download bar and its "Practice first" are not drawn (no demo model). Also the quiet
   "New to Branch?" card, shown once setup has been seen, until it is dismissed. */

import { $, esc, applyCss, onRender } from "../core/dom.js";
import { app, av, toast, ic, closePop, closeDlg } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { logo } from "../core/logos.js";
import { openAddAcct, poolById } from "./account.js";
import { openLocalPicker } from "./localpick.js";
import { t } from "../../i18n.js";
import { setupNeeds } from "../core/setup-needs.js";

const N = 8;
/* A template's name and job are keys: shown in the chosen language, and the Trunk it makes is named in those words. */
const TEMPLATES = [["window.flows.tmpl.inbox", "window.flows.tmpl.inbox-job", "#4F6FA8", 0], ["window.flows.tmpl.expense", "window.flows.tmpl.expense-job", "#D8612A", 2],
  ["window.flows.tmpl.researcher", "window.flows.tmpl.researcher-job", "#2F8C86", 1], ["window.flows.tmpl.chief", "window.flows.tmpl.chief-job", "#56616B", 3]];
const F = { step: null, pick: "", accounts: [], channels: [], gw: "off", upd: "off" };

const hero = () => `<span class="mark mark-full hero-mark" aria-hidden="true"></span><h1>${t("window.flows.first.hi")}</h1><p class="lede">${t("window.flows.first.hi-lede")}</p><div class="acts"><button class="btn pri" type="button" data-act="fr-next">${t("window.flows.first.start")}</button><button class="btn ghost" type="button" data-act="fr-skip">${t("window.flows.first.skip")}</button></div>`;
function think() {
  const ways = [["fr-way-computer", t("glance.local"), t("window.flows.first.private")], ["fr-way-chatgpt", t("window.flows.first.chatgpt"), t("window.flows.first.their-site")],
    ["fr-way-claude", t("window.flows.first.claude"), t("window.flows.first.their-site")]];
  return `<h1>${t("firstRun.title")}</h1><p class="lede">${t("window.flows.first.think-lede")}</p><div class="ways">${ways.map(([a, name, x]) => `<button class="way" type="button" data-act="${a}"><b>${name}</b><small>${x}</small></button>`).join("")}</div><div class="acts"><button class="btn ghost" type="button" data-act="fr-next">${t("window.flows.first.later")}</button></div>`;
}
function accounts() {
  const rows = F.accounts.map((a) => `<button class="way" type="button" data-act="fr-acc" data-v="${esc(a.pool)}"><span data-css="display:flex;align-items:center;gap:10px">${logo(a.pool, a.label, 26)}<b>${esc(a.label)}</b></span><small>${a.signedIn ? t("window.flows.first.signed-in") : t("window.flows.first.sign-in")}</small></button>`).join("");
  return `<h1>${t("window.flows.first.accounts")}</h1><p class="lede">${t("window.flows.first.accounts-lede")}</p><div class="ways">${rows}</div><div class="acts"><button class="btn pri" type="button" data-act="fr-next">${t("action.next")}</button></div>`;
}
function apps() {
  const rows = F.channels.slice(0, 4).map((c) => `<button class="way" type="button" data-act="ch-open" data-v="${esc(c.id)}"><span data-css="display:flex;align-items:center;gap:10px">${logo(c.id, c.name, 26)}<b>${esc(c.name)}</b></span><small>${esc(setupNeeds(c) ?? "")}</small></button>`).join("");
  return `<h1>${t("window.flows.first.anywhere")}</h1><p class="lede">${t("window.flows.first.anywhere-lede")}</p><div class="ways">${rows}</div><div class="acts"><button class="btn pri" type="button" data-act="fr-next">${t("action.next")}</button><button class="btn ghost" type="button" data-act="fr-next">${t("window.flows.first.later")}</button></div>`;
}
function recs() {
  const row = (k, name, x, on) => `<div class="way" data-css="grid-template-columns:1fr auto;align-items:center"><span><b>${name} <span data-css="color:var(--ok)">${t("suggest.recommended")}</span></b><small data-css="display:block">${x}</small></span><input class="sw" type="checkbox" id="fr-${k}" ${on ? "checked" : ""} aria-label="${name}"></div>`;
  return `<h1>${t("window.flows.first.recommend")}</h1><div class="ways" data-css="grid-template-columns:1fr">${row("gw", t("window.flows.first.gw"), t("window.flows.first.gw-hint"), F.gw !== "off")}${row("upd", t("comfort.update.install"), t("window.flows.first.upd-hint"), F.upd === "install")}</div><div class="acts"><button class="btn pri" type="button" data-act="fr-recs">${t("action.next")}</button></div>`;
}
function trunk() {
  const tmpl = ([n, x, col, sh], i) => `<button class="way" type="button" data-act="fr-tmpl" data-i="${i}"><span data-css="display:flex;align-items:center;gap:10px">${av({ kind: "trunk", color: col, shape: sh }, 30)}<b>${esc(t(n))}</b></span><small>${esc(t(x))}</small></button>`;
  return `<h1>${t("window.flows.first.meet")}</h1><p class="lede">${t("window.flows.first.meet-lede")}</p><div class="ways">${TEMPLATES.map(tmpl).join("")}</div>`;
}
const done = () => `<h1>${t("window.flows.first.all-set")}</h1><p class="lede">${t("window.flows.first.ready", { name: esc(F.pick || t("window.flows.first.your-trunk")) })}</p><ul class="steps-list"><li>${t("window.flows.first.finds", { keys: "<b>Ctrl K</b>" })}</li><li>${t("window.flows.first.try-at", { at: "<b>@</b>" })}</li><li>${t("window.flows.first.try-takeover")}</li><li>${t("window.flows.first.try-ring")}</li></ul><div class="acts"><button class="btn pri" type="button" data-act="fr-tour">${t("window.flows.first.tour")}</button><button class="btn" type="button" data-act="fr-skip">${t("dashboard.openBranch")}</button></div>`;
const STEPS = [hero, think, null, accounts, apps, recs, trunk, done];

function draw() {
  $(".first")?.remove();
  if (F.step == null) return;
  const el = Object.assign(document.createElement("div"), { className: "first" });
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("window.first.label"));
  const dots = `<div class="dots" aria-hidden="true">${Array.from({ length: N }, (_, i) => `<i class="${i === F.step ? "on" : ""}"></i>`).join("")}</div>`;
  el.innerHTML = `<div class="inner">${dots}${STEPS[F.step]()}</div>`;
  applyCss(el);
  greyOut(el);
  app().appendChild(el);
  el.querySelector("button:not([aria-disabled='true'])")?.focus({ preventScroll: true });
}

/* The engine's own answers for the steps: accounts, chat apps, the gateway's mode and whether updates install by themselves. */
async function load() {
  const [acc, ch, gw, comfort] = await Promise.all([api("accounts").catch(() => ({})), api("channel-setup").catch(() => ({})), api("never-break").catch(() => ({})), api("comfort").catch(() => ({}))]);
  F.accounts = (acc.pools ?? []).flatMap((p) => (p.accounts ?? []).map((a) => ({ pool: p.pool, label: a.label || p.name || p.pool, signedIn: p.signedIn?.[a.id] === true })));
  F.channels = ch.channels ?? [];
  F.gw = gw.mode ?? "off";
  F.upd = comfort.values?.notify?.autoUpdate ?? "off";
}

export async function startFirst() {
  closePop();
  closeDlg();
  Object.assign(F, { step: 0, pick: "" });
  draw();
  await load();
  if (F.step != null) draw();
}
const go = (i) => { F.step = i === 2 ? 3 : i; draw(); };
const close = () => { F.step = null; draw(); };

/* A dialog opened over the first run (the Add an account wizard, the local-model picker): the first run comes back when
   it closes, with the engine's accounts read again, at `next` when one is given. */
function overFirst(next = F.step) {
  const back = setInterval(() => {
    if (document.querySelector(".scrim")) return;
    clearInterval(back);
    if (F.step == null) return;
    F.step = next;
    load().then(() => { if (F.step != null) draw(); }, (error) => toast(error.message));
  }, 400);
}

/* An account's "Sign in on their site": the Add an account wizard for that service (flows/account.js). */
async function signIn(pool) {
  try { await openAddAcct(pool); } catch (error) { toast(error.message); return; }
  overFirst();
}

/* "How should Branch think?": On this computer is the shared local-model picker (it finds, downloads and says hello
   through a model on this computer, flows/localpick.js); ChatGPT and Claude are their sign-in in the Add an account
   wizard (the connection when there is one, else the plan's own sign-in, flows/account-signin.js). Either way the first
   run carries on with its accounts step once that closes. */
const PLAN = { "fr-way-chatgpt": "chatgpt", "fr-way-claude": "claude-code" };
async function way(act) {
  if (act === "fr-way-computer") { openLocalPicker(); overFirst(3); return; }
  const id = PLAN[act];
  try {
    await openAddAcct(id);
    if (!poolById(id)) run("aa-plan", { dataset: { v: id } });
  } catch (error) { toast(error.message); return; }
  overFirst(3);
}

/* The two recommendations: each is sent only when its switch differs from what the engine has. */
async function recommend() {
  const gw = $("#fr-gw")?.checked, upd = $("#fr-upd")?.checked;
  try {
    if (gw !== (F.gw !== "off")) F.gw = (await api("never-break", { mode: gw ? "on" : "off" })).mode ?? F.gw;
    if (upd !== (F.upd === "install")) F.upd = (await api("comfort", { card: "notify", values: { autoUpdate: upd ? "install" : "off" } })).values?.notify?.autoUpdate ?? F.upd;
  } catch (error) { toast(error.message); return; }
  go(F.step + 1);
}

/* Picking a job makes that Trunk (unless one by that name is there already), switching Trunks on first if they are off. */
async function makeTrunk(i) {
  const [name, description] = TEMPLATES[i].slice(0, 2).map((key) => t(key));
  try {
    if (E.trunkModes.trunks === "off") await api("trunks/switch", { part: "trunks", mode: "on" });
    if (!E.trunks.some((tr) => tr.name === name)) await api("trunks", { name, description });
  } catch (error) { toast(error.message); return; }
  F.pick = name;
  await refresh().catch((error) => toast(error.message));
  go(7);
}

/* ---------- "New to Branch?" ---------- */
const seen = (key) => { try { return !!localStorage.getItem(key); } catch (error) { return false; } };
/* setup-resume: shown once setup has been opened (the engine's record, or this browser's older note) and not finished,
   never while "Show tips and pop-ups" is off or after "Don't show again" (both the engine's, GET /api/state
   onboarding). × only hides it until the window is opened again. */
let hiddenNow = false;
function wanted() {
  const p = E.state?.onboarding ?? {};
  const opened = p.step != null || (p.completed ?? []).length > 0 || p.skipped === true || seen("branch-setup-seen");
  return opened && !hiddenNow && !p.finishedAt && !p.welcomed && p.popups !== false && !seen("branch-welcomed");
}
function welcome() {
  if (!E.loaded || $(".welcome10") || $(".ob9") || $(".tour-layer") || !wanted()) return;
  app().insertAdjacentHTML("beforeend", `<div class="welcome10" role="region" aria-label="${t("window.flows.first.welcome")}"><span class="mark mark-face wel11" aria-hidden="true"></span><span class="grow"><b>${t("window.flows.first.new")}</b><small>${t("window.flows.first.new-hint")}</small></span><button class="btn pri sm" type="button" data-act="onboard">${t("channel-setup.row-button")}</button><button class="btn sm" type="button" data-act="tour">${t("window.flows.first.walkthrough")}</button>${E.state?.onboarding?.mine ? `<button class="link wel-never" type="button" data-act="welcome-never">${t("window.flows.first.never")}</button>` : ""}<button class="icon-btn" type="button" aria-label="${t("window.flows.first.dismiss")}" data-act="welcome-x">${ic("x", "s")}</button></div>`);
  greyOut($(".welcome10"));
  placeWelcome();
}
/* The card keeps the prototype's corner but never covers the message box: its bottom sits just above the dock (the
   composer and the lines over it) whenever one is drawn, so Send is always reachable. */
function placeWelcome() {
  const card = $(".welcome10"), dock = $("#main .dock"), root = app();
  if (!card || !root) return;
  /* It belongs to the conversation, where it keeps clear of the message box; over Settings or a place it would sit on
     their own controls (the Appearance language picker, a card's buttons), so there it waits unseen. */
  card.hidden = S.view !== "chat";
  const over = dock?.getClientRects().length ? root.getBoundingClientRect().bottom - dock.getBoundingClientRect().top + 12 : 0;
  card.style.bottom = over > 0 ? `${Math.round(over)}px` : "";
}
function dismissWelcome() {
  hiddenNow = true;
  $(".welcome10")?.remove();
}
/* "Don't show again": the engine keeps it (POST /api/onboarding { welcomed: true }), on every device. */
async function neverWelcome() {
  try { E.state.onboarding = await api("onboarding", { welcomed: true }); } catch (error) { toast(error.message); return; }
  $(".welcome10")?.remove();
}

export function init() {
  markLive(["fr-way-computer", "fr-way-chatgpt", "fr-way-claude", "fr-acc", "sw:fr-gw", "sw:fr-upd", "firstrun", "fr-next", "fr-skip", "fr-tour", "fr-recs", "fr-tmpl", "welcome-x", "welcome-never"]);
  on("welcome-never", () => neverWelcome());
  on("firstrun", () => startFirst());
  on("fr-next", () => go(F.step + 1));
  on("fr-skip", () => close());
  on("fr-tour", () => { close(); run("tour"); });
  on("fr-recs", () => recommend());
  on("fr-tmpl", (el) => makeTrunk(+el.dataset.i));
  on("fr-acc", (el) => signIn(el.dataset.v));
  on("fr-way-computer", () => way("fr-way-computer"));
  on("fr-way-chatgpt", () => way("fr-way-chatgpt"));
  on("fr-way-claude", () => way("fr-way-claude"));
  on("welcome-x", () => dismissWelcome());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && F.step != null && !document.querySelector(".scrim")) close(); }); // a dialog it opened closes first
  let checked = false;
  onRender(() => { if (!checked && E.loaded) { checked = true; setTimeout(welcome, 1200); } placeWelcome(); });
  addEventListener("resize", placeWelcome);
  document.addEventListener("input", placeWelcome); // the message box grows as it is written in
}
