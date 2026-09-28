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

/* The title row can be transparent over a painted scene, so CSS background colours cannot tell us the actual pixel.
   Ask the authenticated desktop window to sample one pixel just outside the native buttons. Only its own main process
   sees the pixel; the page receives success, never image bytes. */
const G = { queued: false, failed: "" };
async function tell() {
  G.queued = false;
  const overlay = navigator.windowControlsOverlay;
  if (!overlay?.visible) return;
  const area = overlay.getTitlebarAreaRect();
  const x = Math.min(innerWidth - 2, area.x + area.width + 2), y = Math.max(0, area.y + 2);
  try {
    await window.branchDesktop.windowLook({ sample: { x, y } });
    G.failed = "";
  } catch (error) {
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
  setInterval(() => { if (!document.hidden) schedule(); }, 2000); // a moving painted scene changes without a CSS mutation
  schedule();
}
