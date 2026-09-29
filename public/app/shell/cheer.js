/* The small cheer when a task finishes, 1:1 with the prototype's (pass 11 cheer11): Branch's celebration loop (its still
   when motion is reduced), "<name> is done" with the run's own last words, a burst of leaves, and the pet hops and cheers.
   It follows the engine only: a run that was running at the last look and has now completed (GET /api/state runs). As
   there, a run that stopped to ask, a helper's run and a room's are not cheered. One card at a time; a new one replaces it.
   It is a pop-up: while "Show tips and pop-ups" is off (flows/guides.js) nothing is cheered. */

import { $, esc, onRender } from "../core/dom.js";
import { E, ownName, ownerHere, chatFace } from "../core/state.js";
import { app, av, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { media17, calm17 } from "../core/art17.js";
import { petMood, petNow } from "./scene.js";
import { popupsOn } from "../flows/guides.js";
import { t } from "../../i18n.js";

/* Leaves that belong to Branch: the prototype's leafBurst, never while motion is reduced. */
function leafBurst(x, y) {
  if (calm17()) return;
  const root = app(), cv = document.createElement("canvas"), r = root.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  cv.className = "burst11";
  cv.setAttribute("aria-hidden", "true"); // leaves only: nothing to read
  cv.width = r.width * dpr;
  cv.height = r.height * dpr;
  root.appendChild(cv);
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#E07033";
  const cols = ["#3E7B4A", "#5E9E5B", "#2F5E3A", "#8CBF6A", acc, "#F0A04B"], ps = [];
  x -= r.left; y -= r.top;
  for (let i = 0; i < 46; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, v = 5 + Math.random() * 7, spark = i % 5 === 0;
    ps.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, s: spark ? 2 + Math.random() * 2 : 5 + Math.random() * 5, c: cols[i % cols.length], spark, ph: Math.random() * 6.28 });
  }
  let n = 0;
  const T = 95, step = () => {
    n++;
    g.clearRect(0, 0, r.width, r.height);
    for (const p of ps) {
      p.vy += 0.22; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx + Math.sin(n / 9 + p.ph) * (p.spark ? 0 : 0.9); p.y += p.vy; p.rot += p.vr;
      g.globalAlpha = Math.max(0, 1 - n / T);
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c; g.beginPath();
      if (p.spark) { g.shadowColor = p.c; g.shadowBlur = 8; g.arc(0, 0, p.s, 0, 6.28); g.fill(); }
      else { g.ellipse(0, 0, p.s, p.s * 0.45, 0, 0, 6.28); g.fill(); g.strokeStyle = "rgba(255,255,255,.35)"; g.lineWidth = 0.8; g.beginPath(); g.moveTo(-p.s, 0); g.lineTo(p.s, 0); g.stroke(); }
      g.restore();
    }
    if (n < T) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}

/* The conversation's name as the list shows it. */
function nameOf(sessionId) {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === sessionId);
  return ownName(sessionId) || s?.title || s?.opening || t("comfort.field.newConversation");
}
/* The run's own last words, one line, or the prototype's line when it left none. */
const lastWords = (run) => (typeof run.output === "string" && run.output.trim() ? run.output.trim().split("\n")[0].slice(0, 160) : t("window.shell.cheer.finished-its-in-the-conversation"));

export function cheer(run) {
  $(".cheer11")?.remove();
  const el = document.createElement("div");
  el.className = "cheer11";
  el.setAttribute("role", "status");
  el.dataset.run = run.id;
  /* A Trunk's task is cheered with that Trunk's face; Branch's celebration is for Branch's own conversation. */
  const face = chatFace(run.sessionId);
  const art = av(face, 58, run.sessionId);
  el.innerHTML = `${art}<span><b>${esc(t("window.shell.cheer.name-is-done", { name: nameOf(run.sessionId) }))}</b><small>${esc(lastWords(run))}</small></span>`;
  app().appendChild(el);
  const b = el.getBoundingClientRect();
  leafBurst(b.left + 33, b.top + b.height / 2);
  setTimeout(() => el.classList.add("out11"), 3800);
  setTimeout(() => el.remove(), 4300);
  if (petNow() !== "none") petMood("yay", 4000, 900); // a pet switched off has no mood to change
}

/* Whether a run's conversation is a room's. A room's turns run in each Trunk's own side of it (src/trunks/rooms.ts
   memberSessions), which the conversation list never shows, so the engine is asked which room such a conversation
   belongs to (GET /api/trunks/conversations/<id> memberOf; the owner's alone). */
async function inRoom(sessionId) {
  if ((E.rooms ?? []).some((room) => room.sessionId === sessionId)) return true;
  if (!E.rooms?.length || !ownerHere() || E.sessions.some((s) => (s.sessionId ?? s.id) === sessionId)) return false;
  return !!(await api(`trunks/conversations/${encodeURIComponent(sessionId)}`))?.memberOf;
}
/* The newest finished run that is not a room's turn. */
async function cheerLatest(done) {
  for (const run of done.reverse()) if (!hidden(run) && !(await inRoom(run.sessionId))) return cheer(run);
}
/* QA retest 2026-09-28 (m4): the engine's own work that no list shows (reading a schedule's words is set aside and kept out
   of Recent) is not cheered as "New conversation is done". A Trunk introducing itself is set aside too, but its
   conversation is listed, so it still is. */
const hidden = (run) => run.aside === true && !E.sessions.some((s) => (s.sessionId ?? s.id) === run.sessionId);

/* What each run was at the last look; nothing is cheered on the first one, so opening the window never cheers. */
let before = null;
function look() {
  if (!E.state) return;
  const runs = (E.state.runs ?? []).filter((r) => !r.parentRunId);
  if (before) {
    const done = runs.filter((r) => before.get(r.id) === "running" && r.status === "completed");
    if (done.length && popupsOn()) cheerLatest(done).catch((error) => toast(error.message));
  }
  before = new Map(runs.map((r) => [r.id, r.status]));
}
export function initCheer() { onRender(look); }
