/* What is worth telling the owner, and when to keep quiet: the rules of shell/notify.js with nothing of the page in them,
   so the desktop app's main process tells the owner the same things while Branch sits in the tray with no window yet
   (src/desktop/tray-notify.ts). Every function here takes what it needs and returns an answer; nothing is kept. */

export const LONG_MS = 120000;
export const ENDED = new Set(["completed", "failed", "cancelled", "budget_exceeded", "interrupted"]);

/* The two sounds, made on the spot with the Web Audio API: [frequency Hz, start s, length s] per note, and the wave. */
export const SOUNDS = {
  chime: { wave: "sine", notes: [[880, 0, 0.35], [1320, 0.16, 0.45]] },
  knock: { wave: "triangle", notes: [[150, 0, 0.09], [150, 0.16, 0.09]] },
};

/* Plays a sound on an AudioContext; answers whether it played. */
export function playOn(context, kind) {
  const sound = SOUNDS[kind];
  if (!sound) return false;
  const at = context.currentTime;
  for (const [freq, start, length] of sound.notes) {
    const osc = context.createOscillator(), gain = context.createGain();
    osc.type = sound.wave;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at + start);
    gain.gain.exponentialRampToValueAtTime(0.25, at + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + start + length);
    osc.connect(gain).connect(context.destination);
    osc.start(at + start); osc.stop(at + start + length + 0.02);
  }
  return true;
}

/* The owner's quiet hours or whole day off, in the quiet hours' own time zone (src/calendar.ts inQuietHours). */
export function quietNow(quiet, at = new Date()) {
  if (!quiet) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timezone || "UTC", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  if ((quiet.days ?? []).includes(weekday)) return true;
  if (!quiet.enabled) return false;
  const now = Number(parts.hour) * 60 + Number(parts.minute), mins = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
  const from = mins(quiet.from), to = mins(quiet.to);
  return from === to || (from < to ? now >= from && now < to : now >= from || now < to);
}

/* A conversation's name: its Trunk's or its room's, else its title or first words. */
export function nameOf(id, { trunks = [], rooms = [], sessions = [] } = {}) {
  if (!id) return "";
  const trunk = trunks.find((t) => t.chatSessionId === id || (t.retiredChats ?? []).includes(id));
  const room = rooms.find((r) => r.sessionId === id);
  const session = sessions.find((s) => (s.sessionId ?? s.id) === id);
  return trunk?.name || room?.name || session?.title || session?.opening || "";
}

/* A task that has just started waiting for an answer, in a conversation not on screen: the newest, or null. `seen` holds
   the run ids already told (null before the first look: what waited then is the Inbox's, not news); the answer carries
   the next `seen`. A helper's question and a task Branch closed on are not announced. */
export function waitingNews(attention, seen, onScreen = () => false) {
  if (!Array.isArray(attention)) return { news: null, seen };
  const ids = attention.map((w) => w.runId);
  if (seen === null) return { news: null, seen: new Set(ids) };
  const next = new Set(seen);
  const fresh = attention.filter((w) => !seen.has(w.runId) && !w.parentRunId && !w.canContinue);
  for (const id of ids) next.add(id);
  return { news: fresh.filter((w) => !onScreen(w.open || w.sessionId)).at(-1) ?? null, seen: next };
}

/* A task of the owner's that ran two minutes or more and has just ended, in a conversation not on screen: the newest, or
   null. `before` maps run ids to their last status (null before the first look); the answer carries the next map. */
export function doneNews(runs, before, onScreen = () => false) {
  if (!Array.isArray(runs)) return { news: null, before };
  const next = new Map(runs.map((r) => [r.id, r.status]));
  if (before === null) return { news: null, before: next };
  const news = runs.filter((r) => ENDED.has(r.status) && ["running", "needs_input"].includes(before.get(r.id)) && !r.aside
    && Date.parse(r.updatedAt) - Date.parse(r.createdAt) >= LONG_MS && !onScreen(r.sessionId)).at(-1) ?? null;
  return { news, before: next };
}
