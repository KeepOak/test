/**
 * The engine of the desktop app, in a process of its own: an Electron utility process started by the window's main
 * process (src/desktop/engine-host.ts). Everything Branch does (the database, the server, tasks, tools, models) runs
 * here, so however long any of it takes, the window's main process keeps answering Windows, the tray and the window.
 *
 * What only the main process can do (the device's key store, a window for the Stop notice, the Mac login item,
 * quitting the app) is asked of it over the private message channel (src/desktop/engine-link.ts).
 */
import { setWindowShown } from "../environment.js";
import { join } from "node:path";
import { createBranch } from "../index.js";
import { realDeviceNetwork } from "../devices/network.js";
import { defaultPreset, providerFromEnv } from "../providers.js";
import { startServer } from "../server.js";
import { loadIntegrations } from "../integrations/bootstrap.js";
import { ChatGPTAuth, type ChatGPTTokens, type TokenVault } from "../chatgpt-auth.js";
import { diagnose } from "../diagnostic-log.js";
import { recordDesktopCrash } from "../tracing.js";
import { rememberedPort, rememberPort } from "./local-port.js";
import { runningTaskCount } from "./quit-guard.js";
import type { BannerNotice, BannerWindow, BannerWindowFactory } from "../integrations/desktop-banner.js";
import type { LoginItem, LoginItemState } from "../install/autostart.js";
import { Link, ToEngineSchema, type EngineConfig } from "./engine-link.js";
import { trustedCaptureLease } from "./capture-link.js";

interface Port {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}
const port = (process as unknown as { parentPort?: Port }).parentPort;
if (!port) throw new Error("The engine runs only inside the Branch Agent app.");
const parent: Port = port;
const post = (message: unknown): void => parent.postMessage(message);
const link = new Link(post);
/** Events from main, by name (a Stop notice closing). */
const listeners = new Map<string, (args: unknown) => void>();

/** The ChatGPT sign-in, kept in main's file with the device's key store, which only main can use. */
const vault: TokenVault = {
  read: () => link.call<ChatGPTTokens | null>("vault-read"),
  write: (tokens) => link.call<void>("vault-write", tokens),
  clear: () => link.call<void>("vault-clear"),
};

// Whether the window is shown, as main says each time it changes (src/environment.ts tells the model).
listeners.set("window", (args) => { const shown = (args as { shown?: unknown } | undefined)?.shown; setWindowShown(typeof shown === "boolean" ? shown : null); });

/** The Stop notice on a Mac or Linux is a window of main's; it says so when the window goes. */
function remoteBanner(): BannerWindowFactory {
  let next = 1;
  return async (closed: () => void, notice?: BannerNotice): Promise<BannerWindow> => {
    const bannerId = next++;
    let showing = false;
    listeners.set(`banner-closed:${bannerId}`, () => {
      showing = false;
      listeners.delete(`banner-closed:${bannerId}`);
      closed();
    });
    try { await link.call("banner-open", { bannerId, ...(notice ? { notice } : {}) }, 15000); }
    catch (error) { listeners.delete(`banner-closed:${bannerId}`); throw error; }
    showing = true;
    return {
      get showing() { return showing; },
      close: () => { void link.call("banner-close", { bannerId }).catch(() => undefined); },
    };
  };
}

/** The Mac login item, as main last read it; a change is made by main, and its answer is what the change reports. */
function remoteLoginItem(first: LoginItemState): LoginItem {
  let known = first;
  return {
    read: () => known,
    set: async (enabled) => {
      const state = await link.call<LoginItemState>("login-item-set", { enabled }, 15000);
      if (typeof state?.enabled !== "boolean" || typeof state?.needsApproval !== "boolean") throw new Error("The login item did not say how it is set.");
      known = { enabled: state.enabled, needsApproval: state.needsApproval };
      return known;
    },
  };
}

function presets(config: EngineConfig) {
  // A launch environment that names a model wins, as it always has; otherwise the saved connection main unlocked.
  const provider = process.env.BRANCH_PROVIDER !== undefined ? providerFromEnv()
    : config.providerEnv ? providerFromEnv(config.providerEnv) : null;
  const model = config.providerEnv?.BRANCH_MODEL;
  return provider ? [defaultPreset(provider, model || undefined)] : [];
}

async function start(config: EngineConfig): Promise<void> {
  // The MCP connection snippet and the add-on export tell a source copy from an installed one this way, as in main.
  if (!config.packaged) (process as { defaultApp?: boolean }).defaultApp = true;
  const chatgpt = new ChatGPTAuth(vault, { userAgent: `BranchAgent/${config.version}` });
  const branch = await createBranch({
    dataDir: config.dataDir, workspace: config.workspace, presets: presets(config), chatgpt,
    bannerWindow: remoteBanner(),
    findComputers: realDeviceNetwork(), // find-computers: the same parts and rules as `branch start` (src/devices/network.ts)
    // computer-control: only this window's own main process can hide Branch's windows from a computer view.
    nativeCaptureLease: trustedCaptureLease(link, true),
  });
  let integrationClose: (() => Promise<void>) | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= (async () => {
    try { await serverClose?.(); } finally {
      try { await integrationClose?.(); } finally { await branch.close(); }
    }
  })());
  link.handle("stop", async () => { await stop(); setTimeout(() => process.exit(0), 20).unref(); return true; });
  link.handle("running-count", () => runningTaskCount(branch.store));
  // A window or helper of the app died: written into the same record of failures the engine keeps.
  link.handle("crash", (args) => {
    const report = args as { where?: unknown; message?: unknown };
    const where = typeof report?.where === "string" ? report.where.slice(0, 40) : "helper";
    const message = typeof report?.message === "string" ? report.message.slice(0, 500) : "A part of the app stopped";
    diagnose(where === "window" ? "window" : "helper", "error", message);
    recordDesktopCrash(branch.store.spans, branch.runtime.owner, (value) => branch.runtime.hideSecrets(value), { where, message });
    return true;
  });
  if (config.testHooks) link.handle("test-block", (args) => {
    const until = Date.now() + Math.min(Number((args as { ms?: unknown })?.ms) || 0, 30000);
    while (Date.now() < until) { /* deliberately blocking, for the test that proves the window stays responsive */ }
    return true;
  });
  try {
    const integrations = await loadIntegrations(branch.registry, process.env.BRANCH_INTEGRATIONS, process.env, branch.secretsFor, branch.channelHost);
    integrationClose = integrations.close;
    branch.browser = integrations.hosted.browser ?? null;
    branch.studies.browser = integrations.hosted.browser;
    branch.issues = integrations.hosted.issues ?? null;
    // The firewall card says what the browser may open, as the command-line launch does (src/cli.ts).
    branch.reach = { browserOrigins: integrations.hosted.browserOrigins ?? [], browserAnyWebsite: integrations.hosted.browserAnyWebsite === true,
      commandsMayReachInternet: integrations.hosted.commandsNetless !== true };
    // Q45 leaf 0: the same port as last time when it is free, so the page's own stored choices survive a restart.
    const portFile = join(config.dataDir, "local-port.json");
    const server = await startServer(branch, {
      dataDir: config.dataDir, port: await rememberedPort(portFile), anyPortIfTaken: true, presence: "app", presencePid: config.appPid,
      executable: config.executable, installRoot: config.installRoot,
      ...(config.loginItem ? { loginItem: remoteLoginItem(config.loginItem) } : {}),
      quit: () => { void link.call("quit").catch(() => undefined); },
      onWindowKey: (token) => post({ kind: "key", token }),
    });
    rememberPort(portFile, server.url);
    serverClose = server.close;
    post({ kind: "ready", url: server.url, token: server.token });
    // Main keeps the last count of working tasks, so a Quit still asks while the engine is too busy to answer at once.
    let told = -1;
    const tell = () => {
      const count = runningTaskCount(branch.store);
      if (count !== told) { told = count; post({ kind: "event", name: "running", args: count }); }
    };
    tell();
    setInterval(tell, 3000).unref();
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

parent.on("message", (event) => {
  const parsed = ToEngineSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.kind === "start") {
    start(message.config).catch((error: unknown) => {
      post({ kind: "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
      setTimeout(() => process.exit(1), 50);
    });
  } else if (message.kind === "event") listeners.get(message.name)?.(message.args);
  else link.receive(message);
});
