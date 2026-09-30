/* parity-b2: the owner's live view of This computer's screen, in the full-size computer view (stage.js) and its small
   window. The engine sends frames down one open request (GET /api/panels/screen, src/live-screen.ts) for as long as,
   and only while, the view shows This computer to the owner and the page is showing: closing the view, switching to
   the browser or another computer, leaving the conversation, hiding the window, Branch locking or the page going away
   lets go of the request, and the engine stops taking frames with it. The width the view is drawn at is sent with it
   (a small view is sent smaller frames, less often), and the request is opened again only when that changes a step.
   When the engine refuses (the screen switch is off, a password window is showing, Lockdown), its own words are shown
   in place of the screen; frames come back by themselves when the reason goes, and a refused or ended request is
   asked again every few seconds. A locked Branch (423) is not asked again until the view is opened anew. Viewing
   only: nothing here sends a click or a key.
   Each frame also says whether the owner is driving (Take over: every task's screen actions wait) and, while a task that
   clicked is still going, where its newest click landed on the frame and whose task it is (`cursor`), for the Trunk's
   cursor over the screen. */

import { token } from "../core/api.js";

const V = { on: false, open: null, width: 0, timer: 0, frame: "", refusal: "", onChange: null, watching: false, cursor: null, driving: false };
const REFUSED = 3000;
const SMALL = 640, LARGE = 1280; // a frame's width: for a small view, or any other

/** The newest frame (a data: address), or "" while there is none. */
export const screenFrame = () => V.frame;
/** The engine's words for why there is no frame, or "". */
export const screenRefusal = () => V.refusal;
/** Where the Trunk's newest click landed on the frame ({ x, y } shares, `at`, `trunk`), or null. */
export const screenCursor = () => (V.frame ? V.cursor : null);
/** Whether the owner is driving this screen, as the newest frame said. */
export const screenDriving = () => V.driving;
/** The engine's answer to Take over or Hand back, until the next frame says the same. */
export function setDriving(driving) { V.driving = driving === true; }
const locked = () => document.getElementById("app")?.classList.contains("locked-b17") === true;
const showing = () => V.on && !document.hidden && !locked();
/* The step the view is drawn at, in the screen's own pixels. */
function wanted() {
  const el = document.querySelector("#stage7 .st7-screen, #pip7 .pip7-screen");
  const drawn = (el?.clientWidth ?? LARGE) * (window.devicePixelRatio || 1);
  return drawn <= SMALL ? SMALL : LARGE;
}

function shown(got) {
  if (!V.on) return;
  if (got.frame) {
    const first = !V.frame || !!V.refusal, flipped = (got.driving === true) !== V.driving;
    const changedTrunk = (got.cursor?.trunk ?? null) !== (V.cursor?.trunk ?? null);
    Object.assign(V, { frame: got.frame, refusal: "", cursor: got.cursor ?? null, driving: got.driving === true });
    V.onChange?.(first || flipped || changedTrunk);
  } else if (got.refusal) {
    const changed = V.refusal !== got.refusal;
    Object.assign(V, { frame: "", refusal: got.refusal });
    if (changed) V.onChange?.(true);
  }
}

/* One open request: its frames until it ends, is refused, or is let go. Answers the status it ended with. */
async function read(controller, width) {
  const headers = token.get() ? { authorization: "Bearer " + token.get() } : {};
  const response = await fetch(`/api/panels/screen?width=${width}`, { cache: "no-store", headers, signal: controller.signal });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    shown({ refusal: data.error || String(response.status) });
    return response.status;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", status = 200;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return status;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let got = null;
      try { got = JSON.parse(line); } catch { continue; } // a line cut short is skipped
      if (got.status) status = got.status;
      if (controller === V.open) shown(got);
    }
  }
}

function stop() {
  V.open?.abort();
  V.open = null;
  clearTimeout(V.timer);
  V.timer = 0;
}
function start() {
  if (V.open || V.timer || !showing()) return;
  const controller = new AbortController(), width = wanted();
  Object.assign(V, { open: controller, width });
  read(controller, width).then((status) => status, (error) => (error.name === "AbortError" ? 0 : 500)).then((status) => {
    if (V.open !== controller) return;
    V.open = null;
    // Ended or refused: asked again in a few seconds, except while Branch is locked.
    if (status !== 423 && showing()) V.timer = setTimeout(() => { V.timer = 0; start(); }, REFUSED);
  });
}
/* Branch locking lets go of the request at once, whatever else is happening. */
function watchLock() {
  const app = document.getElementById("app");
  if (V.watching || !app) return;
  V.watching = true;
  new MutationObserver(() => { if (locked()) stop(); }).observe(app, { attributes: true, attributeFilter: ["class"] });
}

/** Reads while `on`; `onChange(redraw)` is told of each frame, `redraw` true when the view must be drawn again. */
export function watchScreen(on, onChange) {
  V.onChange = onChange;
  watchLock();
  if (!!on !== V.on) {
    V.on = !!on;
    stop();
    if (!V.on) { Object.assign(V, { frame: "", refusal: "" }); return; }
  } else if (V.open && wanted() !== V.width) stop(); // the view changed size a step: opened again at the new width
  start();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else start(); });
window.addEventListener("pagehide", stop);
