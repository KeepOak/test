import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { clearRunning, sessionTokenFileName, writeRunning } from "../install/running.js";
import { answerHeader, answerProof, answerShort, askHeader, atWindowAddress, isSessionKey, markFor, newBoot, ProofDoor, proofPath, sessionKey } from "../engine-proof.js";
import { contractsMeet, gatewayContract, WorkerReadySchema, type WorkerReady } from "./contract.js";
import { loadGatewayConfig, promoteGood, restoreGood, sameAsGood, type GatewayConfig } from "./gateway-config.js";
import { clearCrashes, markExited, markRunning, recordCrash } from "./gateway-state.js";
import { clearWatch, readWatch, repairSwap, watchVerdict, type UpdateWatch } from "./canary.js";
import { runAsNode } from "../child-env.js";
import { previewRequest } from "./gateway-preview.js";
import { quitPath, quitRequest } from "../install/quit.js";
import { EngineWatchdog, engineAnswers, watchdogDefaults } from "./engine-watchdog.js";
import { gatewayResources } from "./gateway-resources.js";

/**
 * The gateway: a small process that keeps Branch's public address open and keeps one worker — the
 * whole engine — running behind it. It holds no database, no model and no tool, so nothing a task
 * does can take it down. A worker that crashes is replaced; a request that arrives while it is being
 * replaced waits a little and is then told, in a sentence, to try again. See docs/never-break.md.
 */
export type WorkerState = "starting" | "checking" | "ready" | "stopped" | "waiting";
export interface GatewayNote { at: string; text: string }
/** The worker lifecycle used by the gateway, whether a Node child or a retained desktop engine host. */
export interface GatewayChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly connected: boolean;
  send(message: object, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export interface GatewayOptions {
  dataDir: string;
  /** The engine's start script and the arguments that start it. */
  script: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  port: number;
  /** Write the "already running here" note, so the app window joins this gateway. */
  presence?: boolean;
  version: string;
  /** Starts a worker; tests hand in a fixture. */
  spawn?: (script: string, args: string[], env: NodeJS.ProcessEnv) => GatewayChild;
  /** How long a worker must stay up before its settings count as good and its crash chain is cleared. */
  settleMs?: number;
  /** Puts the previous version back after an update that does not stay up; the gateway stops afterwards. */
  rollBack?: (watch: UpdateWatch) => Promise<void>;
  /** Told about every worker that says it is ready, and every crash. */
  onWorker?: (event: { kind: "ready"; ready: WorkerReady } | { kind: "crash"; code: number | null; signal: string | null; tripped: boolean; why?: string }) => void;
  /** Retained desktop broker only: act after a successful owner OFF response has finished. */
  onOwnerOff?: () => void;
  /**
   * QA retest 2026-09-28 (m15): what `branch quit` does to this gateway. The engine behind it has no quit of its own, so
   * the request used to be refused there and `branch quit` fell back to ending the process from outside (exit code 1).
   */
  quit?: () => void;
  /**
   * Owner's PC 2026-09-29: how the gateway watches a ready engine's own address (src/never-break/engine-watchdog.ts), or
   * false for none. An engine that answers nothing for `unresponsiveMs` is ended and started again, and the reason kept.
   */
  watchdog?: false | { everyMs?: number; timeoutMs?: number; unresponsiveMs?: number };
}

/** The engine, through this same runtime, with a message channel and no window on Windows. */
const defaultSpawn = (script: string, args: string[], env: NodeJS.ProcessEnv): GatewayChild =>
  spawn(process.execPath, [script, ...args], { env: { ...env, ...runAsNode(process.execPath) }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });

interface Worker { child: GatewayChild; state: WorkerState; port: number | null; ready: WorkerReady | null; startedAt: number; endedBecause?: string }

/** Bump for any resident field, private-brand, or callback invariant change; such changes require a packaged restart. */
export const gatewayCodeContract = 1;

export class Gateway {
  private codeVersion: string;
  private server: Server | null = null;
  private worker: Worker | null = null;
  private config!: GatewayConfig;
  private stopping = false;
  private failedStarts = 0;
  private tripped = false;
  private relaunch: NodeJS.Timeout | null = null;
  private settle: NodeJS.Timeout | null = null;
  /** An update being watched in its first minutes, from `update-watch.json`. */
  private watch: UpdateWatch | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private readonly waiters = new Map<(port: number | null) => void, boolean>();
  /** This gateway's process, for the desktop window's proof, session key and marks (src/engine-proof.ts). */
  private readonly boot = newBoot();
  /** How many keyless proofs are answered, and how many window connections are held open. */
  private readonly proofDoor = new ProofDoor();
  /** The address of a worker that refused a connection, so it is not tried again before it is replaced. */
  private deadPort: number | null = null;
  /** Connections carried through as upgrades, closed when the gateway stops. */
  private readonly tunnels = new Set<Duplex>();
  /** Asks the ready engine's own address on a timer; armed only while the worker is ready. */
  private watchdog: EngineWatchdog | null = null;
  readonly notes: GatewayNote[] = [];
  restarts = 0;
  url = "";
  constructor(private readonly options: GatewayOptions) { this.codeVersion = options.version; }

  /** Only the checked resident-code adopter changes the version, without rebuilding process-owned state. */
  useCodeVersion(version: string): string {
    const previous = this.codeVersion;
    this.codeVersion = version;
    return previous;
  }

  note(text: string): void {
    this.notes.push({ at: new Date().toISOString(), text });
    if (this.notes.length > 50) this.notes.shift();
  }

  async start(): Promise<string> {
    const loaded = await loadGatewayConfig(this.options.dataDir);
    this.config = loaded.config;
    if (loaded.problem) this.note(loaded.problem);
    await this.readUpdateWatch();
    const previous = await markRunning(this.options.dataDir);
    if (previous.uncleanBefore) this.note("Branch did not close properly last time; interrupted work is picked up again.");
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.on("upgrade", (request, socket, head) => { void this.upgrade(request, socket, head); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("The gateway could not open its address.");
    this.url = `http://127.0.0.1:${address.port}`;
    if (this.options.presence)
      await writeRunning(this.options.dataDir, { port: address.port, pid: process.pid, url: this.url, mode: "daemon", version: this.codeVersion }).catch(() => undefined);
    this.launch();
    return this.url;
  }

  /** What the gateway can say about itself without asking the worker. */
  health(): Record<string, unknown> {
    const worker = this.worker;
    return { ok: worker?.state === "ready", gateway: { pid: process.pid, version: this.codeVersion, contract: gatewayContract.speaks },
      worker: { state: worker?.state ?? "stopped", pid: worker?.child.pid ?? null, version: worker?.ready?.version ?? null },
      restarts: this.restarts, slowedDown: this.tripped, notes: this.notes.slice(-10), resources: gatewayResources() };
  }

  /* ---------- the worker ---------- */

  private launch(): void {
    if (this.stopping) return;
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), ...this.config.workerEnv,
      BRANCH_DATA_DIR: this.options.dataDir, BRANCH_PORT: "0", BRANCH_GATEWAY_CHILD: "1",
      BRANCH_GATEWAY_CONTRACT: `${gatewayContract.speaks}:${gatewayContract.accepts.join("-")}`,
      // A worker that keeps crashing must not carry the same work on by itself and crash again.
      ...(this.tripped ? { BRANCH_RESUME: "ask" } : {}) };
    const child = (this.options.spawn ?? defaultSpawn)(this.options.script, this.options.args ?? ["start"], env);
    const worker: Worker = { child, state: "starting", port: null, ready: null, startedAt: Date.now() };
    this.worker = worker;
    const late = setTimeout(() => {
      if (worker.state !== "starting") return;
      this.note(`The engine did not say it was ready within ${this.config.startSeconds} seconds, so it was stopped and started again.`);
      child.kill("SIGKILL");
    }, this.config.startSeconds * 1000);
    child.on("message", (message) => this.heard(worker, message));
    child.once("error", () => undefined);
    child.once("exit", (code, signal) => { clearTimeout(late); void this.exited(worker, code, signal); });
  }

  private heard(worker: Worker, message: unknown): void {
    if (worker === this.worker && (message as { type?: unknown } | null)?.type === "checking") {
      worker.state = "checking"; worker.port = null;
      this.watchdog?.disarm();
      if (this.settle) clearTimeout(this.settle);
      return;
    }
    const ready = WorkerReadySchema.safeParse(message);
    if (!ready.success || worker !== this.worker) return;
    if (!contractsMeet(gatewayContract, { speaks: ready.data.contract, accepts: ready.data.accepts })) {
      this.note(`The engine (version ${ready.data.version}) speaks a gateway language this gateway cannot read, so it was stopped.`);
      worker.child.kill("SIGKILL");
      return;
    }
    Object.assign(worker, { state: ready.data.provisional ? "checking" : "ready", port: ready.data.port, ready: ready.data });
    this.deadPort = null;
    this.failedStarts = 0;
    for (const [wake, preview] of this.waiters) if (!ready.data.provisional || preview) wake(ready.data.port);
    if (ready.data.provisional) { this.watchdog?.disarm(); return; }
    this.watchWorker(worker, ready.data.port);
    this.options.onWorker?.({ kind: "ready", ready: ready.data });
    void this.checkWatch();
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => { void this.settled(worker); }, this.options.settleMs ?? 30_000);
  }

  private async settled(worker: Worker): Promise<void> {
    if (worker !== this.worker || worker.state !== "ready") return;
    this.tripped = false;
    await clearCrashes(this.options.dataDir);
    await promoteGood(this.options.dataDir, this.config).catch(() => undefined);
  }

  private async exited(worker: Worker, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const wasReady = worker.state === "ready";
    worker.state = "stopped";
    if (worker === this.worker) this.watchdog?.disarm();
    if (this.settle) clearTimeout(this.settle);
    if (this.stopping || worker !== this.worker) return;
    // selfdev: exit code 75 is the engine restarting itself on request (Restart the engine, branch.restart_engine), not
    // a crash: it is started again at once and never counted toward slowing down or putting the previous version back.
    if (code === 75 && wasReady) {
      this.note("The engine restarted itself on request.");
      worker.state = "waiting";
      this.relaunch = setTimeout(() => { this.relaunch = null; this.launch(); }, 0);
      return;
    }
    this.restarts++;
    const verdict = await recordCrash(this.options.dataDir, this.config);
    this.tripped = this.tripped || verdict.tripped;
    this.options.onWorker?.({ kind: "crash", code, signal, tripped: verdict.tripped, ...(worker.endedBecause ? { why: worker.endedBecause } : {}) });
    if (!worker.endedBecause) this.note(`The engine stopped unexpectedly (${signal ?? `code ${code}`}); starting it again${verdict.delayMs ? ` in ${Math.round(verdict.delayMs / 1000)} seconds` : ""}.`);
    const failing = verdict.tripped || (!wasReady && this.failedStarts >= 1);
    if (await this.maybeRollBack(failing)) return;
    if (!wasReady) await this.startFailed();
    worker.state = "waiting";
    this.relaunch = setTimeout(() => { this.relaunch = null; this.launch(); }, verdict.delayMs);
  }

  /**
   * Owner's PC 2026-09-29: an engine that is up but answers nothing is ended, so it is started again like any engine that
   * stopped, and the reason goes with its crash record. An answer also lets go of its address if a refused connection
   * had marked it dead, since only a new engine's ready message cleared that before.
   */
  private watchWorker(worker: Worker, port: number): void {
    this.watchdog?.disarm();
    const settings = this.options.watchdog;
    if (settings === false) return;
    const timeoutMs = settings?.timeoutMs ?? watchdogDefaults.timeoutMs;
    this.watchdog = new EngineWatchdog({
      ...(settings?.everyMs ? { everyMs: settings.everyMs } : {}),
      ...(settings?.unresponsiveMs ? { unresponsiveMs: settings.unresponsiveMs } : {}),
      probe: () => engineAnswers(port, timeoutMs),
      onAnswer: () => {
        if (this.deadPort !== port) return;
        this.deadPort = null;
        for (const wake of this.waiters.keys()) wake(port);
      },
      onUnresponsive: (silentMs) => {
        if (worker !== this.worker || worker.state !== "ready" || this.stopping) return;
        worker.endedBecause = `The engine did not answer for ${Math.round(silentMs / 1000)} seconds, so it was stopped and started again.`;
        this.note(worker.endedBecause);
        worker.child.kill("SIGKILL");
      },
    });
    this.watchdog.arm();
  }

  /** Two failed starts in a row with settings that were never known to work: put the good ones back. */
  private async startFailed(): Promise<void> {
    this.failedStarts++;
    if (this.failedStarts < 2 || (await sameAsGood(this.options.dataDir, this.config))) return;
    const restored = await restoreGood(this.options.dataDir, "The engine would not start with the new gateway settings",
      // What is on disk now, not what this gateway read at start: the owner may have changed the switch since.
      (await loadGatewayConfig(this.options.dataDir)).config);
    if (!restored.restored) return;
    this.config = restored.config;
    this.failedStarts = 0;
    this.note(restored.problem ?? "The last settings that worked were put back.");
  }

  /* ---------- the first minutes after an update ---------- */

  private async readUpdateWatch(): Promise<void> {
    this.watch = await readWatch(this.options.dataDir);
    if (!this.watch || this.watch.platform === "win32") return;
    for (const line of await repairSwap(this.watch.target).catch(() => [])) this.note(line);
  }

  private async checkWatch(): Promise<void> {
    const watch = this.watch;
    const verdict = watchVerdict(watch, { now: Date.now(), watchSeconds: this.config.watchSeconds,
      runningVersion: this.worker?.ready?.version ?? null, failing: false });
    if (!watch || verdict === "roll-back") return;
    if (verdict === "watching") {
      if (this.watchTimer) clearTimeout(this.watchTimer);
      const left = Date.parse(watch.startedAt) + this.config.watchSeconds * 1000 - Date.now();
      this.watchTimer = setTimeout(() => { void this.checkWatch(); }, Math.max(50, left + 50));
      return;
    }
    this.watch = null;
    await clearWatch(this.options.dataDir).catch(() => undefined);
    if (verdict === "done") this.note(`The update to version ${watch.to} is done: it stayed up through its first minutes.`);
  }

  /** A new version that keeps failing in its first minutes is swapped back for the previous one. */
  private async maybeRollBack(failing: boolean): Promise<boolean> {
    const watch = this.watch;
    if (watchVerdict(watch, { now: Date.now(), watchSeconds: this.config.watchSeconds,
      runningVersion: this.worker?.ready?.version ?? null, failing }) !== "roll-back" || !watch) return false;
    this.watch = null;
    await clearWatch(this.options.dataDir).catch(() => undefined);
    this.note(`Version ${watch.to} did not stay up after the update, so version ${watch.from} is being put back.`);
    if (!this.options.rollBack) return false;
    try { await this.options.rollBack(watch); return true; }
    catch (error) { this.note(`The previous version could not be put back: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }

  private waitForWorker(ms: number, preview = false): Promise<number | null> {
    if ((this.worker?.state === "ready" || preview && this.worker?.state === "checking") && this.worker.port && this.worker.port !== this.deadPort) return Promise.resolve(this.worker.port);
    if (this.stopping || ms <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (port: number | null) => { clearTimeout(timer); this.waiters.delete(done); resolve(port); };
      const timer = setTimeout(() => done(null), ms);
      this.waiters.set(done, preview);
    });
  }

  /* ---------- requests ---------- */

  /** Only this computer's own address, exactly as the engine itself insists. */
  private hostOk(request: IncomingMessage): boolean {
    const own = new URL(this.url).host;
    const origin = request.headers.origin;
    return request.headers.host === own && (!origin || origin === `http://${own}`);
  }
  private forwardedHeaders(request: IncomingMessage, port: number): Record<string, string | string[] | undefined> {
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: `127.0.0.1:${port}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    // The desktop window's session key is for this gateway's process: the worker is handed the window key it stands for.
    const key = this.windowKey();
    const supplied = /^Bearer (\S+)$/.exec(String(headers.authorization ?? ""))?.[1] ?? "";
    if (key && isSessionKey(supplied, key, this.boot)) headers.authorization = `Bearer ${key}`;
    delete headers[askHeader]; // marked here, where the window's port is, not by the worker
    return headers;
  }

  /** The window's key, read where it is used: removing a phone that was handed it makes a new one. */
  private windowKey(): string | null {
    try {
      const key = readFileSync(join(this.options.dataDir, sessionTokenFileName), "utf8").trim();
      return /^[a-f0-9]{64}$/.test(key) ? key : null;
    } catch { return null; }
  }

  /** The mark the desktop window asked for on this request's answer, made for this gateway's process and port. */
  private markOf(request: IncomingMessage): string | null {
    const key = this.windowKey();
    if (!key) return null;
    return markFor(request.headers[askHeader], sessionKey(key, this.boot), { port: request.socket?.localPort, address: request.socket?.localAddress }, this.boot);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.hostOk(request)) return plain(response, 403, "Host rejected");
    const path = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && path === "/gateway/health") return json(response, 200, this.health());
    // The gateway holds the window's address, so it is what proves itself there (src/engine-proof.ts), as the engine does.
    if (request.method === "GET" && path === proofPath) return this.proof(request, response);
    // `branch quit` closes the gateway itself (the engine goes with it), with the same checks the engine makes.
    if (path === quitPath && this.options.quit) {
      try { return json(response, 200, await quitRequest(request, { dataDir: this.options.dataDir, quit: this.options.quit })); }
      catch (error) { return json(response, request.method === "POST" ? 403 : 405, { error: error instanceof Error ? error.message : String(error) }); }
    }
    await this.forward(request, response, path ?? "/", true);
  }

  /** The proof, and with `hold` the connection kept open after it, so the window learns the moment the gateway stops. */
  private proof(request: IncomingMessage, response: ServerResponse): void {
    const key = this.windowKey();
    const search = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const local = { port: request.socket?.localPort, address: request.socket?.localAddress };
    // Held open only for the desktop window, on the connection it has just proved, with its session key.
    if (search.get("hold") === "1") {
      const supplied = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
      if (!key || atWindowAddress(local) === null || !isSessionKey(supplied, key, this.boot)) return plain(response, 404, "Not found");
      if (!this.proofDoor.hold(response)) answerShort(response, 429, { error: "Too many held connections." });
      return;
    }
    if (!this.proofDoor.mayAnswer()) return answerShort(response, 429, { error: "Too many questions; ask again in a moment." });
    const answer = key ? answerProof(search, key, local, this.boot) : null;
    if (!answer) return plain(response, 404, "Not found");
    answerShort(response, 200, answer);
  }

  /**
   * Passes one request to the worker. A worker that has just died refuses the connection before its
   * exit is noticed; a request with no body is then held for the next worker rather than failed.
   */
  private async forward(request: IncomingMessage, response: ServerResponse, path: string, retry: boolean, fresh = false): Promise<void> {
    const port = await this.waitForWorker(this.config.holdSeconds * 1000, previewRequest(request.method, path));
    if (port === null) return json(response, 503, { error: "Branch is starting its engine again. Try again in a moment." });
    const closing = request.method === "POST" && path === "/api/deployment/close";
    const mark = this.markOf(request);
    const upstream = httpRequest({ host: "127.0.0.1", port, method: request.method, path: request.url,
      headers: this.forwardedHeaders(request, port), ...(fresh ? { agent: false } : {}) }, (reply) => {
      const headers = { ...reply.headers };
      delete headers[answerHeader];
      if (mark) headers[answerHeader] = mark;
      response.writeHead(reply.statusCode ?? 502, headers);
      reply.pipe(response);
      if (this.options.onOwnerOff && request.method === "POST" && path === "/api/never-break" && (reply.statusCode ?? 500) < 300)
        response.once("finish", () => { void loadGatewayConfig(this.options.dataDir).then(({ config }) => {
          if (config.mode === "off") this.options.onOwnerOff?.();
        }).catch(() => undefined); });
      if (closing && (reply.statusCode ?? 500) < 300) reply.once("end", () => { if (this.options.quit) this.options.quit(); else void this.stop(); });
    });
    upstream.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      if (retry && ["ECONNREFUSED", "ECONNRESET"].includes(code) && !response.headersSent && !hasBody(request)) {
        // A reset on a reused connection is most often a kept-alive connection the engine closed just as it was reused, by
        // an engine that is still up: it is asked again on a fresh connection, and its address is not marked dead for it
        // (owner's PC 2026-09-29: one reset held every request for hours, since only a new engine's ready message cleared
        // the mark). A refusal, or a reset of a fresh connection, means the engine has gone: the request waits for the next
        // one, and the watchdog lets go of the mark if this engine answers after all.
        if (code === "ECONNRESET" && !fresh) return void this.forward(request, response, path, true, true);
        this.deadPort = port;
        return void this.forward(request, response, path, false);
      }
      if (!response.headersSent) json(response, 503, { error: "Branch's engine stopped while answering. Try again in a moment." });
      else response.destroy();
    });
    if (hasBody(request)) request.pipe(upstream);
    else upstream.end();
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    if (!this.hostOk(request)) return void socket.destroy();
    const port = await this.waitForWorker(this.config.holdSeconds * 1000);
    if (port === null) return void socket.destroy();
    const mark = this.markOf(request);
    const upstream = connect(port, "127.0.0.1", () => {
      const lines = Object.entries(this.forwardedHeaders(request, port))
        .flatMap(([name, value]) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((one) => `${name}: ${one}`));
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      if (mark) markHandshake(upstream, socket, mark);
      else upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.tunnels.add(socket);
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => { upstream.destroy(); this.tunnels.delete(socket); });
  }

  /* ---------- stopping ---------- */

  /** Stable entry used by the retained owner's release wrapper, even after implementation replacement. */
  stop(): Promise<void> { return this.stopRetained(); }

  async stopRetained(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.relaunch) clearTimeout(this.relaunch);
    if (this.settle) clearTimeout(this.settle);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchdog?.disarm();
    for (const wake of this.waiters.keys()) wake(null);
    for (const socket of this.tunnels) socket.destroy();
    await this.stopWorker();
    await new Promise<void>((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); this.server.closeAllConnections(); });
    if (this.options.presence) await clearRunning(this.options.dataDir).catch(() => undefined);
    await markExited(this.options.dataDir);
  }

  private async stopWorker(): Promise<void> {
    const child = this.worker?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const within = (ms: number) => Promise.race([gone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    if (child.connected) child.send({ type: "stop" }, () => undefined);
    if (await within(15_000)) return;
    child.kill("SIGTERM");
    if (await within(5_000)) return;
    child.kill("SIGKILL");
    await within(5_000);
  }
}

/**
 * The worker's answer to a socket's opening, passed on with the gateway's mark added to its headers (the window's
 * mark is made here, where its port is), then everything after it as it comes.
 */
function markHandshake(upstream: Duplex, socket: Duplex, mark: string): void {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) { if (head.length > 16384) socket.destroy(); return; }
    upstream.off("data", onData);
    const lines = head.subarray(0, end).toString("latin1").split("\r\n").filter((line) => !line.toLowerCase().startsWith(`${answerHeader}:`));
    socket.write(Buffer.concat([Buffer.from(`${[...lines, `${answerHeader}: ${mark}`].join("\r\n")}\r\n\r\n`, "latin1"), head.subarray(end + 4)]));
    upstream.pipe(socket);
  };
  upstream.on("data", onData);
}

const hasBody = (request: IncomingMessage): boolean =>
  request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) > 0;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function plain(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}
