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
 * now: { waiting: [{ who }], lockdown, noModel, running: [{ who }], view, owner, keys: { palette, sideList },
 *        rank, tipsOn, lastHint, at }; `words(key, values)` puts a line into the window's language.
 */
export function petLine(now, words) {
  const waiting = now.waiting?.[0];
  if (waiting) return { kind: "news", text: words("window.shell.scene.who-needs-a-yes-its-in", { who: waiting.who || "Branch" }) };
  if (now.lockdown) return { kind: "news", text: words("window.shell.scene.lockdown-on") };
  if (now.owner && now.noModel) return { kind: "news", text: words("window.shell.scene.no-model") };
  const running = now.running ?? [];
  if (running.length === 1) return { kind: "news", text: words("window.shell.scene.working-one", { who: running[0].who || "Branch" }) };
  if (running.length > 1) return { kind: "news", text: words("window.shell.scene.working-many", { count: running.length }) };
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
  if (now.view === "chat" && now.keys?.palette) return ["window.shell.scene.find-anything", { key: now.keys.palette }];
  if (now.view === "chat" && now.keys?.sideList) return ["window.shell.scene.hide-list", { key: now.keys.sideList }];
  return ["window.shell.scene.hover-anything-to-see-what-it"];
}
