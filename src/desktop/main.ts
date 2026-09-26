import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerMonitor,
  Tray,
  nativeImage,
  shell,
  type NativeImage,
} from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Wave 5 (deployment): portable folders, joining a background engine, opening straight to the tray.
import { resolveDataLocation } from "../install/layout.js";
import { attachToRunning } from "../install/running.js";
import { writeUpdateBackup } from "../install/update-backup.js";
import { requestUpdateBackup, stopBackgroundEngine } from "../install/background-engine.js";
import { installedAppRoot } from "./install-root.js";
import { rememberedPort, rememberPort } from "./local-port.js";
import { minimizedFlag, startsMinimized } from "../install/autostart.js";
import { macLoginItem } from "./login-item.js";
import { createBranch } from "../index.js";
import { defaultPreset, providerFromEnv } from "../providers.js";
import { startServer } from "../server.js";
import { loadIntegrations } from "../integrations/bootstrap.js";
import { loadDesktopSettings, registerSettingsIpc } from "./settings-ipc.js";
import { registerUpdaterIpc, type UpdateHooks } from "./updater-ipc.js";
import { UpdateDeferredError } from "./updater.js";
import { updateReadiness } from "./update-readiness.js";
import { ChatGPTAuth, FileTokenVault } from "../chatgpt-auth.js";
import { safeStorage } from "electron";
import { crashReporter } from "electron"; // mac7/diagnostics
import { crashReporterPlan, diagnose } from "../diagnostic-log.js"; // mac7/diagnostics, mac7/coding-next
import type { DesktopSettings } from "./settings.js";
import { registerConversationExportIpc } from "./conversation-export-ipc.js";
// 0.18.1: "Branch stopped responding — Restart" relaunches the app, and with it the local server.
import { ipcMain } from "electron";
import { registerRestartIpc } from "./restart-ipc.js";
import { minimumSize, openingFor, readWindowState, restoreBounds, writeWindowState } from "./window-state.js";
import { overlayFor, registerWindowLookIpc } from "./window-chrome-ipc.js";
import { registerEditMenu } from "./context-menu.js";
import { recordDesktopCrash, type SpanStore } from "../tracing.js";
// mac2/desktop-ui: the Stop notice for screen control on macOS and Linux is a window of this app's own.
import { screen } from "electron";
import { electronBannerWindow } from "./banner-window.js";
// mac3/never-break: trying a new version on a copy of the data before an update.
import { snapshotData, updateCanary } from "../never-break/canary.js";
import { appEntryName } from "./release-assets.js";
// mac7/app-icon: the right size of the KeepOak mark for the window, the menu bar and the dock.
import { WINDOW_ICON_SIZE, isTemplateTrayIcon, trayIconScales, trayIconSize } from "./icon-sizes.js";
// mac7/safe-rollback: what an update changes is written down before the hand-over moves anything.
import { recordActivation } from "../install/headless-update.js";
// mac7/win-icon: the taskbar shows the KeepOak mark, not Electron's atom.
import { refreshShortcutsFlag, refreshWindowsIdentity, windowsAppId } from "../install/windows-identity.js";
// Redesign phase 1: asking before a Quit that would stop work (src/desktop/quit-guard.ts).
import { asksBeforeQuit, quitChoice, quitQuestion, runningTaskCount, type QuitReason } from "./quit-guard.js";
import { signedHeaders } from "./signed-headers.js";
// Pass 17: the quick-ask keys, from any app (src/desktop/quick-ask.ts).
import { globalShortcut } from "electron";
import { quickAskKeys, registerQuickAsk } from "./quick-ask.js";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let stop: (() => Promise<void>) | undefined;
let quitting = false;
/* Redesign phase 1: why Branch is quitting, how many tasks are working, and whether an engine in the
   background carries on after this window goes. */
let quitReason: QuitReason = "person";
let runningNow: () => number = () => 0;
let joinedBackground = false;
let askingToQuit = false;

function markPath(): string {
  return fileURLToPath(new URL("../../public/assets/keepoak-mark.png", import.meta.url));
}

/**
 * The window's icon, which Windows and Linux also use for the taskbar. macOS ignores it and takes
 * the dock icon from the `.icns` inside the bundle, so this is only ever the big one.
 */
function branchIcon(): NativeImage {
  return nativeImage
    .createFromPath(markPath())
    .resize({ width: WINDOW_ICON_SIZE, height: WINDOW_ICON_SIZE, quality: "best" });
}

/**
 * The menu-bar or notification-area icon: small, with a sharper copy for a Retina menu bar, and on
 * macOS a template image so the system colours it for a light or a dark menu bar (see icon-sizes.ts).
 */
function trayIcon(): NativeImage {
  const source = nativeImage.createFromPath(markPath());
  const side = trayIconSize(process.platform);
  const image = source.resize({ width: side, height: side, quality: "best" });
  for (const scale of trayIconScales(process.platform)) {
    if (scale === 1) continue;
    const pixels = side * scale;
    const drawn = source.resize({ width: pixels, height: pixels, quality: "best" });
    image.addRepresentation({ scaleFactor: scale, width: pixels, height: pixels, buffer: drawn.toBitmap() });
  }
  if (isTemplateTrayIcon(process.platform)) image.setTemplateImage(true);
  return image;
}

function protectWindow(
  win: BrowserWindow,
  origin: string,
  token: string,
): void {
  const session = win.webContents.session;
  session.on("will-download", (event) => event.preventDefault());
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).origin !== origin });
  });
  // Remembered once: a request can still arrive after the window is gone, and a destroyed
  // window throws on any property access ("Object has been destroyed").
  const contentsId = win.webContents.id;
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const signed =
      details.webContentsId === contentsId &&
      new URL(details.url).origin === origin &&
      new URL(details.url).pathname.startsWith("/api/");
    callback({ requestHeaders: signed ? signedHeaders(details.requestHeaders, token) : { ...details.requestHeaders } });
  });
}

async function createWindow(
  url: string, token: string, settings: DesktopSettings, update: UpdateHooks,
): Promise<void> {
  const statePath = join(app.getPath("userData"), "window-state.json");
  const opening = openingFor(readWindowState(statePath), screen.getAllDisplays().map((display) => display.workArea));
  window = new BrowserWindow({
    width: opening.bounds?.width ?? 1440,
    height: opening.bounds?.height ?? 950,
    ...(opening.bounds ? { x: opening.bounds.x, y: opening.bounds.y } : {}),
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
    title: "Branch Agent",
    // DG-176: no operating-system title bar; the app's own top row is the top of the window.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 16 } } : { titleBarOverlay: overlayFor(true) }),
    backgroundColor: "#03140b",
    show: false,
    icon: branchIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "persist:branch-agent",
    },
  });
  // DG-177: the first launch fills the screen; later ones open the way the owner left the window. The size is put
  // back before maximising and before anything is remembered, so un-maximising returns to it.
  if (opening.bounds) restoreBounds(window, opening.bounds);
  if (opening.maximized) window.maximize();
  const remember = () => {
    if (window && !window.isDestroyed() && !window.isMinimized())
      writeWindowState(statePath, { maximized: window.isMaximized(), bounds: window.getNormalBounds() });
  };
  for (const change of ["maximize", "unmaximize", "resized", "moved", "close"] as const) window.on(change as "resized", remember);
  // "resized" and "moved" come only after a drag, on macOS and Windows, and "close" is skipped when the app is ended
  // rather than its window closed: "resize" and "move" come for every change, so they are written too, once it settles.
  let settle: NodeJS.Timeout | undefined;
  const soon = () => { clearTimeout(settle); settle = setTimeout(remember, 250); };
  window.on("resize", soon);
  window.on("move", soon);
  window.on("closed", () => clearTimeout(settle));
  protectWindow(window, url, token);
  registerWindowLookIpc(ipcMain, window, url);
  registerEditMenu(window, (template) => Menu.buildFromTemplate(template));
  registerSettingsIpc(window, url, settings, process.env.BRANCH_PROVIDER !== undefined);
  registerConversationExportIpc(window, url);
  registerUpdaterIpc(window, url, app.getVersion(), () => { quitReason = "update"; app.quit(); },
    { ...update, readiness: () => updateReadiness(url, token) });
  // Asked for from an open window, so the new copy opens its window too, even after a quiet start.
  registerRestartIpc(ipcMain, window, url, () => {
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== minimizedFlag) });
    quitReason = "restart";
    app.quit();
  });
  registerQuickAsk({ shortcuts: globalShortcut, ipc: ipcMain, window, origin: url, keys: () => quickAskKeys(url, token),
    log: (line) => console.error(line) });
  // Redesign phase 1 (integration review): Windows ending the session never waits for the quit question.
  window.on("query-session-end", () => { quitReason = "system"; });
  window.on("session-end", () => { quitReason = "system"; });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  // "Start quietly in the corner of the taskbar" keeps the window hidden until the tray icon is used.
  window.once("ready-to-show", () => { if (!startsMinimized(process.argv)) window?.show(); });
  await window.loadURL(`${url}/?desktop=1`);
  createTray();
}

/**
 * macOS only: the menu bar every Mac app has. Edit gives copy and paste their usual keys, the app
 * menu gives Cmd+Q, and closing the window keeps Branch in the dock (see the "close" handler).
 * Windows and Linux keep Electron's own menu, hidden by `autoHideMenuBar`, exactly as before.
 */
function setMacMenu(): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "windowMenu" },
  ]));
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("Branch Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Branch Agent",
        click: () => {
          window?.show();
          window?.focus();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => {
    window?.show();
    window?.focus();
  });
}

/**
 * Where this launch keeps its files. A `portable.txt` beside the program makes Branch keep
 * everything next to itself, so the whole assistant travels on a memory stick.
 */
async function folders(base: string): Promise<{ dataDir: string; workspace: string }> {
  const location = await resolveDataLocation(dirname(process.execPath), base);
  return {
    dataDir: process.env.BRANCH_DATA_DIR ?? location.dataDir,
    workspace: process.env.BRANCH_WORKSPACE ?? location.workspace,
  };
}
/**
 * mac7/safe-rollback: the app's Update button writes the same record `branch update --yes` does, so
 * a person who updates from the window can go back afterwards. It stays `staged` until the next
 * start says the swap landed, because this process quits into the hand-over script.
 */
function desktopRecord(dataDir: string): Pick<UpdateHooks, "record"> {
  const installRoot = installedAppRoot(app.isPackaged, process.platform, process.execPath);
  // A copy that cannot update itself never hands over, so there is nothing to write down.
  if (!installRoot) return {};
  return { record: async (stagedDir, toVersion) => {
    const recorded = await recordActivation({ dataDir, installRoot, stagedDir, fromVersion: app.getVersion(),
      toVersion, executableName: appEntryName(process.platform) });
    recorded.close();
  } };
}

/**
 * mac7/win-icon: points this copy's Start-menu and desktop shortcuts, and its Add or remove programs
 * entry, at the KeepOak mark and the app ID (src/install/windows-identity.ts). An update only swaps
 * the program folder, so this runs at every start; it writes nothing when all is already right.
 */
async function refreshWindowsShortcuts(): Promise<void> {
  const installRoot = installedAppRoot(app.isPackaged, process.platform, process.execPath);
  if (process.platform !== "win32" || !installRoot) return;
  await refreshWindowsIdentity({ installRoot, executableName: appEntryName(process.platform), env: process.env }, {
    readShortcut: (path) => shell.readShortcutLink(path),
    updateShortcut: (path, fields) => shell.writeShortcutLink(path, "update", fields),
    exists: existsSync,
  }).catch((error: Error) => console.error("Shortcuts:", error.message));
}

async function start(): Promise<void> {
  const base = app.getPath("userData");
  const settings = await loadDesktopSettings(join(base, "model-settings.json"));
  const { dataDir, workspace } = await folders(base);
  startCrashReporter(dataDir);
  // An engine already working in the background is joined rather than started a second time.
  const running = await attachToRunning(dataDir);
  // Joining an engine means that engine owns the saved work and holds the program files open, so the
  // safety copy is asked of it and it is closed before an update swaps anything.
  joinedBackground = Boolean(running);
  if (running)
    return createWindow(running.url, running.token, settings, {
      backup: () => requestUpdateBackup(running.url, running.token),
      stopDaemon: async () => {
        const report = await stopBackgroundEngine(dataDir, { gracefulOnly: true });
        if (report.pid !== null && !report.stopped) throw new UpdateDeferredError(report.message);
        return report.pid;
      },
      canary: desktopCanary(dataDir, () => engineSnapshot(running.url, running.token)), // mac3/never-break
      ...desktopRecord(dataDir), // mac7/safe-rollback
    });
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(base, "chatgpt-auth.json"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  }), { userAgent: `BranchAgent/${app.getVersion()}` });
  const branch = await createBranch({
    dataDir,
    workspace,
    presets: desktopPresets(settings),
    chatgpt,
    bannerWindow: electronBannerWindow({
      create: (options) => new BrowserWindow(options),
      workArea: () => screen.getPrimaryDisplay().workArea,
    }),
  });
  watchDesktopCrashes(branch);
  runningNow = () => runningTaskCount(branch.store);
  let integrationClose: (() => Promise<void>) | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;
  stop = () =>
    (stopping ??= (async () => {
      try {
        await serverClose?.();
      } finally {
        try {
          await integrationClose?.();
        } finally {
          await branch.close();
        }
      }
    })());
  try {
    const integrations = await loadIntegrations(
      branch.registry,
      process.env.BRANCH_INTEGRATIONS,
      process.env,
      branch.secretsFor,
      branch.channelHost,
    );
    integrationClose = integrations.close;
    branch.browser = integrations.hosted.browser ?? null;
    branch.studies.browser = integrations.hosted.browser; // w911 (A1726) hook: MiniWoB studies open their page in this browser
    branch.issues = integrations.hosted.issues ?? null;
    // Q45 leaf 0: the same port as last time when it is free, so the page's own stored choices survive a restart.
    const portFile = join(dataDir, "local-port.json"); // in the data folder, which the assistant may never change
    const server = await startServer(branch, {
      dataDir, port: await rememberedPort(portFile), anyPortIfTaken: true, presence: "app",
      executable: app.isPackaged ? process.execPath : null,
      installRoot: installedAppRoot(app.isPackaged, process.platform, process.execPath),
      // "Start when you log in" on a Mac is the app's own login item; Windows keeps its per-person sign-in list.
      ...(app.isPackaged && process.platform === "darwin" ? { loginItem: macLoginItem(app) } : {}),
      quit: () => { quitReason = "command"; app.quit(); }, // bucket 22: `branch quit` is the same as Quit in the menu (bounded shutdown below)
    });
    rememberPort(portFile, server.url);
    serverClose = server.close;
    await createWindow(server.url, server.token, settings, {
      backup: () =>
        writeUpdateBackup(dataDir, branch.store.backup(branch.version), branch.version).then(() => undefined),
      // mac3/never-break: the new version is tried on a copy of this data before it is used.
      canary: desktopCanary(dataDir, () => snapshotData({ dataDir, database: branch.store.sqlite, journal: branch.neverBreak.journal.database })),
      ...desktopRecord(dataDir), // mac7/safe-rollback
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Shutting down waits for the loopback server and open work, but never for long: an update
 * hand-over depends on this process actually ending.
 */
function shutDown(): void {
  quitting = true;
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 8000).unref());
  void Promise.race([(stop?.() ?? Promise.resolve()), deadline])
    .catch((error) => console.error("Shutdown:", error.message))
    .finally(() => {
      tray?.destroy();
      app.exit(0);
    });
}
/** Redesign phase 1: work is running and nothing would carry it on, so the person decides. */
async function askThenQuit(): Promise<void> {
  askingToQuit = true;
  try {
    const question = quitQuestion(runningNow());
    const parent = window?.isVisible() ? window : undefined;
    const { response } = parent ? await dialog.showMessageBox(parent, question) : await dialog.showMessageBox(question);
    const choice = quitChoice(response);
    if (quitting) return; // an update, `branch quit` or the computer shutting down came first
    if (choice === "quit") return shutDown();
    if (choice === "keep") window?.hide();
    else { window?.show(); window?.focus(); }
    quitReason = "person";
  } finally {
    askingToQuit = false;
  }
}

/**
 * mac7/diagnostics: Electron's crash reporter keeps crash files (minidumps) on this computer only;
 * uploading is switched off (src/diagnostic-log.ts). "Report a problem" lists them, never sends them.
 * mac7/coding-next: only when the owner switched crash capture on. The switch is read here, at start,
 * before any window exists, so a change applies at the next start.
 */
function startCrashReporter(dataDir: string): void {
  const options = crashReporterPlan(dataDir);
  if (!options) return;
  try {
    crashReporter.start(options);
    process.env.BRANCH_CRASH_DUMPS = app.getPath("crashDumps");
  } catch { /* a crash reporter that will not start must never stop the app */ }
}

/**
 * When the window or one of Electron's helper programs dies, that happens in another process, so
 * nothing the engine listens for ever hears about it. Electron tells this process instead, over
 * its own IPC; each report is written into the same record of failures the engine keeps, with the
 * part of the app it came from on it. Nothing here changes what Electron then does.
 */
function watchDesktopCrashes(branch: { store: { spans: SpanStore }; runtime: { owner: string; hideSecrets(value: string): string } }): void {
  const record = (where: string, message: string, stack?: string) => {
    diagnose(where === "window" ? "window" : "helper", "error", message); // mac7/diagnostics
    recordDesktopCrash(branch.store.spans, branch.runtime.owner,
      (value) => branch.runtime.hideSecrets(value), { where, message, ...(stack === undefined ? {} : { stack }) });
  };
  app.on("render-process-gone", (_event, _contents, details) =>
    record("window", `The window stopped: ${details.reason}${details.exitCode ? ` (code ${details.exitCode})` : ""}`));
  app.on("child-process-gone", (_event, details) =>
    record(details.type || "helper", `A helper program stopped: ${details.reason}${details.exitCode ? ` (code ${details.exitCode})` : ""}`));
}

/** mac3/never-break: the update's canary step for this computer (src/never-break/canary.ts). */
function desktopCanary(dataDir: string, snapshot: () => Promise<string>) {
  return updateCanary({ dataDir, platform: process.platform, executableName: appEntryName(process.platform),
    fromVersion: app.getVersion(), target: installedAppRoot(app.isPackaged, process.platform, process.execPath), snapshot });
}
/** mac3/never-break: asks the background engine, which holds the database, for a copy of it. */
async function engineSnapshot(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/api/never-break/snapshot`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(120000) });
  const body = await response.json().catch(() => null) as { folder?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.folder !== "string") throw new Error(typeof body?.error === "string" ? body.error : "The background engine did not make a copy of your work.");
  return body.folder;
}

function desktopProvider(settings: DesktopSettings) {
  if (process.env.BRANCH_PROVIDER !== undefined) return providerFromEnv();
  try {
    return providerFromEnv(settings.environment());
  } catch {
    settings.reportConnectionIssue();
    return null;
  }
}
/** The saved connection as the one preset, or none: then every message is refused in plain words until a model is set up. */
function desktopPresets(settings: DesktopSettings) {
  const provider = desktopProvider(settings);
  return provider ? [defaultPreset(provider, settings.summary().model || undefined)] : [];
}

app.setName("Branch Agent");
// mac7/win-icon: before any window, so the taskbar files every window under Branch's own ID (the
// one its shortcuts carry) instead of guessing from the program file, which is Electron's.
if (process.platform === "win32") app.setAppUserModelId(windowsAppId);
if (process.env.BRANCH_DESKTOP_HOME)
  app.setPath("userData", process.env.BRANCH_DESKTOP_HOME);
if (process.argv.includes(refreshShortcutsFlag)) {
  // The installer's one-off request: put the shortcuts right and quit, touching nothing else.
  void app.whenReady().then(refreshWindowsShortcuts).finally(() => app.exit(0));
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => window?.show());
  app.on("will-quit", () => globalShortcut.unregisterAll()); // pass 17: quick-ask keys go with the app
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    // Integration review: an update, `branch quit` or the computer shutting down while the question is
    // open quits at once; only another Quit from the person waits for the question already showing.
    if (asksBeforeQuit({ reason: quitReason, runningTasks: runningNow(), engineInBackground: joinedBackground })) {
      if (!askingToQuit) void askThenQuit();
      return;
    }
    shutDown();
  });
  // macOS and Linux say so before the computer shuts down, restarts or signs out: never ask then.
  void app.whenReady().then(() => powerMonitor.on("shutdown", () => { quitReason = "system"; }));
  void app
    .whenReady()
    .then(async () => { setMacMenu(); await refreshWindowsShortcuts(); return start(); })
    .catch((error) => {
      console.error("Branch Agent could not start:", error.message);
      app.quit();
    });
}
