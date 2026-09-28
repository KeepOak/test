/* Sort the Inbox by urgency (Settings › Models › Decision models, the engine's switch GET /api/decisions settings.inbox):
   the rows of Needs you are ordered by the engine's 1-10 score for each (POST /api/decisions/urgency, deadlines and money
   first), highest first; a row not scored yet keeps its place after the scored ones. The engine keeps each score by the
   row's key and words, so a row is asked about once, and it scores a few new ones per call. The rows not scored yet are
   sent first, so every row is reached in time; the same rows are asked about again only once they change, or a minute
   later, so a redraw caused by new scores never asks for the next few by itself. Off (as shipped), or on a household
   profile (the decision models are the owner's), nothing is asked. */
import { api } from "../core/api.js";
import { E } from "../core/state.js";

const U = { on: false, scores: {}, busy: false, asked: "", at: 0 };
const againAfterMs = 60_000;

/** Re-reads the switch and the scores for these rows ([{ key, text }]); true when the order may have changed. */
export async function readUrgency(items, sayOnce) {
  if (E.profiles?.isOwner === false || U.busy) return false;
  U.busy = true;
  try {
    const was = JSON.stringify([U.on, U.scores]);
    U.on = Boolean((await api("decisions").catch(sayOnce)).settings?.inbox);
    const rows = items.filter((item) => item.text), keys = new Set(rows.map((item) => item.key));
    // A row that left the list takes its score with it.
    U.scores = Object.fromEntries(Object.entries(U.scores).filter(([key]) => keys.has(key)));
    const sent = [...rows.filter((item) => !(item.key in U.scores)), ...rows.filter((item) => item.key in U.scores)].slice(0, 50);
    const signature = JSON.stringify(rows);
    if (U.on && sent.length && (signature !== U.asked || Date.now() - U.at >= againAfterMs)) {
      U.asked = signature;
      U.at = Date.now();
      const said = await api("decisions/urgency", { items: sent }).catch(sayOnce);
      if (said.problem) sayOnce(new Error(said.problem));
      U.scores = { ...U.scores, ...(said.scores ?? {}) };
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
