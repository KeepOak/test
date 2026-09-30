import { app, powerMonitor, powerSaveBlocker } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopGateway } from "./gateway-runtime.js";
import { desktopGatewayRollback } from "./gateway-rollback.js";
import { installedAppRoot } from "./install-root.js";
import { rememberedPort, rememberPort } from "./local-port.js";
import { serveDesktopControl } from "./gateway-control.js";
import { applyGatewayLive, gatewayApplyOwner } from "./gateway-live.js";
import { retainedDesktopWorker } from "./gateway-engine.js";
import { desktopGatewayConfig } from "./gateway-mode.js";
import { loadGatewayConfig } from "../never-break/gateway-config.js";
import type { LiveHooks } from "./updater.js";
import type { Gateway } from "../never-break/gateway.js";
import type { EngineHost } from "./engine-host.js";
import { GatewayPowerPolicy } from "./gateway-power.js";

export interface DetachedDesktopOptions {
  base: string; dataDir: string; workspace: string; appRoot: string;
  providerEnv(): Promise<Record<string, string> | null>;
}

/** A windowless Electron owner retains the encrypted vault, Stop notices and one engine behind a stable gateway. */
export async function runDesktopGateway(options: DetachedDesktopOptions): Promise<Gateway | null> {
  const { dataDir, appRoot } = options;
  if ((await desktopGatewayConfig(dataDir)).config.mode === "off") return null;
  let gateway: Gateway | null = null, live: LiveHooks | null = null, host: EngineHost | null = null;
  const power = new GatewayPowerPolicy({ blocker: powerSaveBlocker, events: powerMonitor,
    read: async () => { const saved = (await loadGatewayConfig(dataDir)).config;
      return { keepAwake: saved.keepAwake, gatewayDesired: saved.mode !== "off" }; },
    suspended: async () => { if (host?.running && !host.handingOver) await host.call("power-suspend", {}, 5000); },
    resumed: async () => { if (host?.running && !host.handingOver) await host.call("power-resume", {}, 10000); } });
  try { await power.start(); } catch (error) { power.close(); throw error; }
  const control = await serveDesktopControl(dataDir, {
    "apply-live": (args) => {
      if (!live) throw new Error("The retained engine is not ready to update.");
      const hooks = live;
      return owner.apply(() => applyGatewayLive(appRoot, hooks, args, (stage) => { void owner.control.current()?.call("update-stage", stage, 5000).catch(() => undefined); }));
    },
    ...(!app.isPackaged && process.env.BRANCH_TEST_ENGINE_HOOKS === "1" ? {
      "test-engine": () => ({ pid: host?.pid, handingOver: host?.handingOver, running: host?.running }),
    } : {}),
  }).catch((error: unknown) => { power.close(); throw error; });
  const owner = gatewayApplyOwner(control);
  try {
    gateway = await startDesktopGateway({ dataDir, engineFile: fileURLToPath(new URL("./engine-process.js", import.meta.url)),
      port: await rememberedPort(join(dataDir, "local-port.json")), version: app.getVersion(),
      close: async () => { power.close(); await control.close(); },
      rollBack: desktopGatewayRollback({ dataDir, target: installedAppRoot(app.isPackaged, process.platform, process.execPath),
        version: app.getVersion(), platform: process.platform,
        stop: async () => { if (!gateway) throw new Error("The desktop gateway is not available to stop safely."); await gateway.stop(); },
        exit: () => app.exit(0) }),
      onOwnerOff: () => { void gateway?.stop().finally(() => app.exit(0)); },
      worker: (env, ready, checking) => retainedDesktopWorker(options, env, ready, checking, owner.control, (hooks, next) => { live = hooks; host = next; },
        () => { void gateway?.stop().finally(() => app.exit(0)); }, power) });
  } catch (error) { power.close(); await control.close().catch(() => undefined); throw error; }
  if (gateway) rememberPort(join(dataDir, "local-port.json"), gateway.url);
  else { power.close(); await control.close(); }
  return gateway;
}
