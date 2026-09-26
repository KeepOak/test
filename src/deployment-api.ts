import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { autostartState, macLoginItemsLink, setAutostart, type AutostartDeps, type AutostartState, type LoginItem } from "./install/autostart.js";
import { daemonCommand, daemonLauncherName, daemonTaskName, type DaemonAction, type DaemonOptions } from "./install/daemon.js";
import { launchdLabel } from "./install/launchd.js";
import { systemdUnitName } from "./install/systemd.js";
import { readRunning, sessionTokenFileName } from "./install/running.js";
import { listUpdateBackups, readFirstStart, readUpdateBackup, writeUpdateBackup } from "./install/update-backup.js";
import { doctorFix } from "./doctor-fix.js";
import type { RemoteAccess } from "./remote/remote-access.js";
import type { QrMatrix } from "./remote/qr.js";
import type { createBranch } from "./index.js";
import { readComfort } from "./comfort/settings.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { neverSuggest, nextSuggestion, suggestionsSettings } from "./suggestions.js";

/**
 * The screens behind "how Branch runs on this computer": start when the person signs in, keep working
 * with the window closed, reach it from a phone, and the safety copies taken before an update.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export interface DeploymentContext {
  dataDir: string;
  workspace: string;
  port: number;
  /** The installed app's own program file, or null when Branch runs from a source checkout. */
  executable: string | null;
  /** Where the app is installed (see `installTarget`): the program's folder, or the `.app` bundle on a Mac. */
  installRoot: string | null;
  remote: RemoteAccess;
  /** Stand-ins for the registry tool, so a test never writes this computer's real sign-in list. */
  autostartDeps?: AutostartDeps;
  /** The desktop app's own login item (a Mac), used instead of the Windows sign-in list when handed in. */
  loginItem?: LoginItem;
}

const EnabledSchema = z.object({ enabled: z.boolean(), minimized: z.boolean().optional() }).strict();
const DaemonSchema = z.object({ action: z.enum(["install", "uninstall", "status"]) }).strict();
const RestoreSchema = z.object({ name: z.string().min(1).max(120) }).strict();

/** The barcode as rows of noughts and ones, which the page paints as squares. */
export function qrRows(matrix: QrMatrix): { size: number; version: number; rows: string[] } {
  return {
    size: matrix.size, version: matrix.version,
    rows: matrix.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")),
  };
}

/** macOS and Linux differ from Windows here; tests pass the system in, the server uses this computer's. */
export interface DeploymentDeps {
  platform?: NodeJS.Platform;
  /** Sends a signal to a process; only used to close this engine after it has answered. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** The app's own program when this engine runs inside it in node mode (see `appRuntime`); tests pass it in. */
  appRuntime?: string | null;
}

/**
 * The installed app's program when this engine is that program run in node mode: the background engine on Windows
 * starts as `"Branch Agent.exe" cli.js start` with ELECTRON_RUN_AS_NODE and is not told its own path. A plain Node, or
 * Electron from a source checkout's node_modules, is never an installed app, so neither is ever registered.
 */
export function appRuntime(env: NodeJS.ProcessEnv = process.env, versions: NodeJS.ProcessVersions = process.versions,
  execPath: string = process.execPath): string | null {
  if (!versions.electron || env.ELECTRON_RUN_AS_NODE !== "1") return null;
  return /[\\/]node_modules[\\/]/.test(execPath) ? null : execPath;
}

/**
 * The engine's own script inside an installed copy. `installRoot` is the program's folder on Windows
 * and Linux, and the `.app` bundle on a Mac, which keeps its files in Contents/Resources.
 */
export function engineScriptPath(platform: NodeJS.Platform, installRoot: string): string {
  if (platform === "win32") return win32.join(installRoot, "resources", "app", "dist", "cli.js");
  if (platform === "darwin") return posix.join(installRoot, "Contents", "Resources", "app", "dist", "cli.js");
  return posix.join(installRoot, "resources", "app", "dist", "cli.js");
}

/** "Start with Windows", in the words that fit this computer. */
export function startsBySelfWords(platform: NodeJS.Platform): string {
  if (platform === "win32") return "start with Windows";
  if (platform === "darwin") return "start by itself when you sign in to your Mac";
  return "start by itself when you sign in to this computer";
}

/**
 * Whether Branch starts when the person signs in, and whether it can here: only an installed app can
 * be started by the system (a source checkout has no program of its own to register). Windows keeps a
 * per-person sign-in list; a Mac uses the app's login item, which macOS may want approved first.
 */
export interface AutostartView extends AutostartState { available: boolean; needsApproval: boolean; settingsLink: string }
const noSignInStart = { enabled: false, minimized: false, command: null, needsApproval: false, settingsLink: "" };
export const noSignInStartHereWords = "Starting by itself is not available on this kind of computer yet. Open Branch when you want it.";

/** The program the sign-in list would start: the installed app's own, or none from a source checkout. */
const signInProgram = (context: DeploymentContext, deps: DeploymentDeps): string | null =>
  context.executable || (deps.appRuntime === undefined ? appRuntime() : deps.appRuntime);

async function autostartView(context: DeploymentContext, platform: NodeJS.Platform, deps: DeploymentDeps): Promise<AutostartView> {
  if (!signInProgram(context, deps)) return { ...noSignInStart, available: false };
  if (context.loginItem) {
    const { enabled, needsApproval } = context.loginItem.read();
    return { ...noSignInStart, enabled, needsApproval, settingsLink: needsApproval ? macLoginItemsLink : "", available: true };
  }
  if (platform !== "win32") return { ...noSignInStart, available: false };
  return { ...noSignInStart, ...(await autostartState({}, context.autostartDeps)), available: true };
}

async function saveAutostart(context: DeploymentContext, platform: NodeJS.Platform, deps: DeploymentDeps, body: unknown): Promise<AutostartView> {
  const { enabled, minimized } = EnabledSchema.parse(body);
  const program = signInProgram(context, deps);
  if (!program) throw new Error(`Branch has to be installed on this computer before it can ${startsBySelfWords(platform)}.`);
  if (context.loginItem) context.loginItem.set(enabled);
  else if (platform !== "win32") throw new Error(noSignInStartHereWords);
  else await setAutostart(enabled, { executable: program, minimized: minimized ?? true }, context.autostartDeps);
  return autostartView(context, platform, deps);
}

function notInstalledDaemon(platform: NodeJS.Platform): { action: "status"; taskName: string; installed: false; message: string } {
  if (platform === "darwin")
    return { action: "status", taskName: launchdLabel, installed: false, message: "Move Branch into your Applications folder and open it from there to keep it working with the window closed. It then starts by itself when you sign in to your Mac." };
  if (platform === "linux")
    return { action: "status", taskName: systemdUnitName, installed: false, message: "Install Branch on this computer to keep it working with the window closed. It then starts by itself when you sign in." };
  return { action: "status", taskName: daemonTaskName, installed: false, message: "Install Branch on this computer to keep it running with the window closed." };
}

export function daemonOptions(context: DeploymentContext, platform: NodeJS.Platform = process.platform): DaemonOptions {
  if (!context.executable || !context.installRoot)
    throw new Error("Branch has to be installed on this computer before it can keep running in the background.");
  return {
    executable: context.executable,
    script: engineScriptPath(platform, context.installRoot),
    dataDir: context.dataDir, workspace: context.workspace, port: context.port,
    launcherPath: (platform === "win32" ? win32 : posix).join(context.dataDir, daemonLauncherName),
  };
}

async function overview(app: Branch, context: DeploymentContext, platform: NodeJS.Platform, deps: DeploymentDeps): Promise<unknown> {
  const installed = Boolean(context.executable);
  return {
    installed,
    installRoot: context.installRoot,
    dataDir: context.dataDir,
    autostart: await autostartView(context, platform, deps),
    daemon: installed
      ? await daemonCommand("status", daemonOptions(context, platform))
      : notInstalledDaemon(platform),
    remote: context.remote.status(),
    restorePoints: await listUpdateBackups(context.dataDir),
    firstStart: await readFirstStart(context.dataDir),
    version: app.version,
    // "when I sign in to Windows / my Mac / this computer": the window names the system Branch runs on.
    platform,
  };
}

async function setRemote(app: Branch, context: DeploymentContext, body: unknown, handler: Parameters<RemoteAccess["enable"]>[0]): Promise<unknown> {
  const { enabled } = EnabledSchema.parse(body);
  return enabled ? context.remote.enable(handler) : context.remote.disable();
}

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** True only for the master key of this data folder, never a short-lived key. */
async function carriesMasterKey(request: IncomingMessage, dataDir: string): Promise<boolean> {
  const supplied = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
  const saved = (await readFile(posix.join(dataDir, sessionTokenFileName), "utf8").catch(() => "")).trim();
  return Boolean(saved) && supplied.length === saved.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(saved));
}

/**
 * macOS and Linux: an update asks the engine working in the background to close. Only this computer,
 * holding the master key, may ask, and only the background engine itself closes; the answer is sent
 * before it goes. Windows closes it its own way, so there it is refused.
 */
async function closeEngine(request: IncomingMessage, context: DeploymentContext, deps: DeploymentDeps): Promise<unknown> {
  if ((deps.platform ?? process.platform) === "win32")
    throw new Error("On Windows the update closes the background engine by itself.");
  if (!loopback.has(request.socket?.localAddress ?? "") || !(await carriesMasterKey(request, context.dataDir)))
    throw new Error("Only the app on this computer can close the background engine.");
  const note = await readRunning(context.dataDir);
  if (note?.mode !== "daemon" || note.pid !== process.pid)
    throw new Error("This copy of Branch is not the one working in the background.");
  const signal = deps.signal ?? ((pid: number, name: NodeJS.Signals) => { process.kill(pid, name); });
  // The same stop as pressing Ctrl+C: work is saved and the address is released.
  setTimeout(() => signal(process.pid, "SIGTERM"), 200);
  return { closing: true, message: "Branch is closing in the background so the new version can replace the files." };
}

/**
 * Redesign phase 1: the one bar to offer above the message box now (src/suggestions.ts). Anybody
 * but the owner in the app window is offered nothing. Looking whether the background engine is set
 * up reads the system's own list and changes nothing.
 */
async function suggestion(app: Branch, context: DeploymentContext, platform: NodeJS.Platform): Promise<{ bar: string | null }> {
  const owner = app.runtime.owner;
  const here = !startedWithShortLivedKey() && !currentPerson() && !app.store.profiles.active();
  if (!here) return { bar: null };
  const installed = Boolean(context.executable && context.installRoot);
  const note = await readRunning(context.dataDir).catch(() => null);
  const inBackground = note?.mode === "daemon" && note.pid === process.pid;
  const background = inBackground || (installed && (await daemonCommand("status", daemonOptions(context, platform)).catch(() => null))?.installed === true);
  const onboarded = (app.store.get("settings", owner, "onboarding")?.data as { done?: unknown } | undefined)?.done === true;
  return { bar: nextSuggestion({ owner: here, onboarded, settings: suggestionsSettings(app.store, owner), installed,
    background, autoUpdate: readComfort(app.store, owner, "notify").autoUpdate }) };
}

/** Handles everything under /api/deployment; returns undefined when the path is not one of ours. */
export async function deploymentApi(
  app: Branch, request: IncomingMessage, path: string, context: DeploymentContext,
  readBody: (request: IncomingMessage) => Promise<unknown>,
  remoteHandler: Parameters<RemoteAccess["enable"]>[0],
  deps: DeploymentDeps = {},
): Promise<unknown | undefined> {
  const platform = deps.platform ?? process.platform;
  if (request.method === "GET" && path === "/api/deployment") return overview(app, context, platform, deps);
  if (request.method === "GET" && path === "/api/deployment/suggestion") return suggestion(app, context, platform);
  // "Don't ask again": only the owner reaches this (an unlisted change is refused to everyone else).
  if (request.method === "POST" && path === "/api/deployment/suggestion") {
    app.store.profiles.requireOwner("Suggestions");
    return { settings: neverSuggest(app.store, app.runtime.owner, await readBody(request)) };
  }
  if (request.method === "POST" && path === "/api/deployment/autostart") return saveAutostart(context, platform, deps, await readBody(request));
  if (request.method === "POST" && path === "/api/deployment/daemon") {
    const { action } = DaemonSchema.parse(await readBody(request));
    return daemonCommand(action as DaemonAction, daemonOptions(context, platform));
  }
  if (request.method === "POST" && path === "/api/deployment/close") return closeEngine(request, context, deps);
  if (request.method === "POST" && path === "/api/deployment/remote")
    return setRemote(app, context, await readBody(request), remoteHandler);
  if (request.method === "POST" && path === "/api/deployment/remote/invite") {
    const invitation = context.remote.invite();
    return { url: invitation.url, code: invitation.code, expiresAt: invitation.expiresAt, qr: qrRows(invitation.qr) };
  }
  if (request.method === "GET" && path === "/api/deployment/doctor") {
    const fix = new URL(request.url ?? "/", "http://local").searchParams.get("fix") === "1";
    // Branch itself is listening on that address, so "in use" is the right answer, not a problem.
    return doctorFix({ fix, port: context.port, workspace: context.workspace, portIsOurs: true });
  }
  if (request.method === "POST" && path === "/api/deployment/backup")
    return writeUpdateBackup(context.dataDir, app.store.backup(app.version), app.version);
  if (request.method === "GET" && path === "/api/deployment/restore-points")
    return { points: await listUpdateBackups(context.dataDir), firstStart: await readFirstStart(context.dataDir) };
  if (request.method === "POST" && path === "/api/deployment/restore-point") {
    const { name } = RestoreSchema.parse(await readBody(request));
    const archive = await readUpdateBackup(context.dataDir, name);
    return app.store.restore(archive, { replaceExisting: true });
  }
  return undefined;
}
