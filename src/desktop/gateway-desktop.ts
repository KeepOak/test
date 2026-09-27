import { app } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineHost } from "./engine-host.js";
import { engineBroker } from "./engine-broker.js";
import { desktopEngineServices, forkDesktopEngine } from "./engine-services.js";
import { startDesktopGateway } from "./gateway-runtime.js";
import { installedAppRoot } from "./install-root.js";
import { rememberedPort, rememberPort } from "./local-port.js";
import { liveAtStart } from "./hot-apply.js";
import type { Gateway } from "../never-break/gateway.js";

export interface DetachedDesktopOptions {
  base: string; dataDir: string; workspace: string; appRoot: string;
  providerEnv(): Promise<Record<string, string> | null>;
}

/** A windowless Electron owner retains the encrypted vault, Stop notices and one engine behind a stable gateway. */
export async function runDesktopGateway(options: DetachedDesktopOptions): Promise<Gateway | null> {
  const { base, dataDir, workspace, appRoot } = options;
  const live = await liveAtStart(appRoot, (line) => console.error(line));
  const engineFile = live.engineFile ?? fileURLToPath(new URL("./engine-process.js", import.meta.url));
  let gateway: Gateway | null = null;
  gateway = await startDesktopGateway({ dataDir, engineFile, port: await rememberedPort(join(dataDir, "local-port.json")), version: app.getVersion(),
    worker: (env) => {
      const services = desktopEngineServices(base); let host: EngineHost;
      const { vault, banner, loginItem } = services;
      const broker = engineBroker({ vault, banner, loginItem, tell: (method) => host.tell(method),
        quit: () => { void gateway?.stop().finally(() => app.exit(0)); } });
      return { version: app.getVersion(), closeBroker: () => broker.close(), create: async (gone) => {
        const providerEnv = await options.providerEnv();
        host = new EngineHost({ fork: () => forkDesktopEngine(engineFile, env), handlers: broker.handlers, onGone: gone,
          config: { dataDir, workspace: env.BRANCH_WORKSPACE ?? workspace, providerEnv, version: app.getVersion(), gateway: true,
            executable: app.isPackaged ? process.execPath : null, installRoot: installedAppRoot(app.isPackaged, process.platform, process.execPath),
            packaged: app.isPackaged, loginItem: services.loginItem?.read() ?? null, appPid: process.pid, testHooks: false, appRoot,
            ...(live.window ? { liveWindow: live.window } : {}) }, log: (line) => console.error(line) });
        return host;
      } };
    } });
  if (gateway) rememberPort(join(dataDir, "local-port.json"), gateway.url);
  return gateway;
}
