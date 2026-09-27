import { noteAppOpened } from '../desktop-app-ask.js'; // unhold-control
import { randomUUID } from 'node:crypto';
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
} from './desktop-config.js';
import { DesktopScriptRunner } from './desktop-script.js';
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

export class DesktopControl {
  private readonly runs = new Map<string, RunState>();
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
    const settings = readDesktopSettings(this.store, context.owner);
    if (!settings.enabled) throw new Error(switchedOffMessage);
    // The owner's switch is not the only one: Windows has its own, and a refusal there looks like
    // nothing happening. Ask before touching the screen, and say plainly what to turn on.
    const windows = await this.permissions?.check('screen');
    if (windows && !windows.allowed) throw new Error(windows.message);
    const state = this.runs.get(context.runId) ?? { actions: 0, stopped: false, controller: new AbortController() };
    this.runs.set(context.runId, state);
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
    const showing = (await this.windowList(signal)).filter((window) => window.restricted && !window.minimised);
    if (showing.length)
      throw new Error(`That picture would show ${showing[0]!.title}, which handles passwords. Close or minimise it and ask again.`);
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
    if (!this.runs.delete(context.runId)) return;
    await this.banner.hide();
  }
  async close(): Promise<void> {
    this.runs.clear();
    await this.banner.hide();
    await this.runner.close();
  }
}
