import { Notification } from "electron";
import { notificationSound } from "./notification-sound.js";

interface Waiting { runId: string; sessionId: string; open?: string; who?: string; question?: string; parentRunId?: string; canContinue?: boolean }
interface Run { id: string; sessionId: string; status: string; title?: string; aside?: boolean; createdAt: string; updatedAt: string }
interface Quiet { enabled: boolean; timezone: string; from: string; to: string; days?: number[] }
interface State {
  attention: Waiting[]; runs: Run[];
  onboarding: { popups?: boolean; done?: boolean; skipped?: boolean };
  collab: { profile: { isOwner: boolean }; calendar: { settings?: { quietHours?: Quiet } } };
}
interface Settings { values: { notify: { needsYes: boolean; taskDone: boolean; method: string; sound: string } } }
interface WatchOptions { origin: string; call: typeof fetch; background: () => boolean;
  open: (sessionId: string) => void; log: (error: unknown) => void }
const ended = new Set(["completed", "failed", "cancelled", "budget_exceeded", "interrupted"]);

/** Same hours/days rule as the window, without loading the engine's calendar service into main. */
function quietNow(quiet: Quiet | undefined): boolean {
  if (!quiet) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timezone,
    hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  if ((quiet.days ?? []).includes(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!) + 1)) return true;
  if (!quiet.enabled) return false;
  const mins = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const now = Number(parts.hour) * 60 + Number(parts.minute), from = mins(quiet.from), to = mins(quiet.to);
  return from === to || (from < to ? now >= from && now < to : now >= from || now < to);
}

function tell(options: WatchOptions, notes: Set<Notification>, sessionId: string, title: string, body: string, notify: Settings["values"]["notify"]): void {
  notificationSound(notify.sound);
  if (notify.method !== "system" || !Notification.isSupported()) return;
  const note = new Notification({ title: title || "Branch Agent", body, silent: true });
  if (notes.size >= 32) { const oldest = notes.values().next().value; oldest?.close(); if (oldest) notes.delete(oldest); }
  notes.add(note);
  note.once("click", () => { notes.delete(note); options.open(sessionId); });
  note.once("close", () => notes.delete(note));
  note.once("failed", (_event, error) => { notes.delete(note); options.log(error); });
  note.show();
}

async function read<T>(options: WatchOptions, path: string): Promise<T> {
  const response = await options.call(`${options.origin}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Tray notification state is unavailable.");
  return await response.json() as T;
}

async function stillOwner(options: WatchOptions): Promise<boolean> {
  const state = await read<State>(options, "/api/state");
  return state.collab.profile.isOwner && state.onboarding.popups !== false &&
    !!(state.onboarding.done || state.onboarding.skipped) && !quietNow(state.collab.calendar.settings?.quietHours);
}

/** Proved read-only API requests; one poll at a time. A denied/locked read drops the baseline rather than announcing old work. */
export function watchTrayNotifications(options: WatchOptions): () => void {
  let seen: Set<string> | null = null, runs: Map<string, string> | null = null, busy = false, stopped = false;
  const notes = new Set<Notification>();
  const look = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const state = await read<State>(options, "/api/state");
      if (stopped) return;
      if (!state.collab.profile.isOwner) { seen = null; runs = null; return; }
      const before = runs, previous = seen;
      seen = new Set([...(previous ?? []), ...state.attention.map((w) => w.runId)].slice(-5000));
      runs = new Map(state.runs.map((r) => [r.id, r.status]));
      if (!previous || !before || !options.background() || state.onboarding.popups === false ||
        !(state.onboarding.done || state.onboarding.skipped) || quietNow(state.collab.calendar.settings?.quietHours)) return;
      const { values: { notify } } = await read<Settings>(options, "/api/comfort");
      const waiting = state.attention.filter((w) => !previous.has(w.runId) && !w.parentRunId && !w.canContinue).at(-1);
      const done = state.runs.filter((r) => ended.has(r.status) && ["running", "needs_input"].includes(before.get(r.id) ?? "") &&
        !r.aside && Date.parse(r.updatedAt) - Date.parse(r.createdAt) >= 120_000).at(-1);
      if ((!waiting || !notify.needsYes) && (!done || !notify.taskDone)) return;
      if (!await stillOwner(options) || stopped || !options.background()) return;
      if (waiting && notify.needsYes) tell(options, notes, waiting.open ?? waiting.sessionId, waiting.who ?? "Branch needs you", waiting.question ?? "", notify);
      if (done && notify.taskDone && done.sessionId !== (waiting?.open ?? waiting?.sessionId))
        tell(options, notes, done.sessionId, done.title ?? "Branch Agent", done.status === "completed" ? "Your task finished." : "Your task stopped.", notify);
    } catch { seen = null; runs = null; }
    finally { busy = false; }
  };
  const timer = setInterval(() => void look(), 10_000);
  timer.unref();
  void look();
  return () => { stopped = true; clearInterval(timer); for (const note of notes) note.close(); notes.clear(); };
}
