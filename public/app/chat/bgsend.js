/* RES-702, from OpenClaw 2.0: Ctrl+Enter (Cmd+Enter on a Mac) in a new conversation's message box starts it in the
   background and leaves the person where they are. The message goes to the engine exactly as Enter would send it
   (POST /api/run with its files, Temporary, the conversation's mode and project), but the window does not wait on it:
   the box empties, the page stays, and the dock's background chip counts it while it works (chat/bg.js). When its first
   task has finished, the in-window notification card (shell/notify.js) names it, with Open. The engine carries a task
   on when the window that asked goes away (src/server.ts /api/run), so a reload loses only the card, never the work;
   the conversation is in the list and the Inbox's Finished. At most three are kept waiting at once: each holds one of
   the few connections a browser keeps open to the engine. */

import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { render } from "../core/dom.js";
import { toast } from "../core/ui.js";
import { plain } from "./markdown.js";
import { announce } from "../shell/notify.js";
import { t } from "../../i18n.js";

const MAX = 3;
const going = new Set();
export const backgroundCount = () => going.size;

const LINES = { completed: null, needs_input: "window.chat.bgsend.waiting", failed: "window.chat.bgsend.failed", cancelled: "panels.state.stopped", interrupted: "panels.state.stopped", budget_exceeded: "window.chat.bgsend.failed" };
/* The card's words: the reply's opening words once it finished, else how it ended. */
function lineOf(run) {
  const key = LINES[run?.status];
  if (key) return t(key);
  const words = plain(String(run?.output ?? "")).replace(/\s+/g, " ").trim();
  return words.length > 140 ? `${words.slice(0, 139)}…` : words || t("window.chat.bgsend.done");
}

/**
 * Starts a new conversation with `prompt` in the background. `fields` is what Enter would send with it (files,
 * Temporary, mode, project). Answers false, with the reason said, when it was not started; the caller keeps the words.
 */
export function sendInBackground(prompt, fields = {}) {
  if (going.size >= MAX) { toast(t("window.chat.bgsend.full", { count: MAX })); return false; }
  const key = Symbol(prompt);
  going.add(key);
  toast(t("window.chat.bgsend.started"));
  api("run", { prompt, ...fields })
    .then(async (run) => {
      await refresh().catch(() => {}); // the new conversation's row, before the card names it
      const title = E.sessions.find((s) => (s.sessionId ?? s.id) === run.sessionId)?.title || prompt;
      if (!announce({ sessionId: run.sessionId, who: title, question: lineOf(run) }) && S.chat !== run.sessionId) toast(t("window.chat.bgsend.finished", { name: title }));
    }, (error) => {
      toast(error.message);
      /* Never started (the engine was away, or refused the message): the words go back in an empty new-conversation box. */
      const refused = error.offline || (error.status >= 400 && error.status < 500);
      if (refused && !String(S.drafts.new ?? "").trim()) { S.drafts.new = prompt; if (!S.chat) render(); }
    })
    .finally(() => { going.delete(key); render(); });
  return true;
}
