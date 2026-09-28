import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  MenuItem,
  powerMonitor,
  Tray,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Wave 5 (deployment): portable folders, joining a background engine, opening straight to the tray.
import { resolveDataLocation } from "../install/layout.js";
import { attachToRunning } from "../install/running.js";
import { requestUpdateBackup, stopBackgroundEngine } from "../install/background-engine.js";
import { installedAppRoot } from "./install-root.js";
import { minimizedFlag, startsMinimized } from "../install/autostart.js";
import { macLoginItem } from "./login-item.js";
import { providerFromEnv } from "../providers.js";
import { loadDesktopSettings, registerSettingsIpc } from "./settings-ipc.js";
import { registerUpdaterIpc, updateScratchDir, type UpdateHooks } from "./updater-ipc.js";
import { markStarted, UpdateDeferredError } from "./updater.js";
import { updateReadiness } from "./update-readiness.js";
import { FileTokenVault } from "../chatgpt-auth.js";
import { safeStorage } from "electron";
import { crashReporter } from "electron"; // mac7/diagnostics
import { crashReporterPlan } from "../diagnostic-log.js"; // mac7/diagnostics, mac7/coding-next
import type { DesktopSettings } from "./settings.js";
import { registerConversationExportIpc } from "./conversation-export-ipc.js";
// 0.18.1: "Branch stopped responding — Restart" relaunches the app, and with it the local server.
import { ipcMain } from "electron";
import { registerRestartIpc } from "./restart-ipc.js";
import { minimumSize, openingFor, readWindowState, restoreBounds, writeWindowState } from "./window-state.js";
import { overlayFor, registerWindowLookIpc } from "./window-chrome-ipc.js";
import { registerEditMenu } from "./context-menu.js";
import { appMenuTemplate, helpChannel, type HelpItem } from "./app-menu.js";
// mac2/desktop-ui: the Stop notice for screen control on macOS and Linux is a window of this app's own.
import { screen } from "electron";
import { electronBannerWindow } from "./banner-window.js";
import { release as osRelease } from "node:os";
import { captureService } from "./capture-service.js"; // computer-control: Branch's windows never appear in its own computer view
// mac3/never-break: trying a new version on a copy of the data before an update.
import { stagedEngine, updateCanary } from "../never-break/canary.js";
import { runStagedSmoke, smokeReportPath } from "./beta-smoke.js";
import { appEntryName } from "./release-assets.js";
// mac7/app-icon: the right size of the mascot for the window, the menu bar and the dock.
import { WINDOW_ICON_SIZE, isTemplateTrayIcon, trayIconScales, trayIconSize } from "./icon-sizes.js";
// mac7/safe-rollback: what an update changes is written down before the hand-over moves anything.
// It is loaded when an update is recorded: its store and backup code would otherwise sit in this process all day.
// mac7/win-icon: the taskbar shows the mascot, not Electron's atom.
import { refreshShortcutsFlag, refreshWindowsIdentity, windowsAppId } from "../install/windows-identity.js";
// Redesign phase 1: asking before a Quit that would stop work (src/desktop/quit-guard.ts).
import { asksBeforeQuit, quitChoice, quitQuestion, type QuitReason } from "./quit-guard.js";
import { sameAppOrigin, signedHeaders, windowKeyReader } from "./signed-headers.js";
import { ownDownload } from "./own-download.js";
import { registerClipboardFilesIpc } from "./clipboard-files-ipc.js";
import { registerShowInFolderIpc } from "./show-in-folder-ipc.js"; // dogfood-ux-3
import { isPasteKeys, PasteGate } from "./clipboard-paths.js";
// Talk live: the microphone, only for a call the owner started (src/desktop/talk-live-mic.ts).
import { registerTalkLiveMicIpc, TalkLiveMic } from "./talk-live-mic.js";
// Pass 17: the quick-ask keys, from any app (src/desktop/quick-ask.ts).
import { globalShortcut } from "electron";
import { quickAskKeys, registerQuickAsk } from "./quick-ask.js";
// The engine runs in a process of its own, so nothing it does can freeze the window (src/desktop/engine-host.ts).
import { utilityProcess } from "electron";
import { EngineHost } from "./engine-host.js";
import { BannerNoticeSchema, type EngineConfig } from "./engine-link.js";
import { z } from "zod";
import { builtFrom } from "./build-identity.js";

const BannerOpenSchema = z.object({ bannerId: z.number().int().positive(), notice: BannerNoticeSchema.optional() }).strict();

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let stop: (() => Promise<void>) | undefined;
let quitting = false;
/* Redesign phase 1: why Branch is quitting, how many tasks are working, and whether an engine in the
   background carries on after this window goes. */
let quitReason: QuitReason = "person";
let runningNow: () => Promise<number> = async () => 0;
/** The engine's own process, when this window started one (not when it joined a background engine). */
let engine: EngineHost | undefined;
/** computer-control: lets go of every capture lease the current engine holds (src/desktop/capture-service.ts). */
let closeCapture: () => void = () => undefined;
let joinedBackground = false;
let askingToQuit = false;
let countingToQuit = false;

/** Branch's mascot: the whole of it for the window, its face for the small tray (scripts/make-icons.mjs). */
function markPath(small = false): string {
  const file = small ? "branch-face.png" : "branch-mascot.png";
  return fileURLToPath(new URL(`../../public/assets/${file}`, import.meta.url));
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
  // A template image is drawn from its outline alone: the whole mascot's branches and orbs make one
  // that reads, where the face crop would be a plain round blob.
  const source = nativeImage.createFromPath(markPath(!isTemplateTrayIcon(process.platform)));
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
  /** The window's key as it is now: removing a phone that was handed it replaces it. */
  key: () => string,
  mic: TalkLiveMic,
  /**
   * Whether the engine is answering at the window's address right now. While the app's own engine is starting again,
   * its port is free and another program could take it, so nothing is sent there (above all not the key) until then.
   */
  reachable: () => boolean,
): void {
  const session = win.webContents.session;
  // attach-anything: a file the page itself hands over (a file somebody attached, saved from the conversation) is let
  // through with the system's save dialog; every other download stays refused.
  session.on("will-download", (event, item) => { if (!item || !ownDownload(item.getURL(), origin)) event.preventDefault(); });
  // Every permission is refused, except the microphone for a Talk live call the owner has just started.
  session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(mic.take(contents.id, permission, details as { requestingUrl?: string; mediaTypes?: string[] })),
  );
  session.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  // A task's socket (ws://) is at the window's own address too, so it is let through and signed like /api/ requests.
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !sameAppOrigin(details.url, origin) || !reachable() });
  });
  // Remembered once: a request can still arrive after the window is gone, and a destroyed
  // window throws on any property access ("Object has been destroyed").
  const contentsId = win.webContents.id;
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const signed =
      details.webContentsId === contentsId &&
      sameAppOrigin(details.url, origin) && reachable() &&
      new URL(details.url).pathname.startsWith("/api/");
    callback({ requestHeaders: signed ? signedHeaders(details.requestHeaders, key()) : { ...details.requestHeaders } });
  });
}

async function createWindow(
  url: string, key: () => string, settings: DesktopSettings, update: UpdateHooks, reachable: () => boolean = () => true,
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
    // Started in the tray, the page stays hidden until the window is first shown: otherwise it counts as visible and
    // draws, decodes its loops and holds its tiles for a window nobody can see.
    paintWhenInitiallyHidden: !startsMinimized(process.argv),
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
  // Maximising shows a hidden window, so a quiet start in the tray maximises it only once it is opened.
  if (opening.maximized && startsMinimized(process.argv)) window.once("show", () => window?.maximize());
  else if (opening.maximized) window.maximize();
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
  const mic = new TalkLiveMic(url, window.webContents.id);
  protectWindow(window, url, key, mic, reachable);
  registerTalkLiveMicIpc(ipcMain, window, url, mic);
  registerWindowLookIpc(ipcMain, window, url);
  // attach-anything: the clipboard's files go to the page only just after a paste the person made here: the keys,
  // seen before the page sees them, or the right-click menu's Paste (Electron's own label and keys).
  const pasteGate = new PasteGate();
  const main = window;
  main.webContents.on("before-input-event", (_event, input) => { if (isPasteKeys(input, process.platform)) pasteGate.arm(); });
  // The paste goes where the person is (the focused window); the check opens only when that is this window's page.
  const pasteItem = (enabled: boolean): MenuItemConstructorOptions => {
    const standard = new MenuItem({ role: "paste" });
    return { label: standard.label, accelerator: standard.accelerator ?? "CommandOrControl+V", enabled,
      click: () => {
        const target = (BrowserWindow.getFocusedWindow() ?? (main.isDestroyed() ? null : main))?.webContents;
        if (!target) return; // no window open (a Mac keeps the app running): nothing to paste into
        if (!main.isDestroyed() && target === main.webContents) pasteGate.arm();
        target.paste();
      } };
  };
  registerEditMenu(window, (template) => Menu.buildFromTemplate(template), pasteItem);
  // Edit › Paste chosen with the mouse goes through the same paste check as the keys, on every system. Off the Mac the
  // keys reach the page themselves (and open the check before it, above), so the menu only shows them.
  // Help opens its page in this window, brought to the front (attach-4).
  const help = (item: HelpItem) => {
    if (main.isDestroyed()) return;
    main.show();
    main.focus();
    main.webContents.send(helpChannel, item);
  };
  setAppMenu({ ...pasteItem(true), ...(process.platform === "darwin" ? {} : { registerAccelerator: false }) }, help);
  registerSettingsIpc(window, url, settings, process.env.BRANCH_PROVIDER !== undefined);
  registerConversationExportIpc(window, url);
  registerClipboardFilesIpc(window, url, key, pasteGate);
  registerShowInFolderIpc(window, url, key);
  registerUpdaterIpc(window, url, app.getVersion(), () => { quitReason = "update"; app.quit(); },
    { ...update, readiness: async () => updateReadiness(url, key()) });
  // Asked for from an open window, so the new copy opens its window too, even after a quiet start.
  registerRestartIpc(ipcMain, window, url, () => {
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== minimizedFlag) });
    quitReason = "restart";
    app.quit();
  });
  registerQuickAsk({ shortcuts: globalShortcut, ipc: ipcMain, window, origin: url, keys: async () => quickAskKeys(url, key()),
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
  // Q249 (R21's Windows runs): on a second start the page can move on by itself while it first loads (a reload for the
  // saved look), and Electron then rejects this load with ERR_ABORTED although the window is up and working. That was
  // taken as "could not start": the app quit mid-start and the quit question froze it. Only a real failure stops it now.
  await window.loadURL(`${url}/?desktop=1`).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== "ERR_ABORTED") throw error;
  });
  createTray();
}

/**
 * The menu bar (src/desktop/app-menu.ts): on a Mac the one every Mac app has (Edit gives copy and paste their usual
 * keys, the app menu gives Cmd+Q, and closing the window keeps Branch in the dock, see the "close" handler); on Windows
 * and Linux the one Electron gives, hidden by `autoHideMenuBar`. Either way its Paste is the app's, once a window is
 * open; before that a Mac shows Electron's own Paste, and Windows and Linux keep Electron's own menu. Help comes with
 * the window it opens its pages in.
 */
function setAppMenu(paste?: MenuItemConstructorOptions, help?: (item: HelpItem) => void): void {
  if (!paste && process.platform !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, paste ?? { role: "paste" }, help)));
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
 * Beta builds in a folder of its own that is kept between builds, so a normal merge takes minutes: the data folder's
 * `updates/`, which the assistant may never change (src/never-break/protected.ts) and the copy of the data folder
 * taken before each update leaves out (src/install/data-copy.ts).
 */
const betaBuildDir = (dataDir: string): string => join(dataDir, "updates", "beta-build");
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
    const { recordActivation } = await import("../install/headless-update.js");
    const recorded = await recordActivation({ dataDir, installRoot, stagedDir, fromVersion: app.getVersion(),
      toVersion, executableName: appEntryName(process.platform) });
    recorded.close();
  } };
}

/**
 * mac7/win-icon: points this copy's Start-menu and desktop shortcuts, and its Add or remove programs
 * entry, at the mascot and the app ID (src/install/windows-identity.ts). An update only swaps
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
  // The background engine saves a new key when a phone that was handed it is removed; it is read again each time.
  const runningKey = running ? windowKeyReader(dataDir, running.token) : null;
  // Beta channel: which change this copy was built from, found once here (git is asked without waiting on it).
  const commit = await builtFrom(app.getAppPath(), app.isPackaged);
  if (running && runningKey)
    return createWindow(running.url, runningKey, settings, {
      backup: () => requestUpdateBackup(running.url, runningKey()),
      stopDaemon: async () => {
        const report = await stopBackgroundEngine(dataDir, { gracefulOnly: true });
        if (report.pid !== null && !report.stopped) throw new UpdateDeferredError(report.message);
        return report.pid;
      },
      canary: desktopCanary(dataDir, () => engineSnapshot(running.url, runningKey())), // mac3/never-break
      tryOut: betaTryOut,
      ...desktopRecord(dataDir), // mac7/safe-rollback
      buildDir: betaBuildDir(dataDir),
      currentCommit: commit,
    });
  const url = await startEngine(base, settings, { dataDir, workspace });
  // The key, and anything main sends, go only to an engine answering at the window's address: while the engine starts
  // again, main's own requests are refused before anything is sent (the window's are held in protectWindow).
  const reachable = () => engine?.servingAt === url;
  const key = () => {
    if (!engine || !reachable()) throw new Error("Branch is starting its engine again. Try again in a moment.");
    return engine.token;
  };
  await createWindow(url, key, settings, {
    // The rows' safety copy, then the whole data folder, both made by the engine that holds the database.
    backup: async () => requestUpdateBackup(url, key()),
    // mac3/never-break: the new version is tried on a copy of this data before it is used.
    canary: desktopCanary(dataDir, async () => engineSnapshot(url, key())),
    tryOut: betaTryOut,
    ...desktopRecord(dataDir), // mac7/safe-rollback
    buildDir: betaBuildDir(dataDir),
    currentCommit: commit,
  }, reachable).catch(async (error: unknown) => {
    await engine?.stop();
    throw error;
  });
  // selfdev: the engine and the window are up; a Beta update waiting to see this keeps the new version (updater.ts).
  void markStarted(updateScratchDir(), app.getVersion()).catch(() => undefined);
}

/**
 * Starts the engine in a process of its own (src/desktop/engine-process.ts) and waits for its address. Main keeps
 * only what needs Electron: the device's key store (the saved model key and the ChatGPT sign-in), the Stop notice's
 * window, the Mac login item and quitting. When the engine stops by itself it is started again; the window shows
 * that it is reconnecting meanwhile.
 */
async function startEngine(base: string, settings: DesktopSettings, where: { dataDir: string; workspace: string }): Promise<string> {
  const chatgpt = new FileTokenVault(join(base, "chatgpt-auth.json"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const loginItem = app.isPackaged && process.platform === "darwin" ? macLoginItem(app) : null;
  const config: EngineConfig = {
    ...where, providerEnv: desktopProviderEnv(settings), version: app.getVersion(),
    executable: app.isPackaged ? process.execPath : null,
    installRoot: installedAppRoot(app.isPackaged, process.platform, process.execPath),
    packaged: app.isPackaged, loginItem: loginItem ? loginItem.read() : null,
    appPid: process.pid,
    testHooks: !app.isPackaged && process.env.BRANCH_TEST_ENGINE_HOOKS === "1",
  };
  const banners = new Map<number, { close(): void }>();
  const showBanner = electronBannerWindow({
    create: (options) => new BrowserWindow(options),
    workArea: () => screen.getPrimaryDisplay().workArea,
  });
  // computer-control: the engine asks main to hide every Branch window from screen capture while a computer view is open
  // (Windows WDA_EXCLUDEFROMCAPTURE through setContentProtection). Main decides which windows; the engine names none.
  closeCapture();
  const capture = captureService({
    platform: process.platform, release: osRelease(), processId: process.pid, windows: () => BrowserWindow.getAllWindows(),
    onCreated: (listener) => {
      const created = (_event: unknown, created: BrowserWindow) => listener(created);
      app.on("browser-window-created", created);
      return () => { app.off("browser-window-created", created); };
    },
  });
  closeCapture = () => { try { capture.close(); } catch (error) { console.error("Capture cleanup:", error); } };
  const host = new EngineHost({
    fork: () => utilityProcess.fork(fileURLToPath(new URL("./engine-process.js", import.meta.url)), [],
      { serviceName: "Branch Agent engine", stdio: "inherit" }),
    config,
    handlers: {
      "vault-read": () => chatgpt.read(),
      "vault-write": (tokens) => chatgpt.write(tokens as Parameters<FileTokenVault["write"]>[0]),
      "vault-clear": () => chatgpt.clear(),
      "capture-acquire": (args) => capture.acquire(args),
      "capture-release": (args) => capture.release(args),
      "banner-open": async (args) => {
        const { bannerId, notice } = BannerOpenSchema.parse(args);
        const shown = await showBanner(() => { banners.delete(bannerId); host.tell(`banner-closed:${bannerId}`); }, notice);
        banners.set(bannerId, shown);
        return true;
      },
      "banner-close": (args) => { banners.get(Number((args as { bannerId?: unknown } | undefined)?.bannerId))?.close(); return true; },
      "login-item-set": (args) => {
        if (!loginItem) throw new Error("Not available here");
        return loginItem.set((args as { enabled: unknown }).enabled === true);
      },
      // bucket 22: `branch quit` is the same as Quit in the menu (bounded shutdown below).
      quit: () => { quitReason = "command"; app.quit(); },
    },
    // A stopped engine's leases die with it, so Branch's windows are not left hidden from capture after it has gone.
    onGone: (code) => { closeCapture(); console.error(`The engine stopped (code ${code}); starting it again.`); },
    onBack: (url) => {
      // The engine's own stop is written into its record of failures, as a window's or helper's is.
      void host.call("crash", { where: "engine", message: "The engine stopped and was started again" }).catch(() => undefined);
      // Back at another address (its port was taken meanwhile): the window's page belongs to the old one, so the
      // whole app starts again, which opens the window at the new address.
      if (url !== host.url) { app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== minimizedFlag) }); quitReason = "restart"; app.quit(); return; }
      // A page that went away meanwhile (its reload was held back while the engine was down) is opened again.
      if (window && !window.isDestroyed() && new URL(window.webContents.getURL() || "about:blank").origin !== url)
        void window.loadURL(`${url}/?desktop=1`).catch((error: Error) => console.error("Window:", error.message));
    },
    log: (line) => console.error(line),
  });
  engine = host;
  // An engine too busy to answer in time still has work running: the last count it told is used then. Only an engine
  // that is not running at all has none.
  runningNow = () => host.call<number>("running-count", undefined, 5000).then(Number)
    .catch(() => (host.running ? host.lastRunning : 0));
  stop = () => host.stop(7000);
  watchDesktopCrashes(host);
  if (config.testHooks) (globalThis as { branchEngineForTests?: EngineHost }).branchEngineForTests = host;
  return host.start();
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
    // The engine's process holds the program files open and a hand-over waits only for this process, so the engine is
    // ended first and this waits (briefly) until it has really gone.
    .finally(() => (engine?.end(2000) ?? Promise.resolve()))
    .finally(() => {
      tray?.destroy();
      app.exit(0);
    });
}
/** Redesign phase 1: work is running and nothing would carry it on, so the person decides. */
async function askThenQuit(runningTasks: number): Promise<void> {
  askingToQuit = true;
  try {
    const question = quitQuestion(runningTasks);
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
function watchDesktopCrashes(host: EngineHost): void {
  // The engine writes it down (src/desktop/engine-process.ts); an engine that is itself restarting misses it.
  const record = (where: string, message: string) => { void host.call("crash", { where, message }).catch(() => undefined); };
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
/**
 * Beta: the staged new version started for real, hidden, on a folder of its own in this computer's temporary folder
 * (src/desktop/beta-smoke.ts); never the owner's data. Answers the owner's sentence when it failed, or null.
 */
function betaTryOut(stagedDir: string): Promise<string | null> {
  const { executable } = stagedEngine(stagedDir, process.platform, appEntryName(process.platform));
  return runStagedSmoke({ executable, args: [] }, join(app.getPath("temp"), "branch-agent-try-out"), process.env);
}
/** mac3/never-break: asks the background engine, which holds the database, for a copy of it. */
async function engineSnapshot(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/api/never-break/snapshot`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(120000) });
  const body = await response.json().catch(() => null) as { folder?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.folder !== "string") throw new Error(typeof body?.error === "string" ? body.error : "The background engine did not make a copy of your work.");
  return body.folder;
}

/**
 * The saved connection, unlocked with the device's key store, as the provider variables the engine makes its one
 * preset from; null for none, and then every message is refused in plain words until a model is set up. A launch
 * environment that names a provider wins, and the engine reads that from its own environment.
 */
function desktopProviderEnv(settings: DesktopSettings): Record<string, string> | null {
  if (process.env.BRANCH_PROVIDER !== undefined) return null;
  try {
    const env = settings.environment();
    if (!providerFromEnv(env)) return null; // checked here, so a connection that cannot open is reported in Settings
    return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
  } catch {
    settings.reportConnectionIssue();
    return null;
  }
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
} else if (smokeReportPath(process.argv)) {
  // A Beta try-out of this version (src/desktop/beta-smoke.ts): its own engine, folder and hidden window, then quit.
  // It never takes the single-instance lock, so the version that started it keeps running.
  const report = smokeReportPath(process.argv)!;
  app.on("window-all-closed", () => undefined);
  // Loaded only here: the try-out starts an engine of its own, and its code would otherwise sit in every window's process.
  void app.whenReady().then(() => import("./beta-smoke-window.js")).then(({ smokeMode }) => smokeMode(report, app.getVersion()))
    .then((code) => app.exit(code), () => app.exit(1));
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => window?.show());
  app.on("will-quit", () => { globalShortcut.unregisterAll(); closeCapture(); }); // pass 17: quick-ask keys go with the app; computer-control: and capture leases
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    // Integration review: an update, `branch quit` or the computer shutting down while the question is
    // open quits at once; only another Quit from the person waits for the question already showing.
    if (quitReason !== "person" || joinedBackground) return shutDown();
    // The engine is asked how many tasks are working (never longer than a few seconds, and none when it cannot say).
    if (countingToQuit || askingToQuit) return;
    countingToQuit = true;
    void runningNow().then((runningTasks) => {
      countingToQuit = false;
      if (quitting) return;
      if (asksBeforeQuit({ reason: quitReason, runningTasks, engineInBackground: joinedBackground })) {
        if (!askingToQuit) void askThenQuit(runningTasks);
        return;
      }
      shutDown();
    });
  });
  // macOS and Linux say so before the computer shuts down, restarts or signs out: never ask then.
  void app.whenReady().then(() => powerMonitor.on("shutdown", () => { quitReason = "system"; }));
  void app
    .whenReady()
    .then(async () => { setAppMenu(); await refreshWindowsShortcuts(); return start(); })
    .catch((error) => {
      console.error("Branch Agent could not start:", error.message);
      app.quit();
    });
}
