import { Gateway, type GatewayOptions } from "../never-break/gateway.js";
import { DesktopGatewayWorker, type DesktopWorkerOptions } from "./gateway-worker.js";
import { desktopGatewayConfig } from "./gateway-mode.js";

export interface DesktopGatewayOptions {
  dataDir: string;
  engineFile: string;
  port: number;
  version: string;
  /** Each engine chain gets its own retained Electron broker and teardown. */
  worker(env: NodeJS.ProcessEnv): DesktopWorkerOptions;
  onWorker?: GatewayOptions["onWorker"];
}

/** The public gateway runs in the retained desktop broker, independent of every shell window. */
export async function startDesktopGateway(options: DesktopGatewayOptions): Promise<Gateway | null> {
  const saved = await desktopGatewayConfig(options.dataDir);
  if (saved.config.mode === "off") return null;
  const gateway = new Gateway({
    dataDir: options.dataDir, script: options.engineFile, port: options.port, version: options.version, presence: true,
    spawn: (_script, _args, env) => new DesktopGatewayWorker(options.worker(env)),
    ...(options.onWorker ? { onWorker: options.onWorker } : {}),
  });
  try { await gateway.start(); return gateway; }
  catch (error) { await gateway.stop().catch(() => undefined); throw error; }
}
