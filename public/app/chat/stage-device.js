/* computer-control (SCREEN-077): a paired computer's screen, live, in the full-size computer view. The engine passes each
   picture the other computer sends over its device socket (GET /api/panels/screen/device, src/device-screen.ts) down
   one open request, about one every two and a half seconds, only while the view shows that computer to the owner and
   the page is showing. Watching only: nothing is clicked or typed there from here. When the engine refuses (the
   computer is off, not allowed to show its screen, Lockdown), its own words are shown instead. */
import { token } from "../core/api.js";

const D = { on: false, sid: "", device: "", open: null, frame: "", refusal: "", onChange: null, epoch: 0, waiting: false };
export const deviceFrame = () => D.frame;
export const deviceRefusal = () => D.refusal;
const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
const showing = () => D.on && !!D.sid && !!D.device && !document.hidden && !locked();

function end() {
  D.epoch++; D.open?.abort(); D.open = null; D.frame = ""; D.waiting = false;
}
async function read(epoch) {
  const controller = new AbortController(); D.open = controller;
  try {
    const query = new URLSearchParams({ session: D.sid, device: D.device });
    const headers = token.get() ? { authorization: `Bearer ${token.get()}` } : {};
    const response = await fetch(`/api/panels/screen/device?${query}`, { headers, cache: "no-store", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({}))).error || "That computer's screen is unavailable.");
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16000000) throw new Error("The picture was too large.");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const got = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (got.refusal) throw new Error(got.refusal);
        if (epoch !== D.epoch) return;
        const first = !D.frame;
        Object.assign(D, { frame: got.frame, refusal: "" });
        D.onChange?.(first);
      }
    }
    // The stream ended without a refusal (the engine restarted, a proxy let go): the last picture stays, and the view
    // asks again after one picture's wait.
    if (epoch === D.epoch) {
      D.open = null; D.waiting = true;
      setTimeout(() => { D.waiting = false; if (epoch === D.epoch && showing() && !D.open) void read(epoch); }, 2500);
    }
  } catch (error) {
    if (epoch === D.epoch && error.name !== "AbortError") { D.open = null; D.frame = ""; D.refusal = error.message; D.onChange?.(true); }
  }
}
/** Shows `device`'s screen for conversation `sid` while `on`; anything else lets go of it. */
export function watchDevice(on, sid, device, onChange) {
  D.onChange = onChange;
  const same = D.on === !!on && D.sid === (sid || "") && D.device === (device || "");
  if (same && (D.open || D.waiting || D.refusal || !showing())) return;
  end(); Object.assign(D, { on: !!on, sid: sid || "", device: device || "", refusal: "" });
  if (showing()) void read(D.epoch);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) end(); else if (showing()) void read(D.epoch); });
window.addEventListener("pagehide", end);
