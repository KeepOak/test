/* The live half of the full-size view (stage.js): what Branch's own browser shows while a conversation's task works in
   it, from GET /api/panels/live?session=<id> (src/live-stage.ts). The engine takes one frame of the tab the task works
   in on each read (password boxes covered) and hands back the page's address and title, the tabs beside it and what
   the task is doing now; pushed through a bounded masked stream while the view shows the browser, with ordinary
   reads as a fallback, every few seconds while a task works (for its card in the conversation), and not at all otherwise or
   while the window is hidden. After the task ends the engine
   keeps its last frame in memory, and that is what is shown (not live). */

import { api, token } from "../core/api.js";
import { toast } from "../core/ui.js";
import { S, ownerHere } from "../core/state.js";
import { onRender } from "../core/dom.js";
import { readStageStream } from "./stage-live-stream.js";

const L = { sid: null, view: null, said: "", timer: 0, busy: false, want: null, fast: false, onChange: null,
  controller: null, generation: 0, retryStreamAt: 0, auth: "" };
const FAST = 500, SLOW = 2500;
const visible = () => ownerHere() && S.signedIn && !document.hidden
  && !document.getElementById("app")?.classList.contains("locked-b17");

/** What the engine last said for this conversation (null before the first answer, or for another conversation). */
export const liveOf = (sid) => (sid && sid === L.sid ? L.view : null);
export const liveError = (sid) => (sid && sid === L.want ? L.said : "");
export const liveLoading = (sid) => !!sid && (!L.want || sid === L.want) && !L.view && !L.said;


async function tick() {
  L.timer = 0;
  const sid = L.want;
  if (!sid || !visible() || L.busy) return;
  const controller = new AbortController(), generation = L.generation, auth = token.get();
  const current = () => !controller.signal.aborted && L.want === sid && S.chat === sid
    && L.generation === generation && token.get() === auth && visible();
  const changed = (view) => {
    if (!current()) return;
    const before = L.view; L.sid = sid; L.view = view; L.said = ""; L.onChange?.(before, view);
  };
  L.controller = controller; L.auth = auth;
  L.busy = true;
  try {
    if (L.fast && Date.now() >= L.retryStreamAt) {
      try { await readStageStream(sid, controller.signal, current, changed); return; }
      catch { if (!current()) return; L.retryStreamAt = Date.now() + 30_000; }
    }
    changed(await api(`panels/live?session=${encodeURIComponent(sid)}`, undefined, "GET", controller.signal));
  } catch (error) {
    if (!current()) return;
    // Said once, not again on every read while the engine keeps refusing for the same reason.
    if (error.message !== L.said) toast(error.message);
    L.said = error.message;
    if (L.want === sid) L.onChange?.(L.view, L.view);
  } finally {
    if (L.controller === controller) { L.controller = null; L.busy = false; }
    const delay = L.fast && (L.view?.runId || L.view?.browser?.live) ? FAST : SLOW;
    if (L.want && visible()) L.timer = setTimeout(tick, L.generation === generation ? delay : 0);
  }
}

/** Reads for this conversation (fast while the view shows the browser); null stops reading. One read is ever in flight. */
export function watchLive(sid, onChange, fast) {
  L.onChange = onChange;
  const speedChanged = L.fast !== !!fast; L.fast = !!fast;
  if (L.want === sid && !speedChanged) return;
  L.generation++; L.controller?.abort();
  L.want = sid;
  if (L.sid !== sid) { L.sid = null; L.view = null; L.said = ""; }
  clearTimeout(L.timer);
  L.timer = 0;
  if (sid && !L.busy) tick();
}
function retire() {
  L.generation++; L.controller?.abort(); clearTimeout(L.timer); L.timer = 0;
  L.sid = null; L.view = null; L.said = "";
}
onRender(() => {
  if (L.controller && (!visible() || S.chat !== L.want || token.get() !== L.auth)) retire();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) retire(); else if (L.want && !L.timer && !L.busy) tick();
});
addEventListener("pagehide", retire);
const root = document.getElementById("app");
if (root) new MutationObserver(() => {
  if (!visible()) retire(); else if (L.want && !L.timer && !L.busy) tick();
}).observe(root, { attributes: true, attributeFilter: ["class"] });
