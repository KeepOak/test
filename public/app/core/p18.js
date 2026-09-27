/* Pass 18 pieces shared by several places (design/redesign/pass18/PASS18.md, patch18.js liveLine18 and empty18):
   - liveLine18: the plain line under a Trunk's face, from the engine only (GET /api/state): "Needs you: <its question>"
     in copper while its conversation waits on the person (state.attention, or a run needing input), "Paused" for a
     paused Trunk, the first line of what its running task was asked while it works, else "Idle".
   - empty18: the friendly empty state drawn in place of a list the engine returned empty: a Branch pose
     (public/art/branch-<pose>.webp) playing its loop (/art/anim-<loop>.webm, gated like every face: core/figures.js
     plays it only while on screen and the window is shown), one sentence and one button. A button's action is registered where it lives; one
     with nothing real behind it stays greyed on its own (core/features.js greyOut), and one that decides who may see or
     act is drawn held (data-held="security"). Only drawn once the list was read, never while it is still loading. */

import { esc } from "./dom.js";
import { E, trunkIntro } from "./state.js";
import { agentState } from "./doing.js";
import { t } from "../../i18n.js";
import { media17, sized, look17 } from "./art17.js";
import { reason } from "./why.js";

const firstLine = (text) => String(text ?? "").split("\n")[0].trim().slice(0, 120);

/* The newest running task of a conversation, and what it was asked (never the engine's own ask a Trunk opens with). */
function workingOn(sessionId) {
  const runs = (E.state?.runs ?? []).filter((r) => r.sessionId === sessionId && r.status === "running");
  const newest = runs.reduce((a, r) => (!a || String(r.createdAt) > String(a.createdAt) ? r : a), null);
  if (!newest) return null;
  return trunkIntro({ role: "user", content: newest.prompt }) ? "" : firstLine(newest.prompt);
}

/* What a Trunk's conversation is waiting on the person for, in the engine's words. */
function question(sessionId) {
  const a = (E.state?.attention ?? []).find((x) => x.sessionId === sessionId && !x.canContinue);
  if (a) return firstLine(a.question);
  return firstLine((E.state?.runs ?? []).find((r) => r.sessionId === sessionId && r.status === "needs_input")?.output);
}

/** The line under a Trunk's face. `typing` adds the typing dots (a room member the engine says is typing). */
export function liveLine18(trunk, { typing = false } = {}) {
  if (!trunk) return "";
  const dots = typing ? '<span class="typing18" aria-hidden="true"><i></i><i></i><i></i></span>' : "";
  const st = agentState(trunk);
  if (st === "wait") return `<span class="live18 you18">${esc(t("window.p18.needs-you", { what: question(trunk.chatSessionId) }))}</span>`;
  if (trunk.paused) return `<span class="live18">${t("dashboard.standing.paused")}</span>`;
  const doing = trunk.chatSessionId ? workingOn(trunk.chatSessionId) : null;
  if (doing !== null) return `<span class="live18">${esc(doing || t("live.working"))}${dots}</span>`;
  return `<span class="live18">${t("window.chat.stage.idle")}${dots}</span>`;
}

/* [pose, sentence key, button key, action, extra attributes, held for the separate security review] */
const EMPTY18 = {
  "team:live": ["sleep", "window.p18.empty.team-live", "window.p18.start-conversation", "newconv"],
  "team:people": ["wave", "window.p18.empty.team-people", "household.invite", "invite18c", "", true],
  "team:groups": ["point", "window.p18.empty.team-groups", "window.p18.make-group", "group18c", "", true],
  "team:shared": ["read", "window.p18.empty.team-shared", "window.p18.share-conversation", "share18c", "", true],
  "team:agents": ["work", "window.p18.empty.team-agents", "window.p18.make-team", "mkteam18c"],
  "team:activity": ["read", "window.p18.empty.team-activity", "window.p18.start-conversation", "newconv"],
  "team:usage": ["sleep", "window.p18.empty.team-usage", "window.p18.start-conversation", "newconv"],
  "inbox:needs": ["yay", "window.p18.empty.inbox-needs", "window.p18.start-conversation", "newconv"],
  "inbox:finished": ["sleep", "window.p18.empty.inbox-finished", "window.p18.start-conversation", "newconv"],
  "inbox:history": ["read", "window.p18.empty.inbox-history", "window.p18.start-conversation", "newconv"],
  "automations:scheduled": ["sleep", "window.p18.empty.auto-scheduled", "window.shell.shell.new-automation", "newmenu"],
  "automations:triggers": ["point", "window.p18.empty.auto-triggers", "window.shell.shell.new-automation", "newmenu"],
  "library:memory": ["think", "window.p18.empty.lib-memory", "window.p18.start-conversation", "newconv"],
  "library:documents": ["read", "window.p18.empty.lib-documents", "window.p18.start-conversation", "newconv"],
  "library:made": ["workbook", "window.p18.empty.lib-made", "window.p18.start-conversation", "newconv"],
  "customize:trunks": ["wave", "window.p18.empty.cust-trunks", "studio.newName", "chat", 'data-id="new"'],
  "customize:specialists": ["work", "window.p18.empty.cust-specialists", "window.p18.make-team", "mkteam18c"],
  "pane:activity": ["think", "window.p18.empty.pane-activity", "window.p18.ask-something", "ask18c"],
};

/* Each pose's own loop; a pose with none plays Branch's idle loop, as the conversation's empty state does (chat/chat.js). */
const LOOP18 = { sleep: "sleep", wave: "idle", point: "idle", read: "read", work: "work", yay: "yay", think: "think", workbook: "read" };

/** The empty state for one list, e.g. "team:live". `off` greys its button for an exact engine reason (Make a team
    with no specialists: POST /api/teams needs 1 to 8). */
export function empty18(key, { off = false } = {}) {
  const [pose, line, btn, act, extra = "", held = false] = EMPTY18[key];
  const hold = held ? ' data-held="security" aria-disabled="true" disabled' : off ? ' aria-disabled="true" disabled' : "";
  const art = media17(`/art/branch-${pose}.webp`, sized(`/art/anim-${LOOP18[pose]}.webm`, look17("branch")?.sizes, 120), "gate17");
  const why = off && !held ? reason(act) : ""; // its exact reason, as its tip and under it (core/why.js)
  const tip = why ? ` data-tip="${esc(why)}"` : "", whyText = why ? ` data-why-text="${esc(why)}"` : "";
  return `<div class="empty18c"${whyText}>${art}<p>${t(line)}</p><button class="btn pri${held ? " held18" : ""}" type="button" data-act="${act}" ${extra}${hold}${tip}>${t(btn)}</button></div>`;
}
