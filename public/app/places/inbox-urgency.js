/* Sort the Inbox by urgency (Settings › Models › Decision models, the engine's switch GET /api/decisions settings.inbox):
   the rows of Needs you are ordered by the engine's 1-10 score for each (POST /api/decisions/urgency, deadlines and money
   first), highest first; a row not scored yet keeps its place after the scored ones. The engine keeps each score by the
   row's key and words, so a row is asked about once, and it scores a few new ones per read, so the rest arrive on the
   next. Off (as shipped), or on a household profile (the decision models are the owner's), nothing is asked. */
import { api } from "../core/api.js";
import { E } from "../core/state.js";

const U = { on: false, scores: {}, busy: false };

/** Re-reads the switch and the scores for these rows ([{ key, text }]); true when the order may have changed. */
export async function readUrgency(items, sayOnce) {
  if (E.profiles?.isOwner === false || U.busy) return false;
  U.busy = true;
  try {
    const was = JSON.stringify([U.on, U.scores]);
    U.on = Boolean((await api("decisions").catch(sayOnce)).settings?.inbox);
    const asked = items.filter((item) => item.text);
    if (U.on && asked.length) {
      const said = await api("decisions/urgency", { items: asked.slice(0, 50) }).catch(sayOnce);
      if (said.problem) sayOnce(new Error(said.problem));
      U.scores = said.scores ?? U.scores;
    }
    return was !== JSON.stringify([U.on, U.scores]);
  } finally { U.busy = false; }
}

/** The rows ([key, html]) in the order to draw: by score when the switch is on, else as they came. */
export function byUrgency(rows) {
  if (!U.on) return rows.map(([, html]) => html);
  const score = (key) => U.scores[key] ?? 0;
  return rows.map((row, at) => [row, at]).sort(([a, i], [b, j]) => score(b[0]) - score(a[0]) || i - j).map(([[, html]]) => html);
}
