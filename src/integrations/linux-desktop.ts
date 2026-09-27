import { randomBytes } from 'node:crypto';
import { execFile, spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, connect, Server as NetServer } from 'node:net';
import { z } from 'zod';
import { FeatureModeSchema, optionalFields, sentFields } from '../feature-switches.js';
import { lockdownActive, lockdownOverrides, lockdownToolRefusalText, onLockdownChange } from '../lockdown.js';
import type { Store } from '../store.js';
import { TakeOverBanner } from './linux-desktop-banner.js';

/**
 * FQ-execution.desktop: a Linux desktop the assistant and the owner can share.
 *
 * Screen control (`desktop.ts`) reaches this computer's own screen. This is a different desktop
 * entirely: a throwaway Linux one, drawn by Xvfb inside a container and served over VNC, so the
 * assistant never touches anything of the owner's own. The owner may still watch or take it over —
 * point any VNC viewer at the address this hands back, or press "Take over" on the notice
 * (`linux-desktop-banner.ts`) or on its Settings card — and while they hold it, every assistant
 * action here is refused until they hand it back from that card. Nothing is ever pulled: the
 * container image must already be on this computer, exactly as the browser sandbox works
 * (`browser-container.ts`). The repository carries no recipe for the default image; a minimal
 * example is in docs/examples/linux-desktop/Dockerfile.
 */
export const settingsKey = 'linux-desktop';
export const LinuxDesktopSchema = z.object({
  /** The three-way switch. Off: `desktop.shared.*` refuse in one sentence, and a running desktop stops. */
  mode: FeatureModeSchema.default('off'),
  /** The container image a shared desktop starts from. Nothing is ever pulled. */
  image: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/, 'Image must be a valid reference (name:tag@digest)').default('branch-linux-desktop:latest'),
}).strict();
export type LinuxDesktopSettings = z.infer<typeof LinuxDesktopSchema>;
/** Only what was sent: saving the mode alone must not put the image back to its default. */
export const LinuxDesktopInputSchema = optionalFields(LinuxDesktopSchema);

function savedLinuxDesktop(store: Pick<Store, 'get'>, owner: string): LinuxDesktopSettings {
  const saved = LinuxDesktopSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : LinuxDesktopSchema.parse({});
}
/** The switch as it stands right now. While Lockdown is on it reads off, whatever was saved. */
export function readLinuxDesktop(store: Pick<Store, 'get'>, owner: string): LinuxDesktopSettings {
  const settings = savedLinuxDesktop(store, owner);
  return lockdownOverrides(store, owner, settingsKey) ? { ...settings, mode: 'off' } : settings;
}
export function saveLinuxDesktop(store: Pick<Store, 'get' | 'save'>, owner: string, input: unknown): LinuxDesktopSettings {
  const sent = sentFields(LinuxDesktopInputSchema.parse(input ?? {}), input);
  store.save('settings', owner, settingsKey, LinuxDesktopSchema.parse({ ...savedLinuxDesktop(store, owner), ...sent }));
  return readLinuxDesktop(store, owner);
}

export const switchedOffMessage =
  'Branch is not allowed to use a shared Linux desktop. Turn on "Shared Linux desktop" in Settings → Computer & browser first.';
export const sandboxRefusal = (reason: string): string => `The shared Linux desktop cannot be used: ${reason}`;
/** unhold-control: the owner hands it back from the window's computer view, where "Take over" was pressed. */
export const takenOverMessage =
  'You have taken over the shared desktop, so Branch has let go of it. Only you can hand it back, with "Hand back to …" at the top of the computer view.';
export const notRunningMessage = 'No shared Linux desktop is running. Start one with desktop.shared.start first.';
export const stoppedWhileStartingMessage = sandboxRefusal('it was stopped before it finished starting.');
export const closingMessage = sandboxRefusal('Branch is closing.');

// ---------------------------------------------------------------- the commands themselves

/** The virtual display every shared desktop draws to, and the port its VNC server listens on. */
export const display = ':1';
export const vncPort = 5900;

/** Xvfb's own argument list: a throwaway 1280x800 screen, listening on nothing but the display socket. */
export function xvfbArgv(): string[] {
  return [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'];
}
/** x11vnc's argument list: the same display, password file, and no other listener. */
export function x11vncArgv(): string[] {
  return ['-display', display, '-rfbport', String(vncPort), '-passwdfile', 'rm:/tmp/vncpw', '-forever', '-shared', '-quiet'];
}
export type SharedDesktopAction =
  | { type: 'open'; app: string }
  | { type: 'type'; text: string }
  | { type: 'key'; chord: string };
/** Compute the timeout for a docker exec action: types longer than ~1250 chars need more than 15s. */
export function execTimeoutMs(action: SharedDesktopAction): number {
  if (action.type !== 'type') return 15_000;
  const charMs = 15; // xdotool types at ~12 ms per char; add buffer
  // 4000 chars (the most desktop.shared.type takes) × 15 ms + 5 s = 65 s, and never more than that.
  return Math.min(65_000, 5_000 + action.text.length * charMs);
}
/**
 * xdotool's argument list for one action. Nothing here ever reaches a shell: it is one argv, run
 * directly. A program is started with `xdotool exec`, which starts it and returns without waiting.
 */
export function xdotoolArgv(action: SharedDesktopAction): string[] {
  if (action.type === 'open') return ['exec', '--', action.app];
  if (action.type === 'type') return ['type', '--clearmodifiers', '--', action.text];
  return ['key', '--clearmodifiers', action.chord];
}
/** The exact `docker run` line: nothing of this computer is shared in, and the VNC port stays local. */
export function dockerRunArgv(image: string): string[] {
  const inner = `Xvfb ${xvfbArgv().join(' ')} & while [ ! -s /tmp/vncpw ]; do sleep 0.2; done; exec x11vnc ${x11vncArgv().join(' ')}`;
  return ['run', '-d', '--rm', '--init', '--pull=never',
    '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--label', 'branch.shared-desktop=1',
    '--memory', '1g', '--cpus', '1',
    image, 'sh', '-c', inner];
}
/** Runs one xdotool action inside the running container, against the desktop's own display. */
export function dockerExecArgv(containerId: string, action: SharedDesktopAction): string[] {
  return ['exec', '-e', `DISPLAY=${display}`, containerId, 'xdotool', ...xdotoolArgv(action)];
}
/** Stops any in-flight xdotool action by terminating the process inside the container. */
export function dockerExecKillArgv(containerId: string): string[] {
  return ['exec', '-e', `DISPLAY=${display}`, containerId, 'pkill', '-x', 'xdotool'];
}
export function dockerStopArgv(containerId: string): string[] {
  return ['stop', containerId];
}
export function dockerImageInspectArgv(image: string): string[] {
  return ['image', 'inspect', image];
}

// ---------------------------------------------------------------- running it

/** Starts a program with an argument list (never a shell line), bounded by a time limit. */
export type ProgramRunner = (file: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>;
export const runProgram: ProgramRunner = (file, args, timeoutMs, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, shell: false, signal },
    (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});
/** Writes input via stdin to a command. */
export type Feeder = (file: string, args: string[], input: string, timeoutMs: number) => Promise<void>;
export const feed: Feeder = (file, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { shell: false, timeout: timeoutMs, stdio: ['pipe', 'ignore', 'ignore'] });
  const timer = setTimeout(() => { child.kill(); reject(new Error('feed timeout')); }, timeoutMs);
  child.stdin!.write(input, (err) => {
    if (err) return reject(err);
    child.stdin!.end();
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error(`feed exit code ${code}`));
    resolve();
  });
  child.on('error', (err) => { clearTimeout(timer); reject(err); });
});
/** Spawns a child process and returns it for manual management. */
export type Spawner = (file: string, args: string[]) => ChildProcessWithoutNullStreams;
export const spawner: Spawner = (file, args) => spawn(file, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
/** True once the VNC server inside the container answers. */
export type Prober = (containerId: string, runner: ProgramRunner) => Promise<boolean>;
export const probeTcp: Prober = async (containerId, runner) => {
  try {
    await runner('docker', ['exec', containerId, 'sh', '-c', 'timeout 1 sh -c "</dev/tcp/127.0.0.1/5900" 2>/dev/null'], 2000);
    return true;
  } catch {
    return false;
  }
};

export interface SharedDesktopInfo { host: string; port: number; password: string }
/** What the Settings card shows. Never the VNC password: reading the card is only a look. */
export interface SharedDesktopStatus extends LinuxDesktopSettings { running: boolean; control: 'agent' | 'user' | 'none' }
type Tunnel = { socket: any; child: ChildProcessWithoutNullStreams };
interface Session { id: string; host: string; port: number; password: string; control: 'agent' | 'user'; inFlightAbort: AbortController; takingOver?: Promise<void>; listener: NetServer; tunnels: Set<Tunnel> }
/** The notice with the "Take over" button on it, or a stand-in for one. */
export interface TakeOverNotice { show(onTakeOver: () => void): Promise<void>; hide(): Promise<void> }

const infoOf = (session: Session): SharedDesktopInfo =>
  ({ host: session.host, port: session.port, password: session.password });

/**
 * One shared Linux desktop per owner, started on first use. Whoever holds `control` is the only
 * one Branch will act for: the owner takes it with `takeOver` (the notice's button and the Settings
 * card do the same) and gives it back with `handBack`, which only the owner's own Settings route
 * calls. While the owner holds it, everything the assistant can reach — `start`, `act` and `stop` —
 * is refused, in words that say so plainly. `end` is the owner's and the app's own way to take a
 * desktop down, whoever holds it: the switch going off, Lockdown, and the app closing.
 *
 * Starting takes a while, so it is tracked: two starts at once share one, and a stop (or the app
 * closing) while one is under way calls it off and still takes its container down.
 */
export type ListenerCreator = (containerId: string, tunnels: Set<Tunnel>) => Promise<NetServer>;

export class LinuxDesktopSandbox {
  runner: ProgramRunner = runProgram;
  feeder: Feeder = feed;
  spawnerFn: Spawner = spawner;
  probe: Prober = probeTcp;
  createListener: ListenerCreator;
  password: () => string = () => randomBytes(6).toString('base64url');
  waitMs = 30_000;
  pauseMs = 300;
  banner: TakeOverNotice;
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session>>();
  private readonly stopping = new Map<string, Promise<void>>();
  /** Bumped by every stop, so a start under way can tell it has been called off. */
  private readonly epochs = new Map<string, number>();
  private closed = false;
  private readonly stopListening: () => void;
  constructor(private readonly store: Pick<Store, 'get' | 'save' | 'event'>, options: { banner?: TakeOverNotice } = {}) {
    this.banner = options.banner ?? new TakeOverBanner();
    this.createListener = this.createListenerImpl.bind(this);
    // Lockdown takes the desktop down at once, rather than at the assistant's next action.
    this.stopListening = onLockdownChange((changed, owner, on) => {
      if (on && changed === this.store) void this.end(owner);
    });
  }

  private settings(owner: string): LinuxDesktopSettings {
    return readLinuxDesktop(this.store, owner);
  }
  /** `store.event` keys its rows to a real run; a shared desktop outlives any one run, so writing
   * one down here is best-effort and never the reason a start, a take-over or a stop fails. */
  private log(id: string, kind: string, data: Record<string, unknown>): void {
    try { this.store.event(id, kind, data); } catch { /* no run to attach the record to; not fatal */ }
  }
  private epoch(owner: string): number { return this.epochs.get(owner) ?? 0; }
  /** A start is called off by a stop made since it began, or by the app closing at any point. */
  private calledOff(owner: string, epoch: number): boolean { return this.closed || this.epoch(owner) !== epoch; }
  /**
   * Asked before everything the assistant does: while the switch is off (or Lockdown is on) the
   * desktop is taken down if it is still running, and the request is refused.
   */
  private async allowed(owner: string): Promise<LinuxDesktopSettings> {
    const settings = this.settings(owner);
    if (settings.mode !== 'off') return settings;
    await this.end(owner);
    throw new Error(lockdownActive(this.store, owner) ? lockdownToolRefusalText : switchedOffMessage);
  }
  /** Whether the shared desktop is available at all right now, and why not when it is not. */
  async available(owner: string): Promise<{ ok: boolean; reason: string }> {
    const settings = this.settings(owner);
    if (settings.mode === 'off') return { ok: false, reason: switchedOffMessage };
    try { await this.runner('docker', dockerImageInspectArgv(settings.image), 15_000); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: sandboxRefusal('Docker is not installed on this computer.') };
      return { ok: false, reason: sandboxRefusal(`the image "${settings.image}" is not on this computer yet. Build or pull it yourself first.`) };
    }
    return { ok: true, reason: '' };
  }
  /** Starts a shared desktop for this owner, or hands back the one already running (the assistant's). */
  async start(owner: string): Promise<SharedDesktopInfo> {
    if (this.closed) throw new Error(closingMessage);
    await this.stopping.get(owner); // a stop under way finishes first, notice and all
    const settings = await this.allowed(owner);
    const running = this.sessions.get(owner);
    if (running) {
      if (running.control !== 'agent') throw new Error(takenOverMessage);
      return infoOf(running);
    }
    const epoch = this.epoch(owner);
    let pending = this.starting.get(owner);
    if (!pending) {
      const started: Promise<Session> = this.launch(owner, settings, epoch)
        .finally(() => { if (this.starting.get(owner) === started) this.starting.delete(owner); });
      this.starting.set(owner, started);
      pending = started;
    }
    const session = await pending;
    if (this.calledOff(owner, epoch)) throw new Error(notRunningMessage);
    if (session.control !== 'agent') throw new Error(takenOverMessage);
    return infoOf(session);
  }
  private async launch(owner: string, settings: LinuxDesktopSettings, epoch: number): Promise<Session> {
    const check = await this.available(owner);
    if (!check.ok) throw new Error(check.reason);
    if (this.calledOff(owner, epoch)) throw new Error(stoppedWhileStartingMessage);
    // Remove any stale containers with the shared-desktop label that we're not currently tracking (best-effort)
    const trackedIds = new Set([...this.sessions.values()].map((s) => s.id));
    try {
      const staleList = (await this.runner('docker', ['container', 'ls', '-a', '--filter', 'label=branch.shared-desktop=1', '--format', '{{.ID}}'], 10_000)).trim().split('\n').filter(Boolean);
      for (const staleId of staleList) if (!trackedIds.has(staleId)) {
        await this.runner('docker', dockerStopArgv(staleId), 5_000).catch(() => undefined);
      }
    } catch { /* best-effort cleanup */ }
    const password = this.password();
    let id = '';
    try { id = (await this.runner('docker', dockerRunArgv(settings.image), 30_000)).trim().split('\n').at(-1) ?? ''; }
    catch { throw new Error(sandboxRefusal('Docker could not start the container.')); }
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(sandboxRefusal('Docker did not say which container it started.'));
    // The container exists from here on, so every way out that is not a running desktop takes it down.
    let listener: NetServer | undefined;
    const tunnels = new Set<Tunnel>();
    try {
      // Write the password via stdin to the container
      await this.feeder('docker', ['exec', '-i', id, 'sh', '-c', 'umask 077; cat > /tmp/vncpw'], password, 5_000);
      // Wait for the VNC server to answer inside the container
      await this.answering(owner, epoch, id);
      // Create a listener on loopback:0
      listener = await this.createListener(id, tunnels);
    } catch (error) {
      if (listener) listener.close();
      for (const tunnel of tunnels) {
        tunnel.socket.destroy();
        tunnel.child.kill();
      }
      await this.runner('docker', dockerStopArgv(id), 15_000).catch(() => undefined);
      throw error;
    }
    const addr = listener.address() as { address: string; port: number };
    const session: Session = {
      id, host: addr.address, port: addr.port, password, control: 'agent', inFlightAbort: new AbortController(),
      listener, tunnels,
    };
    this.sessions.set(owner, session);
    this.log(owner, 'shared-desktop.started', { port: addr.port });
    await this.showNotice(owner);
    return session;
  }
  /** Waits for the VNC server to answer inside the container, giving up the moment a stop calls the start off. */
  private async answering(owner: string, epoch: number, containerId: string): Promise<void> {
    for (const until = Date.now() + this.waitMs; Date.now() < until;) {
      if (this.calledOff(owner, epoch)) throw new Error(stoppedWhileStartingMessage);
      if (await this.probe(containerId, this.runner)) {
        if (this.calledOff(owner, epoch)) throw new Error(stoppedWhileStartingMessage);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
    }
    throw new Error(sandboxRefusal(`the desktop did not answer within ${Math.round(this.waitMs / 1000)} seconds.`));
  }
  /**
   * Creates a listener on 127.0.0.1:0 and spawns socat tunnels for each connection. It keeps accepting
   * while the owner holds the desktop (take-over closes only the tunnels already open): taking over
   * is so the owner can drive through a viewer, and the listener is loopback-only behind the password.
   */
  private async createListenerImpl(containerId: string, tunnels: Set<Tunnel>): Promise<NetServer> {
    return new Promise((resolve, reject) => {
      const listener = createServer((socket) => {
        const child = this.spawnerFn('docker', ['exec', '-i', containerId, 'socat', 'STDIO', 'TCP:127.0.0.1:5900']);
        const tunnel = { socket, child };
        tunnels.add(tunnel);

        socket.on('data', (data) => child.stdin?.write(data));
        child.stdout?.on('data', (data) => socket.write(data));
        child.stderr?.on('data', () => {}); // ignore stderr

        const cleanup = () => {
          child.kill();
          socket.destroy();
          tunnels.delete(tunnel);
        };
        socket.on('end', cleanup);
        socket.on('error', cleanup);
        child.on('exit', cleanup);
        child.on('error', cleanup);
      });
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => resolve(listener));
    });
  }
  /** Best-effort: a computer with nowhere to show a window (a headless server) still shares the
   * desktop over VNC, and the owner can still take it over from the Settings card. */
  private async showNotice(owner: string): Promise<void> {
    await this.banner.show(() => { void this.takeOver(owner).catch(() => undefined); }).catch(() => undefined);
  }
  /** Something done inside the shared desktop. Refused outright while the owner holds it. */
  async act(owner: string, action: SharedDesktopAction): Promise<{ ran: string }> {
    await this.allowed(owner);
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    if (session.control !== 'agent') throw new Error(takenOverMessage);
    const signal = session.inFlightAbort.signal;
    try {
      await this.runner('docker', dockerExecArgv(session.id, action), execTimeoutMs(action), signal);
    } catch (error) {
      // A take-over stopped it: the take-over's own pkill (which a hand-back waits for) covers it, and a
      // second, later one could end what the assistant starts after the hand-back.
      if (signal.aborted) throw new Error(takenOverMessage);
      // Kill any lingering xdotool to prevent double-typing on retry
      await this.runner('docker', dockerExecKillArgv(session.id), 5_000).catch(() => undefined);
      // Check if control changed while the action was running
      const current = this.sessions.get(owner);
      if (current?.control === 'user') throw new Error(takenOverMessage);
      throw error;
    }
    // Check control one more time after exec returns
    if (this.sessions.get(owner)?.control !== 'agent') throw new Error(takenOverMessage);
    this.log(owner, 'shared-desktop.action', { type: action.type });
    return { ran: action.type };
  }
  /** The owner has pressed "Take over": Branch lets go until the owner hands it back. */
  async takeOver(owner: string): Promise<void> {
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    // Set control to 'user' first so any in-flight or new actions fail with takenOverMessage
    session.control = 'user';
    // Abort any in-flight action and kill xdotool inside the container
    session.inFlightAbort.abort();
    // Close all open tunnels
    for (const tunnel of session.tunnels) {
      tunnel.socket.destroy();
      tunnel.child.kill();
    }
    session.tunnels.clear();
    const tail = (async () => {
      await this.runner('docker', dockerExecKillArgv(session.id), 5_000).catch(() => undefined); // exit code 1 if nothing was running is fine
      // Q96: a desktop stopped and started again meanwhile is not this one; its notice stays.
      if (this.sessions.get(owner) !== session || session.control !== 'user') return;
      this.log(owner, 'shared-desktop.taken-over', {});
      await this.banner.hide().catch(() => undefined); // taken over from Settings: the notice has done its job
    })();
    session.takingOver = tail;
    await tail;
  }
  /** The owner hands the desktop back (their Settings route only; no tool calls this). */
  async handBack(owner: string): Promise<void> {
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    if (session.control === 'agent') return;
    // Q96: a take-over still under way finishes first, so its late pkill cannot end what the assistant
    // starts next, and its hiding the notice cannot come after the one shown here.
    const waitedFor = session.takingOver;
    await waitedFor?.catch(() => undefined);
    const current = this.sessions.get(owner);
    if (current !== session) throw new Error(notRunningMessage);
    if (current.control === 'agent') return;
    // A Take over pressed while this waited is the owner's last word: it wins.
    if (current.takingOver !== waitedFor) return;
    session.control = 'agent';
    // Create a new AbortController since the old one was aborted on takeOver
    session.inFlightAbort = new AbortController();
    this.log(owner, 'shared-desktop.handed-back', {});
    await this.showNotice(owner); // so the owner can take it over again from the screen
  }
  /** Who holds it right now, for a caller that wants to ask rather than try and fail. */
  controlOf(owner: string): 'agent' | 'user' | 'none' {
    return this.sessions.get(owner)?.control ?? 'none';
  }
  status(owner: string): SharedDesktopStatus {
    return { ...this.settings(owner), running: this.sessions.has(owner), control: this.controlOf(owner) };
  }
  /** Get the viewer connection info (host, port, display, password) for the owner only. */
  async viewerInfo(owner: string): Promise<SharedDesktopInfo> {
    const session = this.sessions.get(owner);
    if (!session) throw new Error(notRunningMessage);
    return infoOf(session);
  }
  /** The Settings card's save: switching it off takes a running desktop down straight away. */
  async saveSettings(owner: string, input: unknown): Promise<SharedDesktopStatus> {
    const next = saveLinuxDesktop(this.store, owner, input);
    if (next.mode === 'off') await this.end(owner);
    return this.status(owner);
  }
  /** The assistant's stop. Refused while the owner holds the desktop: it is theirs until handed back. */
  async stop(owner: string): Promise<void> {
    if (this.sessions.get(owner)?.control === 'user') throw new Error(takenOverMessage);
    await this.end(owner);
  }
  /** Takes the desktop down whoever holds it, calling off a start under way. Never the assistant's. */
  end(owner: string): Promise<void> {
    const under = this.stopping.get(owner);
    if (under) return under;
    const job: Promise<void> = this.teardown(owner)
      .finally(() => { if (this.stopping.get(owner) === job) this.stopping.delete(owner); });
    this.stopping.set(owner, job);
    return job;
  }
  private async teardown(owner: string): Promise<void> {
    this.epochs.set(owner, this.epoch(owner) + 1);
    await this.starting.get(owner)?.catch(() => undefined); // it takes its own container down, or finishes
    const session = this.sessions.get(owner);
    if (!session) return;
    this.sessions.delete(owner);
    await this.banner.hide().catch(() => undefined);
    // Close all tunnels and the listener
    for (const tunnel of session.tunnels) {
      tunnel.socket.destroy();
      tunnel.child.kill();
    }
    session.tunnels.clear();
    if (session.listener) session.listener.close();
    await this.runner('docker', dockerStopArgv(session.id), 15_000).catch(() => undefined);
    this.log(owner, 'shared-desktop.stopped', {});
  }
  /** Stops every shared desktop this launch started, and every one still starting. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopListening();
    const owners = new Set([...this.sessions.keys(), ...this.starting.keys()]);
    await Promise.all([...owners].map((owner) => this.end(owner)));
  }
}
