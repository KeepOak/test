import { app } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineHost } from "./engine-host.js";
import { engineBroker } from "./engine-broker.js";
import { desktopEngineServices, forkDesktopEngine } from "./engine-services.js";
import { installedAppRoot } from "./install-root.js";
import { liveAtStart, liveHooks } from "./hot-apply.js";
import { builtFrom } from "./build-identity.js";
import { fallbackRepo } from "./repo-pair.js";
import type { DetachedDesktopOptions } from "./gateway-desktop.js";
import type { DesktopWorkerOptions } from "./gateway-worker.js";
import { recoverAdoptionWindow, tellAdoptionWindow, type AdoptionControl } from "./gateway-live.js";
import type { LiveHooks } from "./updater.js";
import { EngineClient } from "./engine-client.js";
import { proveOnce } from "../engine-proof.js";
import { requestUpdateBackup } from "../install/background-engine.js";
import type { GatewayPowerPolicy } from "./gateway-power.js";

export async function brokerRequest<T>(host: EngineHost, action: (client: EngineClient) => Promise<T>): Promise<T> {
  const boot = await proveOnce(host.url, host.token);
  if (!boot) throw new Error("The retained engine did not prove its identity.");
  const client = new EngineClient({ origin: host.url, access: { boot: () => host.running ? boot : null }, windowKey: () => host.token });
  try { return await action(client); } finally { client.close(); }
}

function retainedLive(options: DetachedDesktopOptions, host: EngineHost, env: NodeJS.ProcessEnv, ready: (version: string, provisional?: boolean) => void, checking: () => void,
  control: AdoptionControl, packaged: string | null, closeBroker: () => void): LiveHooks {
  const { appRoot, dataDir } = options;
  return liveHooks({ appRoot, dataDir, repo: fallbackRepo, buildDir: join(dataDir, "updates", "beta-build"), packaged,
    host: () => host, forkLive: (file) => forkDesktopEngine(file, env), runtime: process.execPath,
    gateway: { ready, checking, packagedVersion: app.getVersion() }, onEngineDeparture: closeBroker,
    snapshot: () => brokerRequest(host, async (client) => {
      const response = await client.fetch(`${host.url}/api/never-break/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(120000) });
      const body = await response.json() as { folder?: unknown };
      if (!response.ok || typeof body.folder !== "string") throw new Error("The retained engine did not make an update copy.");
      return body.folder;
    }), backup: () => brokerRequest(host, async (client) => { await requestUpdateBackup(host.url, "", { fetch: client.fetch }); }),
    tellWindow: (update) => tellAdoptionWindow(control, update),
    recoverWindow: () => recoverAdoptionWindow(control), log: (line) => console.error(line) });
}

/** Every crash replacement reloads checked live state and encrypted settings, after the departed writer ended. */
export function retainedDesktopWorker(options: DetachedDesktopOptions, env: NodeJS.ProcessEnv, ready: (version: string, provisional?: boolean) => void, checking: () => void,
  control: AdoptionControl, activated: (hooks: LiveHooks, host: EngineHost) => void, quit: () => void,
  power?: GatewayPowerPolicy): DesktopWorkerOptions {
  const services = desktopEngineServices(options.base); let host: EngineHost, version = app.getVersion();
  const { vault, banner, loginItem } = services;
  const broker = engineBroker({ vault, banner, loginItem, tell: (method) => host.tell(method), quit,
    ...(power ? { power: { status: async () => { await power.refresh(); return power.status(); } } } : {}) });
  return { get version() { return version; }, closeBroker: () => broker.close(), create: async (gone) => {
    const live = await liveAtStart(options.appRoot, (line) => console.error(line));
    const engineFile = live.engineFile ?? fileURLToPath(new URL("./engine-process.js", import.meta.url));
    version = live.engineFile ? live.state.engine?.version ?? version : version;
    const providerEnv = await options.providerEnv();
    host = new EngineHost({ fork: () => forkDesktopEngine(engineFile, env), handlers: broker.handlers, onGone: gone,
      config: { dataDir: options.dataDir, workspace: env.BRANCH_WORKSPACE ?? options.workspace, providerEnv, version, gateway: true,
        executable: app.isPackaged ? process.execPath : null, installRoot: installedAppRoot(app.isPackaged, process.platform, process.execPath),
        packaged: app.isPackaged, loginItem: services.loginItem?.read() ?? null, appPid: process.pid, testHooks: false, appRoot: options.appRoot,
        ...(live.window ? { liveWindow: live.window } : {}) }, log: (line) => console.error(line) });
    activated(retainedLive(options, host, env, ready, checking, control, await builtFrom(options.appRoot, app.isPackaged), () => broker.close()), host);
    return host;
  } };
}
