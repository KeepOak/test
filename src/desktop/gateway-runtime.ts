import { Gateway, type GatewayOptions } from "../never-break/gateway.js";
import { DesktopGatewayWorker, type DesktopWorkerOptions } from "./gateway-worker.js";
import { desktopGatewayConfig } from "./gateway-mode.js";

export interface DesktopGatewayOptions {
  dataDir: string;
  engineFile: string;
  port: number;
  version: string;
  /** Each engine chain gets its own retained Electron broker and teardown. */
  worker(env: NodeJS.ProcessEnv, ready: (version: string) => void): DesktopWorkerOptions;
  onWorker?: GatewayOptions["onWorker"];
  close?: () => Promise<void>;
}

class RetainedGateway extends Gateway {
  private ending: Promise<void> | null = null;
  constructor(options: GatewayOptions, private readonly release: () => Promise<void>) { super(options); }
  override stop(): Promise<void> {
    return this.ending ??= super.stop().finally(() => this.release());
  }
}

/** The public gateway runs in the retained desktop broker, independent of every shell window. */
export async function startDesktopGateway(options: DesktopGatewayOptions): Promise<Gateway | null> {
  const saved = await desktopGatewayConfig(options.dataDir);
  if (saved.config.mode === "off") return null;
  const gateway = new RetainedGateway({
    dataDir: options.dataDir, script: options.engineFile, port: options.port, version: options.version, presence: true,
    spawn: (_script, _args, env) => {
      let worker: DesktopGatewayWorker;
      worker = new DesktopGatewayWorker(options.worker(env, (version) => worker.updated(version)));
      return worker;
    },
    ...(options.onWorker ? { onWorker: options.onWorker } : {}),
  }, options.close ?? (async () => undefined));
  try { await gateway.start(); return gateway; }
  catch (error) { await gateway.stop().catch(() => undefined); throw error; }
}
