/* The drawn backgrounds behind the glass, 1:1 with the prototype's bgGrove, groveAir, bgOak and bgRings: the grove (one
   pixel oak on a low hill, dressed for the season, with its petals, leaves, snow or fireflies drifting), the oak turning
   slowly in 3D and the growth rings. Each is drawn on a canvas in the theme's own colours. What moves stops while things
   are kept still, while the window is hidden and while it rests (core/sleep.js), and starts again when it wakes. */

import { mixC } from "./look.js";
import { windowRest, onRest } from "../core/sleep.js";

export const DRAWN = ["grove", "oak3d", "rings"];

let stop = null, parked = null;
export function stopDrawn() { if (stop) { stop(); stop = null; } parked = null; }

/* Decorative scenery holds its last frame behind setup/dialogs. A timer wakes each drawing, rather than a RAF on
   every display frame: even skipped RAF callbacks can keep Chromium's glass compositor busy. */
function loop(fn, fps) {
  let raf = 0, timer = 0, on = true;
  const blocked = () => document.hidden || windowRest() !== "awake" ||
    !!document.querySelector("#app > .scrim, #app > .ob9");
  const clear = () => { cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0; };
  const start = () => {
    if (!on) return;
    if (blocked()) { clear(); parked = start; return; }
    if (!raf && !timer) raf = requestAnimationFrame(tick);
  };
  const tick = (t) => {
    raf = 0;
    if (!on || blocked()) { if (on) parked = start; return; }
    fn(t);
    timer = setTimeout(() => { timer = 0; start(); }, Math.max(0, t + 1000 / fps - performance.now()));
  };
  // Both overlays are direct app children; observing this boundary avoids watching every changing face or message.
  const observer = new MutationObserver(start), app = document.getElementById("app");
  if (app) observer.observe(app, { childList: true });
  document.addEventListener("visibilitychange", start);
  start();
  return () => {
    on = false; clear(); observer.disconnect(); document.removeEventListener("visibilitychange", start);
    if (parked === start) parked = null;
  };
}
onRest(() => { if (parked && windowRest() === "awake") { const go = parked; parked = null; go(); } });

const colours = (dark) => {
  const cs = getComputedStyle(document.documentElement), g = (k) => cs.getPropertyValue(k).trim();
  return { side: g("--side"), bg: g("--bg"), ink: g("--ink"), ink3: g("--ink-3"), accent: g("--accent"), ok: g("--ok"), warn: g("--warn"), dark };
};
/* What the drawing depends on, so the layer is drawn again only when one of them changes. */
export const drawnKey = (kind, season, dark, still, wide) => [kind, season, dark, still, wide, JSON.stringify(colours(dark))].join("|");

function seeded(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function rgb(c) { const m = /^#([0-9a-f]{6})$/i.exec(mixC(c, c, 0)); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [128, 128, 128]; }
function pixCanvas(layer, scale) {
  const cv = document.createElement("canvas");
  cv.className = "pix";
  cv.width = Math.max(120, Math.ceil(layer.clientWidth / scale));
  cv.height = Math.max(80, Math.ceil(layer.clientHeight / scale));
  layer.appendChild(cv);
  return cv;
}

/* The grove's sky, its hill and its oak, drawn once. */
function groveStill(g, W, H, k, season, rnd) {
  const ORD = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], th = (x, y) => (ORD[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
  const skyA = k.dark ? mixC(k.side, "#000000", 0.25) : mixC(k.side, "#FFFFFF", 0.35), skyB = mixC(k.side, k.ok, k.dark ? 0.16 : 0.22);
  const img = g.createImageData(W, H), A = rgb(skyA), B = rgb(skyB);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = th(x, y) < y / H ? B : A, i = (y * W + x) * 4; img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  if (k.dark) { g.fillStyle = mixC(k.ink, k.side, 0.45); for (let i = 0; i < 60; i++) g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H * 0.55), 1, 1); }
  const sx = Math.round(W * 0.8), sy = Math.round(H * 0.2), sr = Math.max(6, Math.round(H * 0.06));
  g.fillStyle = k.dark ? mixC(k.ink, k.side, 0.12) : mixC(k.accent, "#FFFFFF", 0.62); g.beginPath(); g.arc(sx, sy, sr, 0, 7); g.fill();
  if (k.dark) { g.fillStyle = skyA; g.beginPath(); g.arc(sx + sr * 0.45, sy - sr * 0.25, sr * 0.85, 0, 7); g.fill(); }
  const hillY = (x) => H * 0.8 - Math.sin((x / W) * Math.PI) * H * 0.12 - Math.sin(x / 23) * 1.5;
  const hillA = mixC(k.side, k.ok, k.dark ? 0.3 : 0.42), hillB = mixC(hillA, "#000000", 0.12);
  for (let x = 0; x < W; x++) { const top = Math.round(hillY(x)); for (let y = top; y < H; y++) { g.fillStyle = (y - top < 3 && th(x, y) < 0.5) || (y - top >= 3 && th(x, y) < ((y - top) / (H - top)) * 0.6) ? hillB : hillA; g.fillRect(x, y, 1, 1); } }
  groveOak(g, W, H, k, season, rnd, th, hillY);
  if (season === "winter") { g.fillStyle = mixC("#FFFFFF", k.side, 0.08); for (let x = 0; x < W; x++) g.fillRect(x, Math.round(hillY(x)), 1, 2); }
}
function groveOak(g, W, H, k, season, rnd, th, hillY) {
  const ox = Math.round(W * 0.7), base = Math.round(hillY(ox)), half = Math.max(3, Math.round(W * 0.014)), trunkH = Math.round(H * 0.2);
  g.fillStyle = mixC(k.ink, k.side, 0.5); g.fillRect(ox - half, base - trunkH, half * 2, trunkH);
  const limb = (x, y, dx, dy, w) => { for (let i = 0; i < 18; i++) g.fillRect(Math.round(x + (dx * i) / 18), Math.round(y + (dy * i) / 18), w, w); };
  limb(ox, base - trunkH * 0.7, -W * 0.06, -H * 0.12, 2); limb(ox, base - trunkH * 0.8, W * 0.07, -H * 0.1, 2); limb(ox, base - trunkH, 0, -H * 0.12, 2);
  const leaf = { spring: [mixC(k.ok, "#FFFFFF", 0.25), mixC(k.ok, "#FFFFFF", 0.45)], summer: [mixC(k.ok, "#000000", 0.2), k.ok], autumn: [k.accent, k.warn], winter: null }[season];
  if (leaf) for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI, r = rnd() * H * 0.15, cx = ox + Math.cos(a) * r * 1.5, cy = base - trunkH - H * 0.03 - Math.sin(a) * r, rr = H * (0.035 + rnd() * 0.035);
    for (let y = -rr; y < rr; y++) for (let x = -rr; x < rr; x++) if (x * x + y * y < rr * rr) { g.fillStyle = th(Math.round(cx + x), Math.round(cy + y)) < 0.5 + (y / rr) * 0.35 ? leaf[1] : leaf[0]; g.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1); }
  }
  if (season === "spring") { g.fillStyle = "#F2A7C3"; for (let i = 0; i < 40; i++) g.fillRect(Math.round(ox + (rnd() - 0.5) * H * 0.42), Math.round(base - trunkH - H * 0.02 - rnd() * H * 0.2), 1, 1); }
}
/* What drifts through the grove: petals in spring, leaves in autumn, snow in winter, fireflies on a summer night. */
function groveAir(cv, season, k, still) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, rnd = seeded(11);
  const kind = season === "summer" ? (k.dark ? "fly" : null) : { spring: "petal", autumn: "leaf", winter: "snow" }[season];
  if (!kind) return;
  const col = { fly: "#F7E27A", petal: "#F2A7C3", leaf: k.accent, snow: "#FFFFFF" }[kind];
  const motes = Array.from({ length: kind === "snow" ? 70 : 34 }, () => ({ x: rnd() * W, y: rnd() * H, v: 0.2 + rnd() * 0.5, p: rnd() * 6.28 }));
  const frame = (t) => {
    g.clearRect(0, 0, W, H);
    for (const m of motes) {
      if (kind === "fly") { m.x += Math.cos(t / 900 + m.p) * 0.25; m.y += Math.sin(t / 1100 + m.p) * 0.18; g.globalAlpha = 0.45 + 0.55 * Math.max(0, Math.sin(t / 400 + m.p * 3)); }
      else { m.y += m.v * (kind === "snow" ? 0.6 : 0.8); m.x += Math.sin(t / 700 + m.p) * 0.3; if (m.y > H) { m.y = -2; m.x = rnd() * W; } g.globalAlpha = kind === "snow" ? 0.85 : 0.9; }
      g.fillStyle = kind === "leaf" && m.p > 3 ? k.warn : col;
      g.fillRect(Math.round(m.x), Math.round(m.y), kind === "leaf" ? 2 : 1, 1);
    }
    g.globalAlpha = 1;
  };
  frame(0);
  if (!still) stop = loop(frame, 16);
}
function grove(layer, { season, dark, still }) {
  const cv = pixCanvas(layer, 3), air = pixCanvas(layer, 3), k = colours(dark);
  groveStill(cv.getContext("2d"), cv.width, cv.height, k, season, seeded(7));
  groveAir(air, season, k, still);
}

/* The oak, turning slowly behind the glass: points of bark and leaf, turned and drawn back to front. */
function oakPoints(rnd) {
  const pts = [];
  for (let i = 0; i < 260; i++) { const a = rnd() * 6.28, y = rnd() * 1.6; pts.push([Math.cos(a) * 0.12 * (1.2 - y / 3), 1.6 - y, Math.sin(a) * 0.12, "b"]); }
  for (const [cx, cy, cz, r] of [[0, 0.15, 0, 0.95], [-0.55, 0.05, 0.2, 0.6], [0.55, 0.1, -0.15, 0.62], [0.1, -0.35, 0.45, 0.55], [-0.2, -0.25, -0.5, 0.55], [0, -0.55, 0, 0.6]]) {
    for (let i = 0; i < 330; i++) { const u = rnd() * 6.28, v = Math.acos(2 * rnd() - 1), rr = r * Math.cbrt(rnd()); pts.push([cx + rr * Math.sin(v) * Math.cos(u), cy - 0.15 + rr * Math.cos(v) * 0.8, cz + rr * Math.sin(v) * Math.sin(u), "l"]); }
  }
  return pts;
}
function oak(layer, { dark, still }) {
  const cv = pixCanvas(layer, 2), g = cv.getContext("2d"), W = cv.width, H = cv.height, k = colours(dark), pts = oakPoints(seeded(3));
  const leafA = mixC(k.ok, k.side, 0.15), leafB = mixC(k.ok, "#000000", 0.35), bark = mixC(k.ink, k.side, 0.45), cx = W * 0.68, cy = H * 0.5, sc = Math.min(W, H) * 0.32;
  let a = 0.6;
  const frame = () => {
    g.clearRect(0, 0, W, H); a += 0.006;
    g.fillStyle = mixC(k.side, "#000000", k.dark ? 0.3 : 0.08); g.beginPath(); g.ellipse(cx, cy + sc * 1.65, sc * 0.9, sc * 0.16, 0, 0, 7); g.fill();
    const ca = Math.cos(a), sa = Math.sin(a);
    pts.map(([x, y, z, t]) => { const X = x * ca + z * sa, Z = -x * sa + z * ca, f = 3.4 / (3.4 + Z); return [cx + X * sc * f, cy + y * sc * f, Z, t]; })
      .sort((p, q) => q[2] - p[2])
      .forEach(([x, y, z, t]) => { g.fillStyle = t === "b" ? bark : mixC(leafA, leafB, Math.min(1, Math.max(0, (z + 1) / 2))); g.fillRect(Math.round(x), Math.round(y), 2, 2); });
  };
  frame();
  if (!still) stop = loop(frame, 20);
}

/* The growth rings: a still cross-section of the trunk, in the theme's lines with its accent at the heart. */
function rings(layer, { dark }) {
  const cv = document.createElement("canvas"), k = colours(dark);
  cv.width = 480; cv.height = 300;
  layer.appendChild(cv);
  const g = cv.getContext("2d");
  g.fillStyle = k.side; g.fillRect(0, 0, 480, 300); g.strokeStyle = k.ink3; g.globalAlpha = 0.35;
  for (let r = 8; r < 420; r += 7 + Math.sin(r / 9) * 3) { g.beginPath(); g.ellipse(360, 230, r * 1.1, r * 0.9, 0.2, 0, Math.PI * 2); g.stroke(); }
  g.globalAlpha = 1; g.fillStyle = k.accent; g.beginPath(); g.arc(360, 230, 4, 0, 7); g.fill();
}

/* Draws `kind` into the layer (emptied first by the caller), stopping whatever moved before. */
export function drawDrawn(layer, kind, opts) {
  stopDrawn();
  ({ grove, oak3d: oak, rings })[kind]?.(layer, opts);
}

/* The scenery behind the list: the prototype's small pixel oak at the foot of the list, drawn again only when its
   canvas is new or the colours changed. */
export function drawScenery(cv) {
  if (!cv) return;
  const cs = getComputedStyle(document.documentElement), v = (k, d) => cs.getPropertyValue(k).trim() || d;
  const leaf = v("--ok", "#2F8F5B"), trunk = v("--ink-3", "#8A857F"), ground = v("--line-2", "#D7CFC5"), berry = v("--accent", "#D8612A");
  const key = [leaf, trunk, ground, berry].join("|");
  if (cv.dataset.k === key) return;
  cv.dataset.k = key;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, 146, 60);
  // The ground fades in from the left, where the scene starts part-way across the list.
  g.fillStyle = ground; for (let x = 0; x < 146; x++) { const h = 8 + Math.round(3 * Math.sin(x / 14)); g.globalAlpha = Math.min(1, x / 36); g.fillRect(x, 60 - h, 1, h); }
  g.globalAlpha = 1;
  g.fillStyle = trunk; g.fillRect(104, 30, 4, 24); g.fillRect(100, 40, 4, 2); g.fillRect(108, 36, 4, 2);
  g.fillStyle = leaf;
  const blobs = [[106, 24, 13], [95, 29, 8], [117, 28, 9], [106, 15, 8]];
  for (let y = 0; y < 60; y++) for (let x = 78; x < 134; x++) if (blobs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 < r * r) && (x * 7 + y * 3) % 11 !== 0) g.fillRect(x, y, 1, 1);
  g.fillStyle = berry; for (const [x, y] of [[100, 26], [112, 22], [109, 31]]) g.fillRect(x, y, 2, 2);
}
