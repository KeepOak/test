/* Add an account's sign-ins: "Your plan" and "Coding assistants" (and Gemini's Google sign-in), each through the
   engine's own flow. GET /api/accounts lists only connections that already exist, so these come from
   GET /api/accounts/sign-ins, which names what the engine can sign in with and holds no account:
   - ChatGPT: the engine's device-code sign-in (POST /api/chatgpt/login, then GET /api/chatgpt/status until signed in);
     an extra ChatGPT account signs in the same way (POST /api/accounts/chatgpt/login, then GET /api/accounts).
   - A coding assistant: the program's own sign-in, which Branch never sees. Its documented status command is asked
     (POST /api/accounts/sign-ins/check); signed in already, it is added as a connection at once (POST
     /api/providers/cli-agents). Not signed in, Sign in starts the program's own sign-in (POST /api/accounts/sign-ins/start),
     whose page opens in the browser, and the status is asked again until it says signed in.
   - Back, or closing the dialog, stops whatever is still waiting in the engine (POST /api/chatgpt/cancel,
     /api/accounts/chatgpt/cancel or /api/accounts/sign-ins/stop). Every failure is the engine's sentence, with Try again.
   - Gemini: Google sign-in only when the owner saved a client id (POST /api/accounts/sign-ins/gemini, then
     GET /api/models/gemini-signin until connected); otherwise the key step.
   No password is typed here. The code shown is the one-time code the sign-in page asks for, not a secret. */

import { esc } from "../core/dom.js";
import { ic, toast, dialog, closeDlg } from "../core/ui.js";
import { S, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { logo } from "../core/logos.js";
import { t } from "../../i18n.js";
import { W, draw, loadAccounts, poolById } from "./account.js";

export const SI = { view: null };
const program = (id) => SI.view?.programs?.find((p) => p.id === id);
const httpUrl = (url) => /^https?:\/\//i.test(String(url ?? ""));
const siteOf = (url) => { try { return new URL(url).host; } catch { return ""; } };

export async function loadSignIns() {
  try { SI.view = await api("accounts/sign-ins"); } catch (error) { SI.view = null; toast(error.message); }
}

/* The plans the prototype names (PROVS): ChatGPT through its sign-in, Claude and Gemini through their own programs. */
const PLANS = [["chatgpt", "ChatGPT", "chatgpt", "window.flows.acct.note-chatgpt"], ["claude-code", "Claude", "claude", "window.flows.acct.note-claude"],
  ["gemini-cli", "Gemini", "gemini", "window.flows.acct.note-gemini"]];

/* Cards for every sign-in whose connection does not exist yet; a plan whose program is already connected opens it. */
export function signInCards() {
  if (!SI.view) return [];
  const small = (p) => (p && !p.installed ? t("window.flows.acct.not-installed") : t("window.flows.acct.not-signed-in-plan"));
  const plans = PLANS.flatMap(([id, name, mark, note]) => {
    if (id === "chatgpt") return SI.view.chatgpt?.available && !poolById("chatgpt")
      ? [{ act: "aa-plan", v: id, id: mark, name, group: "plan", small: small(null), note: t(note) }] : [];
    const p = program(id);
    if (!p) return [];
    const pool = poolById(p.pool);
    return [{ act: pool ? "aa-prov" : "aa-plan", v: pool ? p.pool : id, id: mark, name, group: "plan", note: t(note),
      small: pool ? `${t("window.flows.acct.signed-in", { count: pool.accounts.length })} · ${t("window.flows.acct.your-plan-lower")}` : small(p) }];
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
  return `<div class="prow" data-css="border:0;padding:0 0 8px">${logo(p.pool, p.name, 36)}<span class="grow"><b>${esc(p.label ?? p.name)}</b><small>${esc(p.command)}</small></span></div><p class="hint12">${esc(p.note)}</p>${line}${said}${p.terms ? termsLine(`${p.terms.route}.${warn}`, p.terms.url) : ""}`;
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
/* Asks again every few seconds while this very sign-in is on screen; closing the dialog or going back stops it. */
function poll(step) {
  const mine = ++ticket;
  const tick = async () => {
    if (mine !== ticket) return;
    if (!dialog() || !W.plan) { stopPolling(); return; }
    try { if (await step()) return; } catch (error) { W.error = error.message; W.code = null; waiting = null; draw(); return; }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}
export const stopPolling = () => {
  ticket++;
  const was = waiting;
  waiting = null;
  if (was) api(was[0], was[1]).catch((error) => toast(error.message));
};
const settled = () => { waiting = null; stopPolling(); };

async function connected(pool, name) {
  settled();
  await loadAccounts();
  Object.assign(W, { plan: null, code: null, check: null, line: null, pool, first: name, step: 3, error: "" });
  await refresh();
  draw();
}

/* The first ChatGPT sign-in: the engine asks OpenAI for the code; the tokens stay in the engine. */
async function startChatGPT() {
  try {
    const got = await api("chatgpt/login", {});
    if (got.signedIn) { await connected("chatgpt", "ChatGPT"); return; }
    W.code = got;
    W.error = "";
    waiting = ["chatgpt/cancel", {}];
    poll(async () => {
      const status = await api("chatgpt/status");
      if (status.signedIn) { await connected("chatgpt", "ChatGPT"); return true; }
      if (!status.pending && status.lastError) { waiting = null; W.error = status.lastError; W.code = null; draw(); return true; }
      return false;
    });
  } catch (error) { W.error = error.message; }
  draw();
}

/* An extra ChatGPT account, just added by accounts/add: it signs in by the same code, into its own locker place. */
export async function signInExtraChatGPT(account, label) {
  const prompt = await api("accounts/chatgpt/login", { account });
  Object.assign(W, { plan: { kind: "chatgpt", account }, code: prompt, step: 2, error: "" });
  waiting = ["accounts/chatgpt/cancel", { account }];
  poll(async () => {
    const pool = (await loadAccounts())?.pools?.find((p) => p.pool === "chatgpt");
    if (pool?.signedIn?.[account]) { settled(); closeDlg(); S.addAcct = null; toast(t("window.flows.acct.connected", { name: label })); return true; }
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

async function check(first = false) {
  const { id, account } = W.plan ?? {};
  if (!id) return;
  try {
    W.check = await api("accounts/sign-ins/check", account ? { id, account } : { id });
    W.error = "";
  } catch (error) { W.error = error.message; }
  if (W.line && W.check?.signedIn) { settled(); closeDlg(); S.addAcct = null; toast(W.check.message); return; }
  /* Already signed in on this computer: the one click that picked it adds it (an extra account keeps its Done). */
  if (first && !W.line && W.check?.installed && W.check.signedIn === true) { await addProgram(); return; }
  draw();
}

/* Sign in: the engine starts the program's own sign-in, whose page opens in the browser; the program finishes it by
   itself. The status is asked every few seconds until it says signed in, then the connection is added. */
async function startProgram() {
  const { id, account } = W.plan ?? {};
  if (!id) return;
  const body = account ? { id, account } : { id };
  try {
    W.check = await api("accounts/sign-ins/start", body);
    W.error = "";
  } catch (error) { W.error = error.message; draw(); return; }
  if (W.check.signedIn === true) { if (W.line) await check(); else await addProgram(); return; }
  waiting = ["accounts/sign-ins/stop", body];
  draw();
  poll(async () => {
    const now = await api("accounts/sign-ins/check", body);
    if (now.signedIn === true) { W.check = now; if (W.line) await check(); else await addProgram(); return true; }
    W.check = { ...now, failed: !now.signingIn };
    if (!now.signingIn) { waiting = null; draw(); return true; }
    draw();
    return false;
  });
}

/* The program becomes a connection under its own name; its sign-in stays the program's. */
async function addProgram() {
  const p = program(W.plan?.id);
  if (!p) return;
  try {
    const made = await api("providers/cli-agents", { id: p.id });
    await loadSignIns();
    await connected(made.id, p.label ?? made.name);
  } catch (error) { W.error = error.message; draw(); }
}

async function startGoogle() {
  try {
    W.code = await api("accounts/sign-ins/gemini", {});
    Object.assign(W, { plan: { kind: "gemini" }, step: 2, error: "" });
    poll(async () => {
      const state = await api("models/gemini-signin");
      if (state.connected) { await connected("google-gemini", "Gemini"); return true; }
      return false;
    });
  } catch (error) { W.error = error.message; }
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
  on("aa-cli", () => addProgram());
  on("aa-goo", () => startGoogle());
  on("aa-fin", () => (W.first ? finishFirst() : (closeDlg(), S.addAcct = null)));
}
