import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NativeCaptureTargetSchema, type NativeCaptureTarget } from './desktop/capture-lease.js';
import { ScreenAction, type ScreenSessionDesktop } from './channels/screen-sessions.js';
import { nativeWindowViewable } from './integrations/native-view-target.js';
import { placeOnFrame } from './live-screen.js';

export const localScreenPaths = ['/api/panels/screen', '/api/panels/screen/targets', '/api/panels/screen/target',
  '/api/panels/screen/control', '/api/panels/screen/input', '/api/panels/screen/painted', '/api/panels/screen/stop'] as const;
export class LocalScreenRefusal extends Error { constructor(readonly status: number, message: string) { super(message); } }
function refuse(message: string, status = 409): never { throw new LocalScreenRefusal(status, message); }
const opaque = (): string => randomBytes(16).toString('hex');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, 200);
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); }
    signal.addEventListener('abort', finish, { once: true });
  });
}
const TargetWindow = z.object({ handle: z.string(), processId: z.number().int().positive(), title: z.string().max(512),
  program: z.string().min(1).max(256), className: z.string().min(1).max(256),
  x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive(), minimised: z.boolean() }).passthrough();

export interface LocalScreenAccess {
  owner: string; sessionId: string; viaDoor: boolean; shortKey: boolean;
  /** Captured offered key, compared with the current window key again after every await. */
  keyValid(): boolean;
}
export interface LocalScreenDesktop {
  captureTargets(owner: string, guard: () => void, signal: AbortSignal): Promise<Record<string, unknown>>;
  chatScreen(owner: string, options: { target: NativeCaptureTarget; guard: () => void; stopped: () => void; signal: AbortSignal }): Promise<ScreenSessionDesktop>;
}
interface LocalScreenDeps {
  owner(): string; isOwner(): boolean; owns(owner: string, sessionId: string): boolean;
  lockdown(): boolean; locked(): string | null; signIn(): boolean; allowsHere(sessionId: string): boolean;
  desktop: LocalScreenDesktop | null; now?: () => number;
}
const TargetMonitor = z.object({ kind: z.literal('monitor'), deviceName: z.string().min(1).max(256), primary: z.boolean().optional(),
  bounds: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(), h: z.number().int().positive() }).strict() }).passthrough();
interface Target { target: NativeCaptureTarget; label: string; excludedProcessId: number; primary?: boolean }
interface Choice extends Target { owner: string; sessionId: string; expires: number }
interface View extends Target {
  owner: string; sessionId: string; viewId: string; epoch: number; port: ScreenSessionDesktop;
  life: AbortController; streaming: boolean; busy: boolean; control: boolean; seq: number;
  unopened: ReturnType<typeof setTimeout> | null;
  frame: { id: string; expires: number; consumed: boolean; painted: boolean } | null;
}

/** A local owner view is independent of the chat/door exception and grants no ordinary tool access. */
export class LocalScreen {
  private readonly choices = new Map<string, Choice>();
  private selected: View | null = null;
  private opening: AbortController | null = null;
  private epoch = 0;
  constructor(private readonly deps: LocalScreenDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private guard(access: LocalScreenAccess): void {
    if (access.viaDoor || access.shortKey || !access.keyValid()) refuse('This computer is available only in its authenticated owner window.', 403);
    if (access.owner !== this.deps.owner() || !this.deps.isOwner() || !this.deps.owns(access.owner, access.sessionId))
      refuse('Choose one of your own conversations before opening this computer.', 403);
    if (!this.deps.allowsHere(access.sessionId)) refuse('This conversation is using another computer or cannot use this computer.', 403);
    if (this.deps.lockdown()) refuse('Lockdown keeps this computer unavailable.', 403);
    const locked = this.deps.locked(); if (locked) refuse(locked, 423);
    if (this.deps.signIn()) refuse('Branch is handling a sign-in. The screen is unavailable until it finishes.');
  }
  private async listed(access: LocalScreenAccess, signal: AbortSignal): Promise<Target[]> {
    this.guard(access); signal.throwIfAborted();
    if (!this.deps.desktop) refuse('This Branch has no supported native computer target.', 404);
    const raw = await this.deps.desktop.captureTargets(access.owner, () => this.guard(access), signal);
    this.guard(access); signal.throwIfAborted();
    const ownPid = z.number().int().positive().parse(raw.excludedProcessId), result: Target[] = [];
    // computer-control: a whole display, now that the desktop host hides every Branch window from capture (the lease in
    // captureTargets) and the reader checks that hiding before and after every frame (desktop-script.ts VerifyExclusion).
    // Without that host, captureTargets has already refused, so no display is ever offered unproved.
    const monitors = (Array.isArray(raw.monitors) ? raw.monitors : []).map((value) => TargetMonitor.safeParse(value))
      .filter((parsed) => parsed.success).map((parsed) => parsed.data!);
    monitors.forEach((m, index) => {
      const target = NativeCaptureTargetSchema.safeParse({ kind: 'monitor', deviceName: m.deviceName, bounds: m.bounds });
      if (target.success) result.push({ target: target.data, excludedProcessId: ownPid, primary: m.primary === true,
        label: `${monitors.length > 1 ? `Display ${index + 1}` : 'Whole screen'}${m.primary && monitors.length > 1 ? ' (main)' : ''} · ${m.bounds.w}×${m.bounds.h}` });
    });
    for (const value of Array.isArray(raw.windows) ? raw.windows : []) {
      const parsed = TargetWindow.safeParse(value);
      if (!parsed.success || parsed.data.minimised || parsed.data.processId === ownPid) continue;
      const w = parsed.data;
      if (!nativeWindowViewable(w, ownPid)) continue;
      const target = NativeCaptureTargetSchema.safeParse({ kind: 'window', handle: w.handle, processId: w.processId,
        bounds: { x: w.x, y: w.y, w: w.width, h: w.height } });
      if (target.success) result.push({ target: target.data, label: w.title, excludedProcessId: ownPid });
    }
    return result.slice(0, 256);
  }
  async targets(access: LocalScreenAccess, signal: AbortSignal): Promise<{ targets: { id: string; label: string; kind: string; primary: boolean }[]; notice: string }> {
    const targets = await this.listed(access, signal);
    this.choices.clear();
    return { notice: "Choose a display or an app window. Branch's own windows never appear in the view; browser windows are left out.", targets: targets.map((target) => {
      const id = opaque(); this.choices.set(id, { ...target, owner: access.owner, sessionId: access.sessionId, expires: this.now() + 30000 });
      return { id, label: target.label, kind: target.target.kind, primary: target.primary === true };
    }) };
  }
  async select(access: LocalScreenAccess, id: string, signal: AbortSignal): Promise<{ viewId: string; label: string }> {
    this.guard(access);
    const choice = this.choices.get(id);
    if (!choice || choice.expires <= this.now() || choice.owner !== access.owner || choice.sessionId !== access.sessionId)
      refuse('Choose a window or display from the current target list.');
    this.choices.delete(id);
    const closing = this.close(), epoch = this.epoch;
    await closing;
    const fresh = await this.listed(access, signal);
    if (this.epoch !== epoch) refuse('This selection was replaced.');
    if (!fresh.some((item) => same(item.target, choice.target))) refuse('That target changed. Choose it again.');
    const life = new AbortController();
    this.opening = life;
    const guard = () => { this.guard(access); if (this.epoch !== epoch) refuse('This view was replaced.'); life.signal.throwIfAborted(); };
    let port: ScreenSessionDesktop | undefined;
    try {
      port = await this.deps.desktop!.chatScreen(access.owner, { target: choice.target, guard,
        stopped: () => { life.abort(); if (this.selected?.epoch === epoch) void this.close(); }, signal: AbortSignal.any([signal, life.signal]) });
      guard(); signal.throwIfAborted();
      if (!port.visible()) refuse('The Stop notice is no longer visible.');
      const view: View = { ...choice, viewId: opaque(), epoch, port, life, streaming: false, busy: false, control: false, seq: 0, frame: null, unopened: null };
      this.selected = view;
      view.unopened = setTimeout(() => { if (this.selected === view && !view.streaming) void this.close(); }, 5000);
      view.unopened.unref();
      return { viewId: view.viewId, label: view.label };
    } catch (error) { life.abort(); await port?.close().catch(() => undefined); throw error; }
    finally { if (this.opening === life) this.opening = null; }
  }
  view(access: LocalScreenAccess, viewId: string): View {
    this.guard(access);
    const view = this.selected;
    if (!view || !viewId) refuse('Choose a window or display before opening this computer.');
    if (view.viewId !== viewId || view.owner !== access.owner || view.sessionId !== access.sessionId)
      refuse('This view belongs to another selection. Choose a fresh target.');
    if (view.life.signal.aborted || !view.port.visible()) refuse('The screen session stopped.');
    return view;
  }
  async frame(access: LocalScreenAccess, viewId: string, width: number, signal: AbortSignal) {
    const view = this.view(access, viewId);
    if (!view.streaming || view.busy) refuse('This view is not ready for a frame.');
    view.busy = true;
    try {
      const shot = await view.port.frames.next(width, AbortSignal.any([signal, view.life.signal]));
      if (this.view(access, viewId) !== view) refuse('This view was replaced.');
      if (!['image/jpeg', 'image/png'].includes(shot.type) || !Buffer.isBuffer(shot.bytes) || shot.bytes.length > 8 * 1024 * 1024
        || !shot.bytes.length || !Number.isSafeInteger(shot.width) || !Number.isSafeInteger(shot.height)
        || shot.width <= 0 || shot.width > 1280 || shot.height <= 0 || shot.height > 16384) refuse('That frame was not a valid bounded image.');
      const captured = shot as typeof shot & { target?: unknown; method?: unknown; screen?: unknown; windows?: unknown; after?: unknown };
      if (!same(NativeCaptureTargetSchema.parse(captured.target), view.target) || !same(captured.screen, view.target.bounds) || captured.method !== view.target.kind)
        refuse('The captured target changed. Choose it again.');
      for (const snapshot of view.target.kind === 'window' ? [captured.windows, captured.after] : []) {
        if (!Array.isArray(snapshot) || view.target.kind !== 'window') refuse('The application identity cannot be verified.');
        const target = view.target;
        const window = snapshot.find((item) => item?.handle === target.handle && item?.processId === target.processId);
        if (!nativeWindowViewable(window, view.excludedProcessId)) refuse('That window became a browser or viewer. Choose an external application again.');
        const checked = TargetWindow.parse(window);
        if (!same({ x: checked.x, y: checked.y, w: checked.width, h: checked.height }, target.bounds))
          refuse('That application moved or resized. Choose it again.');
      }
      const id = opaque(); view.frame = { id, expires: this.now() + 2000, consumed: false, painted: false };
      // The Trunk's cursor where its newest click of a task still going landed (none while the owner drives), and whether
      // the owner drives: the owner's view of the Trunk at work, as #567 draws it.
      const cursor = view.control ? null : placeOnFrame(view.port.pointer(), view.target.bounds);
      return { frame: `data:${shot.type};base64,${shot.bytes.toString('base64')}`, width: shot.width, height: shot.height,
        frameId: id, viewId, seq: ++view.seq, label: view.label, control: view.control, driving: view.control, cursor, at: new Date(this.now()).toISOString() };
    } catch (error) { if (this.selected === view) await this.close(); throw error; }
    finally { view.busy = false; }
  }
  private currentFrame(access: LocalScreenAccess, viewId: string, frameId: string): View {
    const view = this.view(access, viewId);
    if (!view.streaming || !view.frame || view.frame.id !== frameId || !view.frame.painted || view.frame.consumed || view.frame.expires <= this.now())
      refuse('Wait for a fresh frame before using this target.');
    if (view.busy) refuse('This target is already answering another request.');
    return view;
  }
  painted(access: LocalScreenAccess, viewId: string, frameId: string): { painted: true } {
    const view = this.view(access, viewId);
    if (!view.streaming || !view.frame || view.frame.id !== frameId || view.frame.expires <= this.now())
      refuse('That frame is no longer current.');
    view.frame.painted = true;
    return { painted: true };
  }
  async control(access: LocalScreenAccess, viewId: string, frameId: string, held: boolean): Promise<{ control: boolean }> {
    const view = this.currentFrame(access, viewId, frameId);
    view.frame!.consumed = true;
    try {
      if (held) view.port.takeOver(); else view.port.handBack();
      this.view(access, viewId); view.control = held;
      return { control: held };
    } catch (error) { if (this.selected === view) await this.close(); throw error; }
  }
  async input(access: LocalScreenAccess, viewId: string, frameId: string, input: unknown, signal: AbortSignal): Promise<{ acted: true }> {
    const view = this.currentFrame(access, viewId, frameId), action = ScreenAction.parse(input);
    if (!view.control) refuse('Take control before using this target.');
    // A display shows every window on it, so a click could land on any of them: the owner drives a display with their own
    // mouse and keyboard (Take control still pauses every task), and clicks through the view only into a chosen app window.
    if (view.target.kind !== 'window') refuse('On a whole display, use your own mouse and keyboard while you have control. To click through the view, choose an app window.');
    view.frame!.consumed = true; view.busy = true;
    try {
      await view.port.act(action, AbortSignal.any([signal, view.life.signal]));
      if (this.view(access, viewId) !== view) refuse('This view was replaced.');
      return { acted: true };
    } catch (error) { if (this.selected === view) await this.close(); throw error; }
    finally { view.busy = false; }
  }
  async close(): Promise<void> {
    this.epoch++;
    this.opening?.abort(); this.opening = null;
    const view = this.selected; this.selected = null;
    if (!view) return;
    view.life.abort(); view.frame = null; view.streaming = false;
    if (view.unopened) clearTimeout(view.unopened);
    await view.port.close().catch(() => undefined);
  }
  async stream(access: LocalScreenAccess, viewId: string, width: number, _request: IncomingMessage, response: ServerResponse): Promise<void> {
    const view = this.view(access, viewId);
    if (view.streaming) refuse('This target already has an open view.');
    if (view.unopened) clearTimeout(view.unopened);
    view.unopened = null;
    view.streaming = true;
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    let full = false;
    response.on('drain', () => { full = false; });
    response.once('close', () => { if (this.selected === view) void this.close(); });
    while (this.selected === view && !view.life.signal.aborted && !response.destroyed) {
      try {
        // computer-control: the next frame waits until the window has painted this one (or two seconds pass), so a
        // Take over or click is always pressed on a frame that is still current, however slow the window is to paint.
        const waiting = view.frame !== null && !view.frame.painted && !view.frame.consumed && view.frame.expires > this.now();
        if (!full && !view.busy && !waiting) full = !response.write(`${JSON.stringify(await this.frame(access, viewId, width, view.life.signal))}\n`);
        else this.view(access, viewId);
      } catch (error) {
        if (!response.destroyed) response.write(`${JSON.stringify({ refusal: error instanceof Error ? error.message : 'This screen stopped.', status: error instanceof LocalScreenRefusal ? error.status : 409 })}\n`);
        break;
      }
      await pause(view.life.signal);
    }
    if (this.selected === view) await this.close();
    response.end();
  }
}
