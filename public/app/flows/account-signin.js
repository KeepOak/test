/* Add an account's sign-ins: "Your plan" and "Coding assistants" (and Gemini's Google sign-in), each through the
   engine's own flow. GET /api/accounts lists only connections that already exist, so these come from
   GET /api/accounts/sign-ins, which names what the engine can sign in with and holds no account:
   - ChatGPT: the engine's device-code sign-in (POST /api/chatgpt/login, then GET /api/chatgpt/status until signed in);
     an extra ChatGPT account signs in the same way (POST /api/accounts/chatgpt/login, then GET /api/accounts).
   - A coding assistant: the program's own sign-in, which Branch never sees. Its documented status command is asked
     (POST /api/accounts/sign-ins/check); signed in already, it is added as a connection at once (POST
     /api/providers/cli-agents). Not signed in, Sign in starts the program's own sign-in (POST /api/accounts/sign-ins/start),
     whose page opens in the browser, and the status is asked again until it says signed in. A program whose sign-in can
     be finished by hand (Claude Code) also hands over its page's address: it is shown, and the code that page shows is
     pasted here and forwarded to the program (POST /api/accounts/sign-ins/code).
   - Back, or closing the dialog, stops whatever is still waiting in the engine (POST /api/chatgpt/cancel,
     /api/accounts/chatgpt/cancel or /api/accounts/sign-ins/stop). Every failure is the engine's sentence, with Try again.
   - Gemini: Google sign-in only when the owner saved a client id (POST /api/accounts/sign-ins/gemini, then
     GET /api/models/gemini-signin until connected); otherwise the key step.
   No password is typed here. The code shown is the one-time code the sign-in page asks for, not a secret. */

import { esc } from "../core/dom.js";
import { ic, toast, dialog, closeDlg } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { sessionAuthority } from "../core/session-pages.js";
import { api } from "../core/api.js";
import { logo } from "../core/logos.js";
import { t } from "../../i18n.js";
import { W, draw, loadAccounts, poolById } from "./account.js";
import { markLive } from "../core/features.js";

export const SI = { view: null };
const program = (id) => SI.view?.programs?.find((p) => p.id === id);
const httpUrl = (url) => /^https?:\/\//i.test(String(url ?? ""));
const siteOf = (url) => { try { return new URL(url).host; } catch { return ""; } };
/* The maker's own sign-in page only, as the engine checked it: https, one of Claude's sign-in hosts. */
const makerPage = (url) => /^https:\/\//.test(String(url ?? "")) && ["platform.claude.com", "claude.com", "claude.ai", "console.anthropic.com"].includes(siteOf(url));
/* What is typed in the code box, kept across the redraws the status asks cause. */
let pasted = "";

export async function loadSignIns() {
  try { SI.view = await api("accounts/sign-ins"); } catch (error) { SI.view = null; toast(error.message); }
}

/* The plans the prototype names (PROVS): ChatGPT through its sign-in, Claude and Gemini through their own programs. */
const PLANS = [["chatgpt", "ChatGPT", "chatgpt", "window.flows.acct.note-chatgpt"], ["claude-code", "Claude", "claude", "window.flows.acct.note-claude"],
  ["gemini-cli", "Gemini", "gemini", "window.flows.acct.note-gemini"]];

/* Cards for every sign-in whose connection does not exist yet; a plan whose program is already connected opens it. */
export function signInCards() {
  if (!SI.view) return [];
  /* QA retest 2026-09-28 pass 2: an installed program is not asked about its sign-in until it is chosen (canCheck), so
     it is not called "Not signed in": Claude Code signed in on this computer was listed so, then connected at once. */
  const small = (p) => (p && !p.installed ? t("window.flows.acct.not-installed") : p ? t("window.flows.acct.installed-plan") : t("window.flows.acct.not-signed-in-plan"));
  const plans = PLANS.flatMap(([id, name, mark, note]) => {
    if (id === "chatgpt") return SI.view.chatgpt?.available && !poolById("chatgpt")
      ? [{ act: "aa-plan", v: id, id: mark, name, group: "plan", small: small(null), note: t(note) }] : [];
    const p = program(id);
    if (!p) return [];
    const pool = poolById(p.pool);
    return [{ act: pool ? "aa-prov" : "aa-plan", v: pool ? p.pool : id, id: mark, name, group: "plan", note: t(note),
      small: pool ? `${t("window.flows.acct.signed-in", { count: pool.accounts.filter((one) => one.ready === true).length })} · ${t("window.flows.acct.your-plan-lower")}` : small(p) }];
  });
  const code = (SI.view.programs ?? []).filter((p) => !poolById(p.pool))
    .map((p) => ({ act: "aa-plan", v: p.id, id: p.pool, name: p.label ?? p.name, group: "code", small: small(p), note: p.note ?? "" }));
  return [...plans, ...code];
}

/* ---------- the sign-in step ---------- */
function termsLine(route, url) {
  const link = /^https:\/\//.test(String(url ?? "")) ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t("terms.read")}</a>` : "";
  return `<p class="hint"><b>${t("terms.label")}</b> ${esc(route)}${link}</p>`;
}

/* The one-time code and where to type it, as the prototype's sign-in page draws it; the engine's words for the site. */
function codeBlock(name) {
  const url = W.code?.verificationUrl, site = siteOf(url);
  const open = httpUrl(url) && site ? `<a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ic("globe", "s")}${t("window.flows.acct.open-site", { site: esc(site) })}</a>` : "";
  return `<div class="aa-site"><div class="aa-bar"><span class="aa-dots"><i></i><i></i><i></i></span><span class="url">${ic("lock", "s")}${esc(site)}</span></div><div class="aa-page">${logo("chatgpt", name, 40)}<b>${t("window.flows.acct.sign-in-to", { name: esc(name) })}</b><p>${t("window.flows.acct.enter-code")}</p><code class="devcode14" aria-label="${t("window.flows.acct.enter-code")}">${esc(W.code?.userCode ?? "")}</code>${open}<span class="aa-spin">${ic("spin", "s spin")}${t("window.flows.acct.waiting", { site: esc(site) })}</span></div></div><p class="hint">${t("window.flows.acct.never-password")}</p>`;
}

function chatgptBody() {
  const intro = W.code ? codeBlock("ChatGPT") : `<div class="prow" data-css="border:0;padding:0 0 8px">${logo("chatgpt", "ChatGPT", 36)}<span class="grow"><b>${t("window.flows.acct.sign-in-to", { name: "ChatGPT" })}</b><small>${t("window.flows.acct.finish-there")}</small></span></div><p class="hint12">${t("window.flows.acct.note-chatgpt")}</p>`;
  return `${intro}${termsLine(t("terms.chatgpt.route"), "https://learn.chatgpt.com/docs/auth")}`;
}

function programBody() {
  const p = program(W.plan.id);
  if (!p) return "";
  const line = W.line ? `<p>${t("window.flows.acct.run-line")}</p><code class="sigline14">${esc(W.line)}</code>` : "";
  const said = W.check ? `<p class="hint" role="status">${esc(W.check.message)}</p>` : "";
  const warn = p.terms?.warning ? ` ${p.terms.warning}` : "";
  return `<div class="prow" data-css="border:0;padding:0 0 8px">${logo(p.pool, p.name, 36)}<span class="grow"><b>${esc(p.label ?? p.name)}</b><small>${esc(p.command)}</small></span></div><p class="hint12">${esc(p.note)}</p>${line}${said}${byHand()}${p.terms ? termsLine(`${p.terms.route}.${warn}`, p.terms.url) : ""}`;
}

/* While a sign-in that takes a code runs: its page, and the box for the code that page shows. */
function byHand() {
  const url = W.check?.signingIn && W.check.takesCode ? W.check.url : "";
  if (!makerPage(url)) return "";
  const hint = t("pair.join.link.hint");
  return `<a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ic("globe", "s")}${t("window.flows.acct.continue-there")}</a><label class="fld" data-css="margin-top:10px"><span>${hint}</span><input class="inp" id="aa-code" type="text" autocomplete="off" spellcheck="false" value="${esc(pasted)}" aria-label="${hint}"></label><button class="btn sm" type="button" data-act="aa-code">${t("composer.send")}</button>`;
}

function geminiBody() {
  if (!W.code) return "";
  const site = siteOf(W.code.url);
  return `<div class="aa-site"><div class="aa-bar"><span class="aa-dots"><i></i><i></i><i></i></span><span class="url">${ic("lock", "s")}${esc(site)}</span></div><div class="aa-page">${logo("gemini", "Gemini", 40)}<b>${t("window.flows.acct.sign-in-to", { name: "Google" })}</b><p>${t("window.flows.acct.finish-there")}</p>${httpUrl(W.code.url) ? `<a class="btn sm" href="${esc(W.code.url)}" target="_blank" rel="noopener noreferrer">${ic("globe", "s")}${t("window.flows.acct.continue-there")}</a>` : ""}<span class="aa-spin">${ic("spin", "s spin")}${t("window.flows.acct.waiting", { site: esc(site) })}</span></div></div><p class="hint">${t("window.flows.acct.never-password")}</p>`;
}

export function planBody() {
  const error = W.error ? `<p class="hint" role="alert">${esc(W.error)}</p>` : "";
  const kind = W.plan?.kind;
  return (kind === "chatgpt" ? chatgptBody() : kind === "gemini" ? geminiBody() : programBody()) + error;
}

export function planFoot() {
  const back = `<button class="btn ghost" type="button" data-act="aa-back">${t("action.back")}</button>`;
  const kind = W.plan?.kind;
  if (kind === "chatgpt") return back + (W.code ? "" : `<button class="btn pri" type="button" data-act="aa-dev">${W.error ? t("first-run-trouble.retry") : t("window.flows.acct.continue-there")}</button>`);
  if (kind === "gemini") return back;
  const again = `<button class="btn ghost" type="button" data-act="aa-chk">${t("window.flows.acct.check-again")}</button>`;
  if (W.line) return `${again}<button class="btn pri" type="button" data-act="aa-fin">${t("window.flows.acct.done")}</button>`;
  const ready = !!W.check?.installed && W.check.signedIn !== false;
  /* Not signed in, and the engine can start the program's own sign-in: one button does it (Try again after a failure). */
  const start = W.check?.installed && W.check.signedIn === false && W.check.canStart && !W.check.signingIn
    ? `<button class="btn pri" type="button" data-act="aa-psi">${W.check.failed ? t("first-run-trouble.retry") : t("accounts.action.sign-in")}</button>` : "";
  return back + (W.check && !ready ? again : "") + start + (ready ? `<button class="btn pri" type="button" data-act="aa-cli">${t("window.flows.acct.add-account")}</button>` : "");
}

/* ---------- what the buttons do ---------- */
let ticket = 0;
/* What is still waiting in the engine for this sign-in ([route, body]), stopped by Back or by closing the dialog. */
let waiting = null;
let pollDeadline = null;
/* Asks again every few seconds while this very sign-in is on screen; closing the dialog or going back stops it. */
function poll(step) {
  const mine = ++ticket;
  const code = W.code;
  const parsed = code?.expiresAt ? Date.parse(code.expiresAt) : code?.expiresInMs > 0 ? Date.now() + code.expiresInMs : null;
  pollDeadline = Number.isFinite(parsed) ? parsed : null;
  const tick = async () => {
    if (mine !== ticket) return;
    if (!dialog() || !W.plan) { stopPolling(); return; }
    if (pollDeadline !== null && Date.now() >= pollDeadline) {
      stopPolling(); W.error = "This sign-in expired. Start it again."; W.code = null; draw(); return;
    }
    try { if (await step(() => mine === ticket && !!dialog() && !!W.plan)) return; } catch (error) { if (mine !== ticket) return; W.error = error.message; W.code = null; waiting = null; draw(); return; }
    if (mine === ticket) setTimeout(tick, pollDeadline === null ? 3000 : Math.max(1, Math.min(3000, pollDeadline - Date.now())));
  };
  setTimeout(tick, pollDeadline === null ? 3000 : Math.max(1, Math.min(3000, pollDeadline - Date.now())));
}
/* One sign-in flow lasts from its first action until Back, a new pick, the dialog opening again or closing. Its owner
   authority is captured at that first action and is sticky: a lock or profile change since, even one undone, ends it. */
let flow = 0, held = null;
function flowOwner() {
  if (held?.flow === flow) return held;
  held?.authority.close();
  const mine = flow, authority = sessionAuthority(E.profiles, document.getElementById("app"));
  held = { flow: mine, authority, current: () => mine === flow && !!dialog() && authority.current(E.profiles) };
  return held;
}
const halt = () => {
  ticket++;
  pollDeadline = null;
  const was = waiting;
  waiting = null;
  if (was) api(was[0], was[1]).catch((error) => toast(error.message));
};
export const stopPolling = () => { flow++; held?.authority.close(); held = null; halt(); };
const settled = () => { waiting = null; halt(); };

async function connected(pool, name, owner) {
  /* Back, a new sign-in, a closed dialog, a lock or another profile since the flow began: not this one's to finish. */
  if (!owner.current()) return;
  if (pollDeadline !== null && Date.now() >= pollDeadline) throw new Error("This sign-in expired. Start it again.");
  settled();
  await loadAccounts();
  if (!owner.current()) return;
  Object.assign(W, { plan: null, code: null, check: null, line: null, pool, first: name, step: 3, error: "" });
  await refresh();
  if (!owner.current()) return;
  draw();
  document.dispatchEvent(new CustomEvent("model-account-connected", { detail: { pool, account: "primary" } }));
}

/* The first ChatGPT sign-in: the engine asks OpenAI for the code; the tokens stay in the engine. */
async function startChatGPT() {
  const owner = flowOwner();
  try {
    const got = await api("chatgpt/login", {});
    if (!owner.current()) return;
    if (got.signedIn) { await connected("chatgpt", "ChatGPT", owner); return; }
    W.code = got;
    W.error = "";
    waiting = ["chatgpt/cancel", {}];
    poll(async active => {
      const status = await api("chatgpt/status");
      if (!active() || !owner.current()) return true;
      if (status.signedIn) { await connected("chatgpt", "ChatGPT", owner); return true; }
      if (!status.pending && status.lastError) { waiting = null; W.error = status.lastError; W.code = null; draw(); return true; }
      return false;
    });
  } catch (error) { if (!owner.current()) return; W.error = error.message; }
  draw();
}

/* An extra ChatGPT account, just added by accounts/add: it signs in by the same code, into its own locker place. */
export async function signInExtraChatGPT(account, label) {
  const owner = flowOwner();
  const prompt = await api("accounts/chatgpt/login", { account });
  if (!owner.current()) return;
  Object.assign(W, { plan: { kind: "chatgpt", account }, code: prompt, step: 2, error: "" });
  waiting = ["accounts/chatgpt/cancel", { account }];
  poll(async active => {
    const pool = (await loadAccounts())?.pools?.find((p) => p.pool === "chatgpt");
    if (!active() || !owner.current()) return true;
    /* Signed in as an account already in the list: the engine merged it into that one, which is the account now connected. */
    const into = pool?.mergedInto?.[account];
    if (pool?.signedIn?.[account] || into) {
      if (pollDeadline !== null && Date.now() >= pollDeadline) throw new Error("This sign-in expired. Start it again.");
      settled(); closeDlg(); S.addAcct = null;
      document.dispatchEvent(new CustomEvent("model-account-connected", { detail: { pool: "chatgpt", account: into ?? account } }));
      toast(t("window.flows.acct.connected", { name: into ? pool.accounts?.find((a) => a.id === into)?.label ?? label : label }));
      return true;
    }
    const problem = pool?.signInProblems?.[account];
    if (problem) { waiting = null; W.error = problem; W.code = null; draw(); return true; }
    return false;
  });
  draw();
}

/* An extra program account: the engine made its own folder and the line that signs the program in to it. */
export function signInExtraProgram(pool, account) {
  Object.assign(W, { plan: { kind: "program", id: pool.slice(4), account: account.id }, line: account.signInLine ?? "", check: null, step: 2, error: "" });
  draw();
}

async function check(first = false, owner = flowOwner()) {
  const { id, account } = W.plan ?? {};
  if (!id) return;
  try {
    const status = await api("accounts/sign-ins/check", account ? { id, account } : { id });
    if (!owner.current()) return;
    W.check = status;
    W.error = "";
  } catch (error) { if (!owner.current()) return; W.error = error.message; }
  if (W.line && W.check?.signedIn === true) {
    settled(); closeDlg(); S.addAcct = null; toast(W.check.message);
    document.dispatchEvent(new CustomEvent("model-account-connected", { detail: { pool: `cli-${id}`, account } })); return;
  }
  /* Already signed in on this computer: the one click that picked it adds it (an extra account keeps its Done). */
  if (first && !W.line && W.check?.installed && W.check.signedIn === true) { await addProgram(owner); return; }
  draw();
}

/* Sign in: the engine starts the program's own sign-in, whose page opens in the browser; the program finishes it by
   itself. The status is asked every few seconds until it says signed in, then the connection is added. */
async function startProgram() {
  const { id, account } = W.plan ?? {};
  if (!id) return;
  const owner = flowOwner();
  const body = account ? { id, account } : { id };
  pasted = "";
  try {
    const started = await api("accounts/sign-ins/start", body);
    if (!owner.current()) return;
    W.check = started;
    W.error = "";
  } catch (error) { if (owner.current()) { W.error = error.message; draw(); } return; }
  if (W.check.signedIn === true) { if (W.line) await check(false, owner); else await addProgram(owner); return; }
  waiting = ["accounts/sign-ins/stop", body];
  draw();
  poll(async active => {
    const now = await api("accounts/sign-ins/check", body);
    if (!active() || !owner.current()) return true;
    if (now.signedIn === true) { W.check = now; if (W.line) await check(false, owner); else await addProgram(owner); return true; }
    const shown = (c) => JSON.stringify([c?.message, c?.signingIn, c?.url, c?.takesCode]);
    const changed = shown(now) !== shown(W.check);
    W.check = { ...now, failed: !now.signingIn };
    if (!now.signingIn) { waiting = null; draw(); return true; }
    /* Redrawn only when something shown changed, so the code box keeps its focus while it is typed in. */
    if (changed) draw();
    return false;
  });
}

/* The code the maker's page showed, forwarded to the program's running sign-in; the engine's words when it cannot be. */
async function sendCode() {
  const { id, account } = W.plan ?? {};
  const code = pasted.trim();
  if (!id || !code) return;
  try {
    await api("accounts/sign-ins/code", account ? { id, account, code } : { id, code });
    pasted = "";
    W.error = "";
  } catch (error) { W.error = error.message; }
  draw();
}

/* The program becomes a connection under its own name; its sign-in stays the program's. */
async function addProgram(owner = flowOwner()) {
  const p = program(W.plan?.id);
  if (!p) return;
  try {
    const made = await api("providers/cli-agents", { id: p.id });
    if (!owner.current()) return;
    await loadSignIns();
    await connected(made.id, p.label ?? made.name, owner);
  } catch (error) { if (owner.current()) { W.error = error.message; draw(); } }
}

async function startGoogle() {
  const owner = flowOwner();
  try {
    const code = await api("accounts/sign-ins/gemini", {});
    if (!owner.current()) return;
    W.code = code;
    Object.assign(W, { plan: { kind: "gemini" }, step: 2, error: "" });
    poll(async active => {
      const state = await api("models/gemini-signin");
      if (!active() || !owner.current()) return true;
      if (state.connected) { await connected("google-gemini", "Gemini", owner); return true; }
      return false;
    });
  } catch (error) { if (!owner.current()) return; W.error = error.message; }
  draw();
}

/* A plan or program card with no connection yet. */
function pickPlan(id) {
  stopPolling();
  Object.assign(W, { step: 2, pool: null, service: null, saved: null, code: null, check: null, line: null, error: "",
    plan: id === "chatgpt" ? { kind: "chatgpt" } : { kind: "program", id } });
  draw();
  if (W.plan.kind === "program") void check(true);
}

export const googleOffered = () => !!SI.view?.gemini?.signInSetUp;
export function googleButton() {
  return googleOffered() ? `<button class="btn" type="button" data-act="aa-goo">${t("action.sign-in-with-google")}</button>` : "";
}

export function finishFirst() {
  stopPolling();
  closeDlg();
  S.addAcct = null;
  toast(t("window.flows.acct.connected", { name: W.first }));
}

export function initSignIns(on) {
  on("aa-plan", (el) => pickPlan(el.dataset.v));
  on("aa-dev", () => startChatGPT());
  on("aa-chk", () => check());
  on("aa-psi", () => startProgram());
  markLive(["sw:aa-code", "aa-code"]);
  on("aa-code", () => sendCode());
  document.addEventListener("input", (event) => { if (event.target?.id === "aa-code") pasted = event.target.value; });
  on("aa-cli", () => addProgram());
  on("aa-goo", () => startGoogle());
  on("aa-fin", () => (W.first ? finishFirst() : (closeDlg(), S.addAcct = null)));
}
