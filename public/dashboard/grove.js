/* The dashboard's own copy of what was public/grove.js before the old window was removed (#291), served at /dashboard/grove.js. */
/* The grove behind Branch Agent's glass: one pixel oak on a low hill, under the moon at night or a pale
   sun by day, dressed for the season. Everything is drawn here from the theme's own colours (the ground,
   the text, the accent and the "good" green), at a third of the screen's size and scaled up square, so
   it reads as pixel art on any screen. A second, transparent canvas carries what moves: fireflies in
   summer, petals in spring, leaves in autumn, snow in winter. public/layout.js calls paintGrove(). */

const wall = document.getElementById("wall");
const air = document.getElementById("wall-fx");
const SCALE = 3;
/* The usual 4×4 ordered-dither threshold map, so two colours can make a smooth-looking step. */
const ORDER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const threshold = (x, y) => (ORDER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";

let look = { season: "summer", mode: "dark" };
let scene = null;
let motes = [];

/* ---------- colour ---------- */
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
/** Any CSS colour the theme wrote, as [r, g, b]. Every name read here is on :root in /tokens.css, which the page links
    first, so no colour is written down in this file. */
function rgb(value) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "transparent"; /* nothing left over from the last colour read */
  if (value) probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function palette() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => rgb(style.getPropertyValue(name).trim());
  const ground = read("--ground"), text = read("--text");
  const accent = read("--copper"), green = read("--ok");
  const dark = look.mode !== "light";
  /* Night skies deepen toward the top; day skies pale toward the top. */
  const sky = dark ? [mix(ground, [0, 0, 0], 0.35), mix(ground, text, 0.08)] : [mix(ground, [255, 255, 255], 0.55), ground];
  return { dark, ground, text, accent, green, sky };
}
function seeded(seed) {
  let s = seed;
  return () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
}

/* ---------- the still picture ---------- */
function paintGrove(next = {}) {
  look = { ...look, ...next };
  if (!wall || !innerWidth || !innerHeight) return;
  const W = Math.ceil(innerWidth / SCALE), H = Math.ceil(innerHeight / SCALE);
  wall.width = W;
  wall.height = H;
  const ctx = wall.getContext("2d");
  const img = ctx.createImageData(W, H);
  const P = palette();
  const U = Math.min(W, H * 1.15);
  const tall = W / H < 0.9;
  scene = { W, H, U, P, horizon: H * (tall ? 0.74 : 0.8), tx: W * (tall ? 0.5 : 0.62), random: seeded(9161) };
  const put = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  };
  scene.put = put;
  paintSky(scene);
  paintHills(scene);
  paintGround(scene);
  paintOak(scene);
  ctx.putImageData(img, 0, 0);
  seedMotes();
}
/** A smooth band between two colours, dithered so the step between them never shows. */
function dithered(scene, x, y, from, to, t) {
  scene.put(x, y, t > threshold(x, y) ? to : from);
}
function paintSky(s) {
  const { W, P, horizon, U } = s;
  for (let y = 0; y < horizon; y++)
    for (let x = 0; x < W; x++) dithered(s, x, y, P.sky[0], P.sky[1], y / horizon);
  /* the moon, or a pale sun, with a soft ring, only where it can be seen as sky (see moonInView) */
  const cx = W * 0.18, cy = horizon * 0.24, r = Math.max(4, U * 0.045);
  const disc = P.dark ? mix(P.text, P.accent, 0.12) : mix([255, 255, 255], P.accent, 0.18);
  if (wall) wall.dataset.moon = moonInView() ? "shown" : "hidden";
  if (wall?.dataset.moon === "shown") for (let y = Math.floor(cy - r * 2.6); y < cy + r * 2.6; y++)
    for (let x = Math.floor(cx - r * 2.6); x < cx + r * 2.6; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) s.put(x, y, disc);
      else if (d < r * 2.6) dithered(s, x, y, P.sky[1], mix(P.sky[1], disc, 0.35), (1 - (d - r) / (r * 1.6)) * 0.55);
    }
  if (!P.dark) return;
  const star = mix(P.sky[0], P.text, 0.6);
  for (let n = 0; n < W * horizon * 0.0016; n++) s.put(s.random() * W, s.random() * horizon * 0.8, star);
}
/**
 * In the calm window the glass panes cover the whole sky, so wherever the moon sat it only showed as
 * a stray glow through a pane or a sliver in a gap between two. It is left out there, and comes back
 * with the sky itself: when the view is cleared, and in the full window as it always was.
 */
function moonInView() {
  const root = document.documentElement.dataset;
  return root.everything === "on" || Boolean(root.quiet);
}
function paintHills(s) {
  const { W, H, P, horizon } = s;
  const layers = [[0.1, 0.055, 1.3, P.dark ? 0.16 : 0.2], [0.05, 0.03, 4.1, P.dark ? 0.09 : 0.3]];
  for (const [height, wave, phase, depth] of layers) {
    const colour = P.dark ? mix(P.ground, P.text, depth) : mix(P.ground, P.green, depth);
    for (let x = 0; x < W; x++) {
      const top = horizon - H * (height + wave * Math.sin(x * 0.011 + phase) + wave * 0.4 * Math.sin(x * 0.037 + phase * 2));
      for (let y = Math.floor(top); y < horizon; y++) dithered(s, x, y, colour, mix(colour, P.sky[1], 0.4), (horizon - y) / (horizon - top + 1) * 0.5);
    }
  }
}
function paintGround(s) {
  const { W, H, P, horizon } = s;
  const winter = look.season === "winter";
  const base = winter ? mix(P.ground, P.text, P.dark ? 0.26 : 0.06) : P.dark ? mix(P.ground, P.green, 0.14) : mix(P.ground, P.green, 0.35);
  const deep = winter ? mix(base, P.ground, 0.35) : mix(base, [0, 0, 0], 0.35);
  for (let y = Math.floor(horizon); y < H; y++)
    for (let x = 0; x < W; x++) dithered(s, x, y, base, deep, (y - horizon) / (H - horizon));
  const tuft = winter ? mix(base, P.text, 0.4) : mix(base, P.green, 0.5);
  for (let n = 0; n < W * 0.35; n++) {
    const x = s.random() * W, y = horizon + s.random() * (H - horizon);
    s.put(x, y, tuft);
    s.put(x, y - 1, tuft);
  }
  if (look.season === "autumn")
    for (let n = 0; n < W * 0.25; n++)
      s.put(s.tx + (s.random() - 0.5) * s.U * 0.9, horizon + s.random() * (H - horizon) * 0.5, mix(P.accent, P.ground, s.random() * 0.4));
}

/* ---------- the oak ---------- */
function paintOak(s) {
  const { P, U, horizon, tx } = s;
  const bark = P.dark ? mix(P.ground, [0, 0, 0], 0.25) : mix(P.text, P.ground, 0.25);
  const lit = mix(bark, P.text, P.dark ? 0.18 : 0.3);
  const tips = [];
  /* an oak is short in the trunk and wide in the crown */
  limb(s, tx, horizon + 2, -Math.PI / 2, U * 0.1, U * 0.034, 0, tips, bark, lit);
  if (look.season === "winter") return frost(s, tips);
  const leaves = leafTones(P);
  const share = { spring: 0.82, summer: 1, autumn: 0.7 }[look.season] ?? 1;
  for (const tip of tips) if (s.random() < share) crown(s, tip, leaves);
  if (look.season === "spring") blossom(s, tips);
}
/** One limb, then two or three smaller ones from its end, down to twigs. */
function limb(s, x, y, angle, length, width, depth, tips, bark, lit) {
  const steps = Math.max(2, Math.ceil(length));
  let px = x, py = y;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, w = Math.max(0.6, width * (1 - t * 0.45));
    const bend = Math.sin(t * 3 + depth) * 0.08;
    px = x + Math.cos(angle + bend) * length * t;
    py = y + Math.sin(angle + bend) * length * t;
    for (let dx = -w; dx <= w; dx++) s.put(px + dx, py, dx < -w * 0.3 ? lit : bark);
  }
  if (depth >= 5 || width < 0.7) return tips.push({ x: px, y: py, depth });
  if (depth >= 2) tips.push({ x: (x + px) / 2, y: (y + py) / 2, depth }, { x: px, y: py, depth });
  const count = depth === 0 ? 4 : 2 + (s.random() < 0.45 ? 1 : 0);
  /* the first limbs reach out sideways, the way an open-grown oak spreads */
  const fan = depth === 0 ? 0.62 : 0.5;
  for (let n = 0; n < count; n++) {
    const spread = (n - (count - 1) / 2) * (fan + s.random() * 0.25) + (s.random() - 0.5) * 0.18;
    /* limbs climb or reach out, but never hang below level */
    const heading = Math.max(-Math.PI + 0.3, Math.min(-0.3, angle + spread));
    const reach = depth === 0 ? 0.95 : 0.72;
    limb(s, px, py, heading, length * (reach + s.random() * 0.1), width * 0.64, depth + 1, tips, bark, lit);
  }
}
/* Shadow, body and lit edge of the crown. At night everything sits closer to the ground's own colour. */
function leafTones(P) {
  const night = P.dark ? 1 : 0.55;
  if (look.season === "autumn") return [mix(P.accent, P.ground, 0.72 * night), mix(P.accent, P.ground, 0.45 * night), mix(P.accent, P.ground, 0.12)];
  const green = P.dark ? P.green : mix(P.green, P.ground, 0.1);
  if (look.season === "spring") return [mix(green, P.ground, 0.55 * night), mix(green, P.ground, 0.22 * night), mix(green, P.text, 0.3)];
  return [mix(green, P.ground, 0.74 * night), mix(green, P.ground, 0.5 * night), mix(green, P.ground, 0.24 * night)];
}
/** A cluster of leaves, lit from the upper left, with the dither doing the shading. */
function crown(s, tip, tones) {
  const r = s.U * (0.022 + s.random() * 0.016) * (tip.depth >= 4 ? 1 : 1.2);
  const cx = tip.x + (s.random() - 0.5) * r, cy = tip.y - r * 0.3;
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const dx = (x - cx) / r, dy = (y - cy) / r, d = dx * dx + dy * dy;
      if (d > 1 || (d > 0.72 && threshold(x, y) > 0.55)) continue;
      /* lit from the upper left, and darker toward the underside of the whole crown */
      const under = Math.max(0, (y - (s.horizon - s.U * 0.3)) / (s.U * 0.3));
      const light = 0.55 - dx * 0.3 - dy * 0.4 - under * 0.5;
      const band = light * 2;
      /* the rim of every cluster falls into shadow, so neighbouring clusters read apart */
      const rim = d > 0.78 ? 0.6 : 0;
      const b = band - rim;
      const tone = b < 1 ? (b > threshold(x, y) ? 1 : 0) : (b - 1 > threshold(x, y) ? 2 : 1);
      s.put(x, y, tones[Math.max(0, Math.min(2, tone))]);
    }
}
function blossom(s, tips) {
  const petal = [[242, 184, 204], [250, 226, 234]];
  for (const tip of tips)
    for (let n = 0; n < 6; n++) s.put(tip.x + (s.random() - 0.5) * s.U * 0.05, tip.y - s.random() * s.U * 0.04, petal[n & 1]);
}
function frost(s, tips) {
  const snow = mix(s.P.text, [255, 255, 255], 0.4);
  for (const tip of tips) s.put(tip.x, tip.y - 1, snow);
}

/* ---------- what moves ---------- */
function seedMotes() {
  if (!air || !scene) return;
  air.width = scene.W;
  air.height = scene.H;
  const count = { winter: 110, summer: 26, spring: 40, autumn: 44 }[look.season] ?? 30;
  motes = Array.from({ length: Math.round(count * Math.max(0.5, Math.min(2.2, (scene.W * scene.H) / 150000))) }, () => mote(true));
}
function mote(anywhere) {
  const { W, H, U, horizon, tx } = scene;
  const r = Math.random;
  if (look.season === "winter") return { x: r() * W, y: anywhere ? r() * H : -2, vx: 0, vy: 0.012 + r() * 0.02, phase: r() * 6.3 };
  if (look.season === "summer") return { x: r() * W, y: horizon - U * 0.05 + r() * U * 0.12, vx: 0, vy: 0, phase: r() * 6.3, glow: true };
  const x = tx + (r() - 0.5) * U * 0.5, y = horizon - U * (0.22 + r() * 0.2);
  if (look.season === "spring") return { x, y: anywhere ? y - r() * U * 0.2 : y, vx: 0.006 + r() * 0.01, vy: -0.004 - r() * 0.006, phase: r() * 6.3 };
  return { x, y: anywhere ? y + r() * U * 0.3 : y, vx: 0, vy: 0.008 + r() * 0.012, phase: r() * 6.3 };
}
function moveAir(dt, now) {
  const ctx = air.getContext("2d");
  const { W, H, P, horizon } = scene;
  ctx.clearRect(0, 0, W, H);
  const colour = look.season === "summer" ? mix(P.accent, [255, 255, 255], 0.35)
    : look.season === "winter" ? mix(P.text, [255, 255, 255], 0.5)
    : look.season === "spring" ? [246, 206, 220] : P.accent;
  for (let i = 0; i < motes.length; i++) {
    const m = motes[i];
    m.phase += dt * 0.002;
    m.x += m.vx * dt + Math.sin(m.phase) * 0.004 * dt;
    m.y += m.vy * dt + (m.glow ? Math.cos(m.phase * 0.7) * 0.003 * dt : 0);
    if (m.y > H || m.y < -4 || m.x < -4 || m.x > W + 4 || (!m.glow && look.season === "autumn" && m.y > horizon + 12)) motes[i] = mote(false);
    const alpha = m.glow ? 0.35 + 0.65 * Math.max(0, Math.sin(now * 0.002 + m.phase * 3)) : 0.9;
    ctx.fillStyle = `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha.toFixed(2)})`;
    ctx.fillRect(m.x | 0, m.y | 0, 1, 1);
  }
}
let last = 0, running = false;
function frame(now) {
  if (document.hidden || still() || !scene) { running = false; return; }
  requestAnimationFrame(frame);
  const gap = document.documentElement.dataset.quiet ? 33 : 80;
  if (now - last < gap) return;
  const dt = last ? Math.min(120, now - last) : 16;
  last = now;
  moveAir(dt, now);
}
function wake() {
  if (running || !air || document.hidden || still()) return;
  running = true;
  last = 0;
  requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", wake);
new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ["data-quiet", "data-motion"] });
/* The moon comes and goes with the calm window and a cleared view (moonInView). */
new MutationObserver(() => {
  const want = moonInView() ? "shown" : "hidden";
  if (scene && wall?.dataset.moon !== want) paintGrove();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-quiet", "data-everything"] });
let resizeTimer, seen = "";
new ResizeObserver(() => {
  const size = `${innerWidth}x${innerHeight}`;
  if (size === seen) return;
  seen = size;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { paintGrove(); wake(); }, 120);
}).observe(document.documentElement);

/** The season of the year where this computer is, when the owner has not picked one. */
export function seasonToday(date = new Date()) {
  const month = date.getMonth();
  return month >= 2 && month <= 4 ? "spring" : month <= 7 && month >= 5 ? "summer" : month >= 8 && month <= 10 ? "autumn" : "winter";
}
export function paint(next) {
  paintGrove(next);
  wake();
}
