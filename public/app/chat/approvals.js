/* Lockdown, the engine's one switch (GET/POST /api/lockdown). While it is on, the window carries the prototype's "locked"
   look: #app.locked shows every place's red banner, whose "Turn it off" switches it off. The Overview's Lockdown button
   switches it the other way from what the engine says now. The engine refuses the switch to short-lived keys, so only the
   owner's window or this computer's key reaches it. */

import { render, onRender } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

const L = { on: false, read: false };

/* Reads Lockdown from the engine and puts the window's look in step. Nothing is asked before sign-in. */
export async function syncLockdown() {
  if (!E.state) return L.on;
  try { L.on = (await api("lockdown")).on === true; } catch (error) { console.warn(error.message); return L.on; }
  document.getElementById("app")?.classList.toggle("locked", L.on);
  return L.on;
}

/* Switches Lockdown on or off; the engine's refusal is shown in its own words. */
export async function setLockdown(on) {
  try { await api("lockdown", { on }); } catch (error) { toast(error.message); }
  await refresh().catch((error) => toast(error.message));
  await syncLockdown();
  render();
}

export function initApprovals() {
  markLive(["lock"]);
  on("lock", async (el) => setLockdown(el.closest(".lock-banner") ? false : !(await syncLockdown())));
  // The first draw after sign-in reads it once; after that, every ten seconds while the tab is shown, as soon as it is
  // shown again, and straight after each switch.
  onRender(() => { if (E.state && !L.read) { L.read = true; syncLockdown(); } });
  setInterval(() => { if (!document.hidden) syncLockdown(); }, 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncLockdown(); });
}
