import { FromEngineSchema, Link, type EngineConfig, type FromEngine } from "./engine-link.js";

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
  config: EngineConfig;
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

interface Running { child: EngineChild; link: Link; ready: boolean; exited: Promise<number> }

export class EngineHost {
  private current: Running | null = null;
  private stopping = false;
  private restarts = 0;
  private relaunch: NodeJS.Timeout | null = null;
  private key = "";
  /** The last count of working tasks the engine told (it says so when it changes). */
  lastRunning = 0;
  url = "";
  constructor(private readonly options: EngineHostOptions) {}

  /** The window's key as it is now; removing a phone that was handed it makes the engine replace it. */
  get token(): string { return this.key; }
  get pid(): number | undefined { return this.current?.child.pid; }
  /** True while the engine's process is up and has said it is ready. */
  get running(): boolean { return Boolean(this.current?.ready); }

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
    const ended = running.exited.then(() => true);
    if (running.ready) void running.link.call("stop", undefined, deadlineMs).catch(() => undefined);
    else running.child.kill();
    const done = await Promise.race([ended, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), deadlineMs).unref())]);
    if (!done) { running.child.kill(); await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000).unref())]); }
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

  private launch(): Promise<string> {
    const child = this.options.fork();
    const link = new Link((message) => child.postMessage(message));
    for (const [method, handler] of Object.entries(this.options.handlers)) link.handle(method, handler);
    let resolveExit!: (code: number) => void;
    const running: Running = { child, link, ready: false, exited: new Promise((resolve) => { resolveExit = resolve; }) };
    this.current = running;
    return new Promise<string>((resolve, reject) => {
      const late = setTimeout(() => { reject(new Error("The engine did not start in time.")); child.kill(); }, this.options.startMs ?? 180000);
      late.unref?.();
      child.on("message", (raw) => {
        const parsed = FromEngineSchema.safeParse(raw);
        if (!parsed.success) { this.options.log?.("Engine: a message of an unexpected shape was ignored"); return; }
        this.heard(running, parsed.data, (url) => { clearTimeout(late); resolve(url); }, (why) => { clearTimeout(late); reject(new Error(why)); });
      });
      child.on("exit", (code) => {
        clearTimeout(late);
        link.close();
        resolveExit(code);
        const wasReady = running.ready;
        running.ready = false;
        if (!wasReady) { reject(new Error(`The engine stopped while starting (code ${code}).`)); return; }
        if (running === this.current && !this.stopping) this.restart(code);
      });
      child.postMessage({ kind: "start", config: this.options.config });
    });
  }

  private heard(running: Running, message: FromEngine, ready: (url: string) => void, failed: (why: string) => void): void {
    if (message.kind === "ready") {
      running.ready = true;
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
