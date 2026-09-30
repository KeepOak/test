import { NativeWatchSchema, type NativeWatch } from "../native-capture/driver.js";
import { noteAppOpened } from '../desktop-app-ask.js'; // unhold-control
import { randomUUID, createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolContext } from '../contracts.js';
import type { Store } from '../store.js';
import type { RunArtifacts } from '../artifacts.js';
import { WorkspaceFiles } from '../files.js';
import {
  cappedMessage, keyChord, readDesktopSettings, refusalFor, runnableFile, secretReferenceIn, switchedOffMessage,
  type WindowInfo,
  DesktopClickSchema, DesktopClipboardSchema, DesktopKeySchema, DesktopOpenSchema,
  DesktopReadSchema, DesktopScreenshotSchema, DesktopTypeSchema, DesktopWindowsSchema,
} from './desktop-config.js';
import { DesktopScriptRunner, screenBox, type LiveScreenProcess, type ScreenBox } from './desktop-script.js';
import { DesktopBanner } from './desktop-banner.js';

/**
 * Letting the assistant look at this computer's screen and use its keyboard.
 *
 * Three things stand between a request and the screen, and all three have to agree: the owner's
 * switch in Settings is on, the approval policy has said yes to this particular action, and the
 * task has not used up its allowance of screen actions. While any of it is happening a notice sits
 * on top of everything with a Stop button, and every action is written down with the title of the
 * window it touched.
 */
interface RunState { actions: number; stopped: boolean; controller: AbortController }
/** Where the newest click of a task that is still going landed on the screen, and whose task it is. */
export interface Pointer { x: number; y: number; at: string; runId: string; trunk: string | null }
/** Said to a task whose screen action waited while the owner drove, and was stopped or ran out of time waiting. */
export const drivingMessage = "The owner took over this computer's screen, so Branch waited and let go. Try again once they hand it back.";

export class DesktopControl {
  private readonly runs = new Map<string, RunState>();
  /** The newest click of a task, for the owner's live view to draw that Trunk's cursor. Kept in memory only. */
  private pointerAt: Pointer | null = null;
  /** While the owner drives ("Take over"), every screen action of every task waits here until they hand it back. */
  private driving: { since: string; handBack: () => void; handedBack: Promise<void> } | null = null;
  /** Branch is closing: a wait that ends because of that ends with the owner's refusal, never with the action. */
  private closed = false;
  private readonly live = new Set<LiveFrames>();
  private readonly runner: DesktopScriptRunner;
  private readonly banner: DesktopBanner;
  /** Where screenshots are kept; without it, taking one is refused rather than lost. */
  artifacts: RunArtifacts | undefined;
  /** What Windows itself allows. Left unset, only Branch's own switch is consulted, as before. */
  permissions: { check(capability: 'screen'): Promise<{ allowed: boolean; message: string }> } | undefined;
  constructor(private readonly store: Store, options: { artifacts?: RunArtifacts; runner?: DesktopScriptRunner; banner?: DesktopBanner; permissions?: DesktopControl['permissions'] } = {}) {
    this.artifacts = options.artifacts;
    this.permissions = options.permissions;
    this.runner = options.runner ?? new DesktopScriptRunner();
    this.banner = options.banner ?? new DesktopBanner(this.runner);
  }
  async nativeTargets(context: ToolContext): Promise<Record<string, unknown>> {
    const signal = await this.begin(context, "desktop.nativeTargets");
    return this.runner.nativeWindow({ action: "list" }, signal);
  }
  /** A bounded watch of an immutable native target; each frame spends the existing action allowance. */
  async watchNative(input: NativeWatch, context: ToolContext): Promise<unknown> {
    const terms = NativeWatchSchema.parse(input), artifacts = this.artifacts;
    if (!artifacts) throw new Error("Native watch needs the existing private artifacts store.");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
    const changes: { frame: number; sha256: string }[] = []; let latest: Buffer | undefined, previous = "", lastSignal = signal;
    for (let frame = 0; frame < terms.frames; frame++) {
      const bounded = await this.begin({ ...context, signal }, "desktop.watchNative"); lastSignal = bounded;
      const listing = await this.runner.nativeWindow({ action: "list" }, bounded);
      if (terms.target.kind === "display") privateShowing(listing.windows);
      else { const message = refusalFor(terms.target.window); if (message) throw new Error(message); }
      const path = await this.runner.temporaryPng(`native-${randomUUID()}`);
      try {
        const answer = await this.runner.nativeWindow({ action: "capture", watch: terms, outPath: path }, bounded);
        if (terms.target.kind === "display") { privateShowing(answer.before); privateShowing(answer.windows); }
        bounded.throwIfAborted(); if (!readDesktopSettings(this.store, context.owner).enabled) throw new Error(switchedOffMessage);
        const info = await stat(path); if (!info.isFile() || info.size > 20_000_000) throw new Error("Native PNG output bound exceeded.");
        const bytes = await readFile(path), hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== previous) changes.push({ frame, sha256: hash }); previous = hash; latest = bytes;
      } finally { await rm(path, { force: true }).catch(() => undefined); }
      if (frame + 1 < terms.frames) await nativeWatchPause(terms.intervalMs, bounded);
    }
    lastSignal.throwIfAborted(); if (!readDesktopSettings(this.store, context.owner).enabled) throw new Error(switchedOffMessage);
    const kept = await artifacts.write(context.runId, `native-watch-${randomUUID()}.png`, "image/png", latest!);
    lastSignal.throwIfAborted(); if (!readDesktopSettings(this.store, context.owner).enabled) throw new Error(switchedOffMessage);
    this.record(context, "desktop.watchNative", terms.target.kind === "window" ? terms.target.window.title : terms.target.display.id, { frames: terms.frames, changes: changes.length });
    return { ...kept, target: terms.target, excluded: terms.exclude, method: terms.target.kind === "display" ? "native-filter" : "native-window", changes };
  }
  /** Whether the owner has turned the screen and keyboard on. Read again before every action. */
  enabled(owner: string): boolean {
    return readDesktopSettings(this.store, owner).enabled;
  }
  /**
   * Everything that has to be true before the screen is touched at all, and the notice going up.
   * Gives back the signal the script should watch, which is stopped by the task being cancelled
   * and by the Stop button alike.
   */
  private async begin(context: ToolContext, tool: string): Promise<AbortSignal> {
    let settings = readDesktopSettings(this.store, context.owner);
    if (!settings.enabled) throw new Error(switchedOffMessage);
    const state = this.runs.get(context.runId) ?? { actions: 0, stopped: false, controller: new AbortController() };
    this.runs.set(context.runId, state);
    if (state.stopped) throw new Error('You pressed Stop, so Branch has let go of your screen and keyboard.');
    await this.whileDriving(context, AbortSignal.any([context.signal, state.controller.signal]));
    // A take-over may last hours: the permission that held before the wait is no longer authoritative.
    const allowed = await this.permissions?.check('screen');
    if (allowed && !allowed.allowed) throw new Error(allowed.message);
    settings = readDesktopSettings(this.store, context.owner);
    if (!settings.enabled) throw new Error(switchedOffMessage);
    if (state.stopped) throw new Error('You pressed Stop, so Branch has let go of your screen and keyboard.');
    if (state.actions >= settings.maxActionsPerRun) throw new Error(cappedMessage(settings.maxActionsPerRun));
    state.actions += 1;
    await this.banner.show(() => this.stop(context.runId));
    this.store.event(context.runId, 'desktop.started', { tool, action: state.actions, of: settings.maxActionsPerRun });
    return AbortSignal.any([context.signal, state.controller.signal]);
  }
  /**
   * The smallest thing screen control does, on its own and with no notice put up: ask Windows for
   * the list of open windows. It is how `OsPermissions` finds out whether Windows will let this app
   * touch other programs' windows at all, since Windows keeps no switch it can simply be asked for.
   */
  async probe(timeoutMs = 5000): Promise<number> {
    return (await this.windowList(AbortSignal.timeout(timeoutMs))).length;
  }
  /**
   * "Take over": the owner drives. Every task's next screen action waits (it never starts while the owner drives), and
   * the owner's live view says "You're driving". Only the owner's own window reaches this (src/server.ts); no tool does.
   * An action already under way when the owner takes over finishes (it is one click or key, never more).
   */
  takeOver(): { driving: boolean; since: string } {
    if (!this.driving) {
      let handBack!: () => void;
      const handedBack = new Promise<void>((resolve) => { handBack = resolve; });
      this.driving = { since: new Date().toISOString(), handBack, handedBack };
    }
    return { driving: true, since: this.driving.since };
  }
  /** "Hand back": the tasks waiting carry on. Only the owner's own window reaches this. */
  handBack(): { driving: boolean } {
    const was = this.driving;
    this.driving = null;
    was?.handBack();
    return { driving: false };
  }
  /** Whether the owner drives this screen now. */
  isDriving(): boolean { return this.driving !== null; }
  /**
   * Waits, before a screen action, for as long as the owner drives. The task's own stop, cancel or time limit ends the
   * wait. Public for the other tools that act on this computer's apps (src/reach/background-screen.ts), so a take-over
   * holds them too.
   */
  async whileDriving(context: Pick<ToolContext, 'runId'>, signal: AbortSignal): Promise<void> {
    if (!this.driving) return;
    this.store.event(context.runId, 'desktop.paused', { reason: 'the owner took over the screen' });
    while (this.driving) {
      const waiting = this.driving.handedBack;
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error(drivingMessage)); return; }
        const stop = () => reject(new Error(drivingMessage));
        signal.addEventListener('abort', stop, { once: true });
        void waiting.then(() => { signal.removeEventListener('abort', stop); resolve(); });
      });
    }
    // Closing lets every wait go, but the owner never handed back: nothing waiting may act on the screen.
    if (this.closed) throw new Error(drivingMessage);
    this.store.event(context.runId, 'desktop.resumed', { reason: 'the owner handed the screen back' });
  }
  /** Where the newest click of a task that is still going landed, and whose it is; null when there is none. */
  pointer(): Pointer | null {
    const at = this.pointerAt;
    const state = at ? this.runs.get(at.runId) : undefined;
    return at && state && !state.stopped ? at : null;
  }

  /** The Stop button, and the same thing the cancel route does: let go of the screen at once. */
  stop(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    state.stopped = true;
    state.controller.abort(new Error('You pressed Stop.'));
    this.store.event(runId, 'desktop.stopped', { reason: 'the Stop button on the notice was pressed' });
    void this.banner.hide();
  }
  /** Written down for every action, so the record says which window was touched and how. */
  private record(context: ToolContext, tool: string, window: string, detail: Record<string, unknown>): void {
    this.store.event(context.runId, 'desktop.action', { tool, window, ...detail });
  }
  /** Every window that is open, with the ones Branch will not touch marked as such. */
  private async windowList(signal: AbortSignal): Promise<(WindowInfo & { restricted: string | null })[]> {
    const answer = await this.runner.run('windows', {}, signal);
    const raw = Array.isArray(answer.windows) ? answer.windows : [answer.windows];
    return (raw as WindowInfo[]).filter(Boolean).map((window) => ({ ...window, restricted: refusalFor(window) }));
  }
  /**
   * The one open window whose title contains what was asked for. A password or sign-in window is
   * refused here, by the title Windows reports rather than by what was asked for, so no wildcard
   * can reach one.
   */
  private async resolve(match: string, signal: AbortSignal): Promise<WindowInfo> {
    const all = await this.windowList(signal);
    const wanted = match.toLowerCase();
    const hits = all.filter((window) => window.title.toLowerCase().includes(wanted));
    if (!hits.length) throw new Error(`No open window has "${match}" in its name. Use desktop.windows to see what is open.`);
    const chosen = hits.find((window) => window.title.toLowerCase() === wanted) ?? hits[0]!;
    if (hits.length > 1 && !hits.some((window) => window.title.toLowerCase() === wanted))
      throw new Error(`More than one window matches "${match}": ${hits.map((w) => w.title).join('; ')}. Say which one.`);
    if (chosen.restricted) throw new Error(chosen.restricted);
    return chosen;
  }
  /**
   * Finds the window and then does something with it. A window can be rebuilt by its own program
   * between being found and being used — Notepad does it while it brings back yesterday's tabs — so
   * a "that window has gone" answer is taken as a reason to look it up once more, not as a failure.
   */
  private async onWindow<T>(match: string, signal: AbortSignal, act: (window: WindowInfo) => Promise<T>): Promise<{ window: WindowInfo; answer: T }> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const window = await this.resolve(match, signal);
      try { return { window, answer: await act(window) }; } catch (error) { last = error; }
      if (!(last instanceof Error) || !last.message.startsWith('That window is no longer open')) throw last;
    }
    throw new Error(`The window matching "${match}" kept closing while Branch was working with it.`);
  }

  async windows(input: z.infer<typeof DesktopWindowsSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.windows');
    if (input.action === 'list') {
      const all = await this.windowList(signal);
      this.record(context, 'desktop.windows', '', { action: 'list', count: all.length });
      return { windows: all.map((w) => ({ title: w.title, program: w.program, minimised: w.minimised, offLimits: Boolean(w.restricted) })) };
    }
    if (!input.window) throw new Error('Say which window, by part of its name.');
    const verb = input.action === 'minimize' ? 'minimise' : input.action;
    const { window, answer } = await this.onWindow(input.window, signal,
      (target) => this.runner.run('act', { handle: target.handle, verb }, signal));
    this.record(context, 'desktop.windows', window.title, { action: input.action });
    return { window: window.title, action: input.action, stillOpen: Boolean(answer.stillOpen) };
  }

  /** A picture of one window, or of a whole screen, kept beside the private database. */
  async screenshot(input: z.infer<typeof DesktopScreenshotSchema>, context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Taking a picture is switched off because there is nowhere to keep it.');
    const signal = await this.begin(context, 'desktop.screenshot');
    if (!input.window) await this.assertNothingPrivateOnScreen(signal);
    const temporary = await this.runner.temporaryPng(`shot-${randomUUID().slice(0, 8)}`);
    try {
      const answer = input.window
        ? (await this.onWindow(input.window, signal, (target) => this.runner.run('screenshot', { handle: target.handle, outPath: temporary }, signal))).answer
        : await this.runner.run('screenshot', { display: input.display ?? 1, outPath: temporary }, signal);
      // Some windows cannot be photographed on their own, and Windows copies that patch of the
      // screen instead — which would show anything sitting on top. Check again before keeping it.
      if (answer.method === 'screen') await this.assertNothingPrivateOnScreen(signal);
      const kept = await artifacts.write(context.runId, `desktop-${randomUUID().slice(0, 8)}.png`, 'image/png', await readFile(temporary));
      this.record(context, 'desktop.screenshot', String(answer.title ?? ''), { width: answer.width, height: answer.height });
      return { ...kept, window: String(answer.title ?? ''), width: answer.width, height: answer.height };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  /**
   * parity-b2: the frames of this computer's first screen, for the owner's live view of it (src/live-screen.ts), taken
   * one at a time as they are asked for and kept nowhere. Every frame is refused the way every other picture of the
   * screen is: while the owner's switch for the screen is off, while Windows says no, and whenever a window that handles
   * passwords is showing. No notice is put up and nothing is written down: the owner is looking, not a task.
   * On Windows one program stays running while the view is open (LiveScreenProcess) and hands each frame back in its
   * answer, never through a file, with the windows open just before and just after it; a frame taken while one that
   * handles passwords shows is dropped unread. On a Mac each frame is one run of the screen tool, whose file goes at
   * once, and the windows are asked for on their own. `close` ends the program; nothing runs after it.
   */
  liveFrames(owner: string): LiveFrames {
    const reader = this.runner.liveProcess?.() ?? null;
    const frames: LiveFrames = {
      next: (maxWidth, signal) => this.liveFrame(owner, reader, maxWidth, signal),
      close: () => { this.live.delete(frames); reader?.close(); },
      get running() { return reader?.running ?? false; },
    };
    this.live.add(frames);
    return frames;
  }
  private async liveFrame(owner: string, reader: LiveScreenProcess | null, maxWidth: number, signal: AbortSignal): Promise<LiveFrame> {
    if (!readDesktopSettings(this.store, owner).enabled) throw new Error(switchedOffMessage);
    const windows = await this.permissions?.check('screen');
    if (windows && !windows.allowed) throw new Error(windows.message);
    if (reader) {
      const answer = await reader.frame(maxWidth, signal);
      privateShowing(answer.windows);
      privateShowing(answer.after);
      // The switch turned off while the frame was being taken: dropped, not shown.
      if (!readDesktopSettings(this.store, owner).enabled) throw new Error(switchedOffMessage);
      return { bytes: Buffer.from(answer.data, 'base64'), type: 'image/jpeg', width: answer.width, height: answer.height, ...(answer.screen ? { screen: answer.screen } : {}) };
    }
    const temporary = await this.runner.temporaryPng(`live-${randomUUID().slice(0, 8)}`);
    try {
      const answer = await this.runner.run('screenshot', { display: 1, outPath: temporary }, signal);
      await this.assertNothingPrivateOnScreen(signal);
      // A Mac's first screen starts where clicks are counted from; its picture is the whole of it.
      const width = Number(answer.width) || 0, height = Number(answer.height) || 0;
      const screen = screenBox(answer.screen) ?? screenBox({ x: 0, y: 0, w: width, h: height });
      return { bytes: await readFile(temporary), type: 'image/png', width, height, ...(screen ? { screen } : {}) };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  /**
   * Wave 8: the bytes of one rectangle of the screen, for a screen watch. Nothing is kept: the
   * caller reduces these to a fingerprint and throws them away, and the temporary file goes at
   * once. The same refusal applies as to any other picture of the screen — a password manager on
   * screen stops it outright.
   */
  async captureRegion(region: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
    const signal = AbortSignal.timeout(20000);
    await this.assertNothingPrivateOnScreen(signal);
    const temporary = await this.runner.temporaryPng(`watch-${randomUUID().slice(0, 8)}`);
    try {
      await this.runner.run('screenshot', { display: 1, outPath: temporary, region }, signal);
      return new Uint8Array(await readFile(temporary));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  /** A picture taken off the screen itself cannot hide a password manager that is showing, so it is refused instead. */
  private async assertNothingPrivateOnScreen(signal: AbortSignal): Promise<void> {
    privateShowing((await this.runner.run('windows', {}, signal)).windows);
  }

  /** What is in a window, as names and roles, so the assistant can work from words not pixels. */
  async read(input: z.infer<typeof DesktopReadSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.read');
    const { window, answer } = await this.onWindow(input.window, signal,
      (target) => this.runner.run('read', { handle: target.handle, limit: input.limit }, signal));
    const raw = Array.isArray(answer.nodes) ? answer.nodes : [answer.nodes];
    const parts = (raw as Record<string, unknown>[]).filter(Boolean).map((node) => ({
      role: String(node.role ?? ''), name: String(node.name ?? '').slice(0, 200),
      value: String(node.value ?? '').slice(0, 200), enabled: node.enabled !== false,
    }));
    this.record(context, 'desktop.read', window.title, { parts: parts.length });
    return { window: window.title, parts, more: Boolean(answer.more) };
  }

  async click(input: z.infer<typeof DesktopClickSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.click');
    const where = input.name ? { name: input.name } : { x: input.point!.x, y: input.point!.y };
    const { window, answer } = await this.onWindow(input.window, signal,
      (target) => this.runner.run('click', { handle: target.handle, ...where }, signal));
    this.record(context, 'desktop.click', window.title, { what: input.name ?? 'a point', how: answer.how });
    const spot = Array.isArray(answer.at) && answer.at.length === 2 ? answer.at.map(Number) : [];
    if (spot.length === 2 && spot.every(Number.isFinite))
      this.pointerAt = { x: spot[0]!, y: spot[1]!, at: new Date().toISOString(), runId: context.runId, trunk: context.trunk ?? null };
    return { window: window.title, clicked: String(answer.name ?? input.name ?? 'a point'), how: String(answer.how ?? '') };
  }

  async type(input: z.infer<typeof DesktopTypeSchema>, context: ToolContext) {
    const problem = secretReferenceIn(input.text);
    if (problem) throw new Error(problem);
    const signal = await this.begin(context, 'desktop.type');
    const into = input.name ? { name: input.name } : {};
    const { window, answer } = await this.onWindow(input.window, signal,
      (target) => this.runner.run('type', { handle: target.handle, text: input.text, ...into }, signal));
    this.record(context, 'desktop.type', window.title, { into: answer.into, characters: input.text.length, how: answer.how });
    return { window: window.title, into: String(answer.into ?? ''), how: String(answer.how ?? ''), nowReads: String(answer.value ?? '').slice(0, 2000) };
  }

  async key(input: z.infer<typeof DesktopKeySchema>, context: ToolContext) {
    const keys = keyChord(input.chord);
    const signal = await this.begin(context, 'desktop.key');
    const { window } = await this.onWindow(input.window, signal,
      (target) => this.runner.run('key', { handle: target.handle, keys }, signal));
    this.record(context, 'desktop.key', window.title, { chord: input.chord });
    return { window: window.title, pressed: input.chord };
  }

  /**
   * Starts a program by name, or opens a file from the workspace with whatever usually opens it.
   * Opening a file hands it to Windows, which decides what to do with it, and Windows does not say
   * what it did — so the answer is honest about that and tells the model to go and look.
   */
  async open(input: z.infer<typeof DesktopOpenSchema>, context: ToolContext) {
    if (input.path) {
      const problem = runnableFile(input.path);
      if (problem) throw new Error(problem);
    }
    const signal = await this.begin(context, 'desktop.open');
    const path = input.path ? await new WorkspaceFiles(context.workspace).checked(input.path, true) : undefined;
    const answer = await this.runner.run('open', path ? { path } : { app: input.app }, signal);
    const processId = Number(answer.processId ?? 0);
    this.record(context, 'desktop.open', input.app ?? input.path ?? '', { processId });
    // unhold-control: the program has started for this Trunk, so "Ask before opening an app it hasn't used" asks it no more.
    if (input.app) noteAppOpened(this.store, context.owner, context.trunk, input.app);
    return {
      opened: input.app ?? input.path ?? '', processId,
      confirmed: processId > 0,
      note: processId > 0
        ? 'The program started.'
        : 'Windows was asked to open that file; which program took it, and whether a window appeared, is not something Windows reports. Use desktop.windows to see what is open now.',
    };
  }

  /** Reading and writing what is on the clipboard, asked about separately from the rest. */
  async clipboard(input: z.infer<typeof DesktopClipboardSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.clipboard');
    const answer = await this.runner.run('clipboard',
      input.action === 'write' ? { mode: 'write', text: input.text } : { mode: 'read' }, signal);
    this.record(context, 'desktop.clipboard', '', { action: input.action });
    return input.action === 'write' ? { written: true } : { text: String(answer.text ?? '').slice(0, 4000) };
  }

  /** When a task ends, the notice comes down and its allowance is forgotten. */
  async closeRun(context: Pick<ToolContext, 'runId'>): Promise<void> {
    if (this.pointerAt?.runId === context.runId) this.pointerAt = null;
    if (!this.runs.delete(context.runId)) return;
    await this.banner.hide();
  }
  async close(): Promise<void> {
    for (const frames of [...this.live]) frames.close(); // parity-b2: no live view outlives Branch
    for (const state of this.runs.values()) state.controller.abort(new Error('Branch stopped.'));
    this.closed = true;
    this.handBack();
    this.pointerAt = null;
    this.runs.clear();
    await this.banner.hide();
    await this.runner.close();
  }
}

/** parity-b2: one frame of the owner's live view of this screen. */
export interface LiveFrame { bytes: Buffer; type: string; width: number; height: number; screen?: ScreenBox }
/** parity-b2 (smooth): the frames of one live view, and the program behind them while it is open. */
export interface LiveFrames { next(maxWidth: number, signal: AbortSignal): Promise<LiveFrame>; close(): void; readonly running: boolean }

/** Refuses a picture while a window that handles passwords is showing, from a list of the windows open at that moment. */
function privateShowing(listed: unknown): void {
  const raw = Array.isArray(listed) ? listed : [listed];
  const showing = (raw as WindowInfo[]).filter(Boolean).filter((window) => refusalFor(window) && !window.minimised);
  if (showing.length)
    throw new Error(`That picture would show ${showing[0]!.title}, which handles passwords. Close or minimise it and ask again.`);
}

async function nativeWatchPause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Native watch stopped.")); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", abort, { once: true });
  });
}
