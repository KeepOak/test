/* Thinking dropped on a model switch (pass 17, part C §9; the prototype's drop17c block): a one-line note in the thread
   where the conversation's model changed. Branch never sends a model's reasoning to another, by design, so this only says
   so. The switch is where the engine recorded it: each task's chosen model (its model.selected or model.fallback event,
   GET /api/state `runs[].model`), compared by preset between one task and the next in the conversation. The note sits
   before the message that started the first task on the new model; "Why" opens the prototype's short explanation. */

import { esc } from "../core/dom.js";
import { ic, openPop } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const keyOf = (run) => run?.model?.presetId ?? run?.model?.model ?? null;
const nameOf = (run) => run?.model?.presetName || run?.model?.model || "";

/* For each user message that started a task on another model than the task before it: the two models' names. */
function switches(messages) {
  const runs = (E.state?.runs ?? []).filter((r) => S.chat && r.sessionId === S.chat)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const found = new Map();
  let from = 0, before = null;
  for (const run of runs) {
    const at = messages.findIndex((m, i) => i >= from && m.role === "user" && String(m.content ?? "").startsWith(run.prompt));
    if (at < 0) continue;
    from = at + 1;
    if (before && keyOf(before) && keyOf(run) && keyOf(before) !== keyOf(run)) found.set(messages[at], { from: nameOf(before), to: nameOf(run) });
    if (keyOf(run)) before = run;
  }
  return found;
}

const cache = { messages: null, runs: null, found: new Map() };
/* The note to draw before this message, or nothing. */
export function droppedNote(message, messages) {
  if (cache.messages !== messages || cache.runs !== E.state?.runs) Object.assign(cache, { messages, runs: E.state?.runs, found: switches(messages) });
  const s = cache.found.get(message);
  if (!s) return "";
  return `<div class="drop17c" role="note">${ic("spark", "s")}<span>${t("window.chat.switched.note", { toBold: `<b>${esc(s.to)}</b>`, from: esc(s.from), to: esc(s.to) })}</span><button type="button" class="link" data-act="dropwhy17c">${t("flowsBoards.board.handoffWhy")}</button></div>`;
}

export function initSwitched() {
  markLive(["dropwhy17c"]);
  on("dropwhy17c", (el) => openPop(el, `<div class="pt">${t("window.chat.switched.why-title")}</div><p class="pp">${t("window.chat.switched.why-body")}</p>`));
}
