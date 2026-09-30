/* UP-UI-006: the words being typed survive a crash, a restart or a closed window. S.drafts (core/state.js) is kept in this
   browser for the person signed in, per conversation: text only, the newest 50. It is written a moment after typing
   stops, at once when a draft is emptied (a message sent), so a reload never brings back words already sent, and when
   the page goes away. Every writer of S.drafts is kept without being changed: S.drafts becomes a Proxy that notes each
   change. Storage refused (a private window, a full quota) only means nothing is kept; typing never breaks.
   Adapted from Hermes Agent's draft store (apps/desktop/src/store/composer.ts, MIT); see THIRD_PARTY_NOTICES.md. */

import { S, activeId } from "./state.js";

const PREFIX = "branch-drafts:", MOST = 50, WAIT = 400;
const at = new Map(); // conversation key → when its words last changed, for keeping the newest
let where = null, timer = 0, watching = false;

const blank = (text) => typeof text !== "string" || !text.trim();

function write() {
  clearTimeout(timer);
  timer = 0;
  if (!where) return;
  const kept = Object.entries(S.drafts).filter(([, text]) => !blank(text))
    .map(([key, text]) => [key, text, at.get(key) ?? 0]).sort((a, b) => a[2] - b[2]).slice(-MOST);
  try {
    if (kept.length) localStorage.setItem(where, JSON.stringify(kept));
    else localStorage.removeItem(where);
  } catch { /* storage refused: nothing is kept */ }
}

function changed(key, text) {
  at.set(key, Date.now());
  if (blank(text)) write();
  else if (!timer) timer = setTimeout(write, WAIT);
}

function read() {
  try {
    const rows = JSON.parse(localStorage.getItem(where) || "[]");
    return Array.isArray(rows) ? rows.filter((row) => Array.isArray(row) && typeof row[0] === "string" && !blank(row[1])) : [];
  } catch { return []; }
}

/* Once the engine has let the window in (the person is known): what this person left unsent comes back into S.drafts,
   except where the window already holds words (a live update's own draft is newer), and from then on is kept. */
export function keepDrafts() {
  where = PREFIX + (activeId() ?? "owner");
  const drafts = S.drafts;
  for (const [key, text, when] of read()) {
    if (!blank(drafts[key])) continue;
    drafts[key] = text;
    at.set(key, Number(when) || 0);
  }
  if (!watching) {
    watching = true;
    S.drafts = new Proxy(drafts, {
      set(target, key, text) { target[key] = text; if (typeof key === "string") changed(key, text); return true; },
      deleteProperty(target, key) { delete target[key]; if (typeof key === "string") changed(key, ""); return true; },
    });
    addEventListener("pagehide", () => { if (timer) write(); });
  }
  write(); // words typed before the person was known are kept too
}
