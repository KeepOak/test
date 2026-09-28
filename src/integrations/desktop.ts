import { noteAppOpened } from '../desktop-app-ask.js'; // unhold-control
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
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
  DesktopMoveSchema, DesktopDragSchema, DesktopScrollSchema, DesktopWaitSchema, DesktopZoomSchema,
  DesktopHoldKeySchema, DesktopButtonSchema, DesktopCursorSchema, DesktopComputerSchema, holdKeyCodes, computerModifiers,
} from './desktop-config.js';
import { DesktopScriptRunner, screenBox, type LiveScreenProcess, type ScreenBox, type NativeCaptureTarget, type CaptureExclusion } from './desktop-script.js';
import { DesktopBanner } from './desktop-banner.js';
import { ChatNativeScreen, type CapturedNativeFrame } from './chat-screen-native.js';
import type { LivePointer } from '../live-screen.js';
import { CaptureExclusionSchema } from '../desktop/capture-lease.js';

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
/**
 * computer-control: what a picture or a reading of one window promised: that window, at that place and size. A point
 * a tool takes from it is refused once the window has moved or been resized (OpenClaw's frame binding), instead of
 * landing somewhere else. Kept per task, in memory only.
 */
interface Seen { runId: string; handle: string; bounds: { x: number; y: number; w: number; h: number } }
type Spot = { name?: string | undefined; ref?: string | undefined; point?: { x: number; y: number } | undefined };
const spotOf = (input: Spot): Spot => ({
  ...(input.name !== undefined ? { name: input.name } : {}), ...(input.ref !== undefined ? { ref: input.ref } : {}),
  ...(input.point !== undefined ? { point: input.point } : {}),
});
const described = (spot: Spot): string => spot.name ?? (spot.ref ? `part ${spot.ref}` : spot.point ? `point ${spot.point.x},${spot.point.y}` : 'the middle');
/** Where the newest click of a task that is still going landed on the screen, and whose task it is. */
export interface Pointer { x: number; y: number; at: string; runId: string; trunk: string | null }
/** Said to a task whose screen action waited while the owner drove, and was stopped or ran out of time waiting. */
export const drivingMessage = "The owner took over this computer's screen, so Branch waited and let go. Try again once they hand it back.";
/** Trusted desktop-host calls; never populated from an HTTP request or saved setting. Older hosts refuse capture. */
export interface NativeCaptureLease {
  acquire(leaseId: string): Promise<{ processId: number; handles: string[] }>;
  release(leaseId: string): Promise<void>;
}

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
  private readonly nativeCaptureLease: NativeCaptureLease | undefined;
  private readonly nativeScreens = new Set<ChatNativeScreen>();
  private nativeOpening = false;
  /** computer-control: the one mouse button a task holds down (desktop.mouse_down), until it is let go. */
  private heldButton: { runId: string; button: string; handle: string; at: number[]; timer: ReturnType<typeof setTimeout> } | null = null;
  /** computer-control: pictures and readings a task's points may come from (Seen). */
  private readonly seen = new Map<string, Seen>();
  /** computer-control: this program and its parent (in the desktop app, the main process that owns Branch's windows): no tool touches their windows. */
  private readonly ownProcesses = new Set([process.pid, process.ppid].filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  /** Where screenshots are kept; without it, taking one is refused rather than lost. */
  artifacts: RunArtifacts | undefined;
  /** What Windows itself allows. Left unset, only Branch's own switch is consulted, as before. */
  permissions: { check(capability: 'screen'): Promise<{ allowed: boolean; message: string }> } | undefined;
  constructor(private readonly store: Store, options: { artifacts?: RunArtifacts; runner?: DesktopScriptRunner; banner?: DesktopBanner; permissions?: DesktopControl['permissions']; nativeCaptureLease?: NativeCaptureLease } = {}) {
    this.artifacts = options.artifacts;
    this.permissions = options.permissions;
    this.runner = options.runner ?? new DesktopScriptRunner();
    this.banner = options.banner ?? new DesktopBanner(this.runner);
    this.nativeCaptureLease = options.nativeCaptureLease;
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
      // computer-control: the owner drives now, so a button a task holds down is let go first.
      void this.releaseHeld('the owner took over');
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
  pointer(): LivePointer | null {
    const remote = [...this.nativeScreens].find((screen) => screen.visible());
    const pointer = remote?.pointer();
    if (pointer) return pointer;
    return this.agentPointer();
  }
  private agentPointer(): Pointer | null {
    const at = this.pointerAt;
    const state = at ? this.runs.get(at.runId) : undefined;
    return at && state && !state.stopped ? at : null;
  }

  /** Only a trusted owner screen-session factory calls this; there is no tool/approval context bypass. */
  async chatScreen(owner: string, options: { target: NativeCaptureTarget; guard: () => void; stopped: () => void; signal: AbortSignal }): Promise<ChatNativeScreen> {
    if (this.nativeScreens.size || this.nativeOpening) throw new Error('Stop the current native screen session first.');
    this.nativeOpening = true;
    let holder: typeof this.driving = null;
    let made: ChatNativeScreen | undefined;
    try {
      const screen = await ChatNativeScreen.open({ ...options, host: this.nativeCaptureLease, banner: this.banner,
        check: (signal) => this.checkChatScreen(owner, options.guard, signal),
        frames: (target, exclusion) => this.liveFrames(owner, target, exclusion),
        resolve: (window, signal) => this.resolve(window, signal),
        input: (action, window, payload, signal) => {
          const input = action.action === 'type' ? { text: action.text } : action.action === 'key' ? { keys: keyChord(action.chord) }
            : action.action === 'scroll' ? { steps: action.steps } : {};
          return this.runner.run(action.action, { handle: window.handle, ...payload, ...input }, signal);
        },
        takeOver: () => {
          if (this.driving && this.driving !== holder) throw new Error('The owner already holds control in Branch’s window. Hand it back there first.');
          this.takeOver(); holder = this.driving;
        },
        handBack: () => { if (holder && this.driving === holder) this.handBack(); holder = null; },
        holdsControl: () => holder !== null && this.driving === holder,
        agentPointer: () => this.agentPointer(),
        finished: () => { if (made) this.nativeScreens.delete(made); },
      });
      made = screen;
      this.nativeScreens.add(screen);
      return screen;
    } finally { this.nativeOpening = false; }
  }
  private async checkChatScreen(owner: string, guard: () => void, signal: AbortSignal): Promise<void> {
    guard(); signal.throwIfAborted();
    if (!this.enabled(owner)) throw new Error(switchedOffMessage);
    if (!this.permissions) throw new Error('This host cannot prove native screen permission.');
    const allowed = await this.permissions.check('screen');
    if (!allowed.allowed) throw new Error(allowed.message);
    guard(); signal.throwIfAborted();
    if (!this.enabled(owner)) throw new Error(switchedOffMessage);
    await this.assertNothingPrivateOnScreen(signal);
    guard(); signal.throwIfAborted();
  }
  async captureTargets(owner: string, guard: () => void, signal: AbortSignal): Promise<Record<string, unknown>> {
    guard(); signal.throwIfAborted();
    if (!this.nativeCaptureLease) throw new Error('This desktop host cannot prove which viewer windows to exclude. Open the supported Branch desktop app.');
    const leaseId = randomBytes(16).toString('hex');
    let acquired = false, failed = false;
    try {
      const raw = await this.nativeCaptureLease.acquire(leaseId); acquired = true;
      const proof = CaptureExclusionSchema.parse(raw);
      await this.checkChatScreen(owner, guard, signal);
      const result = await this.runner.run('capture-targets', {}, signal);
      await this.checkChatScreen(owner, guard, signal);
      const windows = Array.isArray(result.windows) ? result.windows.filter((raw) => {
        const window = raw as Partial<WindowInfo> | null;
        return window && Number.isSafeInteger(window.processId) && window.processId! > 0 && window.processId !== proof.processId;
      }) : [];
      return { ...result, windows, excludedProcessId: proof.processId };
    } catch (error) { failed = true; throw error; }
    finally { if (acquired) { try { await this.nativeCaptureLease.release(leaseId); } catch (error) { if (!failed) throw error; } } }
  }

  /** The Stop button, and the same thing the cancel route does: let go of the screen at once. */
  stop(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    state.stopped = true;
    state.controller.abort(new Error('You pressed Stop.'));
    this.store.event(runId, 'desktop.stopped', { reason: 'the Stop button on the notice was pressed' });
    if (this.heldButton?.runId === runId) void this.releaseHeld('Stop was pressed');
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
    // computer-control: Branch's own window is never a target: a task clicking there could answer its own questions.
    if (this.ownProcesses.has(Number(chosen.processId))) throw new Error("That window is Branch's own, which Branch never clicks or types into. Choose another window.");
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
      let handle = '';
      const answer = input.window
        ? (await this.onWindow(input.window, signal, (target) => { handle = String(target.handle); return this.runner.run('screenshot', { handle: target.handle, outPath: temporary }, signal); })).answer
        : await this.hidingBranch(() => this.runner.run('screenshot', { display: input.display ?? 1, outPath: temporary }, signal));
      // Some windows cannot be photographed on their own, and Windows copies that patch of the
      // screen instead — which would show anything sitting on top. Check again before keeping it.
      if (answer.method === 'screen') await this.assertNothingPrivateOnScreen(signal);
      const kept = await artifacts.write(context.runId, `desktop-${randomUUID().slice(0, 8)}.png`, 'image/png', await readFile(temporary));
      this.record(context, 'desktop.screenshot', String(answer.title ?? ''), { width: answer.width, height: answer.height });
      const shot = handle ? this.remember(context, { ...answer, handle }) : undefined;
      return { ...kept, window: String(answer.title ?? ''), width: answer.width, height: answer.height,
        ...(shot ? { shot, points: 'Points are window pixels, as in this picture. Pass this shot with them.' } : {}) };
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
  liveFrames(owner: string, target?: NativeCaptureTarget, exclusion?: CaptureExclusion): LiveFrames {
    const reader = this.runner.liveProcess?.(target, exclusion) ?? null;
    if (target && !reader) throw new Error('This host cannot capture the selected native target without falling back to a physical monitor.');
    const frames: LiveFrames = {
      next: (maxWidth, signal) => this.liveFrame(owner, reader, maxWidth, signal),
      close: () => { this.live.delete(frames); reader?.close(); },
      get running() { return reader?.running ?? false; },
    };
    this.live.add(frames);
    return frames;
  }
  private async liveFrame(owner: string, reader: LiveScreenProcess | null, maxWidth: number, signal: AbortSignal): Promise<CapturedNativeFrame> {
    if (!readDesktopSettings(this.store, owner).enabled) throw new Error(switchedOffMessage);
    const windows = await this.permissions?.check('screen');
    if (windows && !windows.allowed) throw new Error(windows.message);
    if (reader) {
      const answer = await reader.frame(maxWidth, signal);
      privateShowing(answer.windows);
      privateShowing(answer.after);
      // The switch turned off while the frame was being taken: dropped, not shown.
      if (!readDesktopSettings(this.store, owner).enabled) throw new Error(switchedOffMessage);
      return { bytes: Buffer.from(answer.data, 'base64'), type: 'image/jpeg', width: answer.width, height: answer.height,
        ...(answer.screen ? { screen: answer.screen } : {}), ...(answer.target ? { target: answer.target } : {}),
        ...(answer.method ? { method: answer.method } : {}), windows: answer.windows, after: answer.after };
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
      await this.hidingBranch(() => this.runner.run('screenshot', { display: 1, outPath: temporary, region }, signal));
      return new Uint8Array(await readFile(temporary));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  /**
   * computer-control: a picture of a whole screen leaves Branch's own windows out where the desktop app can hide them
   * (the same lease as the owner's live view), so a Trunk never sees its own conversation mirrored back. Where it cannot
   * (outside the desktop app, an older Windows) the picture is taken as before.
   */
  private async hidingBranch<T>(take: () => Promise<T>): Promise<T> {
    const host = this.nativeCaptureLease;
    if (!host) return take();
    const leaseId = randomBytes(16).toString('hex');
    let held = false;
    try { CaptureExclusionSchema.parse(await host.acquire(leaseId)); held = true; } catch { /* no proved host here: as before */ }
    try { return await take(); } finally { if (held) await host.release(leaseId).catch(() => undefined); }
  }
  /**
   * computer-control: the owner's own screenshot from the message box's + menu ("Take a screenshot"): the main display,
   * with Branch's own windows left out where the desktop app can hide them, refused while a window that handles
   * passwords shows. It goes back to the owner's window to attach, and nothing is kept here.
   */
  async ownerShot(signal: AbortSignal): Promise<Buffer> {
    const windows = await this.permissions?.check('screen');
    if (windows && !windows.allowed) throw new Error(windows.message);
    await this.assertNothingPrivateOnScreen(signal);
    const temporary = await this.runner.temporaryPng(`owner-${randomUUID().slice(0, 8)}`);
    try {
      await this.hidingBranch(() => this.runner.run('screenshot', { display: 1, outPath: temporary }, signal));
      await this.assertNothingPrivateOnScreen(signal);
      return await readFile(temporary);
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
      ...(typeof node.ref === 'string' && /^-?[0-9]+(\.-?[0-9]+){0,15}$/.test(node.ref) ? { ref: node.ref } : {}),
      ...(Array.isArray(node.box) && node.box.length === 4 && node.box.every(Number.isFinite) ? { box: node.box.map(Number) } : {}),
    }));
    this.record(context, 'desktop.read', window.title, { parts: parts.length });
    const shot = this.remember(context, { ...answer, handle: window.handle });
    return { window: window.title, parts, more: Boolean(answer.more), ...(shot ? { shot } : {}) };
  }

  /**
   * computer-control: a picture or reading of a window, remembered so points taken from it can be checked against where
   * the window is now. The answer's own bounds are the window's at that moment.
   */
  private remember(context: ToolContext, answer: Record<string, unknown>): string | undefined {
    const box = answer.bounds as Record<string, unknown> | undefined, handle = String(answer.handle ?? '');
    const bounds = box && ['x', 'y', 'w', 'h'].every((axis) => Number.isSafeInteger(box[axis]))
      ? { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) } : null;
    if (!bounds || !/^[1-9][0-9]{0,18}$/.test(handle)) return undefined;
    const id = randomBytes(8).toString('hex');
    this.seen.set(id, { runId: context.runId, handle, bounds });
    while (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value!);
    return id;
  }
  /** The window a picture promised, for a point taken from it; refused for another task's picture or another window. */
  private expected(context: ToolContext, shot: string | undefined, window: WindowInfo): Record<string, unknown> {
    if (!shot) return {};
    const seen = this.seen.get(shot);
    if (!seen || seen.runId !== context.runId) throw new Error('That picture is not one this task took. Take a new picture of the window first.');
    if (seen.handle !== String(window.handle)) throw new Error('That picture was of another window. Take a picture of this one first.');
    return { expect: seen.bounds };
  }
  /** Where the newest pointer action landed, for the owner's live view to draw this Trunk's cursor there. */
  private landed(context: ToolContext, answer: Record<string, unknown>): void {
    const spot = Array.isArray(answer.at) && answer.at.length === 2 ? answer.at.map(Number) : [];
    if (spot.length === 2 && spot.every(Number.isFinite))
      this.pointerAt = { x: spot[0]!, y: spot[1]!, at: new Date().toISOString(), runId: context.runId, trunk: context.trunk ?? null };
  }

  async click(input: z.input<typeof DesktopClickSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.click');
    const button = input.button ?? 'left', count = input.count ?? 1;
    const plain = button === 'left' && count === 1 && !input.modifiers?.length && !input.shot && !input.ref;
    const spot = spotOf(input);
    // A plain left click keeps the old path: a named part is pressed through UI Automation (the pointer never moves).
    // A ref, another button, a double or triple click, held keys or a checked picture go through the pointer verbs.
    const { window, answer } = await this.onWindow(input.window, signal, (target) => plain
      ? this.runner.run('click', { handle: target.handle, ...(spot.point ? { x: spot.point.x, y: spot.point.y } : { name: spot.name }) }, signal)
      : this.runner.run('pointer', { handle: target.handle, kind: 'click', at: spot, button, count,
        modifiers: input.modifiers ?? [], ...this.expected(context, input.shot, target) }, signal));
    const how = count === 3 ? 'triple-click' : count === 2 ? 'double-click' : button === 'left' ? String(answer.how ?? 'click') : `${button}-click`;
    this.record(context, 'desktop.click', window.title, { what: described(spot), how, button, count });
    this.landed(context, answer);
    return { window: window.title, clicked: String(answer.name || spot.name || described(spot)), how };
  }

  /** computer-control: move the pointer onto something and rest there, to show a tooltip or open a hover menu. */
  async move(input: z.input<typeof DesktopMoveSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.move');
    const spot = spotOf(input), hoverMs = input.hoverMs ?? 800;
    const { window, answer } = await this.onWindow(input.window, signal, (target) =>
      this.runner.run('pointer', { handle: target.handle, kind: 'move', at: spot, hoverMs, ...this.expected(context, input.shot, target) }, signal));
    this.record(context, 'desktop.move', window.title, { to: described(spot), hoverMs });
    this.landed(context, answer);
    return { window: window.title, over: described(spot), restedMs: hoverMs };
  }

  /** computer-control: press on one spot, glide to another and let go, both inside the same window. */
  async drag(input: z.input<typeof DesktopDragSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.drag');
    const from = spotOf(input.from), to = spotOf(input.to), button = input.button ?? 'left';
    const { window, answer } = await this.onWindow(input.window, signal, (target) =>
      this.runner.run('pointer', { handle: target.handle, kind: 'drag', from, to, button, modifiers: input.modifiers ?? [],
        ...this.expected(context, input.shot, target) }, signal));
    this.record(context, 'desktop.drag', window.title, { from: described(from), to: described(to), button });
    this.landed(context, answer);
    return { window: window.title, dragged: `${described(from)} to ${described(to)}` };
  }

  /**
   * computer-control: scroll a list, page or document. A named part scrolls through UI Automation when it can (the
   * pointer stays where it is); otherwise the wheel turns over the spot, or over the middle of the window.
   */
  async scroll(input: z.input<typeof DesktopScrollSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.scroll');
    const spot = spotOf(input), amount = input.amount ?? 3;
    const { window, answer } = await this.onWindow(input.window, signal, (target) =>
      this.runner.run('pointer', { handle: target.handle, kind: 'scroll', at: spot, direction: input.direction, amount,
        modifiers: input.modifiers ?? [], ...this.expected(context, input.shot, target) }, signal));
    this.record(context, 'desktop.scroll', window.title, { at: described(spot), direction: input.direction, amount, how: answer.how });
    this.landed(context, answer);
    return { window: window.title, scrolled: `${input.direction} ${amount}`, how: answer.how === 'scroll-pattern' ? 'the list itself' : 'the mouse wheel' };
  }

  /**
   * computer-control: wait for a program to catch up. Touches nothing and uses none of the task's screen actions, but
   * ends at once on Stop or a cancel, and says so when the switch went off or the owner took over meanwhile.
   */
  async wait(input: z.infer<typeof DesktopWaitSchema>, context: ToolContext) {
    if (!this.enabled(context.owner)) throw new Error(switchedOffMessage);
    const state = this.runs.get(context.runId);
    if (state?.stopped) throw new Error('You pressed Stop, so Branch has let go of your screen and keyboard.');
    const signal = AbortSignal.any([context.signal, ...(state ? [state.controller.signal] : [])]);
    await new Promise<void>((done, fail) => {
      if (signal.aborted) { fail(new Error('The wait was stopped.')); return; }
      const stop = () => { clearTimeout(timer); fail(new Error('The wait was stopped.')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); done(); }, Math.round(input.seconds * 1000));
      signal.addEventListener('abort', stop, { once: true });
    });
    if (!this.enabled(context.owner)) throw new Error(switchedOffMessage);
    if (this.driving) throw new Error(drivingMessage);
    return { waited: input.seconds };
  }

  /** computer-control: a close-up of part of one window, for small print and small targets. Its points stay window pixels. */
  async zoom(input: z.infer<typeof DesktopZoomSchema>, context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Taking a picture is switched off because there is nowhere to keep it.');
    const signal = await this.begin(context, 'desktop.zoom');
    const { region } = input, scale = Math.max(1, Math.min(4, Math.floor(800 / Math.max(region.width, region.height))));
    const temporary = await this.runner.temporaryPng(`zoom-${randomUUID().slice(0, 8)}`);
    try {
      const { window, answer } = await this.onWindow(input.window, signal, (target) =>
        this.runner.run('zoom', { handle: target.handle, region, scale, outPath: temporary, ...this.expected(context, input.shot, target) }, signal));
      if (answer.method === 'screen') await this.assertNothingPrivateOnScreen(signal);
      const kept = await artifacts.write(context.runId, `desktop-zoom-${randomUUID().slice(0, 8)}.png`, 'image/png', await readFile(temporary));
      this.record(context, 'desktop.zoom', window.title, { region, scale });
      return { ...kept, window: window.title, width: answer.width, height: answer.height, scale,
        points: `This close-up starts at window point (${region.x}, ${region.y}) at ${scale}x: a spot (a, b) in it is window point (${region.x} + a/${scale}, ${region.y} + b/${scale}).` };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * computer-control: a mouse button pressed and held (left_mouse_down). One task holds one button at a time; it is let
   * go by desktop.mouse_up, and by Stop, the task ending, the owner taking over, Branch stopping, or thirty seconds
   * passing, whichever comes first, so no button is ever left held on the owner's computer.
   */
  async mouseDown(input: z.input<typeof DesktopButtonSchema>, context: ToolContext) {
    if (this.heldButton && this.heldButton.runId !== context.runId) throw new Error('Another task is holding a mouse button. Try again when it lets go.');
    if (this.heldButton) throw new Error('This task already holds a mouse button. Let it go with desktop.mouse_up first.');
    const signal = await this.begin(context, 'desktop.mouse_down');
    const spot = spotOf(input), button = input.button ?? 'left';
    const { window, answer } = await this.onWindow(input.window, signal, (target) =>
      this.runner.run('pointer', { handle: target.handle, kind: 'down', at: spot, atCurrent: !spot.name && !spot.ref && !spot.point, button, modifiers: [],
        ...this.expected(context, input.shot, target) }, signal));
    const at = Array.isArray(answer.at) ? answer.at.map(Number) : [];
    const timer = setTimeout(() => { void this.releaseHeld('thirty seconds passed'); }, 30000);
    timer.unref?.();
    this.heldButton = { runId: context.runId, button, handle: String(window.handle), at, timer };
    this.record(context, 'desktop.mouse_down', window.title, { at: described(spot), button });
    this.landed(context, answer);
    return { window: window.title, pressed: button, at: described(spot), note: 'Held until desktop.mouse_up (at most thirty seconds).' };
  }

  /** computer-control: let go of the button this task holds, where it says or where the pointer is (left_mouse_up). */
  async mouseUp(input: z.input<typeof DesktopButtonSchema> | { window: string }, context: ToolContext) {
    const held = this.heldButton;
    if (!held || held.runId !== context.runId) throw new Error('This task holds no mouse button. Press one with desktop.mouse_down first.');
    const signal = await this.begin(context, 'desktop.mouse_up');
    const spot = spotOf(input as Spot);
    const { window, answer } = await this.onWindow(input.window, signal, (target) => {
      if (String(target.handle) !== held.handle) throw new Error('The button was pressed in another window. Let it go there.');
      return this.runner.run('pointer', { handle: target.handle, kind: 'up', at: spot, button: held.button, pressedAt: held.at }, signal);
    });
    // Only a let-go that happened clears it; a refused one leaves it held for mouse_up, Stop, the end or the timer.
    if (this.heldButton === held) { clearTimeout(held.timer); this.heldButton = null; }
    this.record(context, 'desktop.mouse_up', window.title, { at: described(spot), how: answer.how });
    this.landed(context, answer);
    return { window: window.title, released: held.button, how: answer.how === 'up-where-pressed' ? 'let go where it was pressed (that spot was covered or outside the window)' : 'let go' };
  }

  /** Lets go of a held button, whatever happened; letting go needs no approval and is never refused. */
  private async releaseHeld(why: string): Promise<void> {
    const held = this.heldButton;
    if (!held) return;
    clearTimeout(held.timer);
    this.heldButton = null;
    this.store.event(held.runId, 'desktop.released', { button: held.button, why });
    await this.runner.run('release', { buttons: [held.button] }, AbortSignal.timeout(15000)).catch(() => undefined);
  }

  /** computer-control: hold a key or chord down for up to ten seconds (hold_key), always let go afterwards. */
  async holdKey(input: z.infer<typeof DesktopHoldKeySchema>, context: ToolContext) {
    const keys = holdKeyCodes(input.chord), chord = input.chord.toLowerCase();
    const signal = await this.begin(context, 'desktop.hold_key');
    const ms = Math.round(input.seconds * 1000);
    try {
      const { window } = await this.onWindow(input.window, signal, (target) =>
        this.runner.run('hold-key', { handle: target.handle, keys, chord, ms }, signal));
      this.record(context, 'desktop.hold_key', window.title, { chord: input.chord, ms });
      return { window: window.title, held: input.chord, seconds: input.seconds };
    } catch (error) {
      // Stopped or timed out mid-hold: the program was ended before it let go, so let go here.
      await this.runner.run('release', { keys, chords: [chord] }, AbortSignal.timeout(15000)).catch(() => undefined);
      throw error;
    }
  }

  /** computer-control: where the pointer is (cursor_position), on the screen and in a window's pixels. Nothing moves. */
  async cursor(input: z.infer<typeof DesktopCursorSchema>, context: ToolContext) {
    const signal = await this.begin(context, 'desktop.cursor');
    if (!input.window) {
      const answer = await this.runner.run('cursor', {}, signal);
      return { screen: answer.at };
    }
    const { window, answer } = await this.onWindow(input.window, signal, (target) => this.runner.run('cursor', { handle: target.handle }, signal));
    return { window: window.title, screen: answer.at, inWindow: answer.window, inside: answer.inside === true, ...(answer.onTop !== undefined ? { onTop: answer.onTop === true } : {}) };
  }

  /**
   * computer-control: Anthropic's computer tool, action for action, handed to the tools above so every guard applies
   * unchanged. Coordinates are the named window's own pixels (its desktop.screenshot), not a whole display's.
   */
  async computer(input: z.infer<typeof DesktopComputerSchema>, context: ToolContext): Promise<unknown> {
    const need = <T>(value: T | undefined, what: string): T => { if (value === undefined) throw new Error(`${input.action} needs ${what}.`); return value; };
    const window = () => need(input.window, 'a window (part of its name)');
    const point = (at: [number, number] | undefined) => at ? { point: { x: at[0], y: at[1] } } : {};
    const held = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'scroll'].includes(input.action);
    const modifiers = held ? computerModifiers(input.text) : [];
    const shot = input.shot ? { shot: input.shot } : {};
    switch (input.action) {
      case 'screenshot': return this.screenshot(input.window ? { window: input.window } : {}, context);
      case 'zoom': {
        const [x0, y0, x1, y1] = need(input.region, 'a region [x0, y0, x1, y1]');
        return this.zoom({ window: window(), region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, ...shot }, context);
      }
      case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
        const button = input.action === 'right_click' ? 'right' : input.action === 'middle_click' ? 'middle' : 'left';
        const count = input.action === 'double_click' ? 2 : input.action === 'triple_click' ? 3 : 1;
        return this.click({ window: window(), point: { x: need(input.coordinate, 'a coordinate')[0], y: input.coordinate![1] }, button, count, ...(modifiers.length ? { modifiers } : {}), ...shot }, context);
      }
      case 'left_click_drag': return this.drag({ window: window(), from: point(need(input.start_coordinate, 'a start_coordinate')), to: point(need(input.coordinate, 'a coordinate')), ...(modifiers.length ? { modifiers } : {}), ...shot }, context);
      case 'mouse_move': return this.move({ window: window(), ...point(need(input.coordinate, 'a coordinate')), hoverMs: 0, ...shot }, context);
      case 'left_mouse_down': return this.mouseDown({ window: window(), ...(input.coordinate ? point(input.coordinate) : {}), ...shot } as z.input<typeof DesktopButtonSchema>, context);
      case 'left_mouse_up': return this.mouseUp({ window: window(), ...point(input.coordinate) }, context);
      case 'scroll': return this.scroll({ window: window(), ...point(input.coordinate), direction: need(input.scroll_direction, 'a scroll_direction'), amount: input.scroll_amount ?? 3, ...(modifiers.length ? { modifiers } : {}), ...shot }, context);
      case 'type': return this.type({ window: window(), text: need(input.text, 'text') }, context);
      case 'key': return this.key({ window: window(), chord: need(input.text, 'text (the key)'), repeat: input.repeat ?? 1 }, context);
      case 'hold_key': return this.holdKey({ window: window(), chord: need(input.text, 'text (the key)'), seconds: Math.min(10, need(input.duration, 'a duration')) }, context);
      case 'wait': return this.wait({ seconds: need(input.duration, 'a duration') }, context);
      case 'cursor_position': return this.cursor(input.window ? { window: input.window } : {}, context);
    }
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

  async key(input: z.input<typeof DesktopKeySchema>, context: ToolContext) {
    const keys = keyChord(input.chord).repeat(input.repeat ?? 1);
    const signal = await this.begin(context, 'desktop.key');
    const { window } = await this.onWindow(input.window, signal,
      (target) => this.runner.run('key', { handle: target.handle, keys }, signal));
    this.record(context, 'desktop.key', window.title, { chord: input.chord, repeat: input.repeat ?? 1 });
    return { window: window.title, pressed: input.chord, ...((input.repeat ?? 1) > 1 ? { times: input.repeat } : {}) };
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
    for (const [id, seen] of this.seen) if (seen.runId === context.runId) this.seen.delete(id);
    if (this.heldButton?.runId === context.runId) await this.releaseHeld('the task ended');
    if (!this.runs.delete(context.runId)) return;
    await this.banner.hide();
  }
  async close(): Promise<void> {
    for (const screen of this.nativeScreens) await screen.close();
    this.nativeScreens.clear();
    for (const frames of [...this.live]) frames.close(); // parity-b2: no live view outlives Branch
    for (const state of this.runs.values()) state.controller.abort(new Error('Branch stopped.'));
    await this.releaseHeld('Branch stopped');
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
