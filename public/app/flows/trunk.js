/* A Trunk, changed from the window (design doc 5.7): the Trunk editor, the Trunk's own menu items (pin, rename, remove),
   starting a Trunk from a job, and a new room. Every change goes to the engine's Trunk routes (src/trunks/api.ts):
   POST /api/trunks/{id} merges the fields it is given, but `look` is replaced whole, so the full look is always sent.
   What it may do (the permission switches) stays greyed: loosening a Trunk is not done from here. */

import { $, esc, onRender } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic, av, mi, COLOURS, SHAPE_NAMES, hex, faceOf, dialog } from "../core/ui.js";
import { S, E, refresh, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { initPause } from "./pause.js";
import { looks17, look17, NEW17 } from "../core/art17.js";
import { t } from "../../i18n.js";
import { itsTab, onChange as computersChanged } from "./computers17.js"; // pass 17 part D §9: Its computers

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
}

/* The pebble as this editor would save it: the draft's colour, shape, eyes and motion over the saved face. */
function draftFace(tr, change = {}) {
  const d = ed.d;
  return { ...face(tr), name: d.name, color: d.colour ?? face(tr).color, shape: d.shape ?? face(tr).shape, eyes: d.eyes, motion: d.motion, ...change };
}

function lookTab(tr, d) {
  const swatches = COLOURS.map((c) => `<button class="swatch" type="button" data-css="background:${c}" aria-label="${t("window.flows.trunk.colour-c", { c })}" aria-pressed="${hex(c) === d.colour}" data-act="st-colour" data-v="${c}"></button>`).join("");
  /* Each shape drawn as av() draws it: the pebble in the Trunk's own colour, still, with no photo, character or emoji over it. */
  const bare = { photo: null, character: null, lookStill: null, emoji: "", motion: "none", paused: false };
  const shapes = SHAPE_NAMES.map((sh, i) => `<button class="shape" type="button" aria-label="${t("window.flows.trunk.shape-n", { n: i + 1 })}" aria-pressed="${sh === d.shape}" data-act="st-shape" data-v="${i}">${av(draftFace(tr, { ...bare, shape: sh }), 30)}</button>`).join("");
  const moves = MOTIONS.map(([v, l]) => `<button type="button" data-act="st-anim" data-v="${v}" aria-pressed="${d.motion === v}">${t(l)}</button>`).join("");
  const eyes = EYES.map(([v, l]) => `<button type="button" data-act="st-eyes" data-v="${v}" aria-pressed="${d.eyes === v}">${t(l)}</button>`).join("");
  return `<div class="split" data-css="grid-template-columns:1fr 1fr"><div class="field"><label for="st-name">${t("accounts.field.name")}</label><input class="inp" id="st-name" value="${esc(d.name)}"></div><div class="field"><label for="st-role">${t("window.flows.trunk.for")}</label><input class="inp" id="st-role" value="${esc(d.title)}"></div></div>
    <div class="field"><label>${t("studio.colour")}</label><div class="swatches">${swatches}</div></div>
    <div class="field"><label>${t("studio.shape")}</label><div class="shapes">${shapes}</div></div>
    <div class="split" data-css="grid-template-columns:1fr 1fr">${photoField(tr)}<div class="field"><label>${t("window.flows.trunk.moves")}</label><span class="seg">${moves}</span></div></div>
    <div class="field"><label>${t("window.flows.trunk.eyes")}</label><span class="seg">${eyes}</span></div>`;
}

/* ---------- a photo instead of a face: POST /api/trunks/{id}/avatar, which keeps a PNG, JPEG or WebP under about 290 KB
   and refuses anything else with its own words. Saved at once, as the character and the emoji are; Remove gives the
   face made from the name back ({ kind: "face" }). ---------- */
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
async function removePhoto() {
  keepFields();
  try {
    await api(`trunks/${encodeURIComponent(ed.id)}/avatar`, { kind: "face", locked: false });
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
  return `<div class="sec"><h2>${t("window.flows.setup.looks")}</h2><p class="hint" data-css="margin:0 0 8px">${t("window.flows.trunk.moves-hint")}</p>
    <div class="looks12 looks-tl">${pebble}${cards}</div></div>`;
}
async function setCharacter(el) {
  const tr = trunkById(el.dataset.id), v = el.dataset.v;
  if (!tr) return;
  if (ed) keepFields();
  try {
    await api(`trunks/${encodeURIComponent(tr.id)}`, { character: v === "classic" ? null : v });
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

/* Which model: the engine's own presets (GET /api/state models.presets, by their names), saved at once as the Trunk's
   model (POST /api/trunks/{id} model, a preset id). Choosing the one it has again gives it back to the conversation's
   model (""). With no presets set up there is nothing to choose, so none is drawn. */
function modelSeg(tr) {
  const presets = E.state?.models?.presets ?? [];
  const opts = presets.map((p) => `<button type="button" data-act="tm-model" data-id="${esc(tr.id)}" data-v="${esc(p.id)}" aria-pressed="${tr.model === p.id}">${esc(p.name)}</button>`).join("");
  return `<div class="ctl"><b>${t("window.flows.trunk.which-model")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.flows.trunk.which-model")}">${opts}</span></span><small>${t("window.flows.trunk.which-model-hint")}</small></div>`;
}
async function setModel(el) {
  const tr = trunkById(el.dataset.id);
  if (!tr) return;
  keepFields();
  try {
    await api(`trunks/${encodeURIComponent(tr.id)}`, { model: tr.model === el.dataset.v ? "" : el.dataset.v });
    await refresh();
    if (ed?.id === tr.id) drawEditor();
  } catch (error) { toast(error.message); }
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
  const tabs = [["look", t("window.flows.trunk.look")], ["may", t("autonomy.orders.authority")], ["its17d", t("window.p17d.its-computers")]].map(([k, l]) => `<button class="tab" role="tab" type="button" aria-selected="${ed.tab === k}" data-act="st-tab" data-v="${k}">${l}</button>`).join("");
  const body = ed.tab === "look" ? lookPicker(tr) + emojiRow(tr) + lookTab(tr, ed.d) : ed.tab === "its17d" ? itsTab(tr.id) : mayTab(tr);
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
    closeDlg();
    ed = null;
    await refresh();
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
    await refresh();
    drawEditor();
  } catch (error) { toast(error.message); }
}

function shuffle() {
  keepFields();
  ed.d.colour = hex(COLOURS[Math.floor(Math.random() * COLOURS.length)]);
  ed.d.shape = SHAPE_NAMES[Math.floor(Math.random() * SHAPE_NAMES.length)];
  ed.d.eyes = EYES[Math.floor(Math.random() * EYES.length)][0];
  drawEditor();
}

/* ---------- the Trunk's menu: pin, rename, remove ---------- */

/* The conversation menu's items for a Trunk's or a room's own conversation; "" for any other conversation. */
export function trunkMenu() {
  const tr = trunkOfChat();
  if (tr) return mi("pin", "pin", tr.pinned ? t("accounts.action.unpin") : t("window.flows.trunk.pin-top")) + mi("pausetrunk", "pause", tr.paused ? t("autonomy.resume") : t("window.flows.pause.this"), "", `data-id="${esc(tr.id)}"`) + mi("rename", "edit", t("accounts.action.rename")) + mi("edit", "sliders", t("window.flows.trunk.edit-trunk"), "", `data-id="${esc(tr.id)}"`) + mi("teach-start", "teach", t("window.flows.trunk.show-how"));
  const r = roomOfChat();
  if (r) return mi("pin", "pin", r.pinned ? t("accounts.action.unpin") : t("window.flows.trunk.pin-top")) + mi("rename", "edit", t("window.flows.trunk.rename-room")) + mi("room-rules", "sliders", t("window.flows.trunk.room-rules"), "", `data-id="${esc(r.id)}"`);
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

/* ---------- a new room: a name and two to six Trunks. People and agents on other computers stay greyed (sharing). ---------- */
let grp = null;

/* Who answers in a room (src/trunks/room-plan.ts): the engine's three rules, in the prototype's words. The engine's
   default is mentions only; a lead Trunk is the first one picked. */
const RULES = [["mention", "window.flows.trunk.rule-mention"], ["lead", "window.flows.trunk.rule-lead"], ["all", "window.flows.trunk.rule-all"]];
const ruleSeg = (act, current, id = "") => `<div class="ctl"><b>${t("rooms.who.choose")}</b><span class="right"><span class="seg" role="group" aria-label="${t("rooms.who.choose")}">${RULES.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}"${id ? ` data-id="${esc(id)}"` : ""} aria-pressed="${current === v}">${t(l)}</button>`).join("")}</span></span><small>${t("window.flows.trunk.nobody")}</small></div>`;

function groupDlg() {
  const people = (E.profiles?.profiles ?? []).filter((p) => p.id !== activeId()), agents = grp.agents;
  const chip = (act, id, label, on) => `<button type="button" class="chip6" data-act="${act}" data-k="trunks" data-v="${esc(id)}" aria-pressed="${on}">${esc(label)}</button>`;
  openDlg({ title: t("window.flows.trunk.new-group"), wide: true, body: `<label class="fld"><span>${t("accounts.field.name")}</span><input class="inp" id="grp-name" value="${esc(grp.name)}"></label>
    <div class="fld"><span>${t("window.flows.trunk.two-six")}</span><span class="chips8">${E.trunks.map((tr) => chip("grp-pick", tr.id, tr.name, grp.trunks.includes(tr.id))).join("")}</span></div>
    <div class="fld"><span>${t("window.flows.trunk.people-eight")}</span><span class="chips8">${people.map((p) => chip("grp-person", p.id, p.name, false)).join("")}</span></div>
    <div class="fld"><span>${t("window.flows.trunk.agents")}</span><span class="chips8">${agents.map((a) => chip("grp-agent", a.name ?? a.id, a.name ?? a.id, false)).join("")}</span></div>
    ${ruleSeg("grp-rule", grp.rule)}
    ${ctl("grp-talk", t("window.flows.trunk.talk"), t("window.flows.trunk.talk-hint"))}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="grp-make">${t("window.flows.trunk.start-group")}</button>` });
}

/* The agents on other computers are read once, when the dialog opens; they are drawn greyed. */
async function newGroup() {
  closePop();
  let agents = [];
  try { agents = (await api("agents/remote")).agents ?? []; } catch (error) { toast(error.message); }
  grp = { name: "", trunks: [], agents, rule: "mention" };
  groupDlg();
}

function pickMember(el) {
  grp.name = $("#grp-name")?.value ?? grp.name;
  const v = el.dataset.v;
  grp.trunks = grp.trunks.includes(v) ? grp.trunks.filter((x) => x !== v) : [...grp.trunks, v];
  groupDlg();
}

/* The new room opens once the lists are read again, unless the owner has opened another conversation or place
   meanwhile: a late open never takes them away from where they went. */
async function makeRoom() {
  const name = ($("#grp-name")?.value ?? "").trim();
  const from = [S.view, S.chat];
  try {
    const { room } = await api("trunks/rooms", { name, members: grp.trunks, rule: grp.rule });
    grp = null;
    closeDlg();
    await Promise.all([refresh(), loadRooms()]);
    const stayed = S.view === from[0] && S.chat === from[1];
    if (room?.sessionId && stayed) openChat(room.sessionId);
  } catch (error) { toast(error.message); }
}

/* ---------- Room rules (the room's menu): who answers, and the room's own way of working together ---------- */

/* The prototype's patterns (Customize › Specialists), by the engine's names; Teams has no engine form, so it stays greyed. */
const PATTERNS = [["one", "window.flows.trunk.one"], ["super", "window.flows.trunk.lead-helpers"], ["swarm", "window.flows.trunk.swarm"], ["router", "window.flows.trunk.router"], ["parallel", "window.flows.trunk.parallel"], ["teams", "window.flows.trunk.teams"]];
function rulesDlg(id) {
  closePop();
  const r = rooms.find((x) => x.id === id);
  if (!r) return;
  const pats = PATTERNS.map(([v, l]) => `<button type="button" data-act="${v === "teams" ? "room-pat-teams" : "room-pat"}" data-v="${v}" data-id="${esc(id)}" aria-pressed="${r.pattern === v}">${t(l)}</button>`).join("");
  openDlg({ title: t("window.flows.trunk.room-rules"), body: `${ruleSeg("room-rule", r.rule ?? "mention", id)}
    <div class="ctl"><b>${t("window.flows.trunk.together")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.flows.trunk.together")}">${pats}</span></span><small>${t("window.flows.trunk.together-hint")}</small></div>`,
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}
/* Choosing the room's pattern again gives it back to the owner's default (null). */
async function setRule(el, field) {
  const r = rooms.find((x) => x.id === el.dataset.id), v = el.dataset.v;
  const value = field === "pattern" && r?.pattern === v ? null : v;
  if (await change("room", el.dataset.id, { [field]: value })) rulesDlg(el.dataset.id);
}

export function init() {
  initPause();
  markLive(["room-rules", "room-rule", "room-pat", "grp-rule"]);
  on("room-rules", (el) => rulesDlg(el.dataset.id));
  on("room-rule", (el) => setRule(el, "rule"));
  on("room-pat", (el) => setRule(el, "pattern"));
  on("grp-rule", (el) => { grp.name = $("#grp-name")?.value ?? grp.name; grp.rule = el.dataset.v; groupDlg(); });
  markLive(["sw:st-name", "sw:st-role", "sw:rn-name", "sw:grp-name", "edit", "st-tab", "st-colour", "st-shape", "st-anim", "st-shuffle", "st-save", "emo15", "pin", "rename", "rename-save", "remove", "trunk-remove-yes", "tmpl", "grp-new", "grp-pick", "grp-make", "new-trunk"]);
  on("new-trunk", () => newTrunk());
  on("edit", (el) => editTrunk(el.dataset.id));
  on("st-tab", (el) => { keepFields(); ed.tab = el.dataset.v; drawEditor(); });
  computersChanged(() => { if (ed?.tab === "its17d" && dialog()?.querySelector(".editor")) drawEditor(); }); // only while the editor is open
  on("st-colour", (el) => { keepFields(); ed.d.colour = hex(el.dataset.v); drawEditor(); });
  on("st-shape", (el) => { keepFields(); ed.d.shape = SHAPE_NAMES[+el.dataset.v] ?? null; drawEditor(); });
  on("st-anim", (el) => { keepFields(); ed.d.motion = el.dataset.v; drawEditor(); });
  on("st-eyes", (el) => { keepFields(); ed.d.eyes = el.dataset.v; drawEditor(); });
  on("st-photo", () => pickPhoto());
  on("st-photo-x", () => removePhoto());
  on("tm-model", (el) => setModel(el));
  markLive(["st-eyes", "st-photo", "st-photo-x", "tm-model"]);
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
  on("grp-make", () => makeRoom());
  onRender(firstRooms);
}

/* The rooms are read once the window is signed in (E.loaded), then again after each change made here. */
let roomsAsked = false;
function firstRooms() {
  if (roomsAsked || !E.loaded) return;
  roomsAsked = true;
  loadRooms().catch((error) => toast(error.message));
}
