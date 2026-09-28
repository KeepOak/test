import type { ServerResponse } from 'node:http';
import { LocalScreenRefusal, type LocalScreenAccess } from './local-screen.js';

/**
 * computer-control (SCREEN-077): the owner's live view of a paired computer's screen, in the same full-size computer
 * view as This computer's. The paired computer (a `branch node` that the owner allowed to take pictures of its screen)
 * sends each picture over its own device socket (src/devices/hub.ts), one at a time while the view is open, and each is
 * passed to the window as it comes and kept nowhere. Only the owner, at this computer's own window, for one of their
 * own conversations that may use that computer, and never under Lockdown or the app lock. Watching only: nothing is
 * clicked or typed on the other computer from here. The pace is one picture every two seconds and a half, from a
 * budget of its own on the device socket, so watching never takes a task's turns on that computer.
 *
 *   GET /api/panels/screen/device?session=<conversation>&device=<16 hex>
 */
export const deviceScreenPath = '/api/panels/screen/device';
export const deviceScreenPaceMs = 2500;

export interface DeviceScreenDeps {
  owner(): string; isOwner(): boolean; owns(owner: string, sessionId: string): boolean;
  lockdown(): boolean; locked(): string | null;
  /** Whether this conversation may use that computer (its pick, its Trunk's allowed computers). */
  allows(sessionId: string, deviceId: string): boolean;
  /** One picture of that computer's screen, through the device socket; refused when it is off, gone or not allowed. */
  capture(deviceId: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }>;
  paceMs?: number;
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
  constructor(private readonly deps: DeviceScreenDeps) {}

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
          if (!response.destroyed) response.write(`${JSON.stringify({ frame: `data:${shot.mime};base64,${shot.bytes.toString('base64')}`, device: deviceId, at: new Date().toISOString() })}\n`);
        } catch (error) {
          if (!life.signal.aborted && !response.destroyed)
            response.write(`${JSON.stringify({ refusal: error instanceof Error ? error.message : 'That computer stopped.', status: error instanceof LocalScreenRefusal ? error.status : 409 })}\n`);
          break;
        }
        await pause(Math.max(0, (this.deps.paceMs ?? deviceScreenPaceMs) - (Date.now() - started)), life.signal);
      }
    } finally {
      this.views.delete(life);
      if (!response.destroyed) response.end();
    }
  }

  /** Every open view ends (Branch stopping). */
  close(): void { for (const view of this.views) view.abort(); this.views.clear(); }
}
