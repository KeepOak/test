import { Gateway, type GatewayOptions } from "../never-break/gateway.js";
import { DesktopGatewayWorker, type DesktopWorkerOptions } from "./gateway-worker.js";
import { desktopGatewayConfig } from "./gateway-mode.js";
import { restoreGatewayCode } from "./gateway-code.js";

export interface DesktopGatewayOptions {
  dataDir: string;
  appRoot?: string;
  engineFile: string;
  port: number;
  version: string;
  /** Each engine chain gets its own retained Electron broker and teardown. */
  worker(env: NodeJS.ProcessEnv, ready: (version: string, provisional?: boolean) => void, checking: () => void): DesktopWorkerOptions;
  onWorker?: GatewayOptions["onWorker"];
  onOwnerOff?: GatewayOptions["onOwnerOff"];
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
      worker = new DesktopGatewayWorker(options.worker(env, (version, provisional) => worker.updated(version, provisional), () => worker.checking()));
      return worker;
    },
    ...(options.onWorker ? { onWorker: options.onWorker } : {}),
    ...(options.onOwnerOff ? { onOwnerOff: options.onOwnerOff } : {}),
  }, options.close ?? (async () => undefined));
  try { if (options.appRoot) await restoreGatewayCode(options.appRoot, gateway); await gateway.start(); return gateway; }
  catch (error) { await gateway.stop().catch(() => undefined); throw error; }
}
