import { app, powerMonitor, powerSaveBlocker } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopGateway } from "./gateway-runtime.js";
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
import { brokerRequest } from "./gateway-engine.js";
import { gatewayUpdates } from "./gateway-updates.js";
import { requestUpdateBackup } from "../install/background-engine.js";
import { updateScratchDir } from "./updater-ipc.js";

export interface DetachedDesktopOptions {
  base: string; dataDir: string; workspace: string; appRoot: string;
  providerEnv(): Promise<Record<string, string> | null>;
}

/** A windowless Electron owner retains the encrypted vault, Stop notices and one engine behind a stable gateway. */
export async function runDesktopGateway(options: DetachedDesktopOptions): Promise<Gateway | null> {
  const { dataDir, appRoot } = options;
  if ((await desktopGatewayConfig(dataDir)).config.mode === "off") return null;
  let gateway: Gateway | null = null, live: LiveHooks | null = null, host: EngineHost | null = null;
  let adoptedAlone: { ok: boolean; error?: string } | null = null;
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
      // The gateway updating itself with no window: the adoption begins once no shell is joined (the asking one left).
      "test-adopt-alone": (args) => {
        if (!live) throw new Error("The retained engine is not ready to update.");
        const hooks = live;
        adoptedAlone = null;
        void (async () => {
          while (control.current() !== null) await new Promise((wake) => setTimeout(wake, 50));
          adoptedAlone = await owner.apply(() => applyGatewayLive(appRoot, hooks, args, () => undefined))
            .then(() => ({ ok: true }), (error: Error) => ({ ok: false, error: error.message }));
        })();
        return true;
      },
      "test-adopted-alone": () => adoptedAlone,
    } : {}),
  }).catch((error: unknown) => { power.close(); throw error; });
  const owner = gatewayApplyOwner(control);
  try {
    gateway = await startDesktopGateway({ dataDir, engineFile: fileURLToPath(new URL("./engine-process.js", import.meta.url)),
      port: await rememberedPort(join(dataDir, "local-port.json")), version: app.getVersion(),
      close: async () => { power.close(); await control.close(); },
      onOwnerOff: () => { void gateway?.stop().finally(() => app.exit(0)); },
      worker: (env, ready, checking) => retainedDesktopWorker(options, env, ready, checking, owner.control, (hooks, next) => { live = hooks; host = next; },
        () => { void gateway?.stop().finally(() => app.exit(0)); }, power) });
  } catch (error) { power.close(); await control.close().catch(() => undefined); throw error; }
  if (gateway) rememberPort(join(dataDir, "local-port.json"), gateway.url);
  else { power.close(); await control.close(); }
  // Update by itself with no window open: this gateway keeps Branch up to date (gateway-updates.ts). A window, once
  // joined, runs its own loop and this one waits. Only an installed copy updates itself.
  if (gateway && app.isPackaged) {
    const engine = <T>(action: (client: import("./engine-client.js").EngineClient, url: string) => Promise<T>) => {
      if (!host) throw new Error("The retained engine is not ready yet.");
      const now = host;
      return brokerRequest(now, (client) => action(client, now.url));
    };
    const call = (path: string, body?: unknown) => engine(async (client, url) => {
      const response = await client.fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const answer = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(answer?.error ?? `The engine answered ${response.status}.`);
      return answer;
    });
    const { loop } = await gatewayUpdates({ dataDir, appRoot, scratchDir: updateScratchDir(), shellOpen: () => control.current() !== null, live: () => live,
      adopt: (action) => owner.apply(action),
      engine: call,
      snapshot: async () => { const body = await call("/api/never-break/snapshot", {}) as { folder?: unknown }; if (typeof body?.folder !== "string") throw new Error("The retained engine did not make an update copy."); return body.folder; },
      backup: () => engine(async (client, url) => { await requestUpdateBackup(url, "", { fetch: client.fetch }); }) });
    loop.start(60_000);
  }
  return gateway;
}
