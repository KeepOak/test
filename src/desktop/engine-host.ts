import { FromEngineSchema, Link, engineContract, type EngineConfig, type FromEngine } from "./engine-link.js";
import type { HandOverResult } from "../hot-update/engine-handover.js";

/**
 * The window's main process side of the engine's own process (src/desktop/engine-process.ts). Main starts it, waits
 * for its address and key, answers what only main can do, and starts it again when it stops by itself. Main does
 * nothing else with it, so nothing the engine does can hold main up.
 */

/** The little of Electron's UtilityProcess this uses, so it can be checked with a stand-in. */
export interface EngineChild {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface EngineHostOptions {
  fork: () => EngineChild;
  /**
   * What the engine is started with, read again at every start: a model connection saved since the last start is used
   * when the engine starts again.
   */
  config: EngineConfig | (() => EngineConfig);
  /** What the engine may ask of main, by name. */
  handlers: Record<string, (args: unknown) => unknown>;
  /** The engine stopped by itself; it is being started again. */
  onGone?: (code: number) => void;
  /** The engine is back after stopping, at `url`. */
  onBack?: (url: string) => void;
  /** How long a start may take before it counts as failed. */
  startMs?: number;
  log?: (line: string) => void;
}

interface Running { child: EngineChild; link: Link; ready: boolean; url: string; exited: Promise<number> }
interface Waiter<T> { resolve: (value: T) => void; reject: (error: Error) => void }
type Loaded = { contract: number; commit: string | null };
interface Spawned { running: Running; loaded: Promise<Loaded>; waiters: { loaded?: Waiter<Loaded>; ready?: Waiter<string> } }

/** hot-update: how a newer engine takes over (EngineHost.handOver). */
export interface HandOverPlan {
  /** Starts the newer engine's process from its own code, which was checked before this is called. */
  fork: () => EngineChild;
  /** The change the new engine must say it was built from; left out, any. */
  commit?: string | null;
  loadMs?: number;
  drainMs?: number;
  settleMs?: number;
  stopMs?: number;
  /** Throws when the new engine, up at the window's address, is not well; it is then rolled back. */
  check?: (url: string) => Promise<void>;
  /** What the new engine is started with besides the app's own settings. */
  config?: Partial<EngineConfig>;
  /** Told when the old engine has let go and the new one is starting, for the status line. */
  onSwitch?: () => void;
}
export interface HandOverOutcome {
  ok: boolean;
  ms: number;
  handedOver: string[];
  drained: boolean;
  rolledBack: boolean;
  why: string | null;
}

export class EngineHost {
  private current: Running | null = null;
  private stopping = false;
  /** hot-update: a newer engine is taking over; the old one's end is not a stop to recover from. */
  private swapping = false;
  private restarts = 0;
  private relaunch: NodeJS.Timeout | null = null;
  private key = "";
  /** The last count of working tasks the engine told (it says so when it changes). */
  lastRunning = 0;
  url = "";
  /** How the engine is started: the app's own, or the newer one that took over (a later restart starts that one). */
  private fork: () => EngineChild;
  constructor(private readonly options: EngineHostOptions) { this.fork = options.fork; }

  /** The window's key as it is now; removing a phone that was handed it makes the engine replace it. */
  get token(): string { return this.key; }
  get pid(): number | undefined { return this.current?.child.pid; }
  /** True while the engine's process is up and has said it is ready. */
  get running(): boolean { return Boolean(this.current?.ready); }
  /**
   * The address the engine is answering at right now; null while it is starting or stopped. While a newer engine takes
   * over it stays the window's address: the window's requests wait for the new engine there (its gate proves it first).
   */
  get servingAt(): string | null { return this.current?.ready ? this.current.url : this.swapping ? this.url : null; }
  /** hot-update: true while a newer engine takes over. */
  get handingOver(): boolean { return this.swapping; }

  /** Starts the engine and resolves with its address once it answers. */
  async start(): Promise<string> {
    const started = this.launch();
    const url = await started;
    this.url = url;
    return url;
  }

  /** Asks the engine; refused when it is not running or does not answer in time. */
  call<T = unknown>(method: string, args?: unknown, timeoutMs?: number): Promise<T> {
    const running = this.current;
    if (!running?.ready) return Promise.reject(new Error("The engine is not running"));
    return running.link.call<T>(method, args, timeoutMs);
  }

  /** Tells the engine something it needs no answer to (a Stop notice closing). */
  tell(name: string, args?: unknown): void {
    try { this.current?.child.postMessage({ kind: "event", name, ...(args === undefined ? {} : { args }) }); } catch { /* gone */ }
  }

  /** Stops the engine: it closes its server and database; after `deadlineMs` it is ended instead. */
  async stop(deadlineMs = 7000): Promise<void> {
    this.stopping = true;
    if (this.relaunch) clearTimeout(this.relaunch);
    const running = this.current;
    if (!running) return;
    await this.close(running, deadlineMs);
  }

  /** Ends the engine at once (the app is exiting) and resolves once it has gone, or after `waitMs` at most. */
  async end(waitMs: number): Promise<void> {
    this.stopping = true;
    if (this.relaunch) clearTimeout(this.relaunch);
    const running = this.current;
    if (!running) return;
    running.child.kill();
    await Promise.race([running.exited, new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
  }

  /**
   * hot-update: a newer engine takes over from the one running, with the window's address unchanged.
   *
   * The new engine starts beside the old one and loads its code, holding nothing. Only once it says it speaks this app's
   * messages (and is the change that was checked) does the old one drain and checkpoint its tasks
   * (src/hot-update/engine-handover.ts) and close, which lets go of the database. The new one then opens it and listens
   * at exactly the old port; the window's requests wait meanwhile. When the new engine does not come up there, or fails
   * its check, it is ended and the engine that was running before is started again (rolled back), which carries the
   * handed-over tasks on instead. Nothing is done by both: the old engine has closed the database before the new one
   * opens it, and the database itself refuses a second process (src/store.ts, locking_mode=EXCLUSIVE).
   */
  async handOver(plan: HandOverPlan): Promise<HandOverOutcome> {
    const old = this.current;
    if (!old?.ready || this.swapping || this.stopping) throw new Error("The engine is not running, so it cannot be handed over.");
    const started = Date.now();
    const port = Number(new URL(this.url).port);
    const next = this.spawn(plan.fork);
    try {
      const loaded = await within(next.loaded, plan.loadMs ?? 60_000, "The new engine did not load in time.");
      if (loaded.contract !== engineContract) throw new Error("The new engine speaks another version of the app's messages.");
      if (plan.commit !== undefined && loaded.commit !== plan.commit) throw new Error("The new engine is not the change that was checked.");
    } catch (error) {
      next.running.child.kill();
      throw error;
    }
    this.swapping = true;
    const drainMs = plan.drainMs ?? 120_000, settleMs = plan.settleMs ?? 60_000;
    let handed: HandOverResult = { drained: false, handedOver: [], stillWorking: [], ms: 0 };
    try { handed = await old.link.call<HandOverResult>("hand-over", { drainMs, settleMs }, drainMs + settleMs + 30_000); }
    catch (error) { this.options.log?.(`Engine: the old engine did not hand over its work (${message(error)}); it is closed as for a restart.`); }
    await this.close(old, plan.stopMs ?? 15_000);
    this.departed(plan.onSwitch);
    this.current = next.running;
    try {
      const url = await this.begin(next, { ...plan.config, port, holdHandedOver: true });
      if (url !== this.url) throw new Error("The new engine could not listen at the window's address.");
      await plan.check?.(url);
      this.fork = plan.fork;
      this.swapping = false;
      // Only an engine that passed its check carries the handed-over tasks on; one rolled back never touched them.
      await next.running.link.call("carry-on", undefined, 30_000).catch((error: unknown) => this.options.log?.(`Engine: the handed-over tasks did not carry on yet (${message(error)}); the next start carries them on.`));
      return { ok: true, ms: Date.now() - started, handedOver: handed.handedOver, drained: handed.drained, rolledBack: false, why: null };
    } catch (error) {
      return this.rollBack(next.running, port, message(error), handed, started, plan.onSwitch);
    }
  }

  /** The new engine failed: it is ended and the engine that ran before starts again at the same address. */
  private async rollBack(failed: Running, port: number, why: string, handed: HandOverResult, started: number, onSwitch?: () => void): Promise<HandOverOutcome> {
    this.options.log?.(`Engine: the new engine failed (${why}); the one this app was started with is started again.`);
    await this.close(failed, 5000);
    this.departed(onSwitch);
    const back = this.spawn(this.fork);
    this.current = back.running;
    try { await this.begin(back, { port }); }
    catch (again) {
      this.swapping = false;
      this.restart(-1);
      throw new Error(`The new engine failed (${why}), and the engine this app was started with could not start again at once (${message(again)}); it keeps trying.`);
    }
    this.swapping = false;
    return { ok: false, ms: Date.now() - started, handedOver: handed.handedOver, drained: handed.drained, rolledBack: true, why };
  }

  private departed(reset?: () => void): void {
    try { reset?.(); }
    catch (error) { this.options.log?.(`Engine: departure cleanup failed (${message(error)}).`); }
  }

  /** Closes one engine: it closes its server and database, and is ended when it takes longer than `deadlineMs`. */
  private async close(running: Running, deadlineMs: number): Promise<void> {
    const ended = running.exited.then(() => true);
    if (running.ready) void running.link.call("stop", undefined, deadlineMs).catch(() => undefined);
    else running.child.kill();
    const done = await Promise.race([ended, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deadlineMs).unref())]);
    if (!done) { running.child.kill(); await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000).unref())]); }
  }

  private launch(): Promise<string> {
    const spawned = this.spawn(this.fork);
    this.current = spawned.running;
    return this.begin(spawned);
  }

  /** Starts an engine's process and listens to it; nothing is asked of it yet (it loads its code and waits). */
  private spawn(fork: () => EngineChild): Spawned {
    const child = fork();
    const link = new Link((message) => child.postMessage(message));
    for (const [method, handler] of Object.entries(this.options.handlers)) link.handle(method, handler);
    let resolveExit!: (code: number) => void;
    const running: Running = { child, link, ready: false, url: "", exited: new Promise((resolve) => { resolveExit = resolve; }) };
    const waiters: Spawned["waiters"] = {};
    const loaded = new Promise<Loaded>((resolve, reject) => { waiters.loaded = { resolve, reject }; });
    loaded.catch(() => undefined);
    child.on("message", (raw) => {
      const parsed = FromEngineSchema.safeParse(raw);
      if (!parsed.success) { this.options.log?.("Engine: a message of an unexpected shape was ignored"); return; }
      if (parsed.data.kind === "loaded") { waiters.loaded?.resolve({ contract: parsed.data.contract, commit: parsed.data.commit }); return; }
      this.heard(running, parsed.data, (url) => waiters.ready?.resolve(url), (why) => waiters.ready?.reject(new Error(why)));
    });
    child.on("exit", (code) => {
      link.close();
      resolveExit(code);
      const wasReady = running.ready;
      running.ready = false;
      waiters.loaded?.reject(new Error(`The engine stopped while loading (code ${code}).`));
      if (!wasReady) { waiters.ready?.reject(new Error(`The engine stopped while starting (code ${code}).`)); return; }
      if (running === this.current && !this.stopping && !this.swapping) this.restart(code);
    });
    return { running, loaded, waiters };
  }

  /** Asks a spawned engine to start, and resolves with its address once it answers. */
  private begin(spawned: Spawned, extra: Partial<EngineConfig> = {}): Promise<string> {
    const { running } = spawned;
    return new Promise<string>((resolve, reject) => {
      const late = setTimeout(() => { reject(new Error("The engine did not start in time.")); running.child.kill(); }, this.options.startMs ?? 180000);
      late.unref?.();
      spawned.waiters.ready = { resolve: (url) => { clearTimeout(late); resolve(url); }, reject: (error) => { clearTimeout(late); reject(error); } };
      const config = typeof this.options.config === "function" ? this.options.config() : this.options.config;
      running.child.postMessage({ kind: "start", config: { ...config, ...extra } });
    });
  }

  private heard(running: Running, message: FromEngine, ready: (url: string) => void, failed: (why: string) => void): void {
    if (message.kind === "ready") {
      running.ready = true;
      running.url = message.url;
      this.key = message.token;
      ready(message.url);
    } else if (message.kind === "key") this.key = message.token;
    else if (message.kind === "failed") failed(message.message);
    else if (message.kind === "event" && message.name === "running" && Number.isInteger(message.args)) this.lastRunning = message.args as number;
    else if (message.kind === "call" || message.kind === "reply") running.link.receive(message);
  }

  /** The engine stopped by itself: it is started again, waiting longer after each stop in a row. */
  private restart(code: number): void {
    this.options.onGone?.(code);
    const wait = Math.min(30000, 500 * 2 ** Math.min(this.restarts, 6));
    this.restarts++;
    this.options.log?.(`Engine stopped (code ${code}); starting it again in ${wait} ms`);
    this.relaunch = setTimeout(() => {
      this.relaunch = null;
      if (this.stopping) return;
      this.launch().then((url) => {
        // Up for a minute counts as well again, so the next stop is retried quickly.
        setTimeout(() => { if (this.current?.ready) this.restarts = 0; }, 60000).unref();
        this.options.onBack?.(url);
      }, (error: Error) => {
        this.options.log?.(`Engine could not start again: ${error.message}`);
        if (!this.stopping && !this.relaunch) this.restart(-1);
      });
    }, wait);
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function within<T>(promise: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(why)), ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: Error) => { clearTimeout(timer); reject(error); });
  });
}
