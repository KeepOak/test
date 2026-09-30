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
import { readFileSync } from "node:fs";
import { createBranch } from "../index.js";
import { realDeviceNetwork } from "../devices/network.js";
import { defaultPreset, providerFromEnv } from "../providers.js";
import { startServer } from "../server.js";
import { loadIntegrations } from "../integrations/bootstrap.js";
import { ChatGPTAuth, type ChatGPTTokens, type TokenVault } from "../chatgpt-auth.js";
import { diagnose } from "../diagnostic-log.js";
import { noteStalledLooks } from "../comfort/auto-update.js";
import { recordDesktopCrash } from "../tracing.js";
import { rememberedPort, rememberPort } from "./local-port.js";
import { runningTaskCount } from "./quit-guard.js";
import type { BannerNotice, BannerWindow, BannerWindowFactory } from "../integrations/desktop-banner.js";
import type { LoginItem, LoginItemState } from "../install/autostart.js";
import { Link, ToEngineSchema, engineContract, type EngineConfig } from "./engine-link.js";
import { handOverWork, HandOverArgsSchema } from "../hot-update/engine-handover.js";
import { resumeHandedOver } from "../never-break/resume.js";
import { dropLiveWindow, useLiveWindow } from "../hot-update/window-files.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { LiveInUseSchema } from "./engine-link.js";
import { trustedCaptureLease } from "./capture-link.js";
import { EnginePowerRecovery } from "./engine-power.js";
import { startPostUpdateDoctor } from "./post-update-doctor.js";

const UseWindowSchema = z.object({ appRoot: z.string().min(1).max(4096), inUse: LiveInUseSchema.nullable() }).strict();
/** This engine's own copy of a window file (named as under public/), to tell what a live build changed. */
const ownWindowFile = (name: string): Promise<Buffer | null> => readFile(new URL(`../../public/${name}`, import.meta.url)).catch(() => null);
import { keepRunningThroughErrors } from "./engine-errors.js";
import { engineHealthy } from "./engine-health.js";
type Branch = Awaited<ReturnType<typeof createBranch>>;

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

/**
 * hot-update: the code is loaded (every module above was imported) and the engine waits for main's start. A newer engine
 * started beside the old one sits here, holding nothing: no database, no port, no task, until the old one has let go.
 */
function builtCommit(): string | null {
  try {
    const commit = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"))?.commit;
    return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch { return null; }
}
post({ kind: "loaded", contract: engineContract, commit: builtCommit() });

/** Whether the engine can still do its work; nothing can before it has started. */
let healthy: () => Promise<boolean> = async () => false;
/** Closes the engine's server, integrations and database; nothing to close before it has started. */
let closeEngine: () => Promise<void> = async () => undefined;
// A failure nobody caught is written down and the engine carries on; only one that leaves it unable to work ends it,
// and main then starts a fresh engine, where interrupted tasks are offered again or carry on (src/never-break/resume.ts).
keepRunningThroughErrors(process, {
  healthy: () => healthy(),
  log: (line) => { console.error(line); diagnose("engine", "error", line); },
  end: (why) => {
    const line = `The engine cannot carry on (${why}); a fresh one is started.`;
    console.error(line);
    diagnose("engine", "error", line);
    // Closed first where it still can be (its port is let go of for the fresh engine), but never waited on for long.
    const late = new Promise<void>((resolve) => { setTimeout(resolve, 3000).unref(); });
    void Promise.race([closeEngine().catch(() => undefined), late]).finally(() => process.exit(1));
  },
});

/** The engine answers from its database and its server, as the window would reach it. */
function healthOf(branch: Branch, url: string, key: () => string): () => Promise<boolean> {
  return () => engineHealthy(() => { branch.store.sqlite.prepare("SELECT 1").get(); }, url, key());
}

/** Test builds only (main sets `testHooks` for an unpackaged copy started to be tested): ways to make trouble on purpose. */
function testTrouble(branch: Branch): void {
  link.handle("test-block", (args) => {
    const until = Date.now() + Math.min(Number((args as { ms?: unknown })?.ms) || 0, 30000);
    while (Date.now() < until) { /* deliberately blocking, for the test that proves the window stays responsive */ }
    return true;
  });
  link.handle("test-throw", (args) => {
    const kind = (args as { kind?: unknown })?.kind;
    if (kind === "rejection") void Promise.reject(new Error("A failure made on purpose by a test"));
    else setTimeout(() => { throw new Error("A failure made on purpose by a test"); }, 0);
    return true;
  });
  link.handle("test-break", () => {
    branch.store.sqlite.close();
    setTimeout(() => { throw new Error("A failure made on purpose by a test, after closing the database"); }, 0);
    return true;
  });
}

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
  // BRANCH_DESKTOP_GATEWAY: the retained desktop broker stops its gateway after an owner's OFF (src/desktop/gateway-desktop.ts).
  if (config.gateway) { process.env.BRANCH_GATEWAY_CHILD = "1"; process.env.BRANCH_DESKTOP_GATEWAY = "1"; }
  // The MCP connection snippet and the add-on export tell a source copy from an installed one this way, as in main.
  if (!config.packaged) (process as { defaultApp?: boolean }).defaultApp = true;
  if (config.holdHandedOver) process.env.BRANCH_HOLD_HANDED_OVER = "1";
  // hot-update: a live build's window files, when main says one is in use and it checks out; else the engine's own.
  if (config.appRoot && config.liveWindow) await useLiveWindow(config.appRoot, config.liveWindow, ownWindowFile)
    .catch((error: unknown) => console.error(`The live window files were not used: ${error instanceof Error ? error.message : String(error)}`));
  const chatgpt = new ChatGPTAuth(vault, { userAgent: `BranchAgent/${config.version}` });
  const branch = await createBranch({
    dataDir: config.dataDir, workspace: config.workspace, presets: presets(config), chatgpt,
    bannerWindow: remoteBanner(),
    // A detached broker cannot prove another shell PID's viewer until that shell has a trusted capture host.
    ...{ nativeCaptureLease: trustedCaptureLease(link, !config.gateway) },
    findComputers: realDeviceNetwork(), // find-computers: the same parts and rules as `branch start` (src/devices/network.ts)
  });
  // Updating by itself is run by the app (its update loop asks this engine's plan): one that stopped asking is said as
  // a problem in Settings › Updates and the activity log, never left silent (auto-update.ts noteStalledLooks).
  if (config.packaged) {
    const since = Date.now();
    setInterval(() => { try { noteStalledLooks(branch.store, branch.runtime.owner, since); } catch { /* the next look tries again */ } }, 5 * 60_000).unref();
  }
  let integrationClose: (() => Promise<void>) | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;
  let closeDoctor: (() => void) | undefined;
  let doctorStarted = false, doctorPort = 0;
  const doctor = () => {
    if (!config.packaged || stopping || doctorStarted || !doctorPort) return;
    doctorStarted = true;
    try {
      closeDoctor = startPostUpdateDoctor({ store: branch.store, owner: branch.runtime.owner, version: branch.version,
        workspace: branch.runtime.workspace, port: doctorPort, redact: (text) => branch.runtime.hideSecrets(text) });
    } catch (error) { diagnose("updater", "warn", branch.runtime.hideSecrets(`The post-update doctor could not start: ${String(error)}`)); }
  };
  const power = new EnginePowerRecovery({ checkpoint: () => { branch.store.sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)"); },
    due: () => branch.scheduler.tick(), flush: () => branch.channels.flush() });
  const stop = () => (stopping ??= (async () => {
    closeDoctor?.();
    power.close();
    try { await serverClose?.(); } finally {
      try { await integrationClose?.(); } finally { await branch.close(); }
    }
  })());
  closeEngine = stop;
  link.handle("stop", async () => { await stop(); setTimeout(() => process.exit(0), 20).unref(); return true; });
  link.handle("running-count", () => runningTaskCount(branch.store));
  link.handle("power-suspend", (args) => { z.object({}).strict().parse(args ?? {}); return power.suspend(); });
  link.handle("power-resume", (args) => { z.object({}).strict().parse(args ?? {}); return power.resume(); });
  // hot-update: a newer engine is taking over; work drains, then stops after a whole step to carry on there.
  link.handle("hand-over", (args) => handOverWork(branch, HandOverArgsSchema.parse(args ?? {})));
  // hot-update: this engine passed its check after taking over; the tasks handed to it carry on now.
  // hot-update: the window's files of a live build, checked here before they are ever served.
  link.handle("use-window", async (args) => {
    const { appRoot, inUse } = UseWindowSchema.parse(args);
    if (!inUse) { dropLiveWindow(); return { changed: [], ms: 0 }; }
    return useLiveWindow(appRoot, inUse, ownWindowFile);
  });
  link.handle("carry-on", () => {
    const runIds = resumeHandedOver({ store: branch.store, runtime: branch.runtime }).map(({ runId, resumed }) => {
      // A chat's task is answered in that chat when it finishes here (the older engine said nothing for it).
      void branch.channels.carryOnReply(runId, resumed).catch((error: Error) => diagnose("channels", "warn", `A chat's handed-over task could not be answered: ${error.message}`));
      return runId;
    });
    doctor();
    return runIds;
  });
  // A window or helper of the app died: written into the same record of failures the engine keeps.
  link.handle("crash", (args) => {
    const report = args as { where?: unknown; message?: unknown };
    const where = typeof report?.where === "string" ? report.where.slice(0, 40) : "helper";
    const message = typeof report?.message === "string" ? report.message.slice(0, 500) : "A part of the app stopped";
    diagnose(where === "window" ? "window" : "helper", "error", message);
    recordDesktopCrash(branch.store.spans, branch.runtime.owner, (value) => branch.runtime.hideSecrets(value), { where, message });
    return true;
  });
  if (config.testHooks) testTrouble(branch);
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
    let healthKey = "";
    const server = await startServer(branch, {
      dataDir: config.dataDir, port: config.port ?? (config.gateway ? 0 : await rememberedPort(portFile)), anyPortIfTaken: config.port === undefined,
      ...(config.gateway ? {} : { presence: "app" as const, presencePid: config.appPid }),
      executable: config.executable, installRoot: config.installRoot,
      ...(config.loginItem ? { loginItem: remoteLoginItem(config.loginItem) } : {}),
      quit: () => { void link.call("quit").catch(() => undefined); },
      ...(config.gateway ? { gatewayPower: () => link.call("gateway-power-status", {}, 5000) } : {}),
      onWindowKey: (token) => { healthKey = token; post({ kind: "key", token }); },
    });
    if (!config.gateway) rememberPort(portFile, server.url);
    serverClose = server.close;
    healthKey = server.token;
    healthy = healthOf(branch, server.url, () => healthKey);
    post({ kind: "ready", url: server.url, token: server.token });
    doctorPort = Number(new URL(server.url).port);
    if (!config.holdHandedOver) doctor();
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
