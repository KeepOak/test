/* The agent beside the conversation, 1:1 with the prototype's (pass 12 "the agent window beside the conversation"), for
   a Trunk that wears one of pass 17's characters (core/art17.js; the engine keeps which, src/trunks/record.ts character).
   What it acts out comes only from the engine and this window: the Trunk's conversation has a task waiting on you
   (state.attention, or a run that needs input), the Trunk is paused, this window is sending in that conversation, a run
   there is running, the latest run finished moments ago or failed. Whether it shows, its size and making it small are
   this window's own (FEATURE-AUDIT: ag-show, ag-size, ag-min, ag-hide), kept in this browser. */

import { esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { ic, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { look17, figure17 } from "../core/art17.js";
import { agentState } from "../core/doing.js";
import { t } from "../../i18n.js";

const AG_STATES = [["idle", "window.chat.agent.here"], ["think", "window.chat.agent.thinking"], ["work", "window.chat.agent.working"], ["search", "window.chat.agent.searching"], ["read", "window.chat.agent.reading"], ["talk", "window.chat.agent.explaining"], ["wait", "dashboard.needs.title"], ["yay", "first-run-steps.done"], ["oops", "window.chat.agent.snag"], ["sleep", "window.chat.agent.resting"]];
export const AG_LABEL = Object.fromEntries(AG_STATES);

const KEY = "branch-agent-ui";
export const AG = { show: true, size: "m", min: false };
function loadUi() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (error) { toast(error.message); }
  if (typeof saved?.show === "boolean") AG.show = saved.show;
  if (["s", "m", "l"].includes(saved?.size)) AG.size = saved.size;
  if (typeof saved?.min === "boolean") AG.min = saved.min;
}
export function saveUi(change) {
  Object.assign(AG, change);
  try { localStorage.setItem(KEY, JSON.stringify(AG)); } catch (error) { toast(error.message); }
}
loadUi();

/* What a Trunk is visibly doing lives in core/doing.js, so every face (core/ui.js av) can act it out too. */
export { agentState };

/* The Trunks of this conversation that wear a character: its own Trunk, or a room's members. */
function wearers(sessionId) {
  const own = E.trunks.find((tr) => tr.chatSessionId === sessionId);
  const room = (E.rooms ?? []).find((r) => r.sessionId === sessionId);
  const people = own ? [own] : (room?.members ?? []).map((id) => E.trunks.find((tr) => tr.id === id)).filter(Boolean);
  return people.map((tr) => [tr, look17(tr.character)]).filter(([, l]) => l);
}

/* Drawn inside the conversation's own markup (chat/chat.js draw), so a redraw never adds a second one. */
export function agentWin(sessionId, sending) {
  if (!AG.show || !sessionId) return "";
  const looks = wearers(sessionId);
  if (!looks.length) return "";
  const again = document.querySelector(".agent12") ? " again13" : ""; // drawn before: it doesn't pop in again on a redraw
  const one = ([tr, l]) => { const st = agentState(tr, sending); return `<div class="ag-one12" data-id="${esc(tr.id)}" data-st="${st}">${figure17(l, st)}<span class="ag-lab12"><b>${esc(tr.name)}</b><small><i class="ag-dot12 st-${st}"></i>${esc(t(AG_LABEL[st]))}</small></span></div>`; };
  return `<div class="agent12 size-${AG.size}${AG.min ? " min12" : ""}${again}"><div class="ag-row12">${looks.map(one).join("")}</div><div class="ag-ctl12"><button type="button" class="icon-btn" data-act="ag-min" aria-label="${AG.min ? t("window.chat.agent.show") : t("window.chat.agent.small")}">${ic(AG.min ? "plus" : "chev", "s")}</button><button type="button" class="icon-btn" data-act="ag-hide" aria-label="${t("window.chat.agent.hide")}">${ic("x", "s")}</button></div></div>`;
}

export function initAgent17() {
  on("ag-min", () => { saveUi({ min: !AG.min }); renderNow(); });
  on("ag-hide", () => { saveUi({ show: false }); renderNow(); toast(t("window.chat.agent.hidden")); });
  markLive(["ag-min", "ag-hide"]);
}
