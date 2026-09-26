/* The live half of the full-size view (stage.js): what Branch's own browser shows while a conversation's task works in
   it, from GET /api/panels/live?session=<id> (src/live-stage.ts). The engine takes one frame of the tab the task works
   in on each read (password boxes covered) and hands back the page's address and title, the tabs beside it and what
   the task is doing now; read about twice a second while the view shows the browser and a task is going, every few
   seconds while a task of the open conversation works (for its card in the conversation), and not at all otherwise or
   while the window is hidden. After the task ends the engine
   keeps its last frame in memory, and that is what is shown (not live). */

import { api } from "../core/api.js";
import { toast } from "../core/ui.js";

const L = { sid: null, view: null, said: "", timer: 0, busy: false, want: null, fast: false, onChange: null };
const FAST = 500, SLOW = 2500;

/** What the engine last said for this conversation (null before the first answer, or for another conversation). */
export const liveOf = (sid) => (sid && sid === L.sid ? L.view : null);

async function tick() {
  L.timer = 0;
  const sid = L.want;
  if (!sid || document.hidden) return;
  L.busy = true;
  try {
    const view = await api(`panels/live?session=${encodeURIComponent(sid)}`);
    if (L.want !== sid) return;
    const before = L.view;
    L.sid = sid;
    L.view = view;
    L.said = "";
    L.onChange?.(before, view);
  } catch (error) {
    // Said once, not again on every read while the engine keeps refusing for the same reason.
    if (error.message !== L.said) toast(error.message);
    L.said = error.message;
  } finally {
    L.busy = false;
    if (L.want) L.timer = setTimeout(tick, L.fast && (L.view?.runId || L.view?.browser?.live) ? FAST : SLOW);
  }
}

/** Reads for this conversation (fast while the view shows the browser); null stops reading. One read is ever in flight. */
export function watchLive(sid, onChange, fast) {
  L.onChange = onChange;
  const sooner = fast && !L.fast;
  L.fast = !!fast;
  if (L.want === sid) { if (sooner && L.timer) { clearTimeout(L.timer); L.timer = 0; tick(); } return; }
  L.want = sid;
  if (L.sid !== sid) { L.sid = null; L.view = null; }
  clearTimeout(L.timer);
  L.timer = 0;
  if (sid && !L.busy) tick();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && L.want && !L.timer && !L.busy) tick(); });
