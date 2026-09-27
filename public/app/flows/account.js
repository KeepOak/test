/* Accounts (design doc 6.4), against the engine's accounts routes (src/accounts/api.ts) and its service catalogue
   (GET /api/connections/catalog). One place holds the engine's list (GET /api/accounts) for Settings › Accounts and
   Models › Connections, the account menu both of them open, and the "Add an account" wizard:
   step 1 picks a service, step 2 takes a key for a key connection, step 3 names the account, says which Trunks use it
   and where it goes in the order. A key is read from its field once, sent at once with POST /api/accounts/add, and the
   field is emptied: it is never drawn back, kept in a variable or saved in this window. */

import { $, esc, render } from "../core/dom.js";
import { openDlg, openPop, closePop, closeDlg, dialog, ic, mi, toast } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { t } from "../../i18n.js";
import { localPicker, initLocalPick } from "./localpick.js";
import { SI, loadSignIns, signInCards, planBody, planFoot, googleButton, googleOffered, initSignIns, signInExtraChatGPT, signInExtraProgram, stopPolling } from "./account-signin.js";

/* ---------- the engine's list, shared by Settings › Accounts and Models ---------- */
export const A = { view: null, catalog: null };

export async function loadAccounts() {
  try { A.view = await api("accounts"); } catch (error) { A.view = { pools: [] }; toast(error.message); }
  render();
  return A.view;
}
export const pools = () => A.view?.pools ?? [];
export const poolById = (id) => pools().find((p) => p.pool === id);
/* Every account in the engine's order, pool by pool, with the pool's own facts beside it. */
export const allAccounts = () => pools().flatMap((p) => p.accounts.map((a) => ({ ...a, pool: p.pool, poolName: p.name ?? p.pool, kind: p.kind, first: p.defaultAccount === a.id })));
const accountOf = (el) => allAccounts().find((a) => a.pool === el.dataset.pool && a.id === el.dataset.id);
/* A household person (GET /api/profiles names them as active) may look, but every change is the owner's: the engine
   refuses it (src/accounts/api.ts requireOwner), so those controls are drawn greyed. */
export const household = () => !!E.profiles?.active?.id;
export const ownerOnly = () => (household() ? 'disabled aria-disabled="true"' : "");

/* ---------- the account menu (Settings › Accounts and Models › Connections) ---------- */
function openAccountMenu(el) {
  const a = accountOf(el);
  if (!a) return;
  const ids = `data-pool="${esc(a.pool)}" data-id="${esc(a.id)}" ${ownerOnly()}`;
  openPop(el, `<div class="pt">${esc(a.label)}</div>${mi("acct-first", "up", t("window.flows.acct.answer-first"), "", ids)}${mi("toast", "edit", t("accounts.action.rename"))}${mi("toast", "users", t("window.flows.acct.which-trunks"))}<hr>${mi("acct-out", "x", t("accounts.action.sign-out"), "", ids)}`, { right: true });
}

/* "Answer first" is the pool's default account (POST /api/accounts/pool { defaultAccount }). */
async function answerFirst(el) {
  const a = accountOf(el);
  closePop();
  if (!a) return;
  try {
    await api("accounts/pool", { pool: a.pool, defaultAccount: a.id });
    toast(t("window.flows.acct.answers-first", { name: a.label }));
  } catch (error) { toast(error.message); }
  await loadAccounts();
}

/* Signing out removes the account and its key or sign-in (POST /api/accounts/remove); the engine refuses the first
   account of a connection, which is the connection itself. */
async function signOut(el) {
  const a = accountOf(el);
  closePop();
  if (!a) return;
  try {
    await api("accounts/remove", { pool: a.pool, account: a.id });
    toast(t("window.flows.acct.signed-out", { name: a.label }));
  } catch (error) { toast(error.message); }
  await loadAccounts();
}

/* ---------- the wizard ---------- */
const GROUPS = [["all", "look.filter.all"], ["plan", "window.flows.acct.your-plan"], ["code", "window.flows.acct.coding"], ["key", "window.flows.acct.a-key"], ["local", "glance.local"], ["custom", "window.flows.acct.your-own"], ["gone", "terms.standing.retired"]];
const KIND_GROUP = { chatgpt: "plan", cli: "code", "api-key": "key" };
/* plan: a sign-in on screen (account-signin.js), code: its one-time code, check: a program's answer, line: the line that
   signs a program in to an extra account's folder, first: the name of a connection just made by its first sign-in. */
const FRESH = { plan: null, code: null, check: null, line: null, first: "" };
export const W = { step: 1, pool: null, service: null, extras: {}, group: "all", q: "", saved: null, name: "", trunks: [], pos: "last", error: "", ...FRESH };

const siteOf = (url) => { try { return new URL(url).host; } catch { return ""; } };
const httpUrl = (url) => /^https?:\/\//i.test(String(url ?? ""));
const hasPool = (service) => pools().some((p) => p.pool === service.id || p.pool.startsWith(service.id + "-"));
function serviceGroup(s) {
  if (s.terms?.standing === "retired" || s.terms?.standing === "not-offered") return "gone";
  if (s.kind === "local") return "local";
  return s.id === "custom" ? "custom" : "key";
}

/* The cards: every connection that can take another account, then every service in the catalogue that has none yet. */
function cards() {
  const own = pools().map((p) => ({ act: "aa-prov", v: p.pool, id: p.pool, name: p.name ?? p.pool, group: KIND_GROUP[p.kind] ?? "key",
    small: `${t("window.flows.acct.signed-in", { count: p.accounts.length })} · ${p.kind === "api-key" ? t("window.flows.acct.a-key-lower") : t("window.flows.acct.your-plan-lower")}`, note: "" }));
  const rest = (A.catalog ?? []).filter((s) => !hasPool(s)).map((s) => {
    const group = serviceGroup(s);
    const act = group === "local" ? "aa-local" : group === "gone" ? "aa-gone" : "signin";
    const small = group === "local" ? t("window.flows.acct.local-small") : group === "gone" ? (s.terms?.standing === "not-offered" ? t("terms.standing.not-offered") : t("terms.standing.retired")) : t("window.flows.acct.not-signed-in");
    return { act, v: s.id, id: s.id, name: s.name, group, small, note: `${s.name} ${s.note ?? ""}` };
  });
  return [...own, ...signInCards(), ...rest];
}

function card(c) {
  return `<button class="prov prov12 ${c.group === "gone" ? "gone12" : ""}" type="button" data-act="${c.act}" data-v="${esc(c.v)}">${logo(c.id, c.name, 34)}<b>${esc(c.name)}</b><small>${esc(c.small)}</small></button>`;
}

function listHtml(all) {
  const q = W.q.trim().toLowerCase();
  const list = all.filter((c) => (W.group === "all" || c.group === W.group) && (!q || c.name.toLowerCase().includes(q) || c.note.toLowerCase().includes(q)));
  if (W.group !== "all") return list.length ? `<div class="provs">${list.map(card).join("")}</div>` : "";
  return GROUPS.slice(1).map(([g, l]) => {
    const items = list.filter((c) => c.group === g);
    return items.length ? `<div class="aa-grp12"><h3>${t(l)} <span>${items.length}</span></h3><div class="provs">${items.map(card).join("")}</div></div>` : "";
  }).join("");
}

function step1() {
  const all = cards();
  return `<p data-css="margin:0 0 10px">${t("window.flows.acct.which-service", { count: all.length })}</p>
    <div class="aa-top12"><label class="set-search" data-css="margin:0;flex:1">${ic("search", "s")}<input id="aa-q" value="${esc(W.q)}" placeholder="${t("window.flows.acct.search")}" aria-label="${t("window.flows.acct.search")}" autocomplete="off"></label></div>
    <div class="tabs aa-tabs12">${GROUPS.map(([g, l]) => `<button class="tab" type="button" aria-selected="${W.group === g}" data-act="aa-grp" data-v="${g}">${t(l)}</button>`).join("")}</div>
    <div class="aa-list12">${W.group === "local" ? localPicker() + listHtml(all) : listHtml(all) || `<p class="empty">${t("window.flows.acct.no-match")}</p>`}</div>`;
}

/* What a catalogue service asks for besides the key (src/provider-catalog.ts extras), in the engine's words: a fixed
   choice as a list, anything else as a box. Kept in W.extras between draws; none of it is a secret. */
function extraField(x) {
  const now = W.extras[x.key] ?? x.default ?? "";
  const box = x.choices
    ? `<select class="inp" data-sw="aaextra" data-k="${esc(x.key)}">${x.choices.map((c) => `<option value="${esc(c)}"${c === now ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`
    : `<input class="inp" data-sw="aaextra" data-k="${esc(x.key)}" value="${esc(now)}" placeholder="${esc(x.example ?? "")}" autocomplete="off">`;
  return `<label class="fld" data-css="margin-top:10px"><span>${esc(x.label)}</span>${box}</label>`;
}
const extraBoxes = () => [...(dialog()?.querySelectorAll("input, select") ?? [])].filter((el) => el.dataset.sw === "aaextra");
const keepExtras = () => { for (const el of extraBoxes()) W.extras[el.dataset.k] = el.value; };

/* A key connection: the catalogue's own note and where to get a key; the key field is empty every time it is drawn. */
function step2() {
  const p = poolById(W.pool);
  const service = W.service ?? (A.catalog ?? []).find((s) => p && (p.pool === s.id || p.pool.startsWith(s.id + "-")));
  const note = service?.note ? `<p class="hint12">${esc(service.note)}</p>` : "";
  const site = siteOf(service?.signUp);
  const get = httpUrl(service?.signUp) && site ? `<p class="hint"><a href="${esc(service.signUp)}" target="_blank" rel="noopener">${t("window.flows.acct.get-key", { site: esc(site) })}</a></p>` : "";
  const google = W.service?.id === "gemini" && googleOffered() ? `<div class="acts" data-css="margin:0 0 10px">${googleButton()}</div>` : "";
  return `${note}${google}${W.service ? (W.service.extras ?? []).map(extraField).join("") : ""}<label class="fld" data-css="margin-top:10px"><span>${t("addons.pipelines.key")}</span><input class="inp" id="aa-key" type="password" autocomplete="off" placeholder="${t("window.flows.acct.paste-key")}" aria-label="${t("addons.pipelines.key")}"></label>${get}${errorLine()}`;
}

const errorLine = () => (W.error ? `<p class="hint" role="alert">${esc(W.error)}</p>` : "");
const defaultName = (p) => `${p?.name ?? W.pool} · ${t("window.flows.acct.account-n", { n: (p?.accounts.length ?? 0) + (W.saved ? 0 : 1) })}`;

function step3() {
  const p = poolById(W.pool);
  const name = W.name || W.saved?.label || defaultName(p);
  const quick = [t("window.flows.acct.personal"), t("window.flows.acct.work"), t("window.flows.acct.side-project")].map((x) => `<button class="chip6" type="button" data-act="aa-nm" data-v="${esc(`${p?.name ?? W.pool} · ${x}`)}">${esc(x)}</button>`).join("");
  /* A sign-in is never used for a Trunk (src/trunks/accounts.ts), so for a sign-in connection the chips are greyed. */
  const keyPool = p?.kind === "api-key";
  const who = [["anyone", t("window.flows.acct.anyone")], ...E.trunks.map((tr) => [tr.id, tr.name])]
    .map(([id, l]) => `<button class="chip6" type="button" data-act="aa-tr" data-v="${esc(id)}" aria-pressed="${keyPool && W.trunks.includes(id)}" ${keyPool ? "" : 'disabled aria-disabled="true"'}>${esc(l)}</button>`).join("");
  const pos = [["first", t("window.flows.acct.first")], ["last", t("window.flows.acct.last")]].map(([v, l]) => `<button type="button" data-act="aa-pos" data-v="${v}" aria-pressed="${W.pos === v}">${l}</button>`).join("");
  const head = W.saved ? `<div class="prow" data-css="border:0;padding:0 0 8px">${logo(W.pool, p?.name, 36)}<span class="grow"><b>${esc(W.saved.label)}</b><small>${esc(p?.name ?? W.pool)}</small></span></div>` : "";
  return `${head}<label class="fld"><span>${t("window.flows.acct.call-it")}</span><input class="inp" id="aa-name" value="${esc(name)}" maxlength="40" autocomplete="off"></label>
    <div class="fld"><span>${t("window.flows.acct.quick-names")}</span><span class="acts" data-css="gap:6px">${quick}</span></div>
    <div class="fld"><span>${t("window.flows.acct.which-trunks")}</span><span class="acts" data-css="gap:6px">${who}</span></div>
    <div class="ctl"><b>${t("window.flows.acct.order")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.flows.acct.order")}">${pos}</span></span><small>${t("window.flows.acct.order-hint")}</small></div>
    <div class="ctl"><b>${t("window.flows.acct.run-low")}</b><input class="sw" type="checkbox" id="aa-low" aria-label="${t("window.flows.acct.run-low")}" data-sw="set"><small>${t("window.flows.acct.run-low-hint")}</small></div>${errorLine()}`;
}

/* A connection its first sign-in just made: it is the connection's own first account, so there is nothing to name or
   place yet (renaming it would switch several accounts per connection on). */
function firstBody() {
  const first = poolById(W.pool)?.accounts?.[0];
  return `<div class="prow" data-css="border:0;padding:0 0 8px">${logo(W.pool, W.first, 36)}<span class="grow"><b>${esc(W.first)}</b><small>${esc(first?.label ?? "")}</small></span><span class="pill ok"><i></i>${t("layout.connected")}</span></div><p class="hint">${t("window.flows.acct.more-later")}</p>`;
}

const planName = () => (W.plan.kind === "chatgpt" ? "ChatGPT" : W.plan.kind === "gemini" ? "Gemini" : SI.view?.programs?.find((x) => x.id === W.plan.id)?.label ?? W.plan.id);
const dots = (n) => `<div class="wiz-dots">${[1, 2, 3].map((i) => `<i class="${i <= n ? "wz" : ""}"></i>`).join("")}</div>`;

export function draw() {
  if (W.plan) return openDlg({ title: t("window.flows.acct.add-a", { name: planName() }), body: dots(2) + planBody(), foot: planFoot() });
  if (W.first) return openDlg({ title: t("window.flows.acct.add-a", { name: W.first }), body: dots(3) + firstBody(),
    foot: `<button class="btn pri" type="button" data-act="aa-fin">${t("window.flows.acct.done")}</button>` });
  const p = poolById(W.pool);
  const body = W.step === 1 ? step1() : W.step === 2 ? step2() : step3();
  const foot = W.step === 1 ? `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button>`
    : W.step === 2 ? `<button class="btn ghost" type="button" data-act="aa-back">${t("action.back")}</button><button class="btn pri" type="button" data-act="aa-key">${t("window.flows.acct.add-key")}</button>`
    : `<button class="btn ghost" type="button" data-act="aa-back">${t("action.back")}</button><button class="btn pri" type="button" data-act="aa-done">${t("window.flows.acct.add-account")}</button>`;
  openDlg({ title: W.step === 1 ? t("window.flows.acct.add-an-account") : t("window.flows.acct.add-a", { name: p?.name ?? W.service?.name ?? W.pool }), body: dots(W.step) + body, foot, wide: W.step === 1 });
}

/* Step 1 draws from the engine's list and catalogue, read fresh each time the wizard opens. */
async function open(pool = null) {
  S.addAcct = true;
  stopPolling();
  Object.assign(W, { step: 1, pool: null, service: null, extras: {}, group: "all", q: "", saved: null, name: "", trunks: [], pos: "last", error: "", ...FRESH });
  const [, catalog] = await Promise.all([loadAccounts(), api("connections/catalog").catch((error) => { toast(error.message); return null; }), loadSignIns()]);
  A.catalog = catalog?.services ?? [];
  if (pool && poolById(pool)) return pick(pool);
  draw();
}

function pick(pool) {
  const p = poolById(pool);
  Object.assign(W, { pool, step: p?.kind === "api-key" ? 2 : 3, saved: null, name: "", error: "" });
  draw();
}

/* Several accounts per connection ships off (src/accounts/settings.ts). Adding one from the window is asking for it, so
   the switch goes to "when-needed" first when it is off, the way the chat-app wizard switches channel setup on.
   POST /api/accounts/settings takes only { mode } (ModeSchema is strict); the rest of the list is kept as it is. */
async function switchOn() {
  if ((await api("accounts")).mode === "off") await api("accounts/settings", { mode: "when-needed" });
}

/* A catalogue service with no connection yet (the "signin" card), routed by how the service really signs in: every
   cloud service in the catalogue takes a key (src/provider-catalog.ts authStyles), so it opens the key step; one that
   takes none is added at once. Either way it is POST /api/connections/from-preset, which checks the key by using it
   before anything is saved and keeps it in the locker. No catalogue service signs in on its own site. */
function pickService(id) {
  const service = (A.catalog ?? []).find((x) => x.id === id);
  if (!service) return;
  Object.assign(W, { pool: service.id, service, extras: {}, saved: null, name: "", error: "" });
  if (service.auth === "none") return addService("");
  W.step = 2;
  draw();
}

/* The key (and any extras) go to the engine at once; the key field is emptied first and the key kept nowhere. Once the
   engine has made the connection, step 3 names it and places it like any other account. */
async function addService(key) {
  keepExtras();
  const extras = Object.fromEntries(Object.entries(W.extras).filter(([, v]) => String(v).trim()));
  try {
    const made = await api("connections/from-preset", { provider: W.service.id, key, extras });
    await loadAccounts();
    Object.assign(W, { pool: made.id, service: null, extras: {}, saved: poolById(made.id)?.accounts?.[0] ?? null, step: 3, error: "" });
  } catch (error) { W.error = error.message; }
  draw();
}

/* The key goes to the engine at once, under the account's first name; step 3 renames it if asked. */
async function addKey() {
  const field = $("#aa-key");
  if (W.service) { const typed = field?.value ?? ""; if (field) field.value = ""; return addService(typed); }
  const value = field?.value ?? "";
  if (field) field.value = "";
  const p = poolById(W.pool);
  try {
    await switchOn();
    const answer = await api("accounts/add", { pool: W.pool, label: defaultName(p), key: value });
    W.saved = answer.accounts?.[answer.accounts.length - 1] ?? null;
    W.step = 3;
    W.error = "";
  } catch (error) { W.error = error.message; }
  await loadAccounts();
  draw();
}

const keepName = () => { const v = $("#aa-name")?.value; if (v !== undefined) W.name = v; };

/* Adds the account (a sign-in or program connection) or renames the one just added, then applies the draft. */
async function finish() {
  keepName();
  const label = (W.name || W.saved?.label || defaultName(poolById(W.pool))).trim().slice(0, 40);
  try {
    let view;
    if (W.saved) view = W.saved.label === label ? await loadAccounts().then(() => poolById(W.pool)) : await api("accounts/update", { pool: W.pool, account: W.saved.id, label });
    else { await switchOn(); view = await api("accounts/add", { pool: W.pool, label }); }
    const account = W.saved ?? view.accounts?.[view.accounts.length - 1];
    if (!account) return;
    const placed = await place(account.id, view);
    await useInTrunks(account.id);
    /* A sign-in account is only half made until it signs in: ChatGPT by its code, a program by its own line. It is kept
       as W.saved first, so asking again after a failed start signs the same account in rather than adding another. */
    const kind = poolById(W.pool)?.kind ?? view.kind;
    if (kind === "chatgpt" || kind === "cli") { W.saved = account; await loadAccounts(); }
    if (kind === "chatgpt" && !poolById(W.pool)?.signedIn?.[account.id]) return signInExtraChatGPT(account.id, label);
    if (kind === "cli") return signInExtraProgram(W.pool, placed.accounts?.find((a) => a.id === account.id) ?? account);
    closeDlg();
    S.addAcct = null;
    toast(placed.defaultAccount === account.id ? t("window.flows.acct.added-first", { name: label }) : t("window.flows.acct.added-last", { name: label }));
  } catch (error) { W.error = error.message; draw(); }
  await loadAccounts();
}

/* "First" moves it up one place at a time (the engine moves one place per request) until nothing is above it. */
async function place(id, view) {
  let current = view;
  if (W.pos !== "first") return current;
  for (let i = current.accounts.findIndex((a) => a.id === id); i > 0; i--) current = await api("accounts/update", { pool: W.pool, account: id, move: "up" });
  return current;
}

/* Which Trunks use it: each chosen Trunk's keys.accounts names this account for this connection (POST /api/trunks/<id>
   replaces the whole keys object, so the rest of it is carried over from the Trunk as the engine has it now). */
async function useInTrunks(id) {
  if (poolById(W.pool)?.kind !== "api-key") return;
  for (const trunkId of W.trunks.filter((id) => id !== "anyone")) {
    const { trunk } = await api(`trunks/${encodeURIComponent(trunkId)}`);
    const keys = trunk?.keys ?? { copyFromOwner: true, accounts: {} };
    await api(`trunks/${encodeURIComponent(trunkId)}`, { keys: { copyFromOwner: keys.copyFromOwner, accounts: { ...keys.accounts, [W.pool]: id } } });
  }
}

function toggleTrunk(v) {
  if (poolById(W.pool)?.kind !== "api-key") return;
  keepName();
  W.trunks = W.trunks.includes(v) ? W.trunks.filter((x) => x !== v) : [...W.trunks, v];
  draw();
}

/* Search keeps the caret where it was while the list redraws. */
function onSearch(e) {
  if (e.target.id !== "aa-q" || !dialog()) return;
  W.q = e.target.value;
  const at = e.target.selectionStart;
  draw();
  const box = $("#aa-q");
  box?.focus();
  box?.setSelectionRange(at, at);
}

export function openAddAcct(pool = null) { return open(pool); }

export function init() {
  initLocalPick();
  markLive(["sw:aa-q", "sw:aa-key", "sw:aa-name", "sw:aaextra", "signin", "addacct", "aa-prov", "aa-back", "aa-done", "aa-key", "aa-grp", "aa-nm", "aa-tr", "aa-pos", "aa-local", "aa-gone", "acct-menu", "acct-first", "acct-out", "aa-plan", "aa-dev", "aa-chk", "aa-cli", "aa-goo", "aa-fin"]);
  initSignIns(on);
  on("addacct", (el) => open(el.dataset.v || null));
  on("aa-prov", (el) => pick(el.dataset.v));
  on("aa-back", () => { stopPolling(); Object.assign(W, { step: 1, pool: null, service: null, extras: {}, saved: null, name: "", error: "", ...FRESH }); draw(); });
  on("signin", (el) => pickService(el.dataset.v)); // unhold/people: the catalogue cards
  on("aa-key", () => addKey());
  on("aa-done", () => finish());
  on("aa-grp", (el) => { W.group = el.dataset.v; draw(); });
  on("aa-nm", (el) => { const box = $("#aa-name"); if (box) box.value = el.dataset.v; W.name = el.dataset.v; });
  on("aa-tr", (el) => toggleTrunk(el.dataset.v));
  on("aa-pos", (el) => { keepName(); W.pos = el.dataset.v; draw(); });
  on("aa-local", () => { closeDlg(); S.addAcct = null; S.view = "settings"; S.setPage = "local"; render(); });
  on("aa-gone", (el) => { const s = (A.catalog ?? []).find((x) => x.id === el.dataset.v); if (s) toast(s.terms?.warning || s.note || t("window.flows.acct.retired-toast")); });
  on("acct-menu", (el) => openAccountMenu(el));
  on("acct-first", (el) => answerFirst(el));
  on("acct-out", (el) => signOut(el));
  document.addEventListener("input", onSearch);
}

export { closeDlg };
