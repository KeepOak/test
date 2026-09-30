/* computer-control (SCREEN-077): a paired computer's screen, live, in the full-size computer view. The engine passes each
   picture the other computer sends over its device socket (GET /api/panels/screen/device, src/device-screen.ts) down
   one open request, about one every two and a half seconds, only while the view shows that computer to the owner and
   the page is showing. When the engine refuses (the computer is off, not allowed to show its screen, Lockdown), its own
   words are shown instead.
   Using it: when that computer's own "use its screen and keyboard" switch is on, Take over lets the owner click, scroll
   and type on the picture (POST /api/panels/screen/device/drive and /input). Each press names the picture it was aimed
   at; after a click the next press waits for the next picture, so nothing lands on a screen the owner has not seen.
   While the owner holds it, that computer shows a notice on top of everything with a Stop of its own. */
import { token } from "../core/api.js";

const D = { on: false, sid: "", device: "", open: null, frame: "", refusal: "", onChange: null, epoch: 0, waiting: false,
  frameId: "", pressed: false, driving: false, inputNote: null, stoppedHere: false };
export const deviceFrame = () => D.frame;
export const deviceRefusal = () => D.refusal;
export const deviceDriving = () => D.driving;
/** Why this computer cannot be used from here (its switch is off, it cannot), or null when Take over works. */
export const deviceInputNote = () => D.inputNote;
/** Someone at that computer pressed Stop on its notice. */
export const deviceStoppedHere = () => D.stoppedHere;
const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
const showing = () => D.on && !!D.sid && !!D.device && !document.hidden && !locked();

function end() {
  D.epoch++; D.open?.abort(); D.open = null; D.frame = ""; D.waiting = false; D.frameId = ""; D.pressed = false; D.driving = false;
}
async function post(path, body) {
  const headers = { "content-type": "application/json", ...(token.get() ? { authorization: `Bearer ${token.get()}` } : {}) };
  const response = await fetch(`/api/panels/screen/device/${path}`, { method: "POST", headers, cache: "no-store", body: JSON.stringify({ session: D.sid, device: D.device, ...body }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error || "That computer did not take it.");
  return answer;
}
/** Take over (true) or hand back (false) the computer showing. */
export async function driveDevice(on) {
  if (on && D.inputNote) throw new Error(D.inputNote);
  const answer = await post("drive", { on: !!on });
  D.driving = answer.driving === true; D.onChange?.(true);
}
/** One click, scroll, key or piece of text on the picture showing now. */
export async function inputDevice(input) {
  if (!D.driving) throw new Error("Take over this computer first.");
  const frameId = D.frameId, spot = input.action === "click" || input.action === "scroll";
  // A click or scroll uses its picture up; text and keys may follow a click on the same one.
  if (!frameId || (spot && D.pressed)) throw new Error("Wait for the next picture, then press again.");
  if (spot) D.pressed = true;
  await post("input", { frameId, input });
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
        const redraw = first || D.driving !== (got.driving === true) || D.inputNote !== (got.inputNote ?? null) || D.stoppedHere !== (got.stoppedHere === true);
        Object.assign(D, { frame: got.frame, refusal: "", frameId: got.frameId || "", pressed: false, driving: got.driving === true, inputNote: got.inputNote ?? null, stoppedHere: got.stoppedHere === true });
        D.onChange?.(redraw);
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
