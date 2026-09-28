/**
 * Telling the owner while Branch sits in the tray with no window yet (a quiet start): what the window's own
 * notifications do (public/app/shell/notify.js), with the same rules (public/app/shell/notify-rules.js), from main.
 * A task that starts waiting for an answer, or a long task that ends, plays the owner's sound and, when the owner asked
 * for the computer's own notification, shows one; quiet hours, the switches in Settings › Notifications and "Show tips
 * and pop-ups" are followed exactly as the window follows them. Once the window's page is open it tells the owner
 * itself, so this stops.
 */

/** The page's rules module, as main loads it (public/app/shell/notify-rules.js). */
export interface NotifyRules {
  quietNow(quiet: unknown, at?: Date): boolean;
  nameOf(id: string, lists: { trunks?: unknown[]; rooms?: unknown[]; sessions?: unknown[] }): string;
  waitingNews(attention: unknown, seen: Set<string> | null): { news: Waiting | null; seen: Set<string> | null };
  doneNews(runs: unknown, before: Map<string, string> | null): { news: Ended | null; before: Map<string, string> | null };
}
export interface Waiting { runId: string; open?: string; sessionId?: string; who?: string; question?: string }
export interface Ended { id: string; status: string; sessionId?: string; title?: string }

export interface TrayNotifyDeps {
  rules: NotifyRules;
  /** The engine's address and its key; the key throws while the engine starts again. */
  url: string;
  key: () => string;
  /** The window's words, in the owner's language: "window.shell.notify.done" and ".stopped". */
  words: (key: string) => string;
  /** Shows the computer's own notification; a press on it opens the window at that conversation. */
  notify: (title: string, body: string, sessionId: string | undefined) => void;
  sound: (kind: string) => void;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface Snapshot {
  state: { attention?: unknown; runs?: unknown; onboarding?: { done?: boolean; popups?: boolean } };
  notify: { needsYes?: boolean; taskDone?: boolean; sound?: string; method?: string } | null;
  quiet: unknown;
  lists: { trunks?: unknown[]; rooms?: unknown[]; sessions?: unknown[] };
}

export class TrayNotifier {
  private seen: Set<string> | null = null;
  private before: Map<string, string> | null = null;
  private stopped = false;
  private controller: AbortController | null = null;
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | null = null;
  private again = false;
  /** How many looks have been taken (a test reads it to know the notifier has seen what happened). */
  looks = 0;

  constructor(private readonly deps: TrayNotifyDeps) {}

  /** Takes a first look (what already waits is the Inbox's, not news), then follows the engine's events. */
  start(): void {
    void this.check().then(() => this.follow());
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort();
  }

  private get(path: string): Promise<unknown> {
    const call = this.deps.fetch ?? fetch;
    return call(`${this.deps.url}/api/${path}`, { headers: { authorization: `Bearer ${this.deps.key()}` }, signal: AbortSignal.timeout(10000) })
      .then((response) => { if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); });
  }

  private async snapshot(): Promise<Snapshot> {
    const [state, comfort, calendar, trunks, sessions] = await Promise.all([
      this.get("state"), this.get("comfort").catch(() => null), this.get("calendar").catch(() => null),
      this.get("trunks").catch(() => null), this.get("sessions?limit=50").catch(() => null),
    ]) as [Snapshot["state"], { values?: { notify?: Snapshot["notify"] } } | null, { settings?: { quietHours?: unknown } } | null,
      { trunks?: unknown[]; rooms?: unknown[] } | null, { sessions?: unknown[] } | null];
    return { state, notify: comfort?.values?.notify ?? null, quiet: calendar?.settings?.quietHours ?? null,
      lists: { trunks: trunks?.trunks ?? [], rooms: trunks?.rooms ?? [], sessions: sessions?.sessions ?? [] } };
  }

  /** One look at the engine; a look asked for while one runs is taken once it ends. */
  check(): Promise<void> {
    if (this.checking) { this.again = true; return this.checking; }
    this.checking = this.look().catch((error: Error) => this.deps.log?.(`Tray notifications: ${error.message}`))
      .finally(() => { this.checking = null; if (this.again && !this.stopped) { this.again = false; void this.check(); } });
    return this.checking;
  }

  private async look(): Promise<void> {
    const now = await this.snapshot();
    if (this.stopped) return;
    this.looks++;
    const first = this.seen === null;
    const waiting = this.deps.rules.waitingNews(now.state.attention, this.seen);
    const ended = this.deps.rules.doneNews(now.state.runs, this.before);
    this.seen = waiting.seen;
    this.before = ended.before;
    if (first) return;
    // The window's "quiet": pop-ups turned off, or setup not finished (the window would be showing it).
    const quiet = now.state.onboarding?.popups === false || now.state.onboarding?.done === false;
    if (quiet) return;
    const name = (id: string | undefined) => (id ? this.deps.rules.nameOf(id, now.lists) : "");
    const w = waiting.news;
    if (w && now.notify?.needsYes !== false) this.alert(now, w.who || name(w.open || w.sessionId), w.question ?? "", w.open || w.sessionId);
    const done = ended.news;
    if (done && now.notify?.taskDone !== false)
      this.alert(now, name(done.sessionId) || done.title || "", this.deps.words(done.status === "completed" ? "window.shell.notify.done" : "window.shell.notify.stopped"), done.sessionId);
  }

  private alert(now: Snapshot, title: string, body: string, sessionId: string | undefined): void {
    if (this.deps.rules.quietNow(now.quiet)) return;
    if (now.notify?.sound) this.deps.sound(now.notify.sound);
    if (now.notify?.method === "system") this.deps.notify(title, body, sessionId);
  }

  /** The engine's own event stream: any event may change what waits, so each one asks for a look (a few at once, one). */
  private async follow(): Promise<void> {
    let wait = 500;
    while (!this.stopped) {
      try {
        this.controller = new AbortController();
        const response = await (this.deps.fetch ?? fetch)(`${this.deps.url}/api/events/stream`,
          { headers: { authorization: `Bearer ${this.deps.key()}` }, signal: this.controller.signal });
        if (!response.ok || !response.body) throw new Error(`events: ${response.status}`);
        wait = 500;
        const reader = response.body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done || this.stopped) break;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.check(), 300);
        }
      } catch (error) {
        if (this.stopped) return;
        this.deps.log?.(`Tray notifications: ${(error as Error).message}`);
        wait = Math.min(wait * 2, 15000);
      }
      await new Promise((done) => setTimeout(done, wait));
    }
  }
}
