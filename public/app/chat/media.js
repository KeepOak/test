/* Pictures, documents, sound and material in the conversation (design doc 4.3, pass 6 and 15).
   - Make a picture and Write a file ask the engine in the conversation (POST /api/run through the composer): the model
     answers with media.image or documents.write when a connection can. The picture it made is drawn as the prototype's
     picture card (below).
   - Sound and video a person attached play inside the thread: the file comes from GET /api/attachments/file, the length
     from the file itself and the waveform from its own samples.
   - @ references in the draft show as chips over the box; x takes one out of the draft. "read as material, not
     instructions" shows only while the engine reads them that way (GET /api/coding, mentions). */

import { $, $$, esc, onRender, applyCss, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, mi, openDlg, closeDlg, closePop, toast, dialog } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { bgMenuItem } from "./bg.js";
import { t } from "../../i18n.js";

/* ---------- the + menu's extra rows, 1:1 with the prototype (pass 6 and 15) ---------- */
export function plusMore() {
  return "<hr>" + mi("imagine", "image", t("window.chat.media.picture")) + "<hr>" + bgMenuItem() + mi("office15", "doc", t("window.chat.media.office"));
}

/* Sends words as the next message, through the composer, so the thread shows it like anything typed. */
function sendAsMessage(words) {
  const box = $("#prompt");
  if (!box || !$("#composer")) return;
  box.value = words;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  /* The input may redraw the box: submit the form that is there now. */
  $("#composer")?.requestSubmit();
}

function needWords(input) {
  input?.setAttribute("aria-invalid", "true");
  input?.focus();
}

function openImagine() {
  closePop();
  openDlg({ title: t("window.chat.media.picture"), body: `<label class="fld"><span>${t("window.chat.media.describe")}</span><input class="inp" id="img-q" placeholder="${t("window.chat.media.describe-hint")}" maxlength="120"></label>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="img-go">${t("autonomy.suggestions.accept")}</button>` });
}
function makePicture() {
  const input = $("#img-q");
  const words = (input?.value ?? "").trim();
  if (!words) return needWords(input);
  closeDlg();
  sendAsMessage(`Make a picture: ${words}`);
}

/* [kind, the English name the message to the model carries, its product, the name shown]. */
const KINDS = [["docx", "Document", "Word · .docx", "window.chat.media.document"], ["xlsx", "Spreadsheet", "Excel · .xlsx", "window.chat.media.spreadsheet"], ["pptx", "Slides", "PowerPoint · .pptx", "window.chat.media.slides"]];
function openOffice() {
  closePop();
  const kinds = KINDS.map(([k, , s, shown], i) => `<button type="button" role="radio" aria-checked="${i === 0}" data-act="offk15" data-v="${k}"><span class="fi">${k}</span><b>${t(shown)}</b><small>${s}</small></button>`).join("");
  openDlg({ title: t("window.chat.media.write-file"), body: `<div class="office15" role="radiogroup" aria-label="${t("window.chat.media.kind")}">${kinds}</div><label class="fld"><span>${t("window.chat.media.what")}</span><input class="inp" id="off-in15" placeholder="${t("window.chat.media.what-hint")}"></label>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="offgo15">${t("action.write-it")}</button>` });
}
function pickKind(el) {
  dialog()?.querySelectorAll(".office15 button").forEach((b) => b.setAttribute("aria-checked", String(b === el)));
}
function writeFile() {
  const input = $("#off-in15");
  const words = (input?.value ?? "").trim();
  if (!words) return needWords(input);
  const k = dialog()?.querySelector('.office15 [aria-checked="true"]')?.dataset.v ?? "docx"; // state: a selector that reads the chosen kind, not markup
  const [, name, s] = KINDS.find(([key]) => key === k) ?? KINDS[0];
  closeDlg();
  sendAsMessage(`${name} (${s}): ${words}`);
}

/* ---------- the picture card (prototype imgCard) ---------- */
/* A picture the model made with media.image, from the tool's own answer in the conversation: the engine kept it beside
   the task (GET /api/artifacts/file?path=…, pictures only). Every picture this conversation made from the same words is a
   version to pick (window state); Make it again asks for another in the conversation. Save to Library and Use as
   background stay greyed: the engine already keeps every picture in Library › Made for you and has no saving of its own,
   and it has no background of the owner's own to set. */
const P = { urls: new Map(), loading: new Map(), pick: new Map() };
let mediaScope = null, mediaGeneration = 0;
function madePicture(call, messages) {
  if (call.name !== "media.image") return null;
  const answer = messages.find((x) => x.role === "tool" && x.toolCallId === call.id);
  let said;
  try { said = JSON.parse(answer?.content ?? "null"); } catch { return null; } // an answer that is not the tool's JSON made no picture
  const r = said?.ok ? said.result : null;
  return typeof r?.path === "string" && r.path ? { path: r.path, prompt: String(r.prompt ?? ""), model: String(r.model ?? "") } : null;
}
async function pictureUrl(path) {
  if (P.urls.has(path) || P.loading.has(path)) return;
  const generation = mediaGeneration, abort = new AbortController();
  P.loading.set(path, abort);
  try {
    const auth = token.get();
    const response = await fetch(`/api/artifacts/file?path=${encodeURIComponent(path)}`, { cache: "no-store", headers: auth ? { authorization: "Bearer " + auth } : {}, signal: abort.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const blob = await response.blob();
    if (generation !== mediaGeneration) return;
    P.urls.set(path, URL.createObjectURL(blob));
    render();
  } catch (error) { if (generation === mediaGeneration && error.name !== "AbortError") toast(error.message); }
  finally { if (P.loading.get(path) === abort) P.loading.delete(path); }
}
/** The picture cards under a reply whose tool calls made pictures. */
export function pictureCards(m, messages) {
  ensureMediaScope();
  const all = messages.flatMap((x) => (x.toolCalls ?? []).map((c) => madePicture(c, messages))).filter(Boolean);
  return (m.toolCalls ?? []).map((c) => madePicture(c, messages)).filter(Boolean).map((pic) => {
    const versions = all.filter((p) => p.prompt === pic.prompt).slice(-4);
    for (const v of versions) pictureUrl(v.path);
    const key = pic.path, main = versions.find((v) => v.path === P.pick.get(key)) ?? pic;
    const src = (p) => (P.urls.has(p.path) ? ` src="${esc(P.urls.get(p.path))}"` : "");
    const vars = versions.length > 1 ? `<div class="img6-vars">${versions.map((v, i) => `<button type="button" data-act="img-pick" data-id="${esc(key)}" data-v="${esc(v.path)}" aria-pressed="${v.path === main.path}"><img${src(v)} alt="${esc(t("window.chat.img.version", { n: i + 1 }))}"></button>`).join("")}</div>` : "";
    return `<div class="b"><div class="gut"></div><div><div class="card img6"><div class="card-h"><b>${esc(pic.prompt)}</b><span class="pill idle ml">${t("window.chat.img.picture")}</span></div><img class="img6-main"${src(main)} alt="${esc(pic.prompt)}">${vars}
      <div class="acts"><button class="btn sm" type="button" data-act="img-save">${t("window.diagram.save-to-library")}</button><button class="btn sm" type="button" data-act="img-bg">${t("window.chat.img.background")}</button><button class="btn ghost sm" type="button" data-act="img-again" data-v="${esc(pic.prompt)}">${t("window.chat.img.again")}</button></div>${pic.model ? `<p class="hint" data-css="margin:6px 0 0">${esc(t("window.chat.img.made-with", { model: pic.model }))}</p>` : ""}</div></div></div>`;
  }).join("");
}

/* ---------- sound and video attached to a message ---------- */
const M = new Map(); // "<session>/<id>" -> { name, kind, session, id, url, el, dur, peaks, loading }
const BARS = 38;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const playable = (a) => a && (a.kind === "sound" || a.kind === "video" || /^(audio|video)\//.test(a.mediaType ?? ""));

/* The rows under a message for each sound or video it carries; `session` is the conversation it belongs to. */
export function mediaRows(m, session = S.chat) {
  ensureMediaScope();
  if (!session || !Array.isArray(m.attachments)) return "";
  return m.attachments.filter(playable).map((a) => {
    const key = `${session}/${a.id}`;
    if (!M.has(key)) M.set(key, { name: a.name ?? "", kind: /^video\//.test(a.mediaType ?? "") || a.kind === "video" ? "video" : "audio", session, id: a.id });
    return `<div class="u umedia15">${mediaCard(key)}</div>`;
  }).join("");
}

function bar(key, st) {
  const at = st.el?.currentTime ?? 0;
  const pct = st.dur ? Math.min(100, (at / st.dur) * 100) : 0;
  const slider = `data-act="mseek15" data-id="${esc(key)}" role="slider" aria-label="${t("window.chat.media.position")}" aria-valuemin="0" aria-valuemax="${Math.round(st.dur ?? 0)}" aria-valuenow="${Math.round(at)}" tabindex="0"`;
  if (st.kind === "audio") return `<div class="m-wave15" ${slider}>${(st.peaks ?? []).map((h, i) => `<i data-css="height:${h}%" class="${(i / BARS) * 100 < pct ? "on" : ""}"></i>`).join("")}</div>`;
  return `<div class="m-track15" ${slider}><u data-css="width:${pct}%"></u></div>`;
}
function mediaCard(key) {
  const st = M.get(key);
  const playing = st.el && !st.el.paused;
  const glyph = ic(playing ? "pause15" : "play15");
  const ctl = `<button type="button" class="m-play15" data-act="mplay15" data-id="${esc(key)}" aria-label="${playing ? t("window.chat.media.pause", { name: esc(st.name) }) : t("window.chat.media.play", { name: esc(st.name) })}">${glyph}</button>`;
  const time = st.dur ? `<span class="m-time15">${mmss(st.el?.currentTime ?? 0)} / ${mmss(st.dur)}</span>` : "";
  const poster = st.kind === "video" ? `<div class="m-poster15" data-act="mplay15" data-id="${esc(key)}"><span class="m-big15">${glyph}</span></div>` : "";
  return `<div class="media15 ${st.kind} mine15" data-m15="${esc(key)}">${poster}<div class="m-row15">${ctl}${bar(key, st)}${time}</div><div class="m-name15">${ic("chip15", "s")}${esc(st.name)}</div></div>`;
}

/* Redraws one card where it stands; a video keeps its own element, moved back into the new poster. */
function repaint(key) {
  const st = M.get(key);
  if (!st) return;
  for (const node of $$(`[data-m15="${CSS.escape(key)}"]`)) {
    const focused = node.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    const holder = document.createElement("div");
    holder.innerHTML = mediaCard(key);
    applyCss(holder);
    const fresh = holder.firstElementChild;
    node.replaceWith(fresh);
    mountVideo(fresh, st);
    if (focused) fresh.querySelector(`[data-act="${focused}"]`)?.focus();
  }
}
function mountVideo(card, st) {
  if (st.kind !== "video" || !st.el) return;
  const poster = card.querySelector(".m-poster15");
  if (poster && st.el.parentNode !== poster) poster.prepend(st.el);
}

async function fileOf(st, signal) {
  const auth = token.get();
  const response = await fetch(`/api/attachments/file?session=${encodeURIComponent(st.session)}&id=${encodeURIComponent(st.id)}`, { cache: "no-store", headers: auth ? { authorization: "Bearer " + auth } : {}, signal });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
  return response.blob();
}
async function peaksOf(blob) {
  const context = new AudioContext();
  try {
    const sound = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = sound.getChannelData(0);
    const size = Math.max(1, Math.floor(samples.length / BARS));
    const loud = Array.from({ length: BARS }, (_, i) => { let top = 0; for (let j = i * size; j < (i + 1) * size && j < samples.length; j++) top = Math.max(top, Math.abs(samples[j])); return top; });
    const most = Math.max(...loud) || 1;
    return loud.map((v) => Math.round(12 + (v / most) * 88));
  } finally { context.close(); }
}

/* Fetches the file once, reads its length (and, for sound, its waveform), and redraws the card. */
async function load(key) {
  const st = M.get(key);
  if (!st || st.el || st.loading) return st?.loading;
  const generation = mediaGeneration;
  st.abort = new AbortController();
  st.loading = (async () => {
    const blob = await fileOf(st, st.abort.signal);
    if (generation !== mediaGeneration) return;
    st.url = URL.createObjectURL(blob);
    if (st.kind === "audio") st.peaks = await peaksOf(blob);
    if (generation !== mediaGeneration) return;
    const el = document.createElement(st.kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.playsInline = true;
    st.el = el;
    const ready = new Promise((done, fail) => {
      st.cancelMetadata = () => fail(new DOMException("Media no longer shown", "AbortError"));
      el.addEventListener("loadedmetadata", done, { once: true });
      el.addEventListener("error", () => fail(new Error(el.error?.message || "error")), { once: true });
    });
    el.src = st.url;
    await ready;
    st.cancelMetadata = null;
    if (generation !== mediaGeneration) return;
    st.dur = el.duration;
    for (const kind of ["play", "pause", "timeupdate", "ended"]) el.addEventListener(kind, () => repaint(key));
    repaint(key);
  })();
  try { await st.loading; }
  catch (error) {
    if (generation === mediaGeneration) {
      releaseMediaState(st);
      if (error.name !== "AbortError") toast(error.message);
    }
  }
  finally { st.loading = null; st.cancelMetadata = null; }
}

async function playPause(el) {
  const key = el.dataset.id;
  if (!M.get(key)?.el) await load(key);
  const media = M.get(key)?.el;
  if (!media) return;
  if (media.paused) media.play().catch((error) => toast(error.message));
  else media.pause();
}
function seekTo(key, seconds) {
  const st = M.get(key);
  if (!st?.el || !st.dur) return;
  st.el.currentTime = Math.max(0, Math.min(st.dur, seconds));
  repaint(key);
}
async function seek(el, event) {
  const key = el.dataset.id;
  if (!M.get(key)?.el) await load(key);
  const r = el.getBoundingClientRect();
  const x = (event?.clientX ?? r.left) - r.left;
  seekTo(key, (x / r.width) * (M.get(key)?.dur ?? 0));
}

/* After a draw, cards not yet read fetch their file so they can show their length and waveform. */
function mountMedia() {
  for (const card of $$("[data-m15]")) {
    const st = M.get(card.dataset.m15);
    if (!st) continue;
    if (st.el) mountVideo(card, st);
    else load(card.dataset.m15);
  }
}

/* ---------- attach-anything: the other files a message carries ---------- */
/* Pictures show in the thread; any other file is a chip that saves it (GET /api/attachments/file, handed over as a download
   for anything that could carry script). The same route serves the desktop app, which lets only this page's own downloads
   through, with the system's save dialog (src/desktop/main.ts). */
const F = { urls: new Map(), loading: new Map() };
const SHOWN = /^image\/(png|jpeg|webp|gif)$/;
const fsize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export function fileRows(m, session = S.chat) {
  ensureMediaScope();
  if (!session || !Array.isArray(m.attachments)) return "";
  const rest = m.attachments.filter((a) => !playable(a));
  if (!rest.length) return "";
  return `<div class="u-files">${rest.map((a) => {
    const key = `${session}/${a.id}`;
    if (SHOWN.test(a.mediaType ?? "")) {
      if (!F.urls.has(key)) pictureOf(key, session, a.id);
      return F.urls.get(key) ? `<img src="${esc(F.urls.get(key))}" alt="${esc(a.name)}">` : "";
    }
    return `<button class="file" type="button" data-act="attsave" data-s="${esc(session)}" data-id="${esc(a.id)}" data-n="${esc(a.name)}" aria-label="${t("window.chat.plus.save", { name: esc(a.name) })}"><span class="fi">${esc((a.name.split(".").pop() || a.kind).slice(0, 6))}</span><span><b>${esc(a.name)}</b><small>${fsize(a.bytes ?? 0)}</small></span></button>`;
  }).join("")}</div>`;
}
async function pictureOf(key, session, id) {
  if (F.loading.has(key)) return;
  const generation = mediaGeneration, abort = new AbortController();
  F.loading.set(key, abort);
  try {
    const blob = await fileOf({ session, id }, abort.signal);
    if (generation !== mediaGeneration) return;
    F.urls.set(key, URL.createObjectURL(blob)); render();
  }
  /* Said once: a picture that cannot be opened (a household profile cannot open the owner's files) is not asked for again. */
  catch (error) { if (generation === mediaGeneration && error.name !== "AbortError") { F.urls.set(key, ""); toast(error.message); } }
  finally { if (F.loading.get(key) === abort) F.loading.delete(key); }
}
async function saveFile(el) {
  try {
    const url = URL.createObjectURL(await fileOf({ session: el.dataset.s, id: el.dataset.id }));
    const a = Object.assign(document.createElement("a"), { href: url, download: (el.dataset.n || "file").split("/").pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { toast(error.message); }
}

/* Conversation-owned caches have no reason to keep blobs or decoders after navigation.
   Generation checks also prevent a completed old request from restoring a released cache. */
function releaseMediaState(st) {
  st.abort?.abort(); st.cancelMetadata?.();
  if (st.el) { st.el.pause(); st.el.removeAttribute("src"); st.el.load(); st.el.remove(); }
  if (st.url) URL.revokeObjectURL(st.url);
  st.el = null; st.url = null; st.peaks = null; st.dur = null;
}
function releaseMedia() {
  mediaGeneration++;
  const states = [...M.values()];
  M.clear();
  for (const st of states) releaseMediaState(st);
  for (const cache of [P, F]) {
    for (const abort of cache.loading.values()) abort.abort();
    for (const url of cache.urls.values()) if (url) URL.revokeObjectURL(url);
    cache.loading.clear(); cache.urls.clear();
  }
  P.pick.clear();
}
function ensureMediaScope() {
  const scope = JSON.stringify([S.view, S.chat, E.profiles?.active?.id ?? null]);
  if (scope === mediaScope) return;
  releaseMedia();
  mediaScope = scope;
}

/* ---------- @ references in the draft ---------- */
const R = { mentions: null, checked: 0 };
const matOf = (s) => [...new Set(((s || "").match(/@(\S+)/g) || []).map((x) => x.slice(1)).filter((x) => x === "diff" || /[./]/.test(x)))];
async function mentionsOn() {
  if (Date.now() - R.checked < 15000) return R.mentions;
  R.checked = Date.now();
  try { R.mentions = (await api("coding")).modes?.mentions ?? "off"; } catch (error) { toast(error.message); }
  return R.mentions;
}
/* The material chips for what the draft points at; drawn into the dock row. */
export function materials(draft = S.drafts[S.chat ?? "new"]) {
  const mats = matOf(draft);
  if (!mats.length) return "";
  if (Date.now() - R.checked >= 15000) mentionsOn().then((was) => { if (was !== R.mentions) document.dispatchEvent(new Event("branch-dock")); });
  const chips = mats.map((m) => `<span class="mat15">${ic(m === "diff" ? "branch" : m.startsWith("http") ? "globe" : "doc", "s")}<span>${esc(m === "diff" ? t("window.chat.media.changes") : m.split("/").pop() || m)}</span><button type="button" aria-label="${t("window.chat.media.remove", { name: esc(m) })}" data-act="matrm15" data-v="${esc(m)}">${ic("x", "s")}</button></span>`).join("");
  return chips + (R.mentions && R.mentions !== "off" ? `<small class="mat-n15">${t("window.chat.media.material")}</small>` : "");
}
function removeMaterial(el) {
  const box = $("#prompt");
  if (!box) return;
  box.value = box.value.replace("@" + el.dataset.v, "").replace(/\s{2,}/g, " ");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

export function initMedia() {
  on("attsave", (el) => saveFile(el));
  markLive(["attsave", "sw:img-q", "sw:off-in15", "imagine", "img-go", "office15", "offk15", "offgo15", "mplay15", "mseek15", "matrm15", "img-pick", "img-again"]);
  on("img-pick", (el) => { P.pick.set(el.dataset.id, el.dataset.v); render(); });
  on("img-again", (el) => { if (el.dataset.v) sendAsMessage(`Make a picture: ${el.dataset.v}`); });
  on("imagine", () => openImagine());
  on("img-go", () => makePicture());
  on("office15", () => openOffice());
  on("offk15", (el) => pickKind(el));
  on("offgo15", () => writeFile());
  on("mplay15", (el) => playPause(el));
  on("mseek15", (el, event) => seek(el, event));
  on("matrm15", (el) => removeMaterial(el));
  onRender(() => { ensureMediaScope(); queueMicrotask(mountMedia); });
  addEventListener("pagehide", () => { releaseMedia(); mediaScope = null; });
  addEventListener("pageshow", (event) => { if (event.persisted) render(); });
  document.addEventListener("keydown", (e) => {
    const track = e.target.closest?.(".m-wave15, .m-track15");
    if (!track || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const st = M.get(track.dataset.id);
    if (st?.el) seekTo(track.dataset.id, st.el.currentTime + (e.key === "ArrowRight" ? 5 : -5));
  });
}
