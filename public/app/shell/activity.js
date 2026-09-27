/* What is running now and what waits, as the engine lists it (GET /api/activity?waiting=1: the working tasks, each
   conversation's task waiting for an answer, and the messages queued behind them). Read again whenever the engine's state
   changes, which the event stream already triggers, so the status bar's count (working tasks only) and its popover (all
   of them, a clock for the ones that wait) never guess. */

import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { renderNow } from "../core/dom.js";

export const ACT = { list: [], seen: null };
export const working = () => ACT.list.filter((a) => (a.task?.state ?? "working") === "working").length;

export async function readActivity() {
  if (!E.loaded || ACT.seen === E.state) return;
  ACT.seen = E.state;
  const before = JSON.stringify(ACT.list.map((a) => [a.runId, a.task?.state]));
  // The tasks waiting for an answer are the owner's prompts: while a household profile is switched on, only what runs is
  // listed, never the owner's waiting questions.
  const active = E.profiles?.active, onProfile = Boolean(active && typeof active === "object" ? active.id : active);
  const list = await api(onProfile ? "activity" : "activity?waiting=1").catch(() => null);
  if (!Array.isArray(list)) return;
  ACT.list = list;
  if (JSON.stringify(list.map((a) => [a.runId, a.task?.state])) !== before) renderNow();
}
