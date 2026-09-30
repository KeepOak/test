/* The classic pebble face, rendered in Blender (design/art/pebble/: the .blend, its generator and the packer) and
   animated here by what the Trunk is really doing.

   Colour without a render per colour: every state is three sprite sheets (public/art/pebble/pebble.json lays them
   out) drawn onto one canvas per face: the body in white, whose grey is its shading, filled with the Trunk's colour
   and multiplied by that grey; the body's gloss and warm rim on top; then the eyes (round, wide or sleepy), mouth,
   effects and contact shadow. One decoded sheet serves every face that shows it, and the passes stay frame-exact.

   What a face acts out comes only from the engine: chat/agent17.js agentState (a task waiting on you, paused, a task
   running, just finished, failed), refined with GET /api/activity while a task runs (the tool at work: looking,
   reading or doing; the model's own turn is thinking) and, once a task finishes, with its own record (GET
   /api/runs/<id>/receipts: a task that used tools celebrates, a plain reply talks).

   Faces 24px and smaller keep the flat pebble (a 3D shade can't be seen that small). Motion stops, and the still
   shows, when motion is reduced (the engine's reduceMotion preference, "Keep things still", or the computer's own
   setting), when the face is out of view, and for all but the busiest few faces on screen at once. */

import { E } from "./state.js";
import { esc, afterDraw } from "./dom.js";
import { api } from "./api.js";
import { restOf, onRest } from "./sleep.js";
import { restMarks } from "./figures.js";
import { visualStyle } from "./voxel-models.js";

export const PEBBLE_EYES = ["round", "wide", "sleepy"];
const ART = "/art/pebble/";
const SMALL = 24;           // at and under this, the flat pebble
const LIVE_MAX = 12;        // at most this many faces move at once; the rest show their still
const FPS = 24;
const FRAME = 1 / 0.7;      // the rendered frame is this many times the face, for hops and effects
const TALK_MS = 4500;       // a plain reply talks this long (prototype.html agentState saidAt)
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");

/* Which eyes a Trunk wears: the engine keeps them as the Trunk's `eyes` (src/trunks/record.ts; null is round). */
export const eyesOf = (trunk) => (PEBBLE_EYES.includes(trunk?.eyes) ? trunk.eyes : "round");
export const pebbleStill = () => !!E.state?.preferences?.reduceMotion || REDUCE.matches;
const keyOf = (trunk) => (trunk?.id ? `id:${trunk.id}` : trunk?.name ? `name:${trunk.name}` : "");

/* The face's markup (core/ui.js av() draws it for a Trunk with no photo, character or emoji). css carries --s, --c
   and --r; marks are the eye and motion classes the Trunk editor chose. The 3D face carries them too (anything that
   reads the face's class still sees them). On top of what it acts out, app.css gives Breathe the flat breathe on the
   rendered body and Sway the flat bob; None adds nothing. */
export function pebbleFace(trunk, face, size, css, paused, shape, marks = "") {
  const eyes = PEBBLE_EYES.includes(face?.eyes) ? face.eyes : eyesOf(trunk);
  /* Asleep (core/sleep.js), the flat pebble closes its eyes and holds still; the 3D one plays its sleep (stateOf). */
  const rk = trunk?.id ? `t:${trunk.id}` : "", rest = rk ? restOf(rk, pebbleState(trunk)) : "awake";
  const rkAttr = rk ? ` data-rk="${esc(rk)}"` : "";
  marks += restMarks(rk, rest);
  if (visualStyle() === "pixel")
    return `<span class="av pixel-pebble${paused}${marks}" data-css="${css}"${rkAttr} aria-hidden="true"><span class="peb"></span><span class="eye l"></span><span class="eye r"></span></span>`;
  if (size <= SMALL)
    return `<span class="av${paused}${marks}" data-css="${css}"${rkAttr} aria-hidden="true"><span class="peb"></span><span class="eye l"></span><span class="eye r"></span></span>`;
  const key = keyOf(trunk);
  return `<span class="av pbl${paused}${marks}" data-css="${css}" data-pbl-shape="${shape}" data-pbl-eyes="${eyes}" data-pbl-c="${esc(face.color)}" data-pbl-s="${size}"${rkAttr}${key ? ` data-pbl-key="${esc(key)}"` : ""}${trunk?.id ? ` data-pbl-id="${esc(trunk.id)}"` : ""} aria-hidden="true"><span class="pbl-f"><span class="pbl-c"></span><span class="pbl-b"></span><span class="pbl-l"></span><span class="pbl-x"></span></span></span>`;
}

/* ---------- what a Trunk is doing ---------- */

let agentState = null;                  // chat/agent17.js, loaded once every module has run (it imports core/ui.js)
const activity = new Map();             // sessionId → GET /api/activity entry, while a task runs
const didWork = new Map();              // run id → true (used tools), false (a plain reply), null (asking)
const SEARCH = /^(web\.search|files\.(search|grep|find|glob|list)|sessions\.search|history\.search|workspace\.map|code\.map|browser\.)/;
const READ = /^(files\.read|web\.fetch|document\.open|history\.attach|process\.read|skills\.|memory\.(get|search|list|read))/;
const kindOf = (tool) => (SEARCH.test(tool ?? "") ? "search" : READ.test(tool ?? "") ? "read" : "work");

/* A running task: the tool at work now, else the last one used (the model going over what it found), else thinking. */
function doing(sessionId) {
  const a = activity.get(sessionId);
  if (!a) return "work";
  const steps = a.steps ?? [];
  const step = steps.filter((s) => s.status === "working").at(-1) ?? steps.at(-1);
  return step ? kindOf(step.tool) : "think";
}

const lastRun = (sessionId) => (E.state?.runs ?? []).filter((r) => r.sessionId === sessionId)
  .reduce((a, r) => (!a || String(r.updatedAt ?? r.createdAt) > String(a.updatedAt ?? a.createdAt) ? r : a), null);

/* Just finished: a task that used tools (or changed files) celebrates; a plain reply talks for a moment, then rests. */
function finished(sessionId) {
  const run = lastRun(sessionId);
  if (!run) return "idle";
  if ((run.changes ?? []).length) return "yay";
  if (!didWork.has(run.id)) askDidWork(run.id);
  if (didWork.get(run.id)) return "yay";
  return Date.now() - Date.parse(run.updatedAt ?? run.createdAt) < TALK_MS ? "talk" : "idle";
}
function askDidWork(runId) {
  didWork.set(runId, null);
  api(`runs/${encodeURIComponent(runId)}/receipts`)
    .then((r) => didWork.set(runId, (r.items ?? []).length > 0))
    .catch((error) => { didWork.delete(runId); console.warn(error.message); });
}

/* The state a Trunk's face shows: idle, think, search, read, work, wait, talk, yay, oops or sleep. */
export function pebbleState(trunk) {
  if (!trunk?.id || !agentState) return "idle";
  const base = agentState(trunk);
  if (base === "work") return doing(trunk.chatSessionId);
  if (base === "yay") return finished(trunk.chatSessionId);
  return base;
}

/* GET /api/activity, each second and a half while a Trunk on screen has a task running. */
let polling = null;
function pollActivity(want) {
  if (!want || document.hidden) { clearInterval(polling); polling = null; activity.clear(); return; }
  if (polling) return;
  const read = () => api("activity").then((list) => {
    activity.clear();
    for (const a of Array.isArray(list) ? list : []) activity.set(a.sessionId, a);
  }, (error) => console.warn(error.message));
  read();
  polling = setInterval(read, 1500);
}

/* ---------- sheets ---------- */

let meta = null, metaAsked = false;
const images = new Map();              // sheet name → { img, ready, used }, the least recently drawn dropped past SHEETS_MAX
const SHEETS_MAX = 24;
function loadMeta() {
  if (metaAsked) return;
  metaAsked = true;
  fetch(ART + "pebble.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
    .then((m) => { meta = m; schedule(); }, (error) => { metaAsked = false; console.warn(error.message); });
}
/* A sheet, once loaded and decoded off the main thread; null until then (the face keeps its still meanwhile). */
function image(name, now) {
  let got = images.get(name);
  if (!got) {
    const img = new Image();
    got = { img, ready: false, used: 0 };
    img.decoding = "async";
    img.src = ART + name;
    const mine = got;
    img.decode().then(() => { if (images.get(name) === mine) { mine.ready = true; schedule(); } },
      (error) => { if (images.get(name) === mine) images.delete(name); console.warn(`${ART}${name}: ${error.message}`); });
    images.set(name, got);
  }
  got.used = now;
  return got.ready ? got.img : null;
}
/* Past SHEETS_MAX, the sheets drawn least recently are let go (never one drawn in the last second). */
function trimSheets(now) {
  if (images.size <= SHEETS_MAX) return;
  for (const [name, got] of [...images].sort((a, b) => a[1].used - b[1].used)) {
    if (images.size <= SHEETS_MAX || now - got.used < 1000) return;
    images.delete(name);
  }
}
const sheetsFor = (state, f, now) => [image(`${state}-body-${f.shape}.webp`, now), image(`${state}-light-${f.shape}.webp`, now), image(`${state}-fx-${f.eyes}.webp`, now)];

/* ---------- faces on screen ---------- */

const faces = new Map();               // element → face
const reactions = new Map();           // key → { name, at }
const lastState = new Map();           // key → state, to see a task arrive
const hash = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function adopt(el) {
  if (faces.has(el)) return;
  const d = el.dataset, key = d.pblKey ?? "";
  const f = { el, key, id: d.pblId ?? "", shape: Number(d.pblShape) || 0, eyes: PEBBLE_EYES.includes(d.pblEyes) ? d.pblEyes : "round",
    colour: /^#[0-9a-f]{6}$/i.test(d.pblC ?? "") ? d.pblC : "#56616b", size: Number(d.pblS) || 40, visible: inView(el),
    phase: (hash(key) % 997) / 997, canvas: null, drawn: "", gx: 0, gy: 0, rect: null, rectAt: -1e9 };
  /* A redraw replaced the face's element: the same face's canvas moves across as it is, so it isn't drawn again. */
  const same = (o) => !o.el.isConnected && o.canvas && o.key === key && o.id === f.id && o.shape === f.shape && o.eyes === f.eyes && o.colour === f.colour && o.size === f.size;
  const old = key ? [...faces.values()].find(same) : null;
  if (old) {
    Object.assign(f, { canvas: old.canvas, drawn: old.drawn, gx: old.gx, gy: old.gy });
    el.appendChild(f.canvas);
    el.classList.add("pbl-live");
    if (old.el.dataset.pblShow) el.dataset.pblShow = old.el.dataset.pblShow;
    seen.unobserve(old.el);
    faces.delete(old.el);
    moving = null;
  }
  faces.set(el, f);
  seen.observe(el);
}
const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0; };
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) { const f = faces.get(e.target); if (f) f.visible = e.isIntersecting; }
  moving = null;
  schedule();
});
let removed = true;                    // set when the window takes nodes out: only then are gone faces looked for
function forget() {
  if (!removed) return;
  removed = false;
  for (const [el, f] of faces) if (!el.isConnected) { seen.unobserve(el); faces.delete(el); f.canvas = null; moving = null; }
}

/* ---------- state per face, and the small reactions ---------- */

const states = new Map();              // key → { st, at }: read again at most every 400 ms
const glances = new Map();             // key → { dir, until }: a look toward where a message arrived
const ACTIVE = new Set(["think", "work", "search", "read", "talk", "wait", "yay"]);
const GLANCE = new Set(["idle", "wait", "talk"]);
let pointer = null, hovered = null;
const lastHover = new Map();

function stateOf(f, now) {
  if (!f.id) return "idle";
  const c = states.get(f.key);
  if (c && now - c.at < 400) return c.st;
  const trunk = E.trunks.find((t) => t.id === f.id);
  let st = trunk ? pebbleState(trunk) : "idle";
  /* Left alone (core/sleep.js), it sleeps; after the long sleep its sleep holds still (draw). */
  f.rest = restOf(`t:${f.id}`, st);
  if (f.rest !== "awake") st = "sleep";
  const before = lastState.get(f.key);
  /* A message arrives for a Trunk at rest: it wakes up and looks toward the conversation. Woken any other way, it wakes. */
  if (before && (before === "idle" || before === "sleep") && ACTIVE.has(st)) {
    reactions.set(f.key, { name: "wake", at: now });
    glances.set(f.key, { dir: towardConversation(f.el), until: now + 1600 });
  } else if (before === "sleep" && st !== "sleep") reactions.set(f.key, { name: "wake", at: now });
  lastState.set(f.key, st);
  states.set(f.key, { st, at: now });
  return st;
}
function towardConversation(el) {
  const box = document.getElementById("conversation");
  if (!box || box.contains(el)) return [0, 0.6];
  const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2), d = Math.hypot(dx, dy) || 1;
  return [dx / d, dy / d];
}
/* Eyes follow the pointer when it is near, or look where a message arrived; only in the calmer states. */
function glanceAt(f, st, now) {
  if (!GLANCE.has(st)) return [0, 0];
  const g = glances.get(f.key);
  if (g && now < g.until) return g.dir;
  if (!pointer || now - pointer.at > 4000) return [0, 0];
  if (now - f.rectAt > 500) { f.rect = f.el.getBoundingClientRect(); f.rectAt = now; }
  const r = f.rect;
  const dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height / 2), d = Math.hypot(dx, dy);
  return d < 6 || d > 360 ? [0, 0] : [dx / d, dy / d];
}

function react(el, name) {
  const f = faces.get(el), now = performance.now();
  if (!f?.key || pebbleStill()) return;
  if (name === "hover") {
    if (!GLANCE.has(stateOf(f, now)) || now - (lastHover.get(f.key) ?? -1e9) < 2500 || reactions.has(f.key)) return;
    lastHover.set(f.key, now);
  }
  reactions.set(f.key, { name, at: now });
  schedule();
}

/* ---------- drawing ---------- */

export const pebbleStats = { passes: 0, ms: 0, max: 0, draws: 0, live: 0 };

/* The sheet and frame to show now: a reaction while it plays, else the state's loop, from one clock for every face. */
function frameOf(f, st, now) {
  const r = reactions.get(f.key), m = meta.states[r?.name];
  if (r && m) {
    const i = Math.floor(((now - r.at) / 1000) * m.fps);
    if (i < m.frames) return [r.name, i];
    reactions.delete(f.key);
  }
  const s = meta.states[st] ?? meta.states.idle, seconds = s.frames / s.fps;
  /* Each face starts a whole number of frames along, so every face in a state turns its frame at the same moment and
     the window draws once for all of them rather than once for each. */
  return [meta.states[st] ? st : "idle", (Math.floor((now / 1000) * s.fps) + Math.round(f.phase * seconds * s.fps)) % s.frames];
}
function pick(f, st, now) {
  let [name, i] = frameOf(f, st, now), sheets = sheetsFor(name, f, now);
  if (sheets.every(Boolean)) return [name, i, sheets];
  [name, i] = [st, 0];
  sheets = sheetsFor(st, f, now);
  if (sheets.every(Boolean)) return [name, Math.floor((now / 1000) * meta.states[st].fps) % meta.states[st].frames, sheets];
  sheets = sheetsFor("idle", f, now);
  return sheets.every(Boolean) ? ["idle", 0, sheets] : null;
}

/* Draws the face; true while it moves, "still" when it holds its frame (the long sleep), false with no sheet yet. */
function draw(f, at) {
  const st = stateOf(f, at), held = f.rest === "still";
  f.heldAt = held ? f.heldAt ?? at : null;
  const now = held ? f.heldAt : at, got = pick(f, st, now);
  if (!got) return false;
  const [name, i, [body, light, fx]] = got;
  const [tx, ty] = glanceAt(f, st, now);
  const px = Math.round(f.size * FRAME * Math.min(2, devicePixelRatio || 1)), reach = px * 0.025;
  f.gx += (tx * reach - f.gx) * 0.41; // 0.3 a pass at 35 passes a second was; the same speed at 24 passes a second
  f.gy += (ty * reach - f.gy) * 0.41;
  const hx = Math.round(f.gx * 2) / 2, hy = Math.round(f.gy * 2) / 2;
  const tag = `${name}|${i}|${hx}|${hy}|${px}`;
  if (f.canvas && tag === f.drawn) return held ? "still" : true;
  if (!f.canvas) {
    f.canvas = Object.assign(document.createElement("canvas"), { className: "pbl-cv", width: px, height: px });
    f.canvas.setAttribute("aria-hidden", "true");
    f.el.appendChild(f.canvas);
  } else if (f.canvas.width !== px) f.canvas.width = f.canvas.height = px;
  paint(f.canvas.getContext("2d"), px, f.colour, meta.states[name].cols, i, body, light, fx, hx, hy);
  f.el.classList.add("pbl-live");
  if (f.el.dataset.pblShow !== name) f.el.dataset.pblShow = name; // what it acts out now, for a look in devtools
  f.drawn = tag;
  pebbleStats.draws += 1;
  return held ? "still" : true;
}

/* The colour filled in, multiplied by the body's shading and cut to its outline; its gloss; then eyes and effects. */
function paint(ctx, W, colour, cols, i, body, light, fx, gx, gy) {
  const S = meta.size, L = meta.lightSize, x = i % cols, y = Math.floor(i / cols);
  ctx.imageSmoothingQuality = "high";
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, W, W);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, W, W);
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(body, x * S, y * S, S, S, 0, 0, W, W);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(body, x * S, y * S, S, S, 0, 0, W, W);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(light, x * L, y * L, L, L, 0, 0, W, W);
  ctx.drawImage(fx, x * S, y * S, S, S, gx, gy, W, W);
}

function toStill(f) {
  if (f.canvas) { f.canvas.remove(); f.canvas = null; f.drawn = ""; }
  f.el.classList.remove("pbl-live");
  delete f.el.dataset.pblShow;
}

/* One frame of a state onto a canvas, the way every face is drawn (the art previews in design/art/pebble use it). */
export async function pebbleFrame(canvas, { state = "idle", shape = 0, eyes = "round", colour = "#56616b", frame = 0 } = {}) {
  loadMeta();
  for (let i = 0; !meta && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
  if (!meta?.states[state]) throw new Error(`No pebble state ${state}`);
  const names = [`${state}-body-${shape}.webp`, `${state}-light-${shape}.webp`, `${state}-fx-${eyes}.webp`];
  names.forEach((n) => image(n, performance.now()));
  await Promise.all(names.map((n) => images.get(n).img.decode()));
  const [body, light, fx] = names.map((n) => images.get(n).img);
  paint(canvas.getContext("2d"), canvas.width, colour, meta.states[state].cols, frame % meta.states[state].frames, body, light, fx, 0, 0);
  return meta.states[state];
}

const running = (id) => {
  const sid = E.trunks.find((t) => t.id === id)?.chatSessionId;
  return !!sid && (E.state?.runs ?? []).some((r) => r.sessionId === sid && r.status === "running");
};
const rank = (f, now) => (reactions.has(f.key) ? 0 : stateOf(f, now) !== "idle" ? 1 : 2);

/* Which faces move: the busiest few in view. Chosen again when faces come, go or scroll, and every 400 ms for states. */
let moving = null, movingAt = -1e9;
function chooseMoving(now) {
  if (pebbleStill() || !faces.size) return new Set();
  if (!meta) { loadMeta(); return new Set(); }
  if (moving && now - movingAt < 400 && reactions.size === 0) return moving;
  movingAt = now;
  return (moving = new Set([...faces.values()].filter((f) => f.key && f.visible).sort((a, b) => rank(a, now) - rank(b, now)).slice(0, LIVE_MAX)));
}

/* One pass: the busiest few faces in view move, the rest show their still. */
let shownSet = null, shownCalm = null;
function pass(now) {
  const t0 = performance.now();
  forget();
  const chosen = chooseMoving(now), calm = pebbleStill();
  /* Only when who moves changes are the other faces visited, to mark them calm or put their still back. */
  if (chosen !== shownSet || calm !== shownCalm) {
    for (const f of faces.values()) {
      if (f.calm !== calm) { f.calm = calm; f.el.classList.toggle("pbl-calm", calm); } // app.css stops Breathe and Sway too
      if (!chosen.has(f) && (f.canvas || f.el.classList.contains("pbl-live"))) toStill(f);
    }
    [shownSet, shownCalm] = [chosen, calm];
  }
  let live = 0;
  for (const f of chosen) {
    const drawn = draw(f, now);
    if (drawn === true) live += 1;
    else if (!drawn) toStill(f);
  }
  trimSheets(now);
  pollActivity(live > 0 && [...chosen].some((f) => f.id && running(f.id)));
  const took = performance.now() - t0;
  Object.assign(pebbleStats, { passes: pebbleStats.passes + 1, ms: pebbleStats.ms + took, max: Math.max(pebbleStats.max, took), live });
  return live > 0;
}

/* A pass runs at most 24 times a second (the faces' sheets are 12 and 24 fps), woken by a timer rather than by every
   display frame: a pass that changes no canvas then makes the window draw nothing, where asking for every frame kept
   the whole window drawing 60 times a second behind its glass. Hidden, no pass runs until the window is shown. */
const PASS_MS = 1000 / 24;
let raf = 0, wake = 0, lastPass = -1e9;
function loop(now) {
  raf = 0;
  if (document.hidden) return;
  lastPass = now;
  if (!pass(now)) return;
  wake = setTimeout(() => { wake = 0; schedule(); }, Math.max(0, lastPass + PASS_MS - performance.now()));
}
function schedule() { if (!raf && !wake) raf = requestAnimationFrame(loop); }

/* Faces are drawn with innerHTML anywhere in the window (regions, dialogs, popovers): each one is taken up as it lands,
   and drawn before the browser paints, so a redraw never flashes the still. */
function start() {
  import("../chat/agent17.js").then((m) => { agentState = m.agentState; schedule(); }, (error) => console.warn(error.message));
  new MutationObserver((records) => {
    let found = false;
    for (const r of records) {
      if (r.removedNodes.length) removed = true;
      for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(".av.pbl")) { adopt(n); found = true; }
      for (const el of n.querySelectorAll(".av.pbl")) { adopt(el); found = true; }
      }
    }
    if (found) { pass(performance.now()); schedule(); }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll(".av.pbl").forEach(adopt);
  addEventListener("pointermove", (e) => { pointer = { x: e.clientX, y: e.clientY, at: performance.now() }; }, { passive: true });
  document.addEventListener("pointerover", (e) => {
    const host = e.target.closest?.(".av.pbl") ?? e.target.closest?.("button,.row,.prow,.mi,.sr-row")?.querySelector(".av.pbl");
    if (host && host !== hovered) react(host, "hover");
    hovered = host ?? null;
  });
  document.addEventListener("pointerdown", (e) => { const host = e.target.closest?.(".av.pbl"); if (host) react(host, "pat"); }, true);
  REDUCE.addEventListener?.("change", () => { pass(performance.now()); schedule(); });
  onRest(() => { states.clear(); moving = null; schedule(); }); // a face fell asleep or woke (core/sleep.js)
  afterDraw(schedule); // a redraw may follow a change of preference (Keep things still) that moves no face
  /* Hidden, nothing is drawn and GET /api/activity stops; shown again, a pass picks both back up. */
  document.addEventListener("visibilitychange", () => { if (document.hidden) pollActivity(false); else schedule(); });
  schedule();
}
start();
