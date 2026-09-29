/* A Trunk, changed from the window (design doc 5.7): the Trunk editor, the Trunk's own menu items (pin, rename, remove),
   starting a Trunk from a job, and a new room. Every change goes to the engine's Trunk routes (src/trunks/api.ts):
   POST /api/trunks/{id} merges the fields it is given, but `look` is replaced whole, so the full look is always sent.
   What it may do (the permission switches) stays greyed: loosening a Trunk is not done from here. */

import { $, esc, onRender } from "../core/dom.js";
import { openDlg, closeDlg, openPop, closePop, toast, ic, av, mi, COLOURS, SHAPE_NAMES, hex, faceOf, dialog } from "../core/ui.js";
import { S, E, refresh, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { initPause } from "./pause.js";
import { init as initShare } from "./share.js";
import { looks17, look17, NEW17 } from "../core/art17.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";
import { trunkCanUse, trunkModelNote } from "../places/switch-on.js"; // stress test B008
import { itsTab, onChange as computersChanged } from "./computers17.js"; // pass 17 part D §9: Its computers
import { loadAccounts, poolById } from "./account.js"; // models-ui: account names as Settings › Accounts shows them
import { logo } from "../core/logos.js";
import { gsel } from "../core/gsel.js";

/* The prototype's colours and shapes (COLOURS, SHAPES, SHAPE_NAMES) are kept beside av() in core/ui.js. */
/* The prototype's Bob is the engine's sway (the engine has no bob). */
const MOTIONS = [["none", "comfort.placeholder.none"], ["breathe", "studio.motion.breathe"], ["sway", "window.flows.trunk.bob"]];
/* The prototype's eyes; the engine keeps them beside the look (src/trunks/record.ts eyes; null is round). */
const EYES = [["round", "window.flows.trunk.round"], ["wide", "onscreen.width.wide"], ["sleepy", "window.flows.trunk.sleepy"]];
const EMOJI = ["🦊", "🦉", "🐢", "🍄", "🌿", "🐝", "🦔", "🐙", "🌻", "🪴", "🐧", "🦜"];
const LOOK = { face: "pattern", letters: "", emoji: "", shuffle: 0, colour: null, shape: null, motion: "none", depth: "flat" };
/* The prototype's jobs: name, what it does, colour, shape. Kept in English here, since Customize lists them too; the
   Trunk made from one is named in the language in force, from TEMPLATE_WORDS (the same jobs, in the same order). */
export const TEMPLATE_WORDS = [["window.flows.tmpl.inbox", "window.flows.tmpl.inbox-job"], ["window.flows.tmpl.expense", "window.flows.tmpl.expense-job"], ["window.flows.tmpl.researcher", "window.flows.tmpl.researcher-job"], ["window.flows.tmpl.chief", "window.flows.tmpl.chief-job"], ["window.flows.tmpl.bug", "window.flows.tmpl.bug-job"], ["window.flows.tmpl.trip", "window.flows.tmpl.trip-job"]];
export const TEMPLATES = [["Inbox Manager", "Clears your inbox and drafts replies in your voice", "#4F6FA8", 0], ["Expense Manager", "Files receipts and builds monthly reports", "#D8612A", 2], ["Researcher", "Reads the web and writes short briefs with sources", "#2F8C86", 1], ["Chief of Staff", "Plans your week and chases loose ends", "#56616B", 3], ["Bug Reproduction", "Turns a bug report into exact steps", "#B84A6B", 4], ["Trip Planner", "Finds and books refundable travel", "#8A5AA8", 3]];

export const lookOf = (tr) => ({ ...LOOK, ...(tr?.look ?? {}) });
/* What av() draws from, the same face wherever a Trunk is drawn (core/ui.js faceOf). */
export const face = faceOf;
const trunkById = (id) => E.trunks.find((tr) => tr.id === id);
const trunkOfChat = (sid = S.chat) => E.trunks.find((tr) => tr.chatSessionId === sid);
let rooms = [];
const roomOfChat = (sid = S.chat) => rooms.find((r) => r.sessionId === sid);
/* The Trunk or room whose own conversation this is, for the list's row menu (shell/shell.js). */
export const chatOwner = (sid) => trunkOfChat(sid) ?? roomOfChat(sid) ?? null;

async function loadRooms() {
  const answer = await api("trunks");
  rooms = Array.isArray(answer?.rooms) ? answer.rooms : [];
}
/** trunk-rooms-live: the rooms read again after a room was made or changed elsewhere in the window (flows/roomwith.js). */
export const roomsChanged = () => loadRooms();

function openChat(sessionId) {
  const el = document.createElement("button");
  el.dataset.id = sessionId;
  run("chat", el);
}

/* ---------- the editor ---------- */
let ed = null;

function keepFields() {
  const n = $("#st-name"), r = $("#st-role");
  if (n) ed.d.name = n.value;
  if (r) ed.d.title = r.value;
  for (const box of document.querySelectorAll("[data-personality-file]")) {
    const file = ed.files?.find((file) => file.name === box.dataset.personalityFile);
    if (file) file.text = box.value;
  }
}

function filesTab() {
  markLive((ed.files ?? []).map((file) => `sw:personality-${file.name}`));
  return (ed.files ?? []).map((file) => `<div class="field"><label for="personality-${esc(file.name)}">${esc(file.name)}</label><small class="hint">${esc(file.hint)}</small><textarea class="inp" id="personality-${esc(file.name)}" data-personality-file="${esc(file.name)}" rows="6" maxlength="8000">${esc(file.text)}</textarea><button class="btn sm" type="button" data-act="trunk-file-save" data-name="${esc(file.name)}">${t("action.save")}</button></div>`).join("");
}

/* The pebble as this editor would save it: the draft's colour, shape, eyes and motion over the saved face. */
function draftFace(tr, change = {}) {
  const d = ed.d;
  return { ...face(tr), name: d.name, color: d.colour ?? face(tr).color, shape: d.shape ?? face(tr).shape, eyes: d.eyes, motion: d.motion, ...change };
}

/* What the face is, in av()'s own order (core/ui.js): its photo, else its character, else its emoji, else the classic
   pebble. The Look tab shows only what that face is drawn with: the pebble takes its colour, shape, eyes and how it moves;
   an emoji or a photo sits on the pebble's colour and shape and moves with it, with no eyes; a character acts out what the
   Trunk is doing and takes only the colour of the glow behind it (app.css .av.look12). What is not shown keeps its value. */
const USES = { pebble: ["colour", "shape", "moves", "eyes"], character: ["colour"], emoji: ["colour", "shape", "moves"], photo: ["colour", "shape", "moves"] };
function kindOf(tr) {
  const f = face(tr);
  if (f.photo) return "photo";
  if (f.lookStill || look17(f.character)) return "character";
  return f.emoji ? "emoji" : "pebble";
}
const uses = (tr, what) => USES[kindOf(tr)].includes(what);

function lookTab(tr, d) {
  const swatches = COLOURS.map((c) => `<button class="swatch" type="button" data-css="background:${c}" aria-label="${t("window.flows.trunk.colour-c", { c })}" aria-pressed="${hex(c) === d.colour}" data-act="st-colour" data-v="${c}"></button>`).join("");
  /* Each shape drawn as av() draws it: the pebble in the Trunk's own colour, still, with no photo, character or emoji over it. */
  const bare = { photo: null, character: null, lookStill: null, emoji: "", motion: "none", paused: false };
  const shapes = SHAPE_NAMES.map((sh, i) => `<button class="shape" type="button" aria-label="${t("window.flows.trunk.shape-n", { n: i + 1 })}" aria-pressed="${sh === d.shape}" data-act="st-shape" data-v="${i}">${av(draftFace(tr, { ...bare, shape: sh }), 30)}</button>`).join("");
  const moves = MOTIONS.map(([v, l]) => `<button type="button" data-act="st-anim" data-v="${v}" aria-pressed="${d.motion === v}">${t(l)}</button>`).join("");
  const eyes = EYES.map(([v, l]) => `<button type="button" data-act="st-eyes" data-v="${v}" aria-pressed="${d.eyes === v}">${t(l)}</button>`).join("");
  const row = (what, html) => (uses(tr, what) ? html : "");
  return `<div class="split" data-css="grid-template-columns:1fr 1fr"><div class="field"><label for="st-name">${t("accounts.field.name")}</label><input class="inp" id="st-name" value="${esc(d.name)}"></div><div class="field"><label for="st-role">${t("window.flows.trunk.for")}</label><input class="inp" id="st-role" value="${esc(d.title)}"></div></div>
    ${row("colour", `<div class="field"><label>${t("studio.colour")}</label><div class="swatches">${swatches}</div></div>`)}
    ${row("shape", `<div class="field"><label>${t("studio.shape")}</label><div class="shapes">${shapes}</div></div>`)}
    <div class="split" data-css="grid-template-columns:1fr 1fr">${photoField(tr)}${row("moves", `<div class="field"><label>${t("window.flows.trunk.moves")}</label><span class="seg">${moves}</span></div>`)}</div>
    ${row("eyes", `<div class="field"><label>${t("window.flows.trunk.eyes")}</label><span class="seg">${eyes}</span></div>`)}`;
}

/* ---------- a photo instead of a face: POST /api/trunks/{id}/avatar, which keeps a PNG, JPEG or WebP under about 290 KB
   and refuses anything else with its own words. Saved at once, as the character and the emoji are; Remove, or choosing a
   character or an emoji, gives the face made from the name back ({ kind: "face" }). ---------- */
const PHOTO_BYTES = 290 * 1024;
function photoField(tr) {
  const photo = face(tr).photo;
  const thumb = photo ? `<span class="photo-thumb-tl">${av({ ...face(tr), motion: "none", paused: false }, 36)}</span>` : "";
  const remove = photo ? `<button class="btn sm ghost" type="button" data-act="st-photo-x">${t("accounts.action.remove")}</button>` : "";
  return `<div class="field"><label>${t("window.flows.trunk.photo")}</label><span class="photo-tl">${thumb}<button class="btn sm" type="button" data-act="st-photo">${t(photo ? "studio.photo.other" : "studio.photo.choose")}</button>${remove}</span><small class="hint photo-hint-tl">${t("studio.photo.note")}</small></div>`;
}
const readPicture = (file) => new Promise((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result));
  r.onerror = () => fail(r.error);
  r.readAsDataURL(file);
});
async function sendPhoto(file) {
  if (!file || !ed) return;
  /* Anything the request could not carry is refused here with the engine's own limit; the kind is the engine's to judge. */
  if (file.size > PHOTO_BYTES) { toast(t("studio.photo.large")); return; }
  keepFields();
  try {
    await api(`trunks/${encodeURIComponent(ed.id)}/avatar`, { kind: "image", dataUrl: await readPicture(file) });
    await refresh();
    if (ed) drawEditor();
  } catch (error) { toast(error.message); }
}
function pickPhoto() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/webp" });
  input.addEventListener("change", () => sendPhoto(input.files?.[0]));
  input.click();
}
/* The photo is taken off the face (the face made from the name comes back) through the route that removes it. */
const dropPhoto = (id) => api(`trunks/${encodeURIComponent(id)}/avatar`, { kind: "face", locked: false });
async function removePhoto() {
  keepFields();
  try {
    await dropPhoto(ed.id);
    await refresh();
    if (ed) drawEditor();
  } catch (error) { toast(error.message); }
}

/* Pass 17: the Look tab starts with the characters, as the prototype's does: the classic pebble, then every character in the
   engine's catalogue (core/art17.js looks17), Branch's spirit first; only pass 17's own are marked New, as the prototype's
   markNew17 does. Hovering one plays its idle loop. The engine keeps the choice (POST /api/trunks/{id} character; null is
   the classic pebble), saved at once. */
function lookPicker(tr) {
  const cur = tr.character ?? "classic";
  const pebble = `<button type="button" class="look-c12" data-act="look-set" data-id="${esc(tr.id)}" data-v="classic" aria-pressed="${cur === "classic"}"><span class="peb-demo12">${av({ ...draftFace(tr), photo: null, character: null, emoji: face(tr).emoji }, 56)}</span><b>${t("window.flows.trunk.pebble")}</b></button>`;
  const cards = looks17().map((l) => `<button type="button" class="look-c12${NEW17.has(l.id) ? " new17e" : ""}" data-act="look-set" data-id="${esc(tr.id)}" data-v="${esc(l.id)}" aria-pressed="${cur === l.id}"><img src="${esc(l.still)}" alt="" loading="lazy" draggable="false" data-hov="${esc(l.states.idle ?? "")}"><b>${esc(l.name)}</b></button>`).join("");
  return `<div class="sec"><h2>${t("window.flows.setup.looks")}</h2>${kindOf(tr) === "character" ? `<p class="hint" data-css="margin:0 0 8px">${t("window.flows.trunk.moves-hint")}</p>` : ""}
    <div class="looks12 looks-tl">${pebble}${cards}</div></div>`;
}
async function setCharacter(el) {
  const tr = trunkById(el.dataset.id), v = el.dataset.v;
  if (!tr) return;
  if (ed) keepFields();
  try {
    await api(`trunks/${encodeURIComponent(tr.id)}`, { character: v === "classic" ? null : v });
    /* A photo is drawn over any character, so choosing one takes the photo off: the card chosen is the face drawn. */
    if (v !== "classic" && face(tr).photo) await dropPhoto(tr.id);
    await refresh();
    if (ed?.id === tr.id) drawEditor();
    toast(v === "classic" ? t("window.flows.trunk.back-pebble") : t("window.flows.trunk.looks-like", { name: tr.name, look: look17(v)?.name }));
  } catch (error) { toast(error.message); }
}

function emojiRow(tr) {
  const cur = face(tr).emoji;
  return `<div class="emo15"><b>${t("window.flows.trunk.emoji-or")}</b><div class="emo-row15" role="radiogroup" aria-label="${t("window.flows.trunk.emoji")}">${EMOJI.map((e) => `<button type="button" role="radio" aria-checked="${cur === e}" data-act="emo15" data-v="${e}">${e}</button>`).join("")}${cur ? `<button type="button" class="emo-x15" data-act="emo15" data-v="">${t("comfort.placeholder.none")}</button>` : ""}</div></div>`;
}

const ctl = (id, title, sub) => `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" id="${id}" aria-label="${esc(title)}" data-sw="set"><small>${esc(sub)}</small></div>`;
const ctlSeg = (title, sub, opts) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map((o) => `<button type="button" aria-pressed="false" data-act="seg">${esc(o)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;

/* Which model: the engine's own presets (GET /api/state models.presets, by their names) in the window's ordinary select,
   saved at once as the Trunk's model (POST /api/trunks/{id} model, a preset id); Default ("") follows the conversation's
   model. A connection that answers through a sign-in is drawn greyed (a Trunk never uses one), with the reason and the
   way to add one it can use underneath (places/switch-on.js); so is the row with none a Trunk can use. */
function modelSeg(tr) {
  const models = E.state?.models, presets = models?.presets ?? [];
  const opts = [["", t("voice.default")], ...presets.map((p) => [p.id, p.name, !trunkCanUse(p)])];
  return `<div class="ctl tm-model18"><b>${t("window.flows.trunk.which-model")}</b><span class="right">${gsel({ id: "tm-model-sel", label: t("window.flows.trunk.which-model"), options: opts, value: tr.model ?? "", attrs: `data-id="${esc(tr.id)}"` })}</span><small>${t("window.flows.trunk.which-model-hint")}</small>${trunkModelNote(models)}</div>`;
}
async function setModel(el) {
  const tr = trunkById(el.dataset.id);
  if (!tr) return;
  keepFields();
  try {
    await api(`trunks/${encodeURIComponent(tr.id)}`, { model: el.value });
    await refresh();
    if (ed?.id === tr.id) drawEditor();
  } catch (error) { toast(error.message); }
}

/* ---------- Accounts: which account of each connection this Trunk answers with ----------
   The engine's own view (GET /api/trunks/{id}/keys, src/trunks/accounts.ts keyPlan): every connection that can have
   several accounts, the Trunk's pick for each, and keyPlan's plain notes about what it cannot use yet. An account is
   named as Settings › Accounts names it (GET /api/accounts, its verified email or name where the engine has one), else
   by the name the engine keeps. Each change is saved at once: POST /api/trunks/{id} replaces the whole keys object, so the
   Trunk is read fresh first and the rest of it carried over, as flows/account.js saveTrunks does. "Use my accounts too"
   is keys.copyFromOwner (on unless the owner turns it off); with it off, a connection with no pick does not answer. */
async function loadKeys(id) {
  try {
    const [keys, spend] = await Promise.all([api(`trunks/${encodeURIComponent(id)}/keys`),
      api(`trunks/${encodeURIComponent(id)}/spend`).catch(() => null), loadAccounts()]);
    if (ed?.id !== id) return;
    ed.keys = keys;
    ed.spend = spend;
    if (ed.tab === "accounts") drawEditor();
  } catch (error) { toast(error.message); }
}
const accountName = (pool, a) => poolById(pool)?.accounts?.find((x) => x.id === a.id)?.label || a.label || a.id;
/* Whether this connection is the Trunk's own model: a pool is named after its connection (a ChatGPT pool holds its models). */
const usesPool = (tr, pool) => !!tr.model && (tr.model === pool.id || (pool.id === "chatgpt" && tr.model.startsWith("chatgpt")));
function poolRow(tr, pool, keys) {
  const picked = keys.accounts[pool.id] ?? "", known = pool.accounts.some((a) => a.id === picked);
  const none = keys.copyFromOwner ? t("window.flows.trunk.acc-yours") : t("window.flows.trunk.acc-none");
  /* An account the accounts screen says cannot answer now (signed out, a duplicate, paused) is shown but cannot be taken. */
  const ready = (a) => poolById(pool.id)?.accounts?.find((x) => x.id === a.id)?.ready !== false;
  const options = [["", none], ...pool.accounts.map((a) => [a.id, ready(a) ? accountName(pool.id, a) : t("window.flows.trunk.acc-not-ready", { name: accountName(pool.id, a) }), !ready(a) && a.id !== picked])];
  const label = t("window.flows.trunk.acc-pick-for", { name: pool.label });
  const pick = gsel({ sw: "tk-pool", label, options, value: known ? picked : "", attrs: `data-tk-pool="${esc(pool.id)}" data-id="${esc(tr.id)}"` });
  /* Where it goes when its pick reaches its limit: one of the connection's other accounts, before the owner's own. */
  const then = keys.next?.[pool.id]?.[0] ?? "", others = options.filter(([v]) => v && v !== picked);
  const next = known && others.length ? `<span class="tk-then"><small>${t("window.flows.trunk.acc-then")}</small>${gsel({ sw: "tk-next", label: t("window.flows.trunk.acc-then-for", { name: pool.label }),
    options: [["", keys.copyFromOwner ? t("window.flows.trunk.acc-yours") : t("window.flows.trunk.acc-then-stop")], ...others], value: then, attrs: `data-tk-next="${esc(pool.id)}" data-id="${esc(tr.id)}"` })}</span>` : "";
  const using = usesPool(tr, pool) ? `<span class="pill ok tk-uses">${t("window.flows.trunk.acc-answers-with")}</span>` : "";
  return `<div class="ctl tk-pool"><b>${logo(pool.id, pool.label, 20)} ${esc(pool.label)} ${using}</b><span class="right">${pick}${next}</span><small></small></div>`;
}
function accountsTab(tr) {
  const view = ed.keys;
  if (!view) return `<p class="hint">${t("window.flows.trunk.acc-reading")}</p>`;
  const keys = view.keys ?? { copyFromOwner: true, accounts: {} };
  const copy = `<div class="ctl"><b>${t("window.flows.trunk.acc-copy")}</b><input class="sw" type="checkbox" id="tk-copy" data-id="${esc(tr.id)}" ${keys.copyFromOwner ? "checked" : ""} aria-label="${esc(t("window.flows.trunk.acc-copy"))}"><small>${t("window.flows.trunk.acc-copy-hint")}</small></div>`;
  const notes = [view.note, ...(view.plan?.notes ?? [])].filter(Boolean).map((n) => `<li>${esc(n)}</li>`).join("");
  /* The model and its account in one place: which connection it answers with, then each connection's account (the one it
     answers with first and marked). The same "Which model" as What it may do, saved the same way. */
  const pools = [...(view.pools ?? [])].sort((a, b) => Number(usesPool(tr, b)) - Number(usesPool(tr, a)));
  const rows = pools.map((pool) => poolRow(tr, pool, keys)).join("") || `<p class="hint">${t("window.flows.trunk.acc-empty")}</p>`;
  return `<div class="tk-accounts"><p class="hint" data-css="margin:0 0 8px">${t("window.flows.trunk.acc-lede")}</p>${modelSeg(tr)}${copy}${rows}${capRow(tr)}${notes ? `<ul class="hint tk-notes">${notes}</ul>` : ""}</div>`;
}
/* The most it may spend in a month (GET/POST /api/trunks/{id}/spend, src/trunks/spend-cap.ts): what this month's turns and
   their helpers cost at list price, and the limit, saved when the field changes; empty is no limit. Tasks on a model with no
   price on file are named as not counted, never taken as free. */
function capRow(tr) {
  const s = ed.spend;
  if (!s) return "";
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const spent = s.monthlyUsd === null ? t("window.flows.trunk.cap-spent", { amount: money(s.spentUsd) })
    : t("window.flows.trunk.cap-spent-of", { amount: money(s.spentUsd), limit: money(s.monthlyUsd) });
  const unpriced = s.unpricedTasks ? ` ${t("window.flows.trunk.cap-unpriced", { n: s.unpricedTasks })}` : "";
  const over = s.monthlyUsd !== null && s.spentUsd >= s.monthlyUsd ? `<span class="pill no tk-cap-over">${t("window.flows.trunk.cap-reached")}</span>` : "";
  return `<div class="ctl tk-cap"><b><label for="tk-cap">${t("window.flows.trunk.cap")}</label> ${over}</b><span class="right"><input class="inp" id="tk-cap" type="number" min="0.01" max="100000" step="0.01" inputmode="decimal" data-css="width:120px" placeholder="${esc(t("window.flows.trunk.cap-none"))}" value="${s.monthlyUsd ?? ""}" data-id="${esc(tr.id)}"></span><small>${spent}${unpriced} ${t("window.flows.trunk.cap-hint")}</small></div>`;
}
async function setCap(el) {
  const raw = el.value.trim(), id = el.dataset.id;
  const monthlyUsd = raw === "" ? null : Number(raw);
  if (monthlyUsd !== null && !(monthlyUsd >= 0.01)) { toast(t("window.flows.trunk.cap-bad")); return; }
  try { ed.spend = await api(`trunks/${encodeURIComponent(id)}/spend`, { monthlyUsd }); }
  catch (error) { toast(error.message); }
  if (ed?.id === id && ed.tab === "accounts") drawEditor();
}
/* One save at a time: each reads the Trunk afresh, so two quick picks never write over each other. */
let keysSaving = Promise.resolve();
const saveKeys = (id, change) => (keysSaving = keysSaving.then(() => saveKeysNow(id, change)));
async function saveKeysNow(id, change) {
  try {
    const { trunk } = await api(`trunks/${encodeURIComponent(id)}`);
    const had = trunk?.keys ?? { copyFromOwner: true, accounts: {} };
    await api(`trunks/${encodeURIComponent(id)}`, { keys: change({ copyFromOwner: had.copyFromOwner, accounts: { ...had.accounts }, ...(had.next ? { next: { ...had.next } } : {}) }) });
    await refresh().catch((error) => console.warn(error.message));
  } catch (error) { toast(error.message); }
  await loadKeys(id); // what the engine keeps now, whether or not the change was taken
}
function pickAccount(el) {
  const pool = el.dataset.tkPool, v = el.value;
  saveKeys(el.dataset.id, (keys) => {
    if (v) keys.accounts[pool] = v; else delete keys.accounts[pool];
    return keys;
  });
}
function pickNext(el) {
  const pool = el.dataset.tkNext, v = el.value;
  saveKeys(el.dataset.id, (keys) => {
    const next = { ...(keys.next ?? {}) };
    if (v) next[pool] = [v]; else delete next[pool];
    return { ...keys, next };
  });
}
function setCopy(el) {
  const on = el.checked;
  saveKeys(el.dataset.id, (keys) => ({ ...keys, copyFromOwner: on }));
}

/* Drawn as the design has it and greyed, bar Which model: reading files, the browser and sending without asking each loosen
   the Trunk (reviewed apart, not done from here); the engine's Spend money category holds no tool in this build (GET
   /api/state approvalCategories), so there is nothing a Trunk could be let spend or kept from; and its own notes are
   always kept apart (src/trunks/memory-scope.ts), which the engine has no switch for (sharedFacts is another thing). */
function mayTab(tr) {
  return `<div>${ctl("tm-read", t("window.flows.trunk.read-files"), t("window.flows.trunk.read-hint"))}${ctl("tm-browse", t("window.flows.trunk.browser"), t("window.flows.trunk.browser-hint"))}${ctlSeg(t("window.flows.trunk.send"), t("window.flows.trunk.send-hint"), [t("mode.ask"), t("window.chat.tl.allowed")])}${ctlSeg(t("people.admin.kind.spend"), t("window.flows.trunk.spend-hint"), [t("window.flows.trunk.never")])}${modelSeg(tr)}${ctl("tm-notes", t("window.flows.trunk.notes"), t("window.flows.trunk.notes-hint"))}</div>`;
}

/* The editor redraws whole on every change; where the dialog and the characters were scrolled to is kept. */
function drawEditor() {
  const tr = trunkById(ed.id);
  if (!tr) { closeDlg(); ed = null; return; }
  const old = dialog()?.querySelector(".editor") ? dialog() : null;
  const kept = [".dlg-b", ".looks-tl"].map((q) => old?.querySelector(q)?.scrollTop ?? 0);
  const tabs = [["look", t("window.flows.trunk.look")], ["may", t("autonomy.orders.authority")], ["its17d", t("window.p17d.its-computers")], ["files", t("pane.files")], ["accounts", t("window.flows.trunk.accounts")]].map(([k, l]) => `<button class="tab" role="tab" type="button" aria-selected="${ed.tab === k}" data-act="st-tab" data-v="${k}">${l}</button>`).join("");
  const body = ed.tab === "look" ? lookPicker(tr) + emojiRow(tr) + lookTab(tr, ed.d) : ed.tab === "its17d" ? itsTab(tr.id) : ed.tab === "files" ? filesTab() : ed.tab === "accounts" ? accountsTab(tr) : mayTab(tr);
  const el = openDlg({ title: t("trunks.editing", { name: tr.name }), wide: true,
    body: `<div class="editor"><div class="big">${av(draftFace(tr), 84)}<button class="btn sm" type="button" data-act="st-shuffle">${t("studio.shuffle")}</button></div><div data-css="display:grid;gap:14px;min-width:0"><div class="tabs" data-css="margin:0" role="tablist">${tabs}</div>${body}</div></div>`,
    foot: `<button class="btn bad rm-tl" type="button" data-act="remove" data-id="${esc(tr.id)}">${t("window.flows.trunk.remove-trunk")}</button><button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="st-save">${t("action.save")}</button>` });
  if (old) [".dlg-b", ".looks-tl"].forEach((q, i) => { const box = el.querySelector(q); if (box) box.scrollTop = kept[i]; });
}

function editTrunk(id) {
  closePop();
  const tr = trunkById(id);
  if (!tr) return;
  const look = lookOf(tr);
  ed = { id, tab: "look", d: { name: tr.name, title: tr.title ?? "", colour: hex(tr.chosenColour), shape: look.shape, motion: look.motion, eyes: tr.eyes ?? "round" } };
  drawEditor();
}

/* The whole look, with this editor's shape and motion (and any extra change) over what is saved. */
function fullLook(tr, change = {}) {
  return { ...lookOf(tr), shape: ed?.d.shape ?? lookOf(tr).shape, motion: ed?.d.motion ?? lookOf(tr).motion, ...(ed?.d.colour ? { colour: null } : {}), ...change };
}

async function saveEditor() {
  keepFields();
  const tr = trunkById(ed.id);
  const body = { name: ed.d.name.trim(), title: ed.d.title.trim(), look: fullLook(tr), eyes: ed.d.eyes, ...(ed.d.colour ? { chosenColour: ed.d.colour } : {}) };
  try {
    await api(`trunks/${encodeURIComponent(ed.id)}`, body);
    /* The window's own Trunks are read again before the editor closes: closing first left a moment in which Edit Trunk…
       and the header still had the old name. A failed read is not a failed save; the next read carries the new name. */
    await refresh().catch((error) => console.warn(error.message));
    closeDlg();
    ed = null;
    toast(t("window.flows.trunk.saved", { name: body.name }));
  } catch (error) { toast(error.message); }
}

/* The prototype saves an emoji face at once, not on Save, and nothing else with it: the saved look gets only the new face,
   so an unsaved shape or motion stays a draft. None goes back to the face made from the name. As the prototype's emo15
   does, an emoji face puts the classic pebble back in place of a character. */
async function setEmoji(v) {
  keepFields();
  const tr = trunkById(ed.id);
  try {
    await api(`trunks/${encodeURIComponent(ed.id)}`, { look: { ...lookOf(tr), ...(v ? { face: "emoji", emoji: v } : { face: "pattern", emoji: "" }) }, ...(v ? { character: null } : {}) });
    /* A photo is drawn over an emoji too, so choosing one takes the photo off, as choosing a character does. */
    if (v && face(tr).photo) await dropPhoto(ed.id);
    await refresh();
    drawEditor();
  } catch (error) { toast(error.message); }
}

function shuffle() {
  keepFields();
  /* Only what the face shows is shuffled; what is not shown keeps its value. */
  const tr = trunkById(ed.id);
  if (uses(tr, "colour")) ed.d.colour = hex(COLOURS[Math.floor(Math.random() * COLOURS.length)]);
  if (uses(tr, "shape")) ed.d.shape = SHAPE_NAMES[Math.floor(Math.random() * SHAPE_NAMES.length)];
  if (uses(tr, "eyes")) ed.d.eyes = EYES[Math.floor(Math.random() * EYES.length)][0];
  drawEditor();
}

/* ---------- the Trunk's menu: pin, rename, remove ---------- */

/* The conversation menu's items for a Trunk's or a room's own conversation; "" for any other conversation. */
export function trunkMenu() {
  const tr = trunkOfChat();
  if (tr) return mi("pin", "pin", tr.pinned ? t("accounts.action.unpin") : t("window.flows.trunk.pin-top")) + mi("pausetrunk", "pause", tr.paused ? t("autonomy.resume") : t("window.flows.pause.this"), "", `data-id="${esc(tr.id)}"`) + mi("rename", "edit", t("accounts.action.rename")) + mi("edit", "sliders", t("window.flows.trunk.edit-trunk"), "", `data-id="${esc(tr.id)}"`) + mi("teach-start", "teach", t("window.flows.trunk.show-how"));
  const r = roomOfChat();
  if (r) return mi("pin", "pin", r.pinned ? t("accounts.action.unpin") : t("window.flows.trunk.pin-top")) + mi("rename", "edit", t("window.flows.trunk.rename-room")) + mi("room-rules", "sliders", t("window.flows.trunk.room-rules"), t(RULE_SHORT[ruleOf(r)]), `data-id="${esc(r.id)}"`);
  return "";
}
export function trunkMenuEnd() {
  const tr = trunkOfChat();
  return tr ? "<hr>" + mi("remove", "trash", t("window.flows.trunk.remove-trunk"), "", `data-id="${esc(tr.id)}"`) : "";
}

async function change(kind, id, body) {
  try {
    await api(kind === "room" ? `trunks/rooms/${encodeURIComponent(id)}` : `trunks/${encodeURIComponent(id)}`, body);
    await Promise.all([refresh(), loadRooms()]);
    return true;
  } catch (error) { toast(error.message); return false; }
}

export function pinChat(sid = S.chat) {
  closePop();
  const tr = trunkOfChat(sid), r = roomOfChat(sid);
  if (tr) change("trunk", tr.id, { pinned: !tr.pinned });
  else if (r) change("room", r.id, { pinned: !r.pinned });
}

export function renameDlg(sid = S.chat) {
  closePop();
  const tr = trunkOfChat(sid), r = roomOfChat(sid), target = tr ?? r;
  if (!target) return;
  openDlg({ title: tr ? t("accounts.action.rename") : t("window.flows.trunk.rename-room"), body: `<div class="field"><label for="rn-name">${t("accounts.field.name")}</label><input class="inp" id="rn-name" value="${esc(target.name)}"></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="rename-save" data-k="${tr ? "trunk" : "room"}" data-id="${esc(target.id)}">${t("action.save")}</button>` });
  setTimeout(() => $("#rn-name")?.select(), 0);
}

async function renameSave(el) {
  const name = ($("#rn-name")?.value ?? "").trim();
  if (!name) { $("#rn-name")?.setAttribute("aria-invalid", "true"); return; }
  if (await change(el.dataset.k, el.dataset.id, { name })) closeDlg();
}

/* What removing does, as the engine's remove does it (src/trunks/index.ts remove, POST /api/trunks/{id}/remove): its
   automations are removed; each room it is in carries on without it, or is removed when fewer than two Trunks would be
   left; the conversations it answered go back to Branch. Its own conversation stays in the list and what it remembered
   stays in memory (the engine deletes neither). The engine keeps no copy to bring it back, so there is no Undo. */
function removeDlg(id) {
  closePop();
  const tr = trunkById(id);
  if (!tr) return;
  ed = null;
  const rooms = (E.rooms ?? []).filter((r) => (r.members ?? []).includes(tr.id));
  const lines = [t("window.flows.trunk.automations-stop"),
    ...rooms.map((r) => t(r.members.length > 2 ? "window.flows.trunk.rm-room-stays" : "window.flows.trunk.rm-room-goes", { room: r.name })),
    t("window.flows.trunk.rm-answered"), t("window.flows.trunk.rm-chat-kept"), t("window.flows.trunk.rm-memory-kept"), t("window.flows.trunk.rm-no-undo")];
  openDlg({ title: t("studio.remove.title", { name: tr.name }), body: `<ul class="rm-list-tl">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.flows.trunk.keep", { name: esc(tr.name) })}</button><button class="btn bad" type="button" data-act="trunk-remove-yes" data-id="${esc(tr.id)}">${t("accounts.action.remove")}</button>` });
}

async function removeTrunk(id) {
  try {
    await api(`trunks/${encodeURIComponent(id)}/remove`, {});
    closeDlg();
    await Promise.all([refresh(), loadRooms()]);
    toast(t("addons.export.removed"));
  } catch (error) { toast(error.message); }
}

/* ---------- a Trunk from a job: create takes name, title and description; the look follows as an edit ---------- */
async function fromTemplate(i) {
  const [, , colour, shape] = TEMPLATES[i] ?? [];
  if (!TEMPLATE_WORDS[i]) return;
  const [name, what] = TEMPLATE_WORDS[i].map((key) => t(key));
  try {
    const { trunk } = await api("trunks", { name, title: what, description: what });
    await api(`trunks/${encodeURIComponent(trunk.id)}`, { chosenColour: hex(colour), look: { ...LOOK, shape: SHAPE_NAMES[shape] } });
    await refresh();
    openChat(trunk.chatSessionId);
    toast(t("window.flows.trunk.ready", { name }));
  } catch (error) { toast(error.message); }
}

/* ---------- a new Trunk: the prototype's "Trunk 6 for now", made with POST /api/trunks; the engine has it introduce itself in its
   own conversation, which then opens. Its name, colour and face change from the editor. ---------- */
async function newTrunk() {
  closePop();
  try {
    let n = E.trunks.length + 1;
    while (E.trunks.some((tr) => tr.name === `Trunk ${n}`)) n += 1;
    const { trunk } = await api("trunks", { name: `Trunk ${n}` });
    await refresh();
    openChat(trunk.chatSessionId);
  } catch (error) { toast(error.message); }
}

/* ---------- a new room: a name, two to six Trunks and up to eight people on this computer (POST /api/trunks/rooms
   {name, members, people, rule}; the engine checks each person is on this computer and lets a person into that room only).
   Agents on other computers are the ones connected by their A2A card (GET /api/agents/remote, Customize › Tools), seated
   by id (`agents`); the engine takes them from the owner only, and each takes its turn over A2A (src/trunks/rooms.ts).
   "Trunks may talk to each other in here" is drawn on and greyed: every room does, for up to 3 rounds and
   10 Trunk messages (src/trunks/room-plan.ts), and the engine has no switch for it. ---------- */
let grp = null;

/* Who answers in a room (src/trunks/room-plan.ts): the engine's three rules, in the prototype's words. The engine's
   default is mentions only; a lead Trunk is the first one picked. */
const RULES = [["mention", "window.flows.trunk.rule-mention"], ["lead", "window.flows.trunk.rule-lead"], ["all", "window.flows.trunk.rule-all"]];
const ruleSeg = (act, current, id = "") => `<div class="ctl"><b>${t("rooms.who.choose")}</b><span class="right"><span class="seg" role="group" aria-label="${t("rooms.who.choose")}">${RULES.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}"${id ? ` data-id="${esc(id)}"` : ""} aria-pressed="${current === v}">${t(l)}</button>`).join("")}</span></span><small>${t("window.flows.trunk.nobody")}</small></div>`;

/* What the engine needs before it makes a room (a name, two Trunks or more), said beside each field; Start waits for both. */
const needName = () => !String(grp.name ?? "").trim();
const needTwo = () => grp.trunks.length < 2;
const need = (id, words, shown) => `<small class="need18" id="${id}"${shown ? "" : " hidden"}>${words}</small>`;
function checkGroup() {
  const name = $("#grp-need-name"), two = $("#grp-need-two"), start = document.querySelector('[data-act="grp-make"]');
  if (name) name.hidden = !needName();
  if (two) two.hidden = !needTwo();
  if (start) start.disabled = needName() || needTwo();
}

function groupDlg() {
  const people = (E.profiles?.profiles ?? []).filter((p) => p.id !== activeId()), agents = grp.remote;
  const where = (a) => (a.badge ? ` · ${String(a.badge).split(" · ")[1] || a.badge}` : ""); // the prototype's "name · where it runs"
  const chip = (act, id, label, on) => `<button type="button" class="chip6" data-act="${act}" data-k="trunks" data-v="${esc(id)}" aria-pressed="${on}">${esc(label)}</button>`;
  openDlg({ title: t("window.flows.trunk.new-group"), wide: true, body: `<label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="grp-name" value="${esc(grp.name)}" aria-describedby="grp-need-name">${need("grp-need-name", t("window.flows.trunk.need-name"), needName())}</label>
    <div class="fld"><span>${t("window.flows.trunk.two-six")}</span><span class="chips8">${E.trunks.map((tr) => chip("grp-pick", tr.id, tr.name, grp.trunks.includes(tr.id))).join("")}</span>${need("grp-need-two", t("window.flows.trunk.need-two"), needTwo())}</div>
    <div class="fld"><span>${t("window.flows.trunk.people-eight")}</span><span class="chips8">${people.map((p) => chip("grp-person", p.id, p.name, grp.people.includes(p.id))).join("")}</span></div>
    <div class="fld"><span>${t("window.flows.trunk.agents")}</span><span class="chips8">${agents.map((a) => chip("grp-agent", a.id, `${a.name}${where(a)}`, grp.agents.includes(a.id))).join("")}</span></div>
    ${ruleSeg("grp-rule", grp.rule)}
    ${ctl("grp-talk", t("window.flows.trunk.talk"), t("window.flows.trunk.talk-hint"), true)}`, // state: every room lets its Trunks talk (room-plan.ts)
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="grp-make"${needName() || needTwo() ? " disabled" : ""}>${t("window.flows.trunk.start-group")}</button>` });
}

/* The agents on other computers are read once, when the dialog opens. */
async function newGroup() {
  closePop();
  let agents = [];
  try { agents = (await api("agents/remote")).agents ?? []; } catch (error) { toast(error.message); }
  grp = { name: "", trunks: [], people: [], remote: agents, agents: [], rule: "mention" };
  groupDlg();
}

function pickMember(el, list = "trunks") {
  grp.name = $("#grp-name")?.value ?? grp.name;
  const v = el.dataset.v;
  grp[list] = grp[list].includes(v) ? grp[list].filter((x) => x !== v) : [...grp[list], v];
  groupDlg();
}

/* The new room opens once the lists are read again, unless the owner has opened another conversation or place
   meanwhile: a late open never takes them away from where they went. */
async function makeRoom() {
  const name = ($("#grp-name")?.value ?? "").trim();
  grp.name = name;
  if (needName() || needTwo()) { checkGroup(); return; }
  const from = [S.view, S.chat];
  try {
    const { room } = await api("trunks/rooms", { name, members: grp.trunks, people: grp.people, agents: grp.agents, rule: grp.rule });
    grp = null;
    closeDlg();
    await Promise.all([refresh(), loadRooms()]);
    const stayed = S.view === from[0] && S.chat === from[1];
    if (room?.sessionId && stayed) openChat(room.sessionId);
    toast(t("window.flows.trunk.group-started"));
  } catch (error) { toast(error.message); }
}

/* ---------- Room rules (the room's menu): who answers, and the room's own way of working together ---------- */

/* The prototype's patterns (PATTERNS15), by the engine's names (src/team-pattern.ts), each with its line; Teams has no
   engine form, so it stays greyed. A room without its own pattern follows the owner's default (GET /api/state
   orchestration.pattern; "auto" is Branch picking one). */
const PATTERNS = [["one", "window.flows.trunk.one", "A Trunk calls a specialist, waits, carries on."], ["super", "window.flows.trunk.lead-helpers", "One Trunk plans and hands out the parts."],
  ["swarm", "window.flows.trunk.swarm", "Equals pass the work to whoever fits best."], ["router", "window.flows.trunk.router", "Sends each request to the one Trunk that matches."],
  ["parallel", "window.flows.trunk.parallel", "The same job split up, then gathered."], ["teams", "window.flows.trunk.teams", "Small groups, each with its own lead."]];
/* trunk-rooms-live: the engine's two rules the owner asked for ("Only who I tag", "Work together", src/trunks/room-plan.ts)
   are chosen here too, and by the toggle by the message box (flows/roomwith.js). */
const ROOM_RULES = [...RULES, ["tag", "window.flows.trunk.rule-tag"], ["together", "window.flows.trunk.rule-together"]];
const RULE_LINE = { lead: "window.flows.trunk.rule-lead-line", all: "window.flows.trunk.rule-all-line", mention: "window.flows.trunk.nobody",
  tag: "window.flows.trunk.rule-tag-line", together: "window.flows.trunk.rule-together-line" };
const RULE_SHORT = { lead: "window.flows.trunk.rule-lead-short", all: "window.flows.trunk.rule-all-short", mention: "window.flows.trunk.rule-mention-short",
  tag: "window.flows.trunk.rule-tag-short", together: "window.flows.trunk.rule-together-short" };
const ruleOf = (r) => (RULE_SHORT[r?.rule] ? r.rule : "mention");
const ownDefault = () => {
  const v = E.state?.orchestration?.pattern, p = PATTERNS.find(([k]) => k === v);
  return p ? t(p[1]) : t("window.flows.trunk.branch-picks");
};
const pick = (act, v, id, text, sub, on) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="${act}" data-v="${v}" data-id="${esc(id)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${text}</span><span class="mi-s">${sub}</span></span></button>`;
function rulesPop(id) {
  const r = rooms.find((x) => x.id === id);
  if (!r) return "";
  const rules = ["lead", "all", "mention", "tag", "together"].map((k) => ROOM_RULES.find(([v]) => v === k)).map(([v, l]) => pick("room-rule", v, id, t(l), t(RULE_LINE[v]), ruleOf(r) === v)).join("");
  const pats = PATTERNS.map(([v, l, line]) => pick(v === "teams" ? "room-pat-teams" : "room-pat", v, id, t(l), esc(say(line)), r.pattern === v)).join("");
  return `<div class="pt">${t("window.flows.trunk.room-rules")}</div><div class="ph">${t("rooms.who.choose")}</div>${rules}<hr><div class="ph">${t("window.flows.trunk.together-here")}</div>${pick("room-pat", "default", id, esc(t("window.flows.trunk.your-default", { name: ownDefault() })), "", !r.pattern)}${pats}`;
}
function openRules(id) {
  const anchor = $('[data-act="chatmenu"]');
  const html = rulesPop(id);
  if (!anchor || !html) return;
  openPop(anchor, html, { right: true, force: true });
}
/* The room's rule, or its pattern ("default" gives it back to the owner's default, null). */
async function setRule(el, field) {
  const r = rooms.find((x) => x.id === el.dataset.id), v = el.dataset.v;
  closePop();
  if (!r) return;
  const value = field === "pattern" && v === "default" ? null : v;
  if ((field === "rule" ? ruleOf(r) : r.pattern) === value) return;
  if (await change("room", r.id, { [field]: value })) toast(field === "rule" ? t("window.flows.trunk.rule-in-room", { rule: t(ROOM_RULES.find(([k]) => k === v)[1]), room: r.name }) : `${r.name}: ${value ? t(PATTERNS.find(([k]) => k === v)[1]) : ownDefault()}.`);
}

export function init() {
  initPause();
  initShare();
  markLive(["room-rules", "room-rule", "room-pat", "grp-rule"]);
  on("room-rules", (el) => openRules(el.dataset.id));
  on("room-rule", (el) => setRule(el, "rule"));
  on("room-pat", (el) => setRule(el, "pattern"));
  on("grp-rule", (el) => { grp.name = $("#grp-name")?.value ?? grp.name; grp.rule = el.dataset.v; groupDlg(); });
  markLive(["sw:st-name", "sw:st-role", "sw:rn-name", "sw:grp-name", "edit", "st-tab", "st-colour", "st-shape", "st-anim", "st-shuffle", "st-save", "emo15", "pin", "rename", "rename-save", "remove", "trunk-remove-yes", "tmpl", "grp-new", "grp-pick", "grp-person", "grp-agent", "grp-make", "new-trunk"]);
  on("new-trunk", () => newTrunk());
  on("edit", (el) => editTrunk(el.dataset.id));
  on("st-tab", async (el) => {
    if (!ed) return; // only while an editor is open (a household person's Edit on the owner's Trunk opens none)
    keepFields();
    const id = ed.id;
    if (el.dataset.v === "files" && !ed.files) {
      try { const data = await api(`trunks/${id}/files`); if (ed?.id !== id) return; ed.files = data.files; }
      catch (error) { toast(error.message); return; }
    }
    ed.tab = el.dataset.v; drawEditor();
    if (ed.tab === "accounts") loadKeys(ed.id);
  });
  markLive(["trunk-default", "trunk-file-save"]);
  on("trunk-default", async (el) => {
    try { await api(`trunks/${el.dataset.id}/default`, {}); await refresh(); }
    catch (error) { toast(error.message); }
  });
  on("trunk-file-save", async (el) => {
    keepFields();
    const id = ed.id, file = ed.files.find((file) => file.name === el.dataset.name);
    try { await api(`trunks/${id}/files`, { name: file.name, text: file.text }); await refresh(); }
    catch (error) { toast(error.message); }
  });
  computersChanged(() => { if (ed?.tab === "its17d" && dialog()?.querySelector(".editor")) drawEditor(); }); // only while the editor is open
  on("st-colour", (el) => { keepFields(); ed.d.colour = hex(el.dataset.v); drawEditor(); });
  on("st-shape", (el) => { keepFields(); ed.d.shape = SHAPE_NAMES[+el.dataset.v] ?? null; drawEditor(); });
  on("st-anim", (el) => { keepFields(); ed.d.motion = el.dataset.v; drawEditor(); });
  on("st-eyes", (el) => { keepFields(); ed.d.eyes = el.dataset.v; drawEditor(); });
  on("st-photo", () => pickPhoto());
  on("st-photo-x", () => removePhoto());
  document.addEventListener("change", (e) => {
    if (e.target.id === "tm-model-sel") setModel(e.target);
    else if (e.target.id === "tk-copy") setCopy(e.target);
    else if (e.target.id === "tk-cap") setCap(e.target);
    else if (e.target.dataset?.tkPool) pickAccount(e.target);
    else if (e.target.dataset?.tkNext) pickNext(e.target);
  });
  markLive(["st-eyes", "st-photo", "st-photo-x", "sw:tm-model-sel", "sw:tk-copy", "sw:tk-pool", "sw:tk-next", "sw:tk-cap"]);
  on("st-shuffle", () => shuffle());
  on("st-save", () => saveEditor());
  on("emo15", (el) => setEmoji(el.dataset.v));
  on("look-set", (el) => setCharacter(el));
  markLive(["look-set"]);
  on("pin", () => pinChat());
  on("rename", () => renameDlg());
  on("rename-save", (el) => renameSave(el));
  on("remove", (el) => removeDlg(el.dataset.id));
  on("trunk-remove-yes", (el) => removeTrunk(el.dataset.id));
  on("tmpl", (el) => fromTemplate(+el.dataset.i));
  on("grp-new", () => newGroup());
  on("grp-pick", (el) => pickMember(el));
  on("grp-person", (el) => pickMember(el, "people"));
  on("grp-agent", (el) => pickMember(el, "agents")); // a2a-rooms
  on("grp-make", () => makeRoom());
  document.addEventListener("input", (e) => { if (e.target.id === "grp-name" && grp) { grp.name = e.target.value; checkGroup(); } });
  onRender(firstRooms);
}

/* The rooms are read once the window is signed in (E.loaded), then again after each change made here. */
let roomsAsked = false;
function firstRooms() {
  if (roomsAsked || !E.loaded) return;
  roomsAsked = true;
  loadRooms().catch((error) => toast(error.message));
}
