import { E } from "../core/state.js";
import { renderNow, onRender } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";

let state = { enabled: false, open: false }, busy = false;
const bridge = () => window.branchDesktop;
export const available = () => typeof bridge()?.openKeepOakView === "function";
export function keepOakViewSection() {
  const denied = E.profiles?.isOwner !== true || busy || !available() ? " disabled" : "";
  return `<div class="sec"><h2>keepoak.com</h2><p>Open KeepOak in its own private view inside Branch. This is off until you open it.</p><p class="hint">${available() ? "Only keepoak.com can open here. Downloads, pop-ups, and device permissions are blocked. Closing the view keeps its sign-in for this launch; Disconnect clears it." : "This view is available in the desktop app."}</p><div class="acts"><button class="btn pri" type="button" data-act="ko-view-open"${denied}>${state.open ? "Show KeepOak view" : "Open KeepOak view"}</button><button class="btn" type="button" data-act="ko-view-disconnect"${!state.enabled || busy || !available() ? " disabled" : ""}>Disconnect and clear sign-in</button></div></div>`;
}
async function read() {
  if (!available()) return;
  try { state = await bridge().keepOakViewStatus(); renderNow(); } catch { /* the desktop window is closing */ }
}
export async function change(method) {
  if (busy || !available() || (method === "openKeepOakView" && E.profiles?.isOwner !== true)) return;
  busy = true; renderNow();
  try { state = await bridge()[method](); }
  catch (error) { toast(error.message); await read(); }
  finally { busy = false; renderNow(); }
}
export function initKeepOakView() {
  markLive(["ko-view-open", "ko-view-disconnect", "ko-start"]);
  on("ko-start", () => change("openKeepOakView"));
  on("ko-view-open", () => change("openKeepOakView"));
  on("ko-view-disconnect", () => change("disconnectKeepOakView"));
  window.addEventListener("focus", read);
  onRender(() => {
    if (state.enabled && E.profiles?.isOwner === false && !busy) void change("disconnectKeepOakView");
  });
  void read();
}
