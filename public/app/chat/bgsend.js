/* RES-702, from OpenClaw 2.0: Ctrl+Enter (Cmd+Enter on a Mac) in a new conversation's message box starts it in the
   background and leaves the person where they are. The message goes to the engine exactly as Enter would send it
   (POST /api/run with its files, Temporary, the conversation's mode and project), but the window does not wait on it:
   the box empties, the page stays, and the dock's background chip counts it while it works (chat/bg.js). When its first
   task has finished, the in-window notification card (shell/notify.js) names it, with Open. The engine carries a task
   on when the window that asked goes away (src/server.ts /api/run), so a reload loses only the card, never the work;
   the conversation is in the list and the Inbox's Finished. Each waits in one of the window's few long waits
   (core/inflight.js), shared with the panes. */

import { S, E, refresh, activeId } from "../core/state.js";
import { api } from "../core/api.js";
import { render, onRender } from "../core/dom.js";
import { toast } from "../core/ui.js";
import { plain } from "./markdown.js";
import { announce } from "../shell/notify.js";
import { waitRoom, holdWait, LONG_WAITS } from "../core/inflight.js";
import { t } from "../../i18n.js";


const LINES = { completed: null, needs_input: "window.chat.bgsend.waiting", failed: "window.chat.bgsend.failed", cancelled: "panels.state.stopped", interrupted: "panels.state.stopped", budget_exceeded: "window.chat.bgsend.failed" };
const ENDED = new Set(["completed", "failed", "cancelled", "interrupted", "budget_exceeded"]);
/* Each first task is kept with the person who started it (activeId at the press): its card names that person's prompt
   and reply, so it is shown only while that person uses the window, and waits while someone else does. */
const firstTasks = new Map();
function finished(run, prompt, profile) {
  if (!ENDED.has(run?.status) || activeId() !== profile) return false;
  const title = E.sessions.find((s) => (s.sessionId ?? s.id) === run.sessionId)?.title || prompt;
  announce({ sessionId: run.sessionId, who: title, question: lineOf(run) });
  return true;
}
onRender(() => {
  for (const [id, pending] of firstTasks) {
    const run = E.state?.runs?.find((r) => r.id === id);
    if (finished(run, pending.prompt, pending.profile)) firstTasks.delete(id);
  }
});
/* The card's words: the reply's opening words once it finished, else how it ended. */
function lineOf(run) {
  const key = LINES[run?.status];
  if (key) return t(key);
  const words = plain(String(run?.output ?? "")).replace(/\s+/g, " ").trim();
  return words.length > 140 ? `${words.slice(0, 139)}…` : words || t("window.chat.bgsend.done");
}

/** Whether one more may start now; says why not. Asked before the message's files and choices are taken for it. */
export function roomAway() {
  if (waitRoom()) return true;
  toast(t("window.chat.bgsend.full", { count: LONG_WAITS }));
  return false;
}

/**
 * Starts a new conversation with `prompt` in the background. `fields` is what Enter would send with it (files,
 * Temporary, mode, project). Answers false, with the reason said, when it was not started; the caller keeps the words.
 */
export function sendInBackground(prompt, fields = {}, settle = () => {}, draft = prompt) {
  if (!waitRoom()) { toast(t("window.chat.bgsend.full", { count: LONG_WAITS })); return false; }
  const letGo = holdWait(), profile = activeId();
  toast(t("window.chat.bgsend.started"));
  api("run", { prompt, ...fields })
    .then(async (run) => {
      settle(false);
      await refresh().catch(() => {}); // the new conversation's row, before the card names it
      if (!finished(run, prompt, profile) && run?.id && run?.sessionId) firstTasks.set(run.id, { prompt, profile });
    }, (error) => {
      toast(error.message);
      /* Never started (the engine was away, or refused the message): the words go back in an empty new-conversation box. */
      const refused = error.offline || (error.status >= 400 && error.status < 500);
      const restoreHere = settle(refused) !== false;
      if (refused && restoreHere && !String(S.drafts.new ?? "").trim()) { S.drafts.new = draft; if (!S.chat) render(); }
    })
    .finally(() => { letGo(); render(); });
  return true;
}
