/* Weighted whole-turn windows reviewed in Hermes thread/list.tsx (a9a54245, MIT).
   Original Branch DOM implementation. No stored messages are removed or clipped. */
import { $, esc, renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { privateContext } from "./scroll-follow.js";
import { t } from "../../i18n.js";

const PAGE = 600, MIN_TURNS = 8, views = new Map();
let state = () => ({}), pending = null;
const scope = () => `${privateContext()}:${state().sessionId ?? "new"}`;
export const transcriptRevision = (key) => { const v = saved(key); return `${v.budget}:${v.end}`; };

export function paintWeight(message) {
  return 1 + Math.ceil(String(message?.content ?? "").length / 600)
    + (message?.toolCalls?.length ?? 0) * 2 + (message?.attachments?.length ?? 0) * 12;
}

function saved(key) {
  let value = views.get(key);
  if (!value) {
    value = { budget: PAGE, end: null, length: 0 };
    views.set(key, value);
    if (views.size > 64) views.delete(views.keys().next().value);
  }
  return value;
}

/** Group before cutting so a user's question keeps every following tool and answer. */
export function transcriptWindow(key, items, begins, weight = paintWeight, all = false) {
  const value = saved(key), reading = state().atBottom === false;
  if (all) return { items, start: 0, controls: "" };
  if (!reading || value.end === null || items.length < value.length) value.end = items.length;
  value.length = items.length;
  const end = Math.min(value.end, items.length), groups = [];
  for (let i = 0; i < end; i++) {
    if (!groups.length || begins(items[i])) groups.push({ start: i, weight: 0 });
    groups.at(-1).weight += weight(items[i]);
  }
  let start = end, spent = 0, turns = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (turns >= MIN_TURNS && spent + groups[i].weight > value.budget) break;
    start = groups[i].start; spent += groups[i].weight; turns++;
  }
  const more = start > 0 ? `<button class="btn ghost sm" type="button" data-act="transcript-earlier" data-key="${esc(key)}" aria-controls="conversation">${esc(t("conversation.render.earlier", { count: start }))}</button>` : "";
  const newer = end < items.length ? `<button class="btn sm" type="button" data-act="transcript-latest" data-key="${esc(key)}" aria-controls="conversation">${esc(t("conversation.render.latest", { count: items.length - end }))}</button>` : "";
  return { items: items.slice(start, end), start, controls: more || newer ? `<div class="acts">${more}${newer}</div>` : "" };
}

function expand(key, latest) {
  if (!views.has(key)) return;
  const box = $("#scroll"), value = views.get(key);
  if (latest) {
    value.end = null; state().atBottom = true; pending = null;
  } else {
    const bounds = box?.getBoundingClientRect();
    const anchor = bounds && [...box.querySelectorAll("[data-i15]")].find((n) => n.getBoundingClientRect().bottom > bounds.top);
    pending = { key, scope: scope(), id: anchor?.dataset.i15, top: anchor?.getBoundingClientRect().top,
      scroll: box?.scrollTop ?? 0, height: box?.scrollHeight ?? 0 };
    value.budget += PAGE;
    state().atBottom = false;
  }
  document.getSelection()?.removeAllRanges();
  renderNow();
}

/** Restore the same visible message after a prepend; use height delta when no message has an ID. */
export function afterTranscriptWindow() {
  if (!pending) return;
  const kept = pending; pending = null;
  const box = $("#scroll");
  if (!box || kept.scope !== scope()) return;
  const anchor = kept.id ? box.querySelector(`[data-i15="${CSS.escape(kept.id)}"]`) : null;
  if (anchor && Number.isFinite(kept.top)) box.scrollTop += anchor.getBoundingClientRect().top - kept.top;
  else box.scrollTop = kept.scroll + Math.max(0, box.scrollHeight - kept.height);
  state().readTop = box.scrollTop;
}

export function initTranscriptWindow(readState) {
  state = readState;
  markLive(["transcript-earlier", "transcript-latest"]);
  on("transcript-earlier", (el) => expand(el.dataset.key, false));
  on("transcript-latest", (el) => expand(el.dataset.key, true));
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.('[data-act="jump-follow"]')) return;
    for (const [key, value] of views) if (key.startsWith(`${scope()}:`)) value.end = null;
    state().atBottom = true;
  }, true);
}
