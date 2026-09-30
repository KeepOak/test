/* The pets: the 34 painted pets of pass 12 (DATA12.pets), pass 17's six and the three pixel pets. The engine keeps which
   one (GET/POST /api/delight/settings pets.kind, src/achievements.ts petKinds); a kind is the prototype's id, and the
   painted squirrel is "pet-squirrel", its key there, as "squirrel" is the pixel one.
   A picture pet is a still and a walk loop from /art/pets. Branch's mascot belongs only in the logo.
   A pixel pet is drawn from its rows of letters and its colours onto a small canvas, as the prototype's drawPet does,
   and moves by the frame: its feet step while it walks, and it holds still while it naps or motion is reduced. Any
   canvas marked data-px="<kind>" is painted as it lands, so a region redrawn with innerHTML is never left blank. */

import { t } from "../../i18n.js";
import { E } from "./state.js";
import { windowRest, sleeps, onRest } from "./sleep.js";
import { hold17, play17 } from "./held.js";

const PAINTED = ["mossfrog", "leafhog", "fennec", "otter", "capybara", "cloverbun", "owlet", "shellsnail", "jelly", "cloudsheep",
  "pebblecrab", "caterpillar", "sprigdragon", "turtle", "penguin", "puppy", "kitten", "raccoon", "koala", "sloth", "fruitbat",
  "bumblebee", "beetle", "duckling", "hamster", "sealpup", "octopus", "chameleon", "firefly", "dustbunny", "mossgolem", "narwhal",
  "squirrel", "elephant"];
/* Pass 17's six carry the prototype's small "New" mark (markNew17); no other pet does. */
const NEW17 = ["redpanda", "pangolin", "quokka", "acornling", "goatkid", "piglet"];

/* The prototype's pixel pets: each row a line of the sprite, each letter a colour, "." see-through. */
export const PIXEL = {
  squirrel: { px: ["............", ".......oo...", "......oooo..", "..o..ooeooo.", ".ooo.ooooob.", ".oooooooooo.", "..oooobbooo.", "...oooobbo..", "...oo..oo...", "............"], col: { o: "#B8652B", b: "#F2D0AE", e: "#1B1A18" } },
  owl: { px: ["............", "...o....o...", "...oooooo...", "..owwowwoo..", "..oweoweoo..", "..oooyyooo..", "..obbbbbbo..", "..obbbbbbo..", "...oo..oo...", "............"], col: { o: "#6E5A45", w: "#F4EDE0", e: "#1B1A18", y: "#E0A33B", b: "#A38B6C" } },
  hedgehog: { px: ["............", "...s.s.s....", "..sssssss...", ".sssssssss..", ".ssssssssfe.", ".sssssssffff", "..ffffffff..", "...f.ff.f...", "............", "............"], col: { s: "#5B4A3B", f: "#D9B48F", e: "#1B1A18" } },
};

const picture = (id, kind = id) => ({ kind, still: `/art/pets/${id}.webp`, walk: `/art/pets/${id}-walk.webm`, isNew: NEW17.includes(id) });
/* In the gallery's order. */
export const PETS = [
  ...PAINTED.map((id) => picture(id, id === "squirrel" ? "pet-squirrel" : id)),
  ...NEW17.map((id) => picture(id)),
  ...Object.keys(PIXEL).map((kind) => ({ kind, pixel: true })),
];
/* Display an old mascot choice as a regular pet without rewriting its saved name or switches. */
export const petOf = (kind) => PETS.find((p) => p.kind === (kind === "sprout" ? "fennec" : kind));
/* The name the gallery shows: "Pixel squirrel" for a pixel pet, the pet's own name otherwise. */
export const petLabel = (p) => t(p.pixel ? `window.settings.appearance.pixel-${p.kind}` : `delight.pet.kind.${p.kind}`);
/* The kind in a sentence ("Hazel the squirrel"). */
export const petKindName = (kind) => t(`delight.pet.kind.${petOf(kind)?.kind ?? kind}`);

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");
export const calmPets = () => !!E.state?.preferences?.reduceMotion || REDUCE.matches;

/* A pixel pet's canvas; the frame steps its feet unless it naps. */
export const pixelCanvas = (kind, attrs = "") => `<canvas data-px="${PIXEL[kind] ? kind : ""}" width="24" height="20" ${attrs}></canvas>`;
/* The row its feet are on, the last one drawn: the prototype steps the rows below the eighth, which are the squirrel's and
   the owl's feet; the hedgehog's stand a row higher, so the same step is taken from its own feet. */
const feet = (p) => p.px.findLastIndex((row) => /[^.]/.test(row));
export function paintPixel(cv, frame) {
  const p = PIXEL[cv.dataset.px];
  if (!p) return;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, 24, 20);
  const step = frame % 2 && !cv.closest(".zz11") && stepping() ? 1 : 0, low = feet(p);
  p.px.forEach((row, y) => [...row].forEach((ch, x) => { const c = p.col[ch]; if (!c) return; g.fillStyle = c; g.fillRect(x * 2, y * 2 - (step && y >= low ? 1 : 0), 2, 2); }));
  cv.dataset.frame = String(frame);
}

/* One light timer for every pixel canvas on screen, running only while one is there, motion is welcome and the pet is
   switched on (shell/scene.js says so): switched off, nothing of delight ticks, and the gallery's pixel pets stand still. */
let frame = 0, ticker = null, petsOn = () => false;
export const stepWhile = (on) => { petsOn = on; };
const stepping = () => petsOn() && !calmPets() && !document.hidden && windowRest() === "awake"; // nobody sees it step while the window is hidden or asleep
const canvases = () => document.querySelectorAll("canvas[data-px]");
function tick() {
  frame++;
  const all = canvases();
  all.forEach((cv) => paintPixel(cv, frame));
  if (!all.length || !stepping()) { clearInterval(ticker); ticker = null; }
}
export function paintPixels() {
  canvases().forEach((cv) => { if (cv.dataset.frame !== String(frame)) paintPixel(cv, frame); });
  if (!ticker && canvases().length && stepping()) ticker = setInterval(tick, 360);
}
new MutationObserver(paintPixels).observe(document.body, { childList: true, subtree: true });
REDUCE.addEventListener?.("change", paintPixels);
document.addEventListener("visibilitychange", paintPixels);
onRest(paintPixels);

/* Only loops you can see play: pets and feature pictures pause off screen or folded away, and start
   again only if this paused them, so a napping pet stays still. (A hidden window pauses every loop, core/art17.js; the
   Trunks' own figures are not touched here.) A loop paused here is marked data-off13; whoever plays a loop again leaves
   a marked one alone. */
const LOOPS = ".petbox video, .pets12 video, .ob-pets15 video, .cheer11 video, .hero11 video, .ob-stage11 video, .slot17e video";
const resume = (v) => { if (!document.hidden && !v.dataset.off13 && !calmPets() && !v.closest(".zz11") && !sleeps(v)) play17(v).catch((error) => console.warn(error.message)); };
const onScreen = new IntersectionObserver((seen) => seen.forEach(({ target: v, isIntersecting }) => {
  if (isIntersecting) { if (v.dataset.off13) { delete v.dataset.off13; resume(v); } }
  else if (!v.paused) { v.dataset.off13 = "1"; hold17(v); }
}), { rootMargin: "120px" });
new MutationObserver(() => document.querySelectorAll(LOOPS).forEach((v) => onScreen.observe(v))).observe(document.body, { childList: true, subtree: true });
