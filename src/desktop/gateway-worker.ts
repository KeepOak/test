import { EventEmitter } from "node:events";
import { gatewayContract, GatewayMessageSchema } from "../never-break/contract.js";
import type { GatewayChild } from "../never-break/gateway.js";
import type { EngineHost } from "./engine-host.js";

export type GatewayEngine = Pick<EngineHost, "pid" | "running" | "start" | "stop" | "end">;
export interface DesktopWorkerOptions {
  /** Reads the current encrypted desktop settings and creates an engine with the retained broker. */
  create: (gone: (code: number) => void) => Promise<GatewayEngine>;
  version: string;
  closeBroker: () => void;
}

/** Lets the existing gateway own a desktop EngineHost, retaining Electron services without a shell window. */
export class DesktopGatewayWorker extends EventEmitter implements GatewayChild {
  private host: GatewayEngine | null = null;
  private stopping = false;
  private url = "";
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  get pid(): number | undefined { return this.host?.pid; }

  constructor(private readonly options: DesktopWorkerOptions) {
    super();
    void this.begin().catch((error: unknown) => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      void this.finish(1, null);
    });
  }

  private async begin(): Promise<void> {
    this.host = await this.options.create((code) => { void this.finish(code, null); });
    if (this.stopping) { await this.host.end(7000); this.options.closeBroker(); return; }
    const url = await this.host.start();
    if (this.stopping) return;
    this.url = url;
    this.updated(this.options.version);
  }

  /** A proved replacement or rollback is ready at this worker's internal address; wake held public requests. */
  checking(): void {
    if (this.connected && !this.stopping) this.emit("message", { type: "checking" });
  }
  updated(version: string, provisional = false): void {
    if (!this.connected || this.stopping || !this.host?.running || !this.url) return;
    this.emit("message", { type: "ready", contract: gatewayContract.speaks, accepts: gatewayContract.accepts,
      port: Number(new URL(this.url).port), version, pid: this.host.pid, ...(provisional ? { provisional: true } : {}) });
  }

  send(message: object, callback?: (error: Error | null) => void): boolean {
    const parsed = GatewayMessageSchema.safeParse(message);
    if (!this.connected || !parsed.success) { callback?.(new Error("The desktop gateway message was refused")); return false; }
    if (parsed.data.type !== "stop") { callback?.(null); return true; }
    this.stopping = true;
    void (this.host?.stop(7000) ?? Promise.resolve()).then(() => this.finish(0, null), () => this.finish(1, null));
    callback?.(null);
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.connected) return false;
    this.stopping = true;
    void this.finish(null, signal);
    return true;
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (!this.connected) return;
    this.stopping = true;
    this.connected = false;
    await this.host?.end(7000);
    this.options.closeBroker();
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
