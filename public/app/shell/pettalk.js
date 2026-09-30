/* What the pet says (OC-41, OC-51): what is happening now, never a fixed line. Two kinds of words:
   - news, true of this moment and said at every rank: a Trunk waiting for a yes, Lockdown on, no model to answer with,
     work going on;
   - a hint, how to do something here, fitted to where the owner is (Settings, a conversation, a place). Hints shrink as the owner's rank grows: at Bronze and Silver at most one an hour, at Gold and above none;
     none at all while "Show tips and pop-ups" is off.
   petLine() is pure: every fact comes in `now`, so the rules can be read, and checked, in one place. */

export const HINT_EVERY = 60 * 60 * 1000;
const HINTING = new Set(["Bronze", "Silver"]);

/** Whether a hint may be said now: the rank still gets hints, tips are on and the last hint was over an hour ago. */
export const hintDue = ({ rank = "Bronze", tipsOn = true, lastHint = 0, at = Date.now() }) =>
  tipsOn && HINTING.has(rank) && at - lastHint >= HINT_EVERY;

/**
 * The line to say, or null for nothing worth saying.
 * now: { waiting: [{ runId }], connection, gateway, lockdown, noModel, failed, running: [{ id }], view, owner, keys,
 *        rank, tipsOn, lastHint, at }; `words(key, values)` puts a line into the window's language.
 */
export function petLine(now, words) {
  const news = (key, message, values) => ({ kind: "news", key, text: words(message, values) });
  if (now.connection === false) return news("offline", "window.shell.scene.connection-away");
  const waiting = now.waiting ?? [];
  if (waiting.length) return news(`waiting:${waiting.map((w) => w.runId).sort().join(",")}`, "window.shell.scene.answer-waiting");
  if (now.lockdown) return news("lockdown", "window.shell.scene.lockdown-on");
  if (now.owner && now.noModel) return news("no-model", "window.shell.scene.no-model");
  if (now.owner && now.gateway?.problem) return news("gateway-problem", "window.shell.scene.gateway-problem");
  if (now.failed) return news(`failed:${now.failed}`, "window.shell.scene.failed-here");
  const running = now.running ?? [];
  if (running.length) return news(`running:${running.map((r) => r.id).sort().join(",")}`, running.length === 1 ? "window.shell.scene.working-one-safe" : "window.shell.scene.working-count", { count: running.length });
  if (now.owner && now.view === "settings" && now.settingsPage === "gateway" && now.gateway?.running === false)
    return news("gateway-off", "window.shell.scene.gateway-not-running");
  return hintLine(now, words);
}

/** A hint for where the owner is, when one is due; null otherwise. */
export function hintLine(now, words) {
  if (!hintDue(now)) return null;
  return { kind: "hint", text: words(...hintFor(now)) };
}

/* The hint for where the owner is. Each names only what this window really does there. */
function hintFor(now) {
  if (now.view === "settings") return now.owner ? ["window.shell.scene.search-settings"] : ["window.shell.scene.hover-anything-to-see-what-it"];
  if (now.view === "chat" && now.keys?.focusPrompt) return ["window.shell.scene.focus-message", { key: now.keys.focusPrompt }];
  if (now.view === "chat" && now.keys?.sideList) return ["window.shell.scene.hide-list", { key: now.keys.sideList }];
  if (now.view === "inbox") return ["window.shell.scene.inbox-request"];
  if (now.keys?.palette) return ["window.shell.scene.find-anything", { key: now.keys.palette }];
  return ["window.shell.scene.hover-anything-to-see-what-it"];
}
