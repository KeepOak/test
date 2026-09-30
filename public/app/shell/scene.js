/* What lives behind the glass and at the foot of the list, 1:1 with the prototype's: a painted scene behind the window
   when the engine's background is on (GET/POST /api/delight/settings keeps on, scrim and fit), and the pet walking along
   the list when the engine's pet is on. Which painted scene, the season and where the pet walks are the window's own
   (FEATURE-AUDIT: scene-set, season, petwhere15), kept in this browser; your own file is shell/ownbg.js. A pat, and
   following the computer's light or dark (shell/look.js), are told to the engine (POST /api/delight/noticed, which
   counts them when achievements are on). */

import { $, esc, render } from "../core/dom.js";
import { E, S, ownerHere, ownName, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { effMode } from "./look.js";
import { OWN, loadOwn } from "./ownbg.js";
import { media17 } from "../core/art17.js";
import { voxelPet, drawVoxel, setVisualStyle } from "../core/voxel-models.js";
import { PETS, petOf, petLabel, petKindName, pixelCanvas, paintPixels, stepWhile } from "../core/pets.js";
import { t } from "../../i18n.js";
import { windowRest, onRest } from "../core/sleep.js";
import { play17 } from "../core/held.js";
import { say as inWords } from "../core/words.js";
import { binding, spoken } from "./keys.js";
import { petLine, hintLine, hintDue } from "./pettalk.js";
import { popupsOn } from "../flows/guides.js";
import { DRAWN, drawDrawn, drawnKey, stopDrawn, drawScenery } from "./procbg.js";

const KEY = "branch-scene";
export const W = { bg: "painted", scene: "auto", season: "auto", petWhere: "side", scenery: true };
export const D = { settings: null, earned: null, rank: null, asked: false };

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
  if (["painted", "none", "own", ...DRAWN].includes(saved?.bg)) W.bg = saved.bg;
  if (SCENES.some((s) => s[0] === saved?.scene)) W.scene = saved.scene;
  if (["auto", "spring", "summer", "autumn", "winter"].includes(saved?.season)) W.season = saved.season;
  if (["side", "status", "dock"].includes(saved?.petWhere)) W.petWhere = saved.petWhere;
  if (typeof saved?.scenery === "boolean") W.scenery = saved.scenery;
}

/* The engine's delight switches, read once the window is let in and after every change. */
let seenState = null;
export async function loadDelight() {
  if (D.asked || !E.loaded) return;
  D.asked = true;
  seenState = E.state;
  loadWindow();
  try { const d = await api("delight"); D.settings = d.settings ?? null; D.earned = d.earned ?? null; D.rank = d.rank ?? null; } catch (error) { toast(error.message); }
  setVisualStyle(D.settings?.look?.style);
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
  try { const d = await api("delight"); D.settings = d.settings ?? null; D.earned = d.earned ?? null; D.rank = d.rank ?? null; } catch (error) { toast(error.message); }
  setVisualStyle(D.settings?.look?.style);
  if (JSON.stringify(D.settings) !== before) render();
}
/* Changes only the parts named; the engine merges each part into what it has. */
export async function saveDelight(part) {
  const who = activeId(), owner = ownerHere();
  try {
    const got = await api("delight/settings", part);
    if (who !== activeId() || owner !== ownerHere() || !S.signedIn || $("#app")?.classList.contains("locked-b17")) return;
    D.settings = got.settings;
  } catch (error) { toast(error.message); }
  setVisualStyle(D.settings?.look?.style);
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

/* The pets (core/pets.js): None, the
   painted pets, pass 17's six (marked New, as markNew17 marks only those) and the three pixel pets, drawn on their canvas.
   A picture's walk plays on hover unless motion is reduced. `kind` is the one shown now ("none" while the pet is off). */
export const petNow = () => (D.settings?.pets?.on ? petOf(D.settings.pets.kind)?.kind ?? "none" : "none");
export function petCard(v, l, kind, act = "petset") {
  const p = petOf(v);
  const face = !p ? `<span class="pet-px12">—</span>` : p.pixel ? (D.settings?.look?.style === "3d" ? voxelPet(p.kind, 'class="pet-pxc12" aria-hidden="true"') : pixelCanvas(p.kind, 'class="pet-pxc12" aria-hidden="true"'))
    : `<img src="${p.still}" alt="" loading="lazy" draggable="false" data-hov="${p.walk}">`;
  return `<button type="button" class="pet-c12${p?.isNew ? " new17e" : ""}" data-act="${act}" data-v="${esc(v)}" aria-pressed="${kind === v}">${face}<b>${esc(l)}</b></button>`;
}
export const petChoices = () => [["none", t("comfort.placeholder.none")], ...PETS.map((p) => [p.kind, petLabel(p)])];
/* Saves the pet as the engine keeps it: off, or on as one kind; a new pet says hello, as the prototype's does. */
export async function pickPet(v) {
  await saveDelight({ pets: v === "none" ? { on: false } : { on: true, kind: v } });
  if (v !== "none" && D.settings?.pets?.on) setTimeout(() => say(t("window.shell.scene.hi-im-name-click-me-for-a", { name: D.settings.pets.name })), 200);
}

/* What "Behind the glass" has chosen: none while the engine's switch is off, else the painted grove, one of the drawn
   ones (shell/procbg.js) or your own. */
export const bgChoice = () => (D.settings?.background?.on ? W.bg : "none");
/* The oak's season on screen: the painted grove by the season, or one season's grove, in daylight (Moonlight shows the
   night grove). Null when no oak is shown. For the "The oak in …" achievements (shell/notices.js). */
const OAK_SCENES = ["spring", "autumn", "winter"];
export const oakSeason = () => (bgChoice() !== "painted" || effMode() === "dark" ? null
  : W.scene === "auto" ? seasonNow() : OAK_SCENES.includes(W.scene) ? W.scene : null);
export const showsBackground = () => bgChoice() === "painted" || DRAWN.includes(bgChoice()) || (bgChoice() === "own" && !!OWN.url);
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
  if (!on) { stopDrawn(); layer?.remove(); layerKey = ""; return; }
  if (!layer) { layer = Object.assign(document.createElement("div"), { id: "bgLayer" }); app.prepend(layer); layerKey = ""; }
  layer.style.setProperty("--scrim", (D.settings.background.scrim ?? 60) / 100);
  const own = bgChoice() === "own", fit = D.settings.background.fit ?? "fill", drawn = DRAWN.includes(bgChoice());
  const key = own ? `own|${OWN.url}|${fit}|${calm()}` : drawn ? drawnKey(bgChoice(), seasonNow(), effMode() === "dark", calm(), app.clientWidth > 700) : paintFile() + "|" + calm();
  if (key === layerKey) return;
  layerKey = key;
  stopDrawn();
  if (drawn) {
    layer.innerHTML = "";
    const canvas = bgChoice() === "oak3d" ? Object.assign(document.createElement("canvas"), { width:512, height:512, className:"voxel-oak" }) : null;
    if (canvas) layer.append(canvas);
    if (!canvas || !drawVoxel(canvas, "oak")) { canvas?.remove(); drawDrawn(layer, bgChoice(), { season: seasonNow(), dark: effMode() === "dark", still: calm() }); }
    layer.insertAdjacentHTML("beforeend", '<div class="bg-scrim"></div>'); return;
  }
  if (own) { layer.innerHTML = '<div class="bg-scrim"></div>'; drawOwn(layer, fit); return; }
  layer.innerHTML = `<div class="paint11 ${calm() ? "" : "drift11"}"></div><div class="bg-scrim"></div>`;
  layer.firstElementChild.style.backgroundImage = `url("${paintFile()}")`;
}

/* The scenery behind the list (Settings › Appearance › What's shown): a small pixel oak at the list's foot, painted by
   shell/procbg.js drawScenery once its canvas is drawn. */
export const sceneryHTML = () => (W.scenery ? '<canvas class="scenery" id="scenery" width="146" height="60" aria-hidden="true"></canvas>' : "");
export const paintScenery = () => drawScenery($("#scenery"));

/* ---------- the pet ---------- */
/* Every kind the gallery offers (core/pets.js): a pixel pet on its canvas or a picture pet as its walk loop.
   A moment of cheer follows a Trunk finishing (shell/cheer.js). Once the window sleeps the pet stops,
   a "z" floats up and its walk loop pauses. A running task makes the walk loop play faster; otherwise it walks. */
const P = { x: 0, dir: 1, say: "", until: 0, cool: 0, mood: "walk", moodNow: "", moodUntil: 0, hopUntil: 0 };
const hidden = (part) => (E.state?.preferences?.hidden ?? []).includes(part);
stepWhile(() => !!D.settings?.pets?.on);
export function petShown() { const p = D.settings?.pets; return !!(p?.on && petOf(p.kind) && !hidden("pet")); }
function wantPet() {
  if (Date.now() < P.moodUntil) return P.moodNow;
  if (windowRest() !== "awake") return "sleep";
  if ((E.state?.runs ?? []).some((r) => r.status === "running")) return "work";
  return "walk";
}
/* A mood for a while (the cheer's "yay", with a hop), then back to what it is doing. A redraw keeps both. */
export function petMood(mood, ms, hop = 0) {
  if (!petShown()) return; // no pet, nothing to cheer and nothing ticking
  P.moodNow = mood;
  P.moodUntil = Date.now() + ms;
  P.hopUntil = Date.now() + hop;
  applyMood();
  if (hop) setTimeout(applyMood, hop + 20);
}
onRest(() => drawPet());

/* The pet's markup, drawn in the owner row at the list's foot, the status bar or by the message box (the chat's dock
   hook, chat/chat.js addDockItem) by whichever region W.petWhere names. */
export function petHTML(where) {
  if (!petShown() || W.petWhere !== where) return "";
  const p = D.settings.pets, pet = petOf(p.kind), speaking = P.say && Date.now() < P.until;
  const tips = hintDue({ ...facts(), lastHint: 0 }); // "Click for a tip" only while this rank still gets them
  const label = esc(t(tips ? "window.shell.scene.name-the-kind-click-for-a" : "window.shell.scene.name-the-kind", { name: p.name, kind: petKindName(p.kind).toLowerCase() }));
  const button = `role="button" tabindex="0" aria-label="${label}" data-act="pat"`;
  const body = pet.pixel ? (D.settings?.look?.style === "3d" ? voxelPet(pet.kind, `id="pet-cv" ${button}`) : pixelCanvas(pet.kind, `id="pet-cv" ${button}`))
    : `<span class="pet17" ${button}>${media17(pet.still, pet.walk, "pet-vid11 pet12")}</span>`;
  /* Where it has walked to, which way it faces and what it is doing are put on the drawn box by placePet() and
     applyMood(), not written into the markup, so a step does not make the sidebar's markup differ (it is drawn again only
     when that changes, core/dom.js). */
  const box = `<div class="petbox" data-hide="pet" data-kind="${esc(pet.kind)}"><span class="pet-say" id="pet-say" ${speaking ? "" : "hidden"}>${esc(P.say)}</span>${body}</div>`;
  return where === "side" ? `<div class="keeper">${box}</div>` : box;
}
/* It walks by transform, which moves it without laying the window out again; walking by `left` laid out the page on
   every frame of every step (about 2.5 s a minute with a long conversation open). */
function placePet(box) {
  box.classList.toggle("flip", P.dir < 0);
  const to = W.petWhere === "side" ? `translateX(${P.x}px)` : "";
  if (box.dataset.placed) { box.style.transform = to; return; }
  /* A box just drawn starts where the pet already stands; only a step slides. Placed through its transition, a redrawn
     list slid the pet in from its edge each time, a sleeping pet too (tests/window-sleep.test.mjs). */
  box.dataset.placed = "1";
  box.style.transition = "none";
  box.style.transform = to;
  getComputedStyle(box).transform; // the start is taken without a transition
  box.style.transition = "";
}
export function drawPet() {
  syncWalker();
  const box = $(".petbox");
  if (box) placePet(box);
  document.body.classList.toggle("pet-status15", petShown() && W.petWhere === "status");
  document.body.classList.toggle("pet-dock15", petShown() && W.petWhere === "dock" && S.view === "chat");
  applyMood();
  paintPixels();
}
/* What it is doing, laid on the drawn pet without drawing it again: the nap's "z" and the loop's pace. */
function applyMood() {
  const m = wantPet(), box = $(".petbox"), pet = petOf(D.settings?.pets?.kind);
  P.mood = m;
  if (!box || !pet) return;
  box.classList.toggle("zz11", m === "sleep");
  box.classList.toggle("hop11", Date.now() < P.hopUntil);
  const v = box.querySelector("video");
  if (!v) return;
  if (m === "sleep") { if (!v.paused) v.pause(); return; }
  v.playbackRate = m === "work" ? 1.6 : 1;
  if (v.paused && !v.dataset.off13 && !document.hidden) play17(v).catch((error) => console.warn(error.message)); // not while off screen (core/pets.js) or hidden
}

/* What is happening, for the pet's words (shell/pettalk.js): who waits for a yes (a helper's question is not in the Inbox),
   Lockdown, whether a model can answer, the work going on, where the owner is, the owner's rank (GET /api/delight rank)
   and when the last hint was said (kept in this browser, so an hour is an hour across reloads). */
const HINT_KEY = "branch-pet-hint";
const lastHint = () => { try { return Number(localStorage.getItem(HINT_KEY)) || 0; } catch { return 0; } };
const hintSaid = () => { try { localStorage.setItem(HINT_KEY, String(Date.now())); } catch { /* storage refused: the hour is kept only while open */ } P.hintAt = Date.now(); };
function facts() {
  const runs = (E.state?.runs ?? []).filter((r) => r.status === "running" && !r.parentRunId);
  const key = (action) => { const combo = binding(action); return combo ? spoken(combo) : ""; }; // the owner may move a key, or take it away
  return {
    waiting: (E.state?.attention ?? []).filter((w) => !w.parentRunId),
    lockdown: !!document.getElementById("app")?.classList.contains("locked"),
    noModel: !!E.state?.modelNeeded, // the engine's own "no model yet" (chat/nomodel.js reads the same)
    running: runs.map((r) => ({ who: ownName(r.sessionId) || E.state?.identity?.name || "" })),
    view: S.view, owner: ownerHere(),
    keys: { palette: key("palette"), sideList: key("sideList") },
    rank: D.rank ?? "Bronze", tipsOn: popupsOn(), lastHint: Math.max(lastHint(), P.hintAt ?? 0), at: Date.now(),
  };
}
const words = (key, values) => t(key, values);
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
/* A pat: the news of the moment, else a hint when one is due; with nothing to say it only hops. */
export async function pat() {
  const line = petLine(facts(), words);
  if (line) say(line.text);
  if (line?.kind === "hint") hintSaid();
  await noticed({ what: "pat" });
}

/* It walks, unless things are kept still or it naps; it speaks up by itself when a Trunk needs you, at most every five
   minutes, and with a hint when one is due (at most hourly, and never in its first two minutes on screen). The timer
   runs only while the pet is shown. */
let walker = null;
function syncWalker() {
  const want = petShown() && windowRest() === "awake"; // asleep, it naps where it stands
  if (want && !walker) walker = setInterval(walk, 360);
  else if (!want && walker) { clearInterval(walker); walker = null; }
}
function speakUp() {
  const now = facts();
  if (Date.now() > P.cool && now.waiting.length) { P.cool = Date.now() + 300000; say(petLine(now, words).text); return; }
  P.shownAt ??= Date.now();
  if (Date.now() - P.shownAt < 120000) return;
  const hint = hintLine(now, words);
  if (hint) { say(hint.text); hintSaid(); }
}
function walk() {
  const box = $(".petbox");
  if (!box || document.hidden) return; // nobody sees it walk while the window is hidden
  applyMood();
  const bubble = $("#pet-say");
  if (bubble && !bubble.hidden && Date.now() > P.until) bubble.hidden = true;
  if (bubble?.hidden) speakUp();
  if (calm() || P.mood === "sleep") return;
  const max = Math.max(8, (box.parentElement?.clientWidth ?? 120) - 56);
  P.x += P.dir * 6;
  if (P.x + 8 > max) P.dir = -1;
  if (P.x < 0) { P.x = 0; P.dir = 1; }
  placePet(box);
}
