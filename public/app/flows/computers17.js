/* Pass 17 part D §9 (and the greyed §1 cloud pieces beside it): the computers a Trunk may use, 1:1 with the prototype's
   patch17d.js. Every computer is the engine's: This computer and the owner's paired computers (GET /api/devices, a
   phone is never one). A Trunk's list and its "At once" are GET/POST /api/trunks/<id>/computers, which replaces both;
   with nothing saved every computer is allowed and there is no limit, so no "At once" is pressed. A conversation's
   computer is GET /api/devices/pick/<conversation> and POST /api/devices/pick (the engine refuses one its Trunk may not
   use). Branch's own conversations have no list, so their menu has no "Allowed for" part.
   - the Trunk editor's "Its computers" tab (itsTab), Settings › Computer's "Which Trunk uses which" (trunkRow17), and
     the full-size view's computer menu (pickChip, the comp-pick popover);
   - a cloud computer needs an outside provider account Branch does not have, so its offer cards stay greyed.
   Parity B2: the menu lists the KeepOak computer drawn disabled with the prototype's "Connect keepoak.com first" (the
   engine has no keepoak.com computer until that account exists), and the full-size view reads the conversation's list
   and computer through `computersOf` and picks one through `pickFor` (its tab per computer). */

import { esc, render } from "../core/dom.js";
import { E, S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, av, toast, openPop, closePop, mi, radio } from "../core/ui.js";
import { t } from "../../i18n.js";
import { art17Slot } from "../core/art17.js"; // the prototype's SPOTS17: the cloud picture in the offer
import { initDaytona } from "./daytona.js";

const DESKTOP = ["win32", "darwin", "linux"];
const PLATFORM = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const C = { devices: null, views: new Map(), picks: new Map(), listeners: [], asked: new Set() };

/** Every computer, This computer first; the prototype's own words for This computer. */
export function computers() {
  const paired = (C.devices ?? []).filter((d) => DESKTOP.includes(d.platform))
    .map((d) => ({ id: d.id, name: d.name, os: PLATFORM[d.platform] ?? d.platform, icon: d.platform === "darwin" ? "mac" : "monitor" }));
  return [{ id: "this", name: t("dashboard.computer.title"), os: t("window.settings.computer.your-windows-desktop"), icon: "monitor" }, ...paired];
}
const computerOf = (id) => computers().find((c) => c.id === id);
const trunkName = (id) => E.trunks.find((t) => t.id === id)?.name ?? "";

/** Tells the Trunk editor (and anything else drawn outside #main) that a list changed. */
export function onChange(fn) { C.listeners.push(fn); }
const changed = () => { render(); for (const fn of C.listeners) fn(); };

async function loadDevices() {
  const got = await api("devices").catch((error) => { toast(error.message); return null; });
  C.devices = got?.devices ?? [];
}
async function loadView(id) {
  const view = await api(`trunks/${encodeURIComponent(id)}/computers`).catch((error) => { toast(error.message); return null; });
  if (view) C.views.set(id, view);
  return view;
}
/** Reads the computers and every Trunk's list again (Settings › Computer, the Trunk editor). */
export async function loadAll() {
  if (E.profiles?.isOwner === false) return; // the owner's computers: the engine refuses anyone else
  await loadDevices();
  await Promise.all(E.trunks.map((t) => loadView(t.id)));
  changed();
}
export const viewOf = (id) => C.views.get(id) ?? null;

/* Replaces a Trunk's list and limit; the engine's answer is what is drawn next. */
async function save(id, allowed, atOnce) {
  try {
    const view = await api(`trunks/${encodeURIComponent(id)}/computers`, { allowed, atOnce });
    C.views.set(id, view);
    for (const [sid, pick] of C.picks) if (pick.trunkId === id) C.picks.delete(sid);
    changed();
    return view;
  } catch (error) { toast(error.message); return null; }
}
/* Adding a computer keeps the limit where the owner set it; a shorter list brings it down (patch17d toggleComp). */
async function toggle(id, cid) {
  const view = C.views.get(id) ?? await loadView(id);
  if (!view) return null;
  const allowed = view.allowed.includes(cid) ? view.allowed.filter((x) => x !== cid) : [...view.allowed, cid];
  const atOnce = view.atOnce === null ? null : Math.max(1, Math.min(view.atOnce, allowed.length || 1));
  return save(id, allowed, atOnce);
}

/* ---------- the Trunk editor's "Its computers" tab ---------- */
export function itsTab(id) {
  const view = C.views.get(id);
  if (!view) { if (!C.asked.has(id)) { C.asked.add(id); loadAll(); } return '<div class="its17d"></div>'; }
  const on = view.allowed, max = view.atOnce;
  const rows = computers().map((x) => `<label class="ic-row17d"><input type="checkbox" data-sw="itsc17d" data-id="${esc(id)}" data-v="${esc(x.id)}" ${on.includes(x.id) ? "checked" : ""} aria-label="${esc(t("window.p17d.may-use", { name: trunkName(id), computer: x.name }))}"><span class="ico-tile">${ic(x.icon, "s")}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.os)}</small></span></label>`).join("");
  const nums = [1, 2, 3, 4].map((n) => `<button type="button" data-act="itsmax17d" data-id="${esc(id)}" data-v="${n}" aria-pressed="${max === n}" ${n > Math.max(1, on.length) ? "disabled" : ""}>${n}</button>`).join("");
  const first = on.length ? on.slice(0, 3).map((cid, i) => `<button type="button" data-act="itsfirst17d" data-id="${esc(id)}" data-v="${esc(cid)}" aria-pressed="${i === 0}">${esc(computerOf(cid)?.name ?? "")}</button>`).join("")
    : `<button type="button" disabled aria-pressed="false">${t("window.p17d.no-computer")}</button>`;
  return `<div class="its17d"><p class="hint" data-css="margin:0">${esc(t("window.p17d.its-hint", { name: trunkName(id) }))}</p>
    <div class="ic-list17d">${rows}</div>
    <div class="ic-ctl17d"><span><b>${t("window.settings.computer.at-once")}</b><small>${t("window.p17d.at-once-hint")}</small></span><span class="seg">${nums}</span></div>
    <div class="ic-ctl17d"><span><b>${t("window.p17d.starts-on")}</b><small>${t("window.p17d.starts-on-hint")}</small></span><span class="seg">${first}</span></div>
    ${cloudOffer(esc(t("window.p17d.cloud-own", { name: trunkName(id) })), t("window.p17d.cloud-own-hint"), id)}</div>`;
}

/* The cloud offer: a cloud computer is made and billed by an outside provider Branch has no account with, so Set one up
   stays greyed (cloudnew17d has no handler). */
function cloudOffer(title, sub, id = "") {
  return `<div class="cl-offer17d has-art17e" role="note"><span class="ico-tile ico17e">${ic("cloud17d", "s")}</span>${art17Slot("art17-cloud", false, "spot17e tile17e")}<span class="grow"><b>${title}</b><small>${sub}</small></span><button class="btn sm" type="button" data-act="cloudnew17d"${id ? ` data-id="${esc(id)}"` : ""}>${t("window.places.automations17.set-one-up")}</button></div>`;
}
/** Settings › Computer, above Add a computer, while no cloud computer exists (none can, in this build). */
export const settingsCloudOffer = () => cloudOffer(t("window.p17d.cloud-offer"), t("window.p17d.cloud-offer-hint"));

/* ---------- Settings › Computer: Which Trunk uses which ---------- */
export function trunkRow17(trunk) {
  const id = esc(trunk.id), view = C.views.get(trunk.id);
  const chips = view ? computers().map((x) => `<button type="button" class="chip6" data-act="comp-chip" data-id="${id}" data-v="${esc(x.id)}" aria-pressed="${view.allowed.includes(x.id)}">${esc(x.name)}</button>`).join("") : "";
  const nums = [1, 2, 3, 4].map((n) => `<button type="button" data-act="comp-max" data-id="${id}" data-v="${n}" aria-pressed="${view?.atOnce === n}">${n}</button>`).join("");
  return `<div class="prow percomp8">${av(trunk, 32)}<span class="grow"><b>${esc(trunk.name ?? "")}</b><span class="chips8">${chips}</span></span><label class="max8"><small>${t("window.settings.computer.at-once")}</small><span class="seg">${nums}</span></label></div>`;
}

/* ---------- the full-size view's computer menu ---------- */
async function loadPick(sid) {
  const pick = await api(`devices/pick/${encodeURIComponent(sid)}`).catch((error) => { toast(error.message); return null; });
  if (!pick) return null;
  if (!C.devices) await loadDevices();
  C.picks.set(sid, pick);
  render();
  return pick;
}
/* What the conversation may pick from, and what it uses: its pick, else its Trunk's first computer, else This computer. */
function pickState(sid) {
  const pick = C.picks.get(sid);
  if (!pick) return null;
  const list = pick.allowed ? pick.allowed.map(computerOf).filter(Boolean) : computers();
  const using = pick.picked ?? list[0]?.id ?? "this";
  return { pick, list, using };
}
/** What the conversation may pick from and the computer it uses ({ list, using }), once the engine has said; the first
    call asks. Null for anyone but the owner: the owner's computers are the owner's (GET /api/devices refuses anyone else). */
export function computersOf(sid) {
  if (E.profiles?.isOwner === false || !sid) return null;
  const st = pickState(sid);
  if (!st && !C.picks.has(sid)) { C.picks.set(sid, null); loadPick(sid); }
  return st;
}
export const computerNamed = (id) => computerOf(id) ?? null;
/** The chip beside the computer's name at the top of the full-size view; drawn once the engine has said. */
export function pickChip(sid) {
  const st = computersOf(sid);
  if (!st) return "";
  const one = computerOf(st.using);
  const label = st.list.length > 1 ? `${ic("layers", "s")}${esc(t("window.p17d.n-computers", { count: st.list.length }))}` : `${ic(one?.icon ?? "monitor", "s")}${esc(one?.name ?? "")}`;
  return `<button class="st7-pick" type="button" data-act="comp-pick">${label}${ic("down", "s")}</button>`;
}
function pickMenu(sid) {
  const st = pickState(sid);
  if (!st) return "";
  const { pick, list, using } = st, trunkId = pick.trunkId;
  const max = pick.atOnce;
  const limit = trunkId && max !== null ? `<p class="pp comp-max17d">${esc(list.length > max ? t("window.p17d.up-to-of", { max, count: list.length }) : t("window.p17d.up-to", { max }))} <button class="link" type="button" data-act="edit" data-id="${esc(trunkId)}">${t("window.settings.voice.change")}</button></p>` : "";
  const here = list.length ? `<div class="ph">${t("window.p17d.conversation-uses")}</div>${list.map((x) => radio("convcomp17d", x.id, esc(x.name), esc(x.os), using === x.id)).join("")}${limit}<hr>` : "";
  const allowed = trunkId ? `<div class="ph">${esc(t("window.p17d.allowed-for", { name: trunkName(trunkId) }))}</div>${computers().map((x) => `<button class="mi" type="button" role="menuitemcheckbox" aria-checked="${(pick.allowed ?? computers().map((c) => c.id)).includes(x.id)}" data-act="comp-toggle" data-v="${esc(x.id)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${esc(x.name)}</span><span class="mi-s">${esc(x.os)}</span></span></button>`).join("")}<hr>` : "";
  // The KeepOak row goes with the Trunk's list, or with the conversation's own when it has no Trunk (Branch's own).
  const withKo = allowed ? here + allowed.replace(/<hr>$/, keepOak("menuitemcheckbox") + "<hr>") : here.replace(/<hr>$/, keepOak("menuitemradio") + "<hr>");
  return withKo + mi("comp-add", "plus", t("window.flows.comp.add")) + mi("setgo", "gear", t("window.p17d.manage-computers"), "", 'data-v="computer"');
}
/* The prototype's KeepOak row: a computer on keepoak.com, which needs that account first (none exists in the engine). */
const keepOak = (role) => `<button class="mi" type="button" role="${role}" aria-checked="false" aria-disabled="true" disabled><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${t("window.settings.computer.keepoak-computer")}</span><span class="mi-s">${t("window.p17d.keepoak-first")}</span></span></button>`;

/** The conversation uses this computer from now on (the engine refuses one its Trunk may not use); true once it does. */
export async function pickFor(sid, v) {
  try {
    await api("devices/pick", { sessionId: sid, deviceId: v });
    await loadPick(sid);
    return true;
  } catch (error) { toast(error.message); return false; }
}
async function pickComputer(el) {
  const v = el.dataset.v;
  closePop();
  if (await pickFor(S.chat, v)) toast(t("window.p17d.conversation-uses-now", { name: computerOf(v)?.name ?? "" }));
}
async function toggleHere(el) {
  const sid = S.chat, pick = C.picks.get(sid);
  if (!pick?.trunkId) return;
  const view = await toggle(pick.trunkId, el.dataset.v);
  if (!view) return;
  await loadPick(sid);
  const anchor = document.querySelector(".st7-pick");
  if (anchor) openPop(anchor, pickMenu(sid), { force: true });
  const n = view.allowed.length;
  toast(t(n === 0 ? "window.p17d.may-use-none" : n === 1 ? "window.p17d.may-use-one" : "window.p17d.may-use-many", { name: trunkName(pick.trunkId), count: n }));
}

async function setMax(el) {
  const id = el.dataset.id, n = +el.dataset.v;
  const view = C.views.get(id) ?? await loadView(id);
  if (!view || !await save(id, view.allowed, n)) return;
  toast(t(n === 1 ? "window.p17d.may-run-one" : "window.p17d.may-run-many", { name: trunkName(id), count: n }));
}
async function setFirst(el) {
  const id = el.dataset.id, view = C.views.get(id);
  if (!view) return;
  await save(id, [el.dataset.v, ...view.allowed.filter((x) => x !== el.dataset.v)], view.atOnce);
}

export function init() {
  initDaytona();
  markLive(["sw:itsc17d", "itsmax17d", "itsfirst17d", "comp-chip", "comp-max", "comp-pick", "convcomp17d", "comp-toggle"]);
  on("itsmax17d", (el) => setMax(el));
  on("comp-max", (el) => setMax(el));
  on("itsfirst17d", (el) => setFirst(el));
  on("comp-chip", (el) => toggle(el.dataset.id, el.dataset.v));
  on("comp-pick", (el) => { const html = pickMenu(S.chat); if (html) openPop(el, html); });
  on("convcomp17d", (el) => pickComputer(el));
  on("comp-toggle", (el) => toggleHere(el));
  document.addEventListener("change", (e) => {
    const box = e.target;
    if (box.dataset?.sw !== "itsc17d") return;
    toggle(box.dataset.id, box.dataset.v);
  });
}
