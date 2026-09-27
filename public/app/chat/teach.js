/* "Show it how, once" (prototype teach-start / teach-stop): teaching a Trunk by doing a job once while it watches, through
   the engine's own teaching (POST /api/trunks/<id>/watch, then POST /api/trunks/<id>/teach). Starting names the Trunk:
   the one answering the open conversation, or, from anywhere else, the one picked from the list. A new conversation opens
   with the "watching and learning" bar: the engine learns only from a task the owner did, never from a Trunk's own turn,
   so the job is done there rather than in the Trunk's conversation. "I'm done, save it" asks the engine to keep the
   task done in that conversation since watching began (its newest finished one, named by id, never an older one) as a
   workflow given to that Trunk; until one has finished the button waits. */

import { esc, renderNow } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, toast, openPop, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

let T = null;
let X = { start: () => {} };

/* The Trunk answering a conversation: its own chat, or the one the conversation was given to. */
function trunkOf(sid) {
  if (!sid) return null;
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === sid);
  return E.trunks.find((tr) => tr.chatSessionId === sid || tr.id === s?.trunkId || tr.id === s?.trunk?.id) ?? null;
}
/* The task done while it watched: this conversation's newest finished task started since watching began. */
const finishedSince = () => (E.state?.runs ?? []).filter((r) => r.sessionId === T.sid && r.status === "completed" && String(r.createdAt) >= T.since)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;

/* Drawn over the conversation opened for the lesson; a new conversation's bar follows it once its first message gives it an id. */
export function teachBar(sessionId) {
  if (!T || T.sid !== (sessionId ?? null)) return "";
  return `<div class="bar teach">${ic("teach", "s")}<span><b>${t("window.chat.teach.watching", { name: esc(T.name) })}</b> ${t("window.chat.teach.do-once")}</span><button class="btn sm" type="button" data-act="teach-stop" ${finishedSince() ? "" : "disabled"}>${t("window.chat.teach.done")}</button></div>`;
}
export function teachAdopt(sessionId) {
  if (T && T.sid === null && sessionId) T.sid = sessionId;
}

const picker = () => `<div class="ph">${t("window.chat.teach.picker")}</div>${E.trunks.map((tr) => `<button class="mi" type="button" data-act="teach-start" data-id="${esc(tr.id)}">${av(tr, 22)}<span><span class="mi-t">${esc(tr.name)}</span><span class="mi-s">${esc(tr.title ?? "")}</span></span></button>`).join("")}`;

async function start(el) {
  const trunk = E.trunks.find((tr) => tr.id === el.dataset.id) ?? (S.view === "chat" ? trunkOf(S.chat) : null);
  if (!trunk) { if (E.trunks.length) openPop(el, picker()); return; }
  closePop();
  let watching;
  try { watching = await api(`trunks/${encodeURIComponent(trunk.id)}/watch`, {}); } catch (error) { toast(error.message); return; }
  T = { trunkId: trunk.id, name: trunk.name, since: watching.since, sid: null };
  X.start();
}

async function stop() {
  const run = T ? finishedSince() : null;
  if (!run) return;
  try { await api(`trunks/${encodeURIComponent(T.trunkId)}/teach`, { runId: run.id }); } catch (error) { toast(error.message); return; }
  T = null;
  renderNow();
}

export function initTeach(context) {
  X = context;
  markLive(["teach-start", "teach-stop"]);
  on("teach-start", (el) => start(el));
  on("teach-stop", () => stop());
}
