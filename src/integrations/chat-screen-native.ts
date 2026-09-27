import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NativeCaptureTargetSchema, CaptureExclusionSchema } from '../desktop/capture-lease.js';
import { ScreenAction, type ScreenSessionDesktop } from '../channels/screen-sessions.js';
import type { LivePointer } from '../live-screen.js';
import type { NativeCaptureTarget, CaptureExclusion, ScreenBox } from './desktop-script.js';
import type { NativeCaptureLease, LiveFrame, LiveFrames } from './desktop.js';
import type { DesktopBanner, BannerLease } from './desktop-banner.js';
import { secretReferenceIn, type WindowInfo } from './desktop-config.js';

const Snapshot = z.object({ handle: z.string().min(1), processId: z.number().int().positive(),
  x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).passthrough();
type Snapshot = z.infer<typeof Snapshot>;
export interface CapturedNativeFrame extends LiveFrame {
  target?: NativeCaptureTarget; method?: string; windows?: unknown; after?: unknown;
}
export interface ChatNativeParts {
  target: NativeCaptureTarget;
  host: NativeCaptureLease | undefined;
  banner: DesktopBanner;
  signal: AbortSignal;
  stopped(): void;
  /** Owner/profile/App lock/pairing are reread by the caller, never supplied by the client. */
  guard(): void;
  /** Screen switch, OS permission and password windows, before and after asynchronous work. */
  check(signal: AbortSignal): Promise<void>;
  frames(target: NativeCaptureTarget, exclusion: CaptureExclusion): LiveFrames;
  resolve(window: string, signal: AbortSignal): Promise<WindowInfo>;
  input(action: ScreenAction, window: WindowInfo, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  takeOver(): void;
  handBack(): void;
  /** True only while this particular port still holds the physical desktop, not another local owner lease. */
  holdsControl(): boolean;
  agentPointer(): LivePointer | null;
  finished(): void;
}
function refuse(message: string): never { throw new Error(message); }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const bounds = (at: Snapshot): ScreenBox => ({ x: at.x, y: at.y, w: at.width, h: at.height });

/** Native capture/input has no tool context or grant bypass; only an authenticated screen session calls this port. */
export class ChatNativeScreen implements ScreenSessionDesktop {
  readonly frames: LiveFrames;
  private readonly reader: LiveFrames;
  private closed = false;
  private closeResult: Promise<void> | undefined;
  private displayed: CapturedNativeFrame | null = null;
  private ownerPointer: LivePointer | null = null;
  private readonly target: NativeCaptureTarget;
  private constructor(private readonly parts: ChatNativeParts, private readonly leaseId: string,
    private readonly exclusion: CaptureExclusion, private readonly notice: BannerLease, private readonly life: AbortController) {
    this.target = NativeCaptureTargetSchema.parse(parts.target);
    this.reader = parts.frames(this.target, exclusion);
    const reader = this.reader;
    this.frames = { next: (width, signal) => this.frame(width, signal), close: () => { void this.close().catch(() => undefined); }, get running() { return reader.running; } };
  }
  static async open(parts: ChatNativeParts): Promise<ChatNativeScreen> {
    parts.guard();
    NativeCaptureTargetSchema.parse(parts.target);
    if (!parts.host) refuse('This desktop host cannot prove which viewer windows to exclude. Open the supported Branch desktop app.');
    const leaseId = randomBytes(16).toString('hex'), life = new AbortController();
    let notice: BannerLease | undefined, session: ChatNativeScreen | undefined;
    let acquired = false;
    try {
      const proof = await parts.host.acquire(leaseId); acquired = true;
      const exclusion = CaptureExclusionSchema.parse(proof);
      if (parts.target.kind === 'window' && parts.target.processId === exclusion.processId) refuse('Branch cannot capture or control its own viewer.');
      parts.guard();
      await parts.check(AbortSignal.any([parts.signal, life.signal]));
      notice = await parts.banner.acquire(() => { life.abort(); parts.stopped(); void session?.close().catch(() => undefined); });
      parts.guard();
      if (life.signal.aborted || parts.signal.aborted || !notice.visible()) refuse('The screen session stopped before its notice was ready.');
      session = new ChatNativeScreen(parts, leaseId, exclusion, notice, life);
      return session;
    } catch (error) {
      life.abort();
      await notice?.release().catch(() => undefined);
      if (acquired) await parts.host.release(leaseId).catch(() => undefined);
      throw error;
    }
  }
  visible(): boolean { return !this.closed && this.notice.visible(); }
  private signal(extra?: AbortSignal): AbortSignal {
    const signals = [this.parts.signal, this.life.signal];
    if (extra) signals.push(extra);
    return AbortSignal.any(signals);
  }
  private async checked(signal: AbortSignal): Promise<CaptureExclusion> {
    this.parts.guard();
    if (this.closed || signal.aborted || !this.notice.visible()) refuse('The screen session stopped.');
    await this.parts.check(signal);
    const fresh = CaptureExclusionSchema.parse(await this.parts.host!.acquire(this.leaseId));
    if (fresh.processId !== this.exclusion.processId) refuse('The desktop host changed. Start a new screen session.');
    this.parts.guard();
    if (signal.aborted || !this.notice.visible()) refuse('The screen session stopped.');
    return fresh;
  }
  private async frame(width: number, extra: AbortSignal): Promise<CapturedNativeFrame> {
    const signal = this.signal(extra);
    try {
      await this.checked(signal);
      const frame = await this.reader.next(width, signal) as CapturedNativeFrame;
      await this.checked(signal);
      const target = NativeCaptureTargetSchema.parse(frame.target);
      if (!same(target, this.target) || !same(frame.screen, this.target.bounds) || frame.method !== this.target.kind) refuse('The captured target changed. Choose it again.');
      this.displayed = frame;
      return frame;
    } catch (error) { await this.close(); throw error; }
  }
  private snapshot(window: WindowInfo): Snapshot {
    const displayed = this.displayed;
    if (!displayed) refuse('Wait for a live frame before using the screen.');
    const find = (list: unknown): Snapshot | undefined => {
      if (!Array.isArray(list)) return undefined;
      return list.map((value) => Snapshot.safeParse(value)).filter((value) => value.success)
        .map((value) => value.data!).find((value) => value.handle === String(window.handle) && value.processId === window.processId);
    };
    const before = find(displayed.windows), after = find(displayed.after);
    if (!before || !after || !same(bounds(before), bounds(after))) refuse('That window changed while the frame was captured. Refresh the view.');
    return after;
  }
  private point(action: ScreenAction, window: Snapshot): { x: number; y: number } {
    const box = this.target.bounds;
    if (action.action === 'click') return { x: action.x, y: action.y };
    const x = (window.x + window.width / 2 - box.x) / box.w, y = (window.y + window.height / 2 - box.y) / box.h;
    if (x < 0 || y < 0 || x > 1 || y > 1) refuse('That window is outside the live view.');
    return { x, y };
  }
  async act(input: ScreenAction, extra: AbortSignal): Promise<void> {
    const action = ScreenAction.parse(input), signal = this.signal(extra);
    if (!this.parts.holdsControl()) refuse('Take over before using the screen.');
    if (action.action === 'type') { const problem = secretReferenceIn(action.text); if (problem) refuse(problem); }
    try {
      const exclusion = await this.checked(signal), window = await this.parts.resolve(action.window, signal);
      const snapshot = this.snapshot(window);
      if (this.target.kind === 'window' && (String(window.handle) !== this.target.handle || window.processId !== this.target.processId)) refuse('Choose the window shown in the live view.');
      const point = this.point(action, snapshot);
      await this.checked(signal);
      if (!this.parts.holdsControl()) refuse('Control was handed back before this action.');
      const answer = await this.parts.input(action, window, { expectedTarget: this.target, expectedProcessId: window.processId,
        expectedWindowBounds: bounds(snapshot), exclusion, pointOnTarget: point }, signal);
      await this.checked(signal);
      if (action.action === 'click' && Array.isArray(answer.at) && answer.at.length === 2 && answer.at.every(Number.isFinite))
        this.ownerPointer = { x: Number(answer.at[0]), y: Number(answer.at[1]), at: new Date().toISOString(), trunk: null };
    } catch (error) { await this.close(); throw error; }
  }
  takeOver(): void { this.parts.guard(); if (this.closed) refuse('The screen session stopped.'); this.parts.takeOver(); }
  handBack(): void { this.parts.handBack(); this.ownerPointer = null; }
  pointer(): LivePointer | null { return this.parts.holdsControl() ? this.ownerPointer : this.parts.agentPointer(); }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closed = true;
    this.life.abort();
    this.displayed = null;
    this.reader.close();
    this.handBack();
    this.closeResult = (async () => {
      try { try { await this.notice.release(); } finally { await this.parts.host!.release(this.leaseId); } }
      finally { this.parts.finished(); }
    })();
    return this.closeResult;
  }
}
