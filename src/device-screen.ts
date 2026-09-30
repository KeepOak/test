import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { deviceArgs } from './devices/args.js';
import { LocalScreenRefusal, type LocalScreenAccess } from './local-screen.js';

/**
 * computer-control (SCREEN-077): the owner's live view of a paired computer's screen, in the same full-size computer
 * view as This computer's. The paired computer (a `branch node` that the owner allowed to take pictures of its screen)
 * sends each picture over its own device socket (src/devices/hub.ts), one at a time while the view is open, and each is
 * passed to the window as it comes and kept nowhere. Only the owner, at this computer's own window, for one of their
 * own conversations that may use that computer, and never under Lockdown or the app lock. The pace is one picture
 * every two seconds and a half, from a budget of its own on the device socket, so watching never takes a task's turns.
 *
 * Using it: the owner takes over that computer (only when its own "Let you use its screen and keyboard from Branch"
 * switch is on, which that computer checks again itself), then clicks, scrolls and types on the picture. Each press
 * names the picture it was aimed at, which must be the last one shown and fresh, so a click never lands on a screen
 * the owner has not seen. While the owner drives, a task cannot act on that computer ("You're driving") and that
 * computer shows a notice on top of everything with a Stop of its own; Stop there, closing the view, Hand back,
 * Lockdown, the app lock or two quiet minutes end it. Tasks never get this: there is no tool for it.
 *
 *   GET  /api/panels/screen/device?session=<conversation>&device=<16 hex>
 *   POST /api/panels/screen/device/drive  {session, device, on}
 *   POST /api/panels/screen/device/input  {session, device, frameId, input}
 */
export const deviceScreenPath = '/api/panels/screen/device';
export const deviceScreenPaceMs = 2500;
export const deviceDrivePath = '/api/panels/screen/device/drive';
export const deviceInputPath = '/api/panels/screen/device/input';
/** How old the picture a press was aimed at may be. */
export const deviceFrameFreshMs = 30_000;

export interface DeviceScreenDeps {
  owner(): string; isOwner(): boolean; owns(owner: string, sessionId: string): boolean;
  lockdown(): boolean; locked(): string | null;
  /** Whether this conversation may use that computer (its pick, its Trunk's allowed computers). */
  allows(sessionId: string, deviceId: string): boolean;
  /** One picture of that computer's screen, through the device socket; refused when it is off, gone or not allowed. */
  capture(deviceId: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }>;
  /** Why that computer's screen and keyboard cannot be used from here (its switch is off, it cannot), or null. */
  inputRefusal(deviceId: string): string | null;
  /** The owner takes over that computer, or hands it back (src/devices/hub.ts `drive`). */
  drive(deviceId: string, on: boolean): void;
  driving(deviceId: string): boolean;
  /** Whether someone at that computer just pressed Stop on its notice. */
  stoppedHere(deviceId: string): boolean;
  /** One owner input, through the device socket; that computer checks its own switch again. */
  input(deviceId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  paceMs?: number;
  now?: () => number;
}
function refuse(message: string, status = 409): never { throw new LocalScreenRefusal(status, message); }
const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => {
  if (signal.aborted) return done();
  const timer = setTimeout(finish, ms);
  function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); }
  signal.addEventListener('abort', finish, { once: true });
});

export class DeviceScreen {
  private readonly views = new Set<AbortController>();
  /** The last picture shown of each computer: presses are aimed at it. */
  private readonly shown = new Map<string, { frameId: string; at: number; pressed: boolean }>();
  constructor(private readonly deps: DeviceScreenDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Take over (on) or hand back (off). Taking over needs an open view and that computer's own switch. */
  drive(access: LocalScreenAccess, deviceId: string, on: boolean): { driving: boolean } {
    this.guard(access, deviceId);
    if (on) {
      const refused = this.deps.inputRefusal(deviceId); if (refused) refuse(refused);
      if (!this.shown.has(deviceId)) refuse('Open that computer in the view first.');
    }
    this.deps.drive(deviceId, on);
    return { driving: on };
  }

  /** One click, scroll, key or piece of text, aimed at the picture named. */
  async input(access: LocalScreenAccess, deviceId: string, frameId: string, raw: unknown, signal: AbortSignal): Promise<{ done: true }> {
    this.guard(access, deviceId);
    if (!this.deps.driving(deviceId)) refuse('Take over that computer first.');
    const last = this.shown.get(deviceId);
    if (!last || last.frameId !== frameId || this.now() - last.at > deviceFrameFreshMs)
      refuse('The picture moved on; press again on the one showing now.');
    const parsed = deviceArgs.input.safeParse(raw);
    if (!parsed.success) refuse(parsed.error.issues[0]?.message ?? 'That input is not understood.', 400);
    // A click or scroll uses its picture up, so a second one never lands on a screen not yet seen. Text and keys go
    // where the owner last clicked, so they may follow a click on the same picture.
    const spot = parsed.data.action === 'click' || parsed.data.action === 'scroll';
    if (spot && last.pressed) refuse('The picture moved on; press again on the one showing now.');
    if (spot) this.shown.set(deviceId, { ...last, pressed: true });
    try { await this.deps.input(deviceId, parsed.data, signal); }
    catch (error) { refuse(error instanceof Error ? error.message : 'That computer did not take it.'); }
    return { done: true };
  }

  /** Asked before the view opens and again before and after every picture. */
  guard(access: LocalScreenAccess, deviceId: string): void {
    if (access.viaDoor || access.shortKey || !access.keyValid()) refuse('Another computer is shown only in Branch\'s own window on this computer.', 403);
    if (access.owner !== this.deps.owner() || !this.deps.isOwner() || !this.deps.owns(access.owner, access.sessionId))
      refuse('Choose one of your own conversations before opening a computer.', 403);
    if (!/^[a-f0-9]{16}$/.test(deviceId)) refuse('That is not a paired computer.', 400);
    if (this.deps.lockdown()) refuse('Lockdown keeps other computers unavailable.', 403);
    const locked = this.deps.locked(); if (locked) refuse(locked, 423);
    if (!this.deps.allows(access.sessionId, deviceId)) refuse('This conversation cannot use that computer.', 403);
  }

  /** One open view: a line per picture until the window lets go, the owner loses access, or the computer refuses. */
  async stream(access: LocalScreenAccess, deviceId: string, response: ServerResponse): Promise<void> {
    this.guard(access, deviceId);
    const life = new AbortController();
    this.views.add(life);
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.once('close', () => life.abort());
    try {
      while (!life.signal.aborted && !response.destroyed) {
        const started = Date.now();
        try {
          this.guard(access, deviceId);
          const shot = await this.deps.capture(deviceId, life.signal);
          this.guard(access, deviceId);
          if (!/^image\/(png|jpeg)$/.test(shot.mime) || !shot.bytes.length) refuse('That computer did not send a picture.');
          const frameId = randomBytes(8).toString('hex');
          this.shown.set(deviceId, { frameId, at: this.now(), pressed: false });
          if (!response.destroyed) response.write(`${JSON.stringify({ frame: `data:${shot.mime};base64,${shot.bytes.toString('base64')}`, device: deviceId,
            frameId, driving: this.deps.driving(deviceId), inputNote: this.deps.inputRefusal(deviceId),
            stoppedHere: this.deps.stoppedHere(deviceId), at: new Date().toISOString() })}\n`);
        } catch (error) {
          if (!life.signal.aborted && !response.destroyed)
            response.write(`${JSON.stringify({ refusal: error instanceof Error ? error.message : 'That computer stopped.', status: error instanceof LocalScreenRefusal ? error.status : 409 })}\n`);
          break;
        }
        await pause(Math.max(0, (this.deps.paceMs ?? deviceScreenPaceMs) - (Date.now() - started)), life.signal);
      }
    } finally {
      this.views.delete(life);
      // Closing the view hands the computer back.
      this.shown.delete(deviceId);
      this.deps.drive(deviceId, false);
      if (!response.destroyed) response.end();
    }
  }

  /** Every open view ends (Branch stopping). */
  close(): void { for (const view of this.views) view.abort(); this.views.clear(); }
}
