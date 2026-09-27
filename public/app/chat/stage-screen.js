/* parity-b2: the owner's live view of This computer's screen, in the full-size computer view (stage.js) and its small
   window. Each frame is taken by the engine as it is asked for (GET /api/panels/screen, src/live-screen.ts), so the
   screen is read here about once a second while, and only while, the view shows This computer to the owner and the
   page is showing: closing the view, switching to the browser or another computer, leaving the conversation, hiding
   the window or Branch locking stops the reading, and nothing is taken in between. One read is in flight at a time.
   When the engine refuses (the screen switch is off, a password window is showing, Lockdown), its own words are shown
   in place of the screen and it is asked again every few seconds, since each of those can change; a locked Branch
   (423) is not asked again until the view is opened anew. Viewing only: nothing here sends a click or a key. */

import { api } from "../core/api.js";

const V = { on: false, timer: 0, busy: false, frame: "", refusal: "", onChange: null };
const EVERY = 1000, REFUSED = 3000;

/** The newest frame (a data: address), or "" while there is none. */
export const screenFrame = () => V.frame;
/** The engine's words for why there is no frame, or "". */
export const screenRefusal = () => V.refusal;
const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;

async function tick() {
  V.timer = 0;
  if (!V.on || document.hidden || locked()) return;
  V.busy = true;
  let wait = EVERY;
  try {
    const got = await api("panels/screen");
    if (!V.on) return;
    const first = !V.frame || !!V.refusal;
    Object.assign(V, { frame: got.frame, refusal: "" });
    V.onChange?.(first);
  } catch (error) {
    if (!V.on) return;
    wait = error.status === 423 ? 0 : REFUSED;
    const changed = V.refusal !== error.message;
    Object.assign(V, { frame: "", refusal: error.message });
    if (changed) V.onChange?.(true);
  } finally {
    V.busy = false;
    if (V.on && wait && !document.hidden && !locked()) V.timer = setTimeout(tick, wait);
  }
}

/** Reads while `on`; `onChange(redraw)` is told of each frame, `redraw` true when the view must be drawn again. */
export function watchScreen(on, onChange) {
  V.onChange = onChange;
  if (!!on === V.on) return;
  V.on = !!on;
  clearTimeout(V.timer);
  V.timer = 0;
  if (!V.on) { Object.assign(V, { frame: "", refusal: "" }); return; }
  if (!V.busy) tick();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && V.on && !V.timer && !V.busy) tick(); });
