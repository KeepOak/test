/* What lives behind the glass and at the foot of the list, 1:1 with the prototype's: a painted scene behind the window
   when the engine's background is on (GET/POST /api/delight/settings keeps on, scrim and fit), and the pet walking along
   the list when the engine's pet is on. Which painted scene, the season and where the pet walks are the window's own
   (FEATURE-AUDIT: scene-set, season, petwhere15), kept in this browser; your own file is shell/ownbg.js. A pat, and
   following the computer's light or dark (shell/look.js), are told to the engine (POST /api/delight/noticed, which
   counts them when achievements are on). */

import { $, esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { effMode } from "./look.js";
import { OWN, loadOwn } from "./ownbg.js";
import { media17, fill17 } from "../core/art17.js";
import { PETS, petOf, petLabel, petKindName, sproutLoop, pixelCanvas, paintPixels, stepWhile } from "../core/pets.js";
import { t } from "../../i18n.js";
import { say as inWords } from "../core/words.js";

const KEY = "branch-scene";
export const W = { bg: "painted", scene: "auto", season: "auto", petWhere: "side" };
export const D = { settings: null, earned: null, asked: false };

/* The painted scenes: the four groves and the night from /art, and the extra scenes in /art/bg. */
export const SCENES = [["auto", "By the season", ""], ["spring", "Spring grove", "/art/grove-spring.webp"], ["autumn", "Autumn grove", "/art/grove-autumn.webp"],
  ["winter", "Winter grove", "/art/grove-winter.webp"], ["night", "Firefly night", "/art/grove-night.webp"], ["summer", "Summer Meadow", "/art/bg/grove-summer.webp"],
  ["rain", "Rainy Forest", "/art/bg/grove-rain.webp"], ["lake", "Mountain Lake", "/art/bg/grove-lake.webp"], ["blossom", "Blossoming Grove", "/art/bg/grove-blossom.webp"],
  ["canyon", "Desert Canyon", "/art/bg/grove-canyon.webp"], ["snownight", "Snowy Night", "/art/bg/grove-snownight.webp"], ["bamboo", "Bamboo Grove", "/art/bg/grove-bamboo.webp"],
  ["hills", "Sunflower Hills", "/art/bg/grove-hills.webp"], ["night17-lake", "Still lake at night", "/art/bg/lake-night.webp"], ["night17-highland", "Moonlit highland", "/art/bg/highland-moon.webp"],
  ["day17-sea", "Morning sea", "/art/bg/sea-morning.webp"], ["day17-meadow", "Meadow afternoon", "/art/bg/meadow-afternoon.webp"],
  ["glow17-amber", "Amber glass", "/art/bg/glow-amber.webp"], ["season17-snow", "First snow", "/art/bg/first-snow.webp"]];
const PAINT = { spring: "spring", summer: "spring", autumn: "autumn", winter: "winter" };
const seasonNow = () => (W.season !== "auto" ? W.season : ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"][new Date().getMonth()]);
function paintFile() {
  const picked = SCENES.find((s) => s[0] === W.scene);
  if (picked?.[2]) return picked[2];
  return `/art/grove-${effMode() === "dark" ? "night" : PAINT[seasonNow()] || "spring"}.webp`;
}

export function saveWindow() {
  try { localStorage.setItem(KEY, JSON.stringify(W)); } catch (error) { toast(error.message); }
}
function loadWindow() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (error) { toast(error.message); }
  if (["painted", "none", "own"].includes(saved?.bg)) W.bg = saved.bg;
  if (SCENES.some((s) => s[0] === saved?.scene)) W.scene = saved.scene;
  if (["auto", "spring", "autumn", "winter"].includes(saved?.season)) W.season = saved.season;
  if (["side", "status"].includes(saved?.petWhere)) W.petWhere = saved.petWhere;
}

/* The engine's delight switches, read once the window is let in and after every change. */
let seenState = null;
export async function loadDelight() {
  if (D.asked || !E.loaded) return;
  D.asked = true;
  seenState = E.state;
  loadWindow();
  try { const d = await api("delight"); D.settings = d.settings ?? null; D.earned = d.earned ?? null; } catch (error) { toast(error.message); }
  try { await loadOwn(); } catch (error) { toast(error.message); }
}
/* Read again after each refresh (the engine's events refresh the window), so a switch changed elsewhere, such as in
   the terminal, reaches an open window. Redraws only when the switches changed. */
let reading = null;
export function followDelight() {
  if (!D.asked || !E.state || E.state === seenState) return reading ?? Promise.resolve();
  seenState = E.state;
  reading = rereadDelight().finally(() => { reading = null; });
  return reading;
}
async function rereadDelight() {
  const before = JSON.stringify(D.settings);
  try { const d = await api("delight"); D.settings = d.settings ?? null; D.earned = d.earned ?? null; } catch (error) { toast(error.message); }
  if (JSON.stringify(D.settings) !== before) render();
}
/* Changes only the parts named; the engine merges each part into what it has. */
export async function saveDelight(part) {
  try { D.settings = (await api("delight/settings", part)).settings; } catch (error) { toast(error.message); }
}

/* A painted scene picked (Settings › Appearance, setup's Make it yours): this window keeps which one, and the engine's
   background switch is turned on first if it is off, then the scene is drawn behind the glass. */
export async function pickScene(v) {
  if (!SCENES.some((s) => s[0] === v)) return;
  W.scene = v;
  W.bg = "painted";
  saveWindow();
  if (!D.settings?.background?.on) await saveDelight({ background: { on: true } });
  drawBackground();
}
/* The painted scenes as the gallery's cards, each a still of its picture; "By the season" shows its four groves. Pass 17's
   six carry the prototype's small "New" mark (markNew17 marks every scene card, setup's too); no other scene does. */
const NEW_SCENES17 = new Set(["night17-lake", "night17-highland", "day17-sea", "day17-meadow", "glow17-amber", "season17-snow"]);
export function sceneCards(act, isOn, mark = (v) => (NEW_SCENES17.has(v) ? " new17e" : "")) {
  const face = (f) => (f ? `<span class="sc-img12" data-css="background-image:url('${f}')"></span>`
    : `<span class="sc-img12 sc-auto12">${["spring", "autumn", "winter", "night"].map((k) => `<i data-css="background-image:url('/art/grove-${k}.webp')"></i>`).join("")}</span>`);
  return SCENES.map(([v, n, f]) => `<button type="button" class="scene-c12${mark(v)}" data-act="${act}" data-v="${v}" aria-pressed="${!!isOn(v)}">${face(f)}<b>${esc(inWords(n))}</b></button>`).join("");
}

/* The pets (core/pets.js) as the prototype's gallery shows them (petGallery12, with pass 17e's): None, Little Branch, the
   painted pets, pass 17's six (marked New, as markNew17 marks only those) and the three pixel pets, drawn on their canvas.
   A picture's walk plays on hover unless motion is reduced. `kind` is the one shown now ("none" while the pet is off). */
export const petNow = () => (D.settings?.pets?.on && petOf(D.settings.pets.kind) ? D.settings.pets.kind : "none");
export function petCard(v, l, kind, act = "petset") {
  const p = petOf(v);
  const face = !p ? `<span class="pet-px12">—</span>` : p.pixel ? pixelCanvas(p.kind, 'class="pet-pxc12" aria-hidden="true"')
    : `<img src="${p.still}" alt="" loading="lazy" draggable="false" data-hov="${p.walk}">`;
  return `<button type="button" class="pet-c12${p?.isNew ? " new17e" : ""}" data-act="${act}" data-v="${esc(v)}" aria-pressed="${kind === v}">${face}<b>${esc(l)}</b></button>`;
}
export const petChoices = () => [["none", t("comfort.placeholder.none")], ...PETS.map((p) => [p.kind, petLabel(p)])];
/* Saves the pet as the engine keeps it: off, or on as one kind; a new pet says hello, as the prototype's does. */
export async function pickPet(v) {
  await saveDelight({ pets: v === "none" ? { on: false } : { on: true, kind: v } });
  if (v !== "none" && D.settings?.pets?.on) setTimeout(() => say(t("window.shell.scene.hi-im-name-click-me-for-a", { name: D.settings.pets.name })), 200);
}

/* What "Behind the glass" has chosen: none while the engine's switch is off, else the painted grove or your own. */
export const bgChoice = () => (D.settings?.background?.on ? W.bg : "none");
export const showsBackground = () => bgChoice() === "painted" || (bgChoice() === "own" && !!OWN.url);
const calm = () => !!E.state?.preferences?.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Your own file: a video plays muted in a loop (paused while things are kept still); a picture or an animation fills,
   fits or repeats as the engine's fit says. */
function drawOwn(layer, fit) {
  const { saved } = OWN;
  if (saved.kind === "video") {
    const v = Object.assign(document.createElement("video"), { src: OWN.url, muted: true, loop: true, playsInline: true, autoplay: !calm() });
    v.className = `bg-media fit-${fit === "fit" ? "fit" : "fill"}`;
    layer.prepend(v);
    return;
  }
  const d = Object.assign(document.createElement("div"), { className: `bg-media bg-img fit-${fit}` });
  d.style.backgroundImage = `url("${OWN.url}")`;
  layer.prepend(d);
}

/* The layer behind the window: made once, redrawn only when what it shows changes. */
let layerKey = "";
export function drawBackground() {
  const app = document.getElementById("app");
  let layer = $("#bgLayer");
  const on = showsBackground();
  app.classList.toggle("has-bg", on);
  if (!on) { layer?.remove(); layerKey = ""; return; }
  if (!layer) { layer = Object.assign(document.createElement("div"), { id: "bgLayer" }); app.prepend(layer); layerKey = ""; }
  layer.style.setProperty("--scrim", (D.settings.background.scrim ?? 60) / 100);
  const own = bgChoice() === "own", fit = D.settings.background.fit ?? "fill";
  const key = own ? `own|${OWN.url}|${fit}|${calm()}` : paintFile() + "|" + calm();
  if (key === layerKey) return;
  layerKey = key;
  if (own) { layer.innerHTML = '<div class="bg-scrim"></div>'; drawOwn(layer, fit); return; }
  layer.innerHTML = `<div class="paint11 ${calm() ? "" : "drift11"}"></div><div class="bg-scrim"></div>`;
  layer.firstElementChild.style.backgroundImage = `url("${paintFile()}")`;
}

/* ---------- the pet ---------- */
/* Every kind the gallery offers (core/pets.js): a pixel pet on its canvas, a picture pet as its walk loop, Little Branch as
   Branch's own loops. What it is doing follows the prototype's wantPet11: a moment of cheer after a Trunk finishes
   (shell/cheer.js), working while a run is running (a walk loop plays faster, Little Branch works), a nap after a minute
   with no click or key (it stops, a "z" floats up, a walk loop pauses, Little Branch sleeps), else walking. */
const P = { x: 0, dir: 1, say: "", until: 0, cool: 0, mood: "walk", moodNow: "", moodUntil: 0, hopUntil: 0, input: Date.now() };
const hidden = (part) => (E.state?.preferences?.hidden ?? []).includes(part);
stepWhile(() => !!D.settings?.pets?.on);
export function petShown() { const p = D.settings?.pets; return !!(p?.on && petOf(p.kind) && !hidden("pet")); }
function wantPet() {
  if (Date.now() < P.moodUntil) return P.moodNow;
  if ((E.state?.runs ?? []).some((r) => r.status === "running")) return "work";
  if (Date.now() - P.input > 60000) return "sleep";
  return "walk";
}
/* A mood for a while (the cheer's "yay", with a hop), then back to what it is doing. A redraw keeps both. */
export function petMood(mood, ms, hop = 0) {
  P.moodNow = mood;
  P.moodUntil = Date.now() + ms;
  P.hopUntil = Date.now() + hop;
  applyMood();
  if (hop) setTimeout(applyMood, hop + 20);
}
["pointerdown", "keydown"].forEach((ev) => addEventListener(ev, () => { P.input = Date.now(); if (P.mood === "sleep") applyMood(); }, true));

/* The pet's markup, drawn inside the list's foot or the status bar by whichever region W.petWhere names. */
export function petHTML(where) {
  if (!petShown() || W.petWhere !== where) return "";
  const p = D.settings.pets, pet = petOf(p.kind), mood = wantPet(), speaking = P.say && Date.now() < P.until;
  const label = esc(t("window.shell.scene.name-the-kind-click-for-a", { name: p.name, kind: petKindName(p.kind).toLowerCase() }));
  const button = `role="button" tabindex="0" aria-label="${label}" data-act="pat"`;
  const body = pet.pixel ? pixelCanvas(pet.kind, `id="pet-cv" ${button}`)
    : `<span class="pet17" ${button}>${media17(pet.still, pet.sprout ? sproutLoop(mood) : pet.walk, pet.sprout ? "pet-vid11" : "pet-vid11 pet12")}</span>`;
  const box = `<div class="petbox ${P.dir < 0 ? "flip" : ""} ${mood === "sleep" ? "zz11" : ""} ${Date.now() < P.hopUntil ? "hop11" : ""}" data-hide="pet" data-kind="${esc(pet.kind)}" ${where === "side" ? `data-css="left:${8 + P.x}px"` : ""}><span class="pet-say" id="pet-say" ${speaking ? "" : "hidden"}>${esc(P.say)}</span>${body}</div>`;
  return where === "side" ? `<div class="keeper">${box}</div>` : box;
}
export function drawPet() {
  syncWalker();
  document.body.classList.toggle("pet-status15", petShown() && W.petWhere === "status");
  applyMood();
  paintPixels();
}
/* What it is doing, laid on the drawn pet without drawing it again: the nap's "z", Little Branch's loop, a loop's pace. */
function applyMood() {
  const m = wantPet(), box = $(".petbox"), pet = petOf(D.settings?.pets?.kind);
  P.mood = m;
  if (!box || !pet) return;
  box.classList.toggle("zz11", m === "sleep");
  box.classList.toggle("hop11", Date.now() < P.hopUntil);
  if (pet.sprout) {
    const slot = box.querySelector("[data-m17]");
    if (slot && slot.dataset.m17Loop !== sproutLoop(m)) { slot.dataset.m17Loop = sproutLoop(m); fill17(box); }
    return;
  }
  const v = box.querySelector("video");
  if (!v) return;
  if (m === "sleep") { if (!v.paused) v.pause(); return; }
  v.playbackRate = m === "work" ? 1.6 : 1;
  if (v.paused) v.play().catch((error) => console.warn(error.message));
}

/* What the pet says: a Trunk that needs a yes first, else a tip that is true of this window. */
function petWords() {
  const waiting = (E.state?.attention ?? []).find((w) => !w.parentRunId); // a helper's question is not in the Inbox
  if (waiting) return t("window.shell.scene.who-needs-a-yes-its-in", { who: waiting.who || "Branch" });
  return [t("window.shell.scene.ctrl-k-finds-anything-even-settings"), t("window.shell.scene.hover-anything-to-see-what-it")][Math.floor(Date.now() / 60000) % 2];
}
export function say(text) {
  P.say = text;
  P.until = Date.now() + 6500;
  const el = $("#pet-say");
  if (el) { el.textContent = text; el.hidden = false; }
}
/* Something the window saw, told to the engine (POST /api/delight/noticed, the shapes in src/delight.ts NoticeSchema).
   The engine keeps it only while achievements are on, so nothing is sent while they are off. The switch may have been
   turned on elsewhere since it was read, so "off" is asked again before anything is dropped. A flag is told once per
   window: the engine counts it once (src/delight.ts notice). */
const toldFlags = new Set();
export async function noticed(what) {
  if (what.what === "flag" && toldFlags.has(what.flag)) return;
  if (!D.settings?.achievements?.on) await rereadDelight();
  if (!D.settings?.achievements?.on) return;
  try {
    const answer = await api("delight/noticed", what);
    if (answer?.kept && what.what === "flag") toldFlags.add(what.flag);
  } catch (error) { toast(error.message); }
}
export async function pat() {
  say(petWords());
  await noticed({ what: "pat" });
}

/* It walks, unless things are kept still or it naps; it speaks up by itself when a Trunk needs you, at most every five
   minutes. The timer runs only while the pet is shown. */
let walker = null;
function syncWalker() {
  const want = petShown();
  if (want && !walker) walker = setInterval(walk, 360);
  else if (!want && walker) { clearInterval(walker); walker = null; }
}
function walk() {
  const box = $(".petbox");
  if (!box) return;
  applyMood();
  const bubble = $("#pet-say");
  if (bubble && !bubble.hidden && Date.now() > P.until) bubble.hidden = true;
  if (Date.now() > P.cool && bubble?.hidden && (E.state?.attention ?? []).some((w) => !w.parentRunId)) { P.cool = Date.now() + 300000; say(petWords()); }
  if (calm() || P.mood === "sleep") return;
  const max = Math.max(8, (box.parentElement?.clientWidth ?? 120) - 56);
  P.x += P.dir * 6;
  if (P.x + 8 > max) P.dir = -1;
  if (P.x < 0) { P.x = 0; P.dir = 1; }
  if (W.petWhere === "side") box.style.left = 8 + P.x + "px";
  box.classList.toggle("flip", P.dir < 0);
}
