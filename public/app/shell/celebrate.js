/* The achievement celebration (design doc 7): when the engine has an achievement earned and not yet celebrated
   (GET /api/delight/achievements "fresh", only while achievements are on and not kept quiet), Bronze and Silver get a
   small note for seven seconds and Gold and up the big card with confetti. Each one shown is told to the engine
   (POST /api/delight/told) so it never shows again; "Nice" closes the card. Looked at after a redraw (the engine's
   events redraw the window) and every 15 s while achievements are on, at most every 10 s; never while they are off. */

import { $, esc, applyCss, onRender, render } from "../core/dom.js";
import { E, S } from "../core/state.js";
import { D, followDelight } from "./scene.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { app, toast, ic } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t, language } from "../../i18n.js";
import { lookFollowed } from "./language.js";
import { say } from "../core/words.js";

const TIERS = ["Bronze", "Silver", "Gold", "Diamond", "Godly", "SSS+"];
const COLOUR = { Bronze: "#A86A3D", Silver: "#8C959E", Gold: "#C9982E", Diamond: "#4F8FB8", Godly: "#8A5AA8", "SSS+": "#C2412D" };
const MEDAL = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="14" r="5.5"></circle><path d="M8.5 9.5L6 3h4l2 4 2-4h4l-2.5 6.5"></path></svg>`;
let last = 0, busy = false, refused = false;

function confetti(cv, n) {
  if (!cv || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = cv.getBoundingClientRect(); cv.width = r.width; cv.height = r.height;
  const g = cv.getContext("2d"), cols = ["#D8612A", "#2F8F5B", "#4F6FA8", "#C9982E", "#8A5AA8"];
  const bits = Array.from({ length: n }, () => ({ x: r.width / 2, y: r.height / 2, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 12 - 4, c: cols[Math.floor(Math.random() * 5)], s: 3 + Math.random() * 4 }));
  let t = 0;
  const step = () => { g.clearRect(0, 0, cv.width, cv.height); bits.forEach((b) => { b.x += b.vx; b.y += b.vy; b.vy += 0.45; g.fillStyle = b.c; g.fillRect(b.x, b.y, b.s, b.s * 0.6); }); if (++t < 110 && document.body.contains(cv)) requestAnimationFrame(step); };
  step();
}

/* The bell on the note and on the card: one click keeps achievements quiet, the same switch as Settings' "Quiet" (the
   engine's delight settings, achievements.quiet). They are still earned and listed; only the pop-ups stop. */
const mute = () => `<button class="ach-mute" type="button" data-act="ach-mute" aria-label="${t("window.shell.celebrate.stop-popups")}" data-tip="${t("window.shell.celebrate.stop-popups")}">${ic("belloff", "s")}</button>`;

function show(a) {
  const medal =`<span class="medal" data-css="background:${COLOUR[a.tier] ?? "var(--ink-3)"}">${MEDAL}</span>`;
  const el = document.createElement("div");
  if (a.tier === "Bronze" || a.tier === "Silver") {
    $(".ach-toast")?.remove();
    el.className = "ach-toast";
    el.setAttribute("role", "status");
    el.innerHTML = `${medal}<span><b>${t("window.shell.celebrate.achievement-unlocked")}</b> · ${esc(a.name)} · ${esc(say(a.tier))}</span>${mute()}`;
    setTimeout(() => el.remove(), 7000);
  } else {
    $(".ach-big")?.remove();
    el.className = "ach-big";
    el.innerHTML = `<canvas id="confetti"></canvas><div class="card">${medal}<b data-css="font-size:18px">${esc(a.name)}</b><span>${esc(a.desc)}</span><span class="pill idle">${esc(say(a.tier))}</span><button class="btn pri sm" type="button" data-act="ach-close">${t("window.shell.celebrate.nice")}</button>${mute()}</div>`;
    setTimeout(() => el.remove(), 6000);
  }
  applyCss(el);
  app().appendChild(el);
  if (el.className === "ach-big") confetti(el.querySelector("#confetti"), a.tier === "Gold" ? 80 : 180);
}

/* One at a time, the highest tier first; the rest wait for the next look. */
let later = null, ticker = null;
const wanted = () => !!D.settings?.achievements?.on && !D.settings.achievements.quiet;
/* The light timer runs only while achievements are on and not kept quiet. */
function syncTicker() {
  const want = E.loaded && wanted() && !refused;
  if (want && !ticker) ticker = setInterval(check, 15000);
  else if (!want && ticker) { clearInterval(ticker); ticker = null; }
  if (!want) { clearTimeout(later); later = null; }
  return want;
}
async function check() {
  if (!syncTicker() || busy || S.ob) return; // never over setup: what is earned meanwhile waits until it closes
  const wait = 10000 - (Date.now() - last);
  if (wait > 0) { clearTimeout(later); later = setTimeout(check, wait); return; }
  last = Date.now();
  busy = true;
  try {
    await lookFollowed;
    const view = await api(`delight/achievements?lang=${language()}`);
    const next = (view.on ? view.fresh ?? [] : []).slice().sort((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier))[0];
    if (next) { show(next); await api("delight/told", { ids: [next.id] }); }
  } catch (error) { refused = true; syncTicker(); toast(error.message); } finally { busy = false; }
}

/* quiet true stops the pop-ups (with Undo), false brings them back; the engine keeps it, so it holds after a reload. */
async function keepQuiet(quiet) {
  try { D.settings = (await api("delight/settings", { achievements: { quiet } })).settings; } catch (error) { toast(error.message); return; }
  $(".ach-toast")?.remove();
  $(".ach-big")?.remove();
  syncTicker();
  render();
  if (quiet) toast(t("delight.ach.quiet"), () => keepQuiet(false));
}

export function initCelebrate() {
  markLive(["ach-close", "ach-mute"]);
  on("ach-close", () => $(".ach-big")?.remove());
  on("ach-mute", () => keepQuiet(true));
  /* After a refresh the switches are read again first, so a look never goes out on switches that were just turned off. */
  onRender(() => { followDelight().then(check); });
}
