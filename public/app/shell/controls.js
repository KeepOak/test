/* The desktop app's own minimise, maximise and close (Windows and Linux: Electron's titleBarOverlay, the browser's Window
   Controls Overlay), drawn by the operating system over the title row's right end. */

import { toast } from "../core/ui.js";

/* The row keeps their width clear (--wco-r, read from navigator.windowControlsOverlay and again whenever it moves), so
   none of the page's buttons ever sits under them; app.css falls back to env(titlebar-area-*) before this has run. The
   Mac's traffic lights are on the left and keep their own spacing. */
export function reserveControls() {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay?.getTitlebarAreaRect) return;
  const apply = () => {
    const area = overlay.getTitlebarAreaRect();
    const shown = overlay.visible && area.width > 0, root = document.documentElement.style;
    root.setProperty("--wco-r", `${shown ? Math.max(0, Math.ceil(innerWidth - area.x - area.width)) : 0}px`);
    root.setProperty("--wco-h", `${shown ? Math.ceil(area.y + area.height) : 0}px`);
  };
  overlay.addEventListener?.("geometrychange", apply);
  addEventListener("resize", apply);
  apply();
}

/* Their glyphs follow the look: the colour the row really is under them (every theme, light or dark, chosen or
   following the computer, over the painted scene behind the glass) is measured there and told to the desktop app
   (branchDesktop.windowLook, src/desktop/window-chrome-ipc.ts), which draws the glyphs to read on it (WCAG AA) and
   shades a hovered button against it. Measured by laying each background under that point, outermost first, on one
   pixel; told only when it changed, and again after every change to the look. */
const pixel = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
function groundAt(x, y) {
  const layers = [];
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor);
  if (!layers.length) return null;
  const paint = pixel.getContext("2d", { willReadFrequently: true });
  paint.globalCompositeOperation = "source-over";
  paint.fillStyle = "#ffffff";
  paint.fillRect(0, 0, 1, 1);
  for (const colour of layers) {
    paint.fillStyle = "transparent";
    paint.fillStyle = colour;
    paint.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const G = { queued: false, told: null, failed: "" };
async function tell() {
  G.queued = false;
  const overlay = navigator.windowControlsOverlay;
  if (!overlay?.visible) return;
  const area = overlay.getTitlebarAreaRect();
  const ground = groundAt(Math.min(innerWidth - 1, area.x + area.width + 1), Math.max(0, area.y + 1));
  if (!ground || ground === G.told) return;
  G.told = ground;
  try {
    await window.branchDesktop.windowLook(ground);
    G.failed = "";
  } catch (error) {
    G.told = null;
    if (error.message !== G.failed) toast(error.message);
    G.failed = error.message;
  }
}
/* Once after the change that asked, when the look is whole (a look sets many colours in one go); not on an animation
   frame, which a window in the tray never gets. */
function schedule() {
  if (G.queued) return;
  G.queued = true;
  queueMicrotask(() => void tell());
}
export function followControlsLook() {
  if (!window.branchDesktop?.windowLook || !navigator.windowControlsOverlay) return;
  const watch = (el) => el && new MutationObserver(schedule).observe(el, { attributes: true, attributeFilter: ["style", "class", "data-theme", "data-palette"] });
  watch(document.documentElement);
  watch(document.getElementById("app"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
  document.addEventListener("transitionend", (event) => { if (/background|color/.test(event.propertyName)) schedule(); });
  navigator.windowControlsOverlay.addEventListener?.("geometrychange", schedule);
  schedule();
}
