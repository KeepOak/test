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
import { existsSync, readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Wave 5 (deployment): portable folders, joining a background engine, opening straight to the tray.
import { resolveDataLocation } from "../install/layout.js";
import { attachToRunning } from "../install/running.js";
import { requestUpdateBackup, stopBackgroundEngine } from "../install/background-engine.js";
import { installedAppRoot } from "./install-root.js";
import { minimizedFlag, startsMinimized } from "../install/autostart.js";
import { takeShellLock } from "./shell-lock.js";
import { providerFromEnv } from "../providers.js";
import { loadDesktopSettings, registerSettingsIpc } from "./settings-ipc.js";
import { registerUpdaterIpc, updateScratchDir, type UpdateHooks } from "./updater-ipc.js";
import { markStarted, UpdateDeferredError, UpdateStuckError, type Updater } from "./updater.js";
import { updatePlanFrom, updateReadiness } from "./update-readiness.js";
import { logoShare, readTrayUsage, trayBitmap, trayTip, type TrayUsage } from "./tray-ring.js";
import { crashReporter } from "electron"; // mac7/diagnostics
import { crashReporterPlan, diagnose } from "../diagnostic-log.js"; // mac7/diagnostics, mac7/coding-next
import { openMainLog } from "./main-log.js";
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
import type { UtilityProcess } from "electron";
import { desktopEngineServices, forkDesktopEngine } from "./engine-services.js";
import { followPower } from "./engine-power.js";
import { EngineHost } from "./engine-host.js";
// hot-update: Beta changes main does not load are applied live, and the window takes them in place.
import { liveAtStart, liveHooks, runningChange } from "./hot-apply.js";
import { registerLiveWindowIpc, type Cover, type WindowUpdate } from "./live-window-ipc.js";
import type { InUse } from "../hot-update/live-folder.js";
import { fallbackRepo } from "./repo-pair.js";
import type { EngineConfig } from "./engine-link.js";
import { engineBroker } from "./engine-broker.js";
import { builtFrom } from "./build-identity.js";
// The window's key goes only to an engine that proved it is the engine (src/engine-proof.ts, src/desktop/engine-gate.ts).
import { askHeader, proveOnce, sessionKey } from "../engine-proof.js";
import { AnswerCheck } from "./answer-check.js";
import { EngineClient, startingAgain, webResponse } from "./engine-client.js";
import { EnginePage } from "./engine-page.js";
import { Readable } from "node:stream";
import { EngineGate, type EngineAccess } from "./engine-gate.js";
import { RequestHold } from "./request-hold.js";
import { readRunning, type Attachment } from "../install/running.js";
import { moveOldEngine } from "../install/old-engine.js";
import { desktopGatewayConfig } from "./gateway-mode.js";
import { desktopGatewayFlag, GatewayLaunchError, joinedEngineVerdict, launchDesktopGateway } from "./gateway-launch.js";
import { launchSupervisedGateway, windowsGatewaySupervision } from "./gateway-supervised.js";
import type { WriteShortcut } from "../install/gateway-task.js";
import { keepRunningThroughErrors } from "./engine-errors.js";
import { runDesktopGateway } from "./gateway-desktop.js";
import { joinedGatewayLive } from "./gateway-client.js";
import { rollBackPointer, versionedLayout } from "./app-folders.js";
import { goingBackIsSafe, systemDeps } from "./version-switch.js";
import { failureName, shellUpMarker } from "./shell-switch.js";
import { storeMigrations } from "../never-break/migrations.js";
import { forwardedVariable, forwardTarget, guardedForward, handOverHook, resumeWindow, sameInstall, settleLayout } from "./shell-window.js";
import { portableMarker } from "../install/layout.js";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayTimer: NodeJS.Timeout | undefined;
let stop: (() => Promise<void>) | undefined;
let quitting = false;
/* Redesign phase 1: why Branch is quitting, how many tasks are working, and whether an engine in the
   background carries on after this window goes. */
let quitReason: QuitReason = "person";
let runningNow: () => Promise<number> = async () => 0;
/** The engine's own process, when this window started one (not when it joined a background engine). */
let engine: EngineHost | undefined;
/** hot-update: the live build whose window files the engine serves (null: its own), and how the open window is told. */
let liveWindowNow: InUse | null = null;
let tellWindow: (update: WindowUpdate) => Promise<void> = () => Promise.reject(new UpdateDeferredError("The window is not open yet."));
let recoverWindow: () => Promise<void> = () => Promise.resolve();
/**
 * hot-update: with no window open (none yet, as after a start in the tray, or closed for good) there is no page to tell
 * or restore, so a live update goes ahead: the next window opens on the files served then. A window that is open but
 * cannot take the update still holds it (tellWindow defers).
 */
const noWindowOpen = (): boolean => !window || window.isDestroyed();
const tellOpenWindow = (update: WindowUpdate): Promise<void> => noWindowOpen() ? Promise.resolve() : tellWindow(update);
const recoverOpenWindow = (): Promise<void> => noWindowOpen() ? Promise.resolve() : recoverWindow();
let closeCapture: () => void = () => undefined;
/** Tells the engine whether the window is shown, so a chat's answer can say where Branch is (src/environment.ts). */
function tellWindowShown(): void {
  if (window && !window.isDestroyed()) engine?.tell("window", { shown: window.isVisible() && !window.isMinimized() });
}
let joinedBackground = false;
/**
 * The update closed (or is closing) the background engine the window joined, to swap the program files. Until the
 * hand-over has this process quit, that engine being gone is the update, not a reason to start Branch again: a restart
 * would run the old program from the folder being swapped. An install that fails gives the updater back, and then it is.
 */
let closingForUpdate = false;
let updater: Updater | undefined;
const handingOver = (): boolean => closingForUpdate && updater?.inProgress === true;
let askingToQuit = false;
let countingToQuit = false;
/** Whether the app's own engine has proved itself at the window's address (src/desktop/engine-gate.ts). */
let engineGate: EngineGate | undefined;
/** Test builds only: an unpackaged copy started with BRANCH_TEST_ENGINE_HOOKS=1 lets a test see the engine and its gate. */
/** Windows: where this copy's versions sit (app-folders.ts); null for a portable copy, other systems, or source. */
const appLayout = () => (app.isPackaged ? versionedLayout(process.execPath, process.platform, existsSync(join(dirname(process.execPath), portableMarker))) : null);
const testHooksOn = (): boolean => !app.isPackaged && process.env.BRANCH_TEST_ENGINE_HOOKS === "1";
/**
 * hot-update: the program's own folder, which holds its live builds. A test copy (never a packaged app) may name a folder
 * of its own inside the checkout, so tests do not share one; the packages are still found above it.
 */
const liveAppRoot = (): string => (testHooksOn() && process.env.BRANCH_TEST_LIVE_ROOT) || app.getAppPath();

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

/** The tray icon with its usage ring (./tray-ring.ts), at every size trayIcon() draws; the logo alone without a share. */
function trayImageFor(usage: TrayUsage | null): NativeImage {
  if (!usage) return trayIcon();
  const template = isTemplateTrayIcon(process.platform);
  const source = nativeImage.createFromPath(markPath(!template));
  const draw = (side: number): Buffer => {
    const logoSide = Math.round(side * logoShare);
    return trayBitmap(side, source.resize({ width: logoSide, height: logoSide, quality: "best" }).toBitmap(), logoSide, usage.percentLeft, template);
  };
  const side = trayIconSize(process.platform);
  const image = nativeImage.createFromBitmap(draw(side), { width: side, height: side });
  for (const scale of trayIconScales(process.platform))
    if (scale !== 1) image.addRepresentation({ scaleFactor: scale, width: side * scale, height: side * scale, buffer: draw(side * scale) });
  if (template) image.setTemplateImage(true);
  return image;
}

/** Reads what the connection in use has left once a minute, and redraws the tray only when that changed. Nothing (above
    all not the key) is sent while the engine is not answering at the window's address. */
function watchTrayUsage(url: string, key: () => string, reachable: () => boolean): void {
  let shown = "";
  const look = async () => {
    if (!reachable()) return;
    const usage = await readTrayUsage(url, key()).catch(() => null);
    const mark = usage ? `${usage.percentLeft}|${usage.label}` : "";
    if (!tray || tray.isDestroyed() || mark === shown) return;
    shown = mark;
    tray.setImage(trayImageFor(usage));
    tray.setToolTip(trayTip(usage));
  };
  void look();
  trayTimer = setInterval(() => void look(), 60_000);
  trayTimer.unref();
}

function protectWindow(
  win: BrowserWindow,
  origin: string,
  /**
   * The key the window signs with: the session key for the proved engine's process, made from the window's key as it
   * is now (removing a phone that was handed it replaces it). It throws while the engine has not proved itself.
   */
  key: () => string,
  mic: TalkLiveMic,
  /**
   * Whether the engine at the window's address has proved it is the engine. While an engine starts again its port is
   * free and another program could take it, so every request there is held (and none carries the key) until then.
   */
  access: EngineAccess,
  /** Every http request of the window's goes through this, on a connection proved to reach the engine. */
  client: EngineClient,
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
  const hold = new RequestHold(access);
  // The moment the engine is gone, every request already on its way there is ended too: one that was signed while the
  // engine was there could otherwise wait for a connection, or be sent again, and reach whatever takes the port next.
  access.onLost(() => { void session.closeAllConnections().catch((error: Error) => console.error("Connections:", error.message)); });
  session.webRequest.onBeforeRequest((details, callback) => {
    if (!sameAppOrigin(details.url, origin)) { callback({ cancel: true }); return; }
    hold.when((go) => callback({ cancel: !go }));
  });
  // The window's http requests (its page, its files, its /api/ calls) are sent by main, not by the page's own network
  // code: main proves the connection reaches this engine's process before it sends a request or its body there, signs
  // /api/ requests with the session key, and takes only answers the engine marked (src/desktop/engine-client.ts).
  session.protocol.handle("http", async (request) => {
    if (!sameAppOrigin(request.url, origin)) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    try {
      const answer = await client.send({ method: request.method, path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers.entries()),
        body: request.body ? Readable.fromWeb(request.body as import("node:stream/web").ReadableStream) : null,
        sign: url.pathname.startsWith("/api/") });
      return webResponse(answer, request.method);
    } catch (error) {
      console.error(`Window request to the engine: ${(error as Error).message}`);
      return new Response(JSON.stringify({ error: startingAgain }), { status: 503, headers: { "content-type": "application/json" } });
    }
  });
  // A task's socket (ws://) is the one request the page's own network code still sends: it is signed and its answer
  // checked for the engine's mark below, and nothing is sent on it before that answer is taken.
  // Remembered once: a request can still arrive after the window is gone, and a destroyed
  // window throws on any property access ("Object has been destroyed").
  const contentsId = win.webContents.id;
  const answers = new AnswerCheck(Number(new URL(origin).port));
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!sameAppOrigin(details.url, origin)) { callback({ cancel: true }); return; }
    // The engine may have stopped between the request being let go and its headers: then it is refused, never sent.
    const boot = access.boot();
    let signing: string;
    try { signing = key(); } catch { callback({ cancel: true }); return; }
    if (!boot) { callback({ cancel: true }); return; }
    const signed = details.webContentsId === contentsId && new URL(details.url).pathname.startsWith("/api/");
    const headers = signed ? signedHeaders(details.requestHeaders, signing) : { ...details.requestHeaders };
    headers[askHeader] = answers.ask(details.id, signing, boot);
    callback({ requestHeaders: headers });
  });
  // Only the engine's own answers reach the page: one without its mark (from whatever took the port) is refused here.
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!sameAppOrigin(details.url, origin)) { callback({ cancel: true }); return; }
    const holds = answers.holds(details.id, details.responseHeaders);
    if (!holds) console.error(`Refused an answer at the engine's address that the engine did not mark: ${new URL(details.url).pathname}`);
    callback(holds ? {} : { cancel: true });
  });
  session.webRequest.onCompleted((details) => answers.forget(details.id));
  session.webRequest.onErrorOccurred((details) => answers.forget(details.id));
}

async function createWindow(
  url: string, key: () => string, settings: DesktopSettings, update: UpdateHooks, access: EngineAccess, client: EngineClient,
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
  // The engine tells the model whether Branch's window is open or hidden in the tray (src/environment.ts).
  for (const change of ["show", "hide", "minimize", "restore"] as const) window.on(change as "show", tellWindowShown);
  window.on("closed", () => engine?.tell("window", { shown: false }));
  tellWindowShown();
  const mic = new TalkLiveMic(url, window.webContents.id);
  protectWindow(window, url, key, mic, access, client);
  // A page that went away while the engine was not there (its load was held too long) is opened again once it is back.
  const shown = window;
  const pageRecovery = new EnginePage(access,
    () => !shown.isDestroyed() && new URL(shown.webContents.getURL() || "about:blank").origin !== url,
    () => { void shown.loadURL(`${url}/?desktop=1`).catch((error: Error) => console.error("Window:", error.message)); });
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
  registerClipboardFilesIpc(window, url, key, pasteGate, client.fetch);
  registerShowInFolderIpc(window, url, key, undefined, client.fetch);
  // The window as it is at each moment (none while closed for good or not yet opened): updates go on without one.
  const openWindow = () => window ?? null;
  updater = registerUpdaterIpc(openWindow, url, app.getVersion(), () => { quitReason = "update"; app.quit(); },
    { ...update, readiness: async () => updateReadiness(url, key(), client.fetch),
      // Update by itself runs in this process, whatever the page is doing (update-loop.ts).
      plan: (facts) => updatePlanFrom(url, key(), facts, client.fetch),
      // Versioned app folders: the switch waits for the window's invisible moment and hands its state over (shell-window.ts).
      handOver: handOverHook({ window: openWindow, userData: app.getPath("userData"), power: powerMonitor }) });
  // Asked for from an open window, so the new copy opens its window too, even after a quiet start.
  // hot-update: the window takes a live update in place, under a picture of itself while it reloads (no blank frame).
  const liveWindow = registerLiveWindowIpc({ ipc: ipcMain, window, origin: url, cover: () => pictureCover(main) });
  tellWindow = liveWindow.tell;
  recoverWindow = liveWindow.recover;
  registerRestartIpc(ipcMain, window, url, () => {
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== minimizedFlag) });
    quitReason = "restart";
    app.quit();
  });
  registerQuickAsk({ shortcuts: globalShortcut, ipc: ipcMain, window, origin: url, keys: async () => quickAskKeys(url, key(), client.fetch),
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
  // After a shell switch (shell-switch.ts): what the old version's window had open comes back in this one's first page,
  // and only once it has, this version says its window is up (the switch script goes back to the old one otherwise).
  const windowUp = await resumeWindow({ ipc: ipcMain, window, origin: url, userData: app.getPath("userData"), version: app.getVersion(),
    scratchDir: updateScratchDir(), expectRestore: liveWindow.expectRestore });
  // Q249 (R21's Windows runs): on a second start the page can move on by itself while it first loads (a reload for the
  // saved look), and Electron then rejects this load with ERR_ABORTED although the window is up and working. That was
  // taken as "could not start": the app quit mid-start and the quit question froze it. Only a real failure stops it now.
  await window.loadURL(`${url}/?desktop=1`).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ERR_ABORTED") return;
    console.error("Window:", (error as Error).message);
    pageRecovery.failed();
  });
  createTray();
  watchTrayUsage(url, key, () => access.ready());
  void windowUp().then(() => settleVersions(), (error: Error) => {
    console.error("Window up:", error.message);
    diagnose("updater", "warn", `This version's window could not say it is up: ${error.message}`);
  });
}

/**
 * Versioned app folders: once this version's window is up, "start with Windows" and the background engine's launcher
 * name it, and versions nothing runs from any more are removed (two minutes on, when a switch has long settled).
 */
function settleVersions(): void {
  const layout = appLayout();
  if (!layout?.folder) return;
  setTimeout(() => {
    void folders(app.getPath("userData")).then(({ dataDir }) => settleLayout(layout, appEntryName(process.platform), dataDir))
      .then((done) => {
        if (done.retired) diagnose("updater", "info", "The copy installed before versioned folders is now the stable launcher");
        if (!done.pruned.length) return;
        console.log(`Removed older versions: ${done.pruned.join(", ")}`);
        diagnose("updater", "info", "Removed versions nothing runs from any more", { fields: { versions: done.pruned.join(", ") } });
      })
      .catch((error: Error) => {
        console.error("Versions:", error.message);
        diagnose("updater", "warn", `Settling the version folders failed: ${error.message}`);
      });
  }, 120_000).unref();
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
/** A live update's own notes (the engine handed over, a live build not used): on the console and in the activity log. */
const liveNote = (line: string): void => { console.error(line); diagnose("updater", "info", line); };
/**
 * mac7/safe-rollback: the app's Update button writes the same record `branch update --yes` does, so
 * a person who updates from the window can go back afterwards. It stays `staged` until the next
 * start says the swap landed, because this process quits into the hand-over script.
 */
function desktopRecord(dataDir: string): Pick<UpdateHooks, "record" | "dataDir"> {
  const installRoot = installedAppRoot(app.isPackaged, process.platform, process.execPath);
  // A copy that cannot update itself never hands over, so there is nothing to write down.
  if (!installRoot) return { dataDir };
  return { dataDir, record: async (stagedDir, toVersion) => {
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
  const layout = appLayout();
  await refreshWindowsIdentity({ installRoot, executableName: appEntryName(process.platform), env: process.env,
    // Versioned app folders: a shortcut to another version of this install moves to this one, the version in use.
    ...(layout ? { sameInstall: (path: string) => sameInstall(layout.root, path) } : {}) }, {
    readShortcut: (path) => shell.readShortcutLink(path),
    updateShortcut: (path, fields) => shell.writeShortcutLink(path, "update", fields),
    exists: existsSync,
  }).catch((error: Error) => console.error("Shortcuts:", error.message));
}

/** The gateway's Startup shortcut, where Windows refuses its scheduled task (src/install/gateway-task.ts): no VBScript. */
const electronShortcut: WriteShortcut = async (link) => {
  if (!shell.writeShortcutLink(link.path, "create", { target: link.target, args: link.arguments, cwd: link.workingDirectory, description: link.description }))
    throw new Error("Windows did not write the Startup shortcut.");
};

async function start(): Promise<void> {
  const base = app.getPath("userData");
  const settings = await loadDesktopSettings(join(base, "model-settings.json"));
  const { dataDir, workspace } = await folders(base);
  // One window per data folder, whichever copy of Branch it is (shell-lock.ts): a second leaves before touching it.
  const lock = await takeShellLock(dataDir);
  if (!lock.held) {
    console.error(`Branch is already open on this data folder (process ${lock.by}), so this copy leaves without touching it.`);
    quitReason = "command";
    app.exit(0);
    return;
  }
  app.once("will-quit", () => { void lock.release(); });
  startCrashReporter(dataDir);
  // Main's own lines (the updater's steps among them) go into the engine's activity log, engine running or not.
  openMainLog(dataDir);
  diagnose("desktop", "info", "The window's main process started", { fields: { version: app.getVersion() } });
  // An engine already working in the background is joined rather than started a second time; one from a version
  // before the engine's proof is moved to this version first.
  // The desktop's gateway preference is written ON before anything can save the file's other fields, so no later
  // save (keep-awake, a timing change) stores the schema's default OFF as if the owner had chosen it.
  const gatewayMode = (await desktopGatewayConfig(dataDir)).config.mode;
  let running = await joinBackground(dataDir) ?? await upgradeBackground(dataDir, workspace);
  if (!running && gatewayMode !== "off") running = await brokerOrOwnEngine(base, dataDir, workspace);
  // Joining an engine means that engine owns the saved work and holds the program files open, so the
  // safety copy is asked of it and it is closed before an update swaps anything.
  joinedBackground = Boolean(running);
  // The background engine saves a new key when a phone that was handed it is removed; it is read again each time.
  const runningKey = running ? windowKeyReader(dataDir, running.token) : null;
  // Beta channel: which change this copy was built from, found once here (git is asked without waiting on it).
  const commit = await builtFrom(app.getAppPath(), app.isPackaged);
  if (running && runningKey) {
    const gate = joinedGate(dataDir, running.url, runningKey);
    const key = gatedKey(gate, runningKey);
    const client = new EngineClient({ origin: running.url, access: gate, windowKey: runningKey });
    // The private update channel is optional: a stale or unanswering one leaves live updates waiting, never the window.
    const brokerLive = existsSync(join(dataDir, "desktop-control", "authority.json")) ? await joinedGatewayLive({
      appRoot: liveAppRoot(), dataDir, repo: fallbackRepo, buildDir: betaBuildDir(dataDir), packaged: commit,
      host: () => undefined, forkLive: forkEngine, runtime: process.execPath,
      snapshot: async () => engineSnapshot(running.url, key(), client.fetch),
      backup: async () => requestUpdateBackup(running.url, key(), { fetch: client.fetch }),
      tellWindow: tellOpenWindow, recoverWindow: recoverOpenWindow, log: liveNote,
    }).catch((error: Error) => { liveNote(`Background engine's update channel: ${error.message}`); return null; }) : null;
    if (testHooksOn() && brokerLive) (globalThis as { branchLiveForTests?: unknown }).branchLiveForTests = { hooks: brokerLive.hooks, engineState: brokerLive.inspect };
    await createWindow(running.url, key, settings, {
      backup: async () => requestUpdateBackup(running.url, key(), { fetch: client.fetch }),
      stopDaemon: async () => {
        closingForUpdate = true;
        // Its close goes through the proved connection too: the window key is never sent to its address.
        const report = await stopBackgroundEngine(dataDir, { gracefulOnly: true, fetch: client.fetch })
          .catch((error: unknown) => { closingForUpdate = false; throw error; });
        if (report.pid !== null && !report.stopped) { closingForUpdate = false; throw new UpdateStuckError(report.message); }
        return report.pid;
      },
      canary: desktopCanary(dataDir, async () => engineSnapshot(running.url, key(), client.fetch)), // mac3/never-break
      tryOut: betaTryOut,
      ...desktopRecord(dataDir), // mac7/safe-rollback
      buildDir: betaBuildDir(dataDir),
      currentCommit: commit,
      ...(brokerLive ? { live: brokerLive.hooks } : {}),
    }, gate, client);
    window?.once("closed", () => brokerLive?.close());
    // selfdev: joined to the background engine, the window is up; a Beta update waiting to see this keeps the new
    // version. Without it, a Beta update with the background engine on was put back after 90 s every time.
    void markStarted(updateScratchDir(), app.getVersion()).catch(() => undefined);
    return;
  }
  // hot-update: the live builds in use, checked now; the engine starts from its live build when there is one.
  const live = await liveAtStart(liveAppRoot(), liveNote);
  liveWindowNow = live.window;
  const url = await startEngine(base, settings, { dataDir, workspace }, live.engineFile);
  // The key, and anything main sends, go only to the app's own engine serving at the window's address that has proved
  // itself there: while the engine starts again, main's own requests are refused before anything is sent.
  const gate = new EngineGate({ origin: url, key: () => engine?.token ?? "", also: () => engine?.servingAt === url,
    log: (line) => console.error(line) });
  engineGate = gate;
  gate.start();
  if (testHooksOn()) (globalThis as { branchEngineGateForTests?: EngineGate }).branchEngineGateForTests = gate;
  const key = gatedKey(gate, () => engine?.token ?? "");
  const client = new EngineClient({ origin: url, access: gate, windowKey: () => engine?.token ?? "" });
  // hot-update: Beta changes main does not load are applied live (src/desktop/hot-apply.ts).
  const hot = liveHooks({ appRoot: liveAppRoot(), dataDir, repo: fallbackRepo, buildDir: betaBuildDir(dataDir), packaged: commit,
    host: () => engine, forkLive: forkEngine,
    snapshot: async () => engineSnapshot(url, key(), client.fetch), backup: async () => requestUpdateBackup(url, key(), { fetch: client.fetch }),
    tellWindow: tellOpenWindow, recoverWindow: recoverOpenWindow, runtime: process.execPath, onApplied: (state) => { liveWindowNow = state.window; },
    onEngineDeparture: () => closeCapture(),
    log: liveNote });
  if (testHooksOn()) (globalThis as { branchLiveForTests?: unknown }).branchLiveForTests = { hooks: hot, tell: (update: WindowUpdate) => tellWindow(update) };
  await createWindow(url, key, settings, {
    // The rows' safety copy, then the whole data folder, both made by the engine that holds the database.
    backup: async () => requestUpdateBackup(url, key(), { fetch: client.fetch }),
    // mac3/never-break: the new version is tried on a copy of this data before it is used.
    canary: desktopCanary(dataDir, async () => engineSnapshot(url, key(), client.fetch)),
    tryOut: betaTryOut,
    ...desktopRecord(dataDir), // mac7/safe-rollback
    buildDir: betaBuildDir(dataDir),
    currentCommit: runningChange(live.state, commit),
    live: hot,
  }, gate, client).catch(async (error: unknown) => {
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
async function startEngine(base: string, settings: DesktopSettings, where: { dataDir: string; workspace: string }, liveEngine: string | null = null): Promise<string> {
  const services = desktopEngineServices(base);
  closeCapture = () => { try { services.capture?.close(); } catch (error) { console.error("Capture cleanup:", error); } };
  const loginItem = services.loginItem;
  // Read at every start of the engine, so a model connection saved in Settings since then is the one it uses.
  const config = (): EngineConfig => ({
    ...where, providerEnv: desktopProviderEnv(settings), version: app.getVersion(),
    executable: app.isPackaged ? process.execPath : null,
    installRoot: installedAppRoot(app.isPackaged, process.platform, process.execPath),
    packaged: app.isPackaged, loginItem: loginItem ? loginItem.read() : null,
    appPid: process.pid,
    testHooks: testHooksOn(),
    // hot-update: where live builds are kept, and the one whose window files the engine serves (checked there first).
    appRoot: liveAppRoot(),
    ...(liveWindowNow ? { liveWindow: liveWindowNow } : {}),
  });
  const broker = engineBroker({ ...services,
    tell: (method) => host.tell(method), quit: () => { quitReason = "command"; app.quit(); } });
  const host = new EngineHost({
    fork: () => forkEngine(liveEngine ?? fileURLToPath(new URL("./engine-process.js", import.meta.url))),
    config,
    handlers: broker.handlers,
    onGone: (code) => { closeCapture(); engineGate?.lost(); console.error(`The engine stopped (code ${code}); starting it again.`); },
    onBack: (url) => {
      // The engine's own stop is written into its record of failures, as a window's or helper's is.
      void host.call("crash", { where: "engine", message: "The engine stopped and was started again" }).catch(() => undefined);
      tellWindowShown(); // an engine started again knows nothing of the window yet
      // Back at another address (its port was taken meanwhile): the window's page belongs to the old one, so the
      // whole app starts again, which opens the window at the new address.
      if (url !== host.url) { relaunchApp(); return; }
      // Back at the same address: it proves itself there again, and the window's held requests go on.
      engineGate?.nudge();
    },
    log: (line) => console.error(line),
  });
  engine = host;
  // An engine too busy to answer in time still has work running: the last count it told is used then. Only an engine
  // that is not running at all has none.
  runningNow = () => host.call<number>("running-count", undefined, 5000).then(Number)
    .catch(() => (host.running ? host.lastRunning : 0));
  stop = async () => { try { await host.stop(7000); } finally { broker.close(); } };
  watchDesktopCrashes(host);
  // Sleep and wake reach this engine as they reach a detached gateway's (a real sleep still pauses everything).
  followPower(powerMonitor, host, (line) => console.error(line));
  if (testHooksOn()) (globalThis as { branchEngineForTests?: EngineHost }).branchEngineForTests = host;
  return host.start();
}

/**
 * Starts an engine's process from `file`: the app's own engine-process.js, or a live build's (hot-update), checked before
 * this is called. A notch below normal, so when the computer is busy the window, the tray and the owner's other apps
 * are served first and the engine's work waits a moment instead. (Profiled: the packaged app's rare 100 ms stalls were
 * the whole window process going unscheduled on a busy computer, not work of its own on its thread.)
 */
function forkEngine(file: string): UtilityProcess {
  return forkDesktopEngine(file);
}

/**
 * hot-update: a picture of the window laid exactly over it while its page reloads. It is shown only once the picture is
 * drawn (the image decoded and two frames painted), never taking focus, and goes the moment the page is back.
 */
function pictureCover(parent: BrowserWindow): Cover {
  let cover: BrowserWindow | null = null;
  return {
    show: async (image, bounds) => {
      cover = new BrowserWindow({ ...bounds, parent, show: false, frame: false, focusable: false, skipTaskbar: true, hasShadow: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, backgroundColor: "#03140b",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "branch-live-cover" } });
      const html = `<!doctype html><html><body style="margin:0;overflow:hidden"><img alt="" style="display:block;width:100vw;height:100vh" src="${image.toDataURL()}"></body></html>`;
      await cover.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await cover.webContents.executeJavaScript("new Promise((done) => { const i = document.images[0]; const drawn = () => requestAnimationFrame(() => requestAnimationFrame(done)); i.decode().then(drawn, drawn); })");
      cover.setBounds(bounds);
      cover.showInactive();
    },
    close: () => { if (cover && !cover.isDestroyed()) cover.destroy(); cover = null; },
  };
}

/** The background engine, when one is running here and proves itself (src/engine-proof.ts). */
async function joinBackground(dataDir: string): Promise<Attachment | null> {
  // Its first question goes through a connection proved for the engine process that answered the proof.
  let client = null as EngineClient | null;
  const joined = await attachToRunning(dataDir, {
    prove: async (address, key) => {
      const boot = await proveOnce(address, key);
      if (!boot) return null;
      client = new EngineClient({ origin: address, access: { boot: () => boot }, windowKey: () => key });
      return sessionKey(key, boot);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (!client) throw new Error(startingAgain);
      return client.fetch(input, init);
    }) as typeof fetch,
  });
  client?.close();
  return joined;
}

/**
 * A background engine from a version before the engine's proof cannot prove itself, so it is closed and started again
 * as this version, and the window joins the fresh one: nothing for the owner to do, and nothing shown as an error. The
 * window's key goes to the old engine only once this computer says the process holding its port is the one its own
 * note names (src/install/old-engine.ts). Anything else (no such engine, or one that is not safe to close) leaves it,
 * and the app starts its own engine as it would with none running.
 */
function upgradeBackground(dataDir: string, workspace: string): Promise<Attachment | null> {
  // moveOldEngine starts the fresh engine with ELECTRON_RUN_AS_NODE=1 (src/install/old-engine.ts), never a second window.
  return moveOldEngine({
    dataDir, fresh: { executable: process.execPath, script: fileURLToPath(new URL("../cli.js", import.meta.url)), workspace },
    proves: async (url, key) => (await proveOnce(url, key)) !== null, join: () => joinBackground(dataDir), log: (line) => console.log(line),
  });
}

/** The whole app starts again, opening its window even after a quiet start. */
function relaunchApp(hidden = false): void {
  const args = process.argv.slice(1).filter((arg) => arg !== minimizedFlag);
  app.relaunch({ args: hidden ? [...args, minimizedFlag] : args });
  quitReason = "restart";
  app.quit();
}

/**
 * The saved gateway is ON: join or start the detached broker. When its launch is proved over (the process it started
 * failed or ended, and no broker is named alive), this window starts its own engine rather than never opening: there
 * is then no second database writer, and Settings shows the gateway saved on but not running. A broker that may still
 * be starting is never raced by a second engine; the owner is told why Branch cannot open.
 */
async function brokerOrOwnEngine(base: string, dataDir: string, workspace: string): Promise<Attachment | null> {
  try {
    // Deliberately Electron itself, not as Node: gateway-launch.ts removes ELECTRON_RUN_AS_NODE and passes its own flag.
    const launch = { executable: process.execPath, appRoot: app.getAppPath(), packaged: app.isPackaged,
      base, dataDir, workspace, join: () => joinBackground(dataDir) };
    // UP-PLATFORM-002: the installed Windows app starts it through its scheduled task, which restarts it after a crash.
    if (!app.isPackaged || process.platform !== "win32" || testHooksOn()) return await launchDesktopGateway(launch);
    return await launchSupervisedGateway({ ...windowsGatewaySupervision({ dataDir, executable: process.execPath }, { writeShortcut: electronShortcut }),
      join: launch.join, direct: () => launchDesktopGateway(launch), log: (line) => console.error(line) });
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof GatewayLaunchError && !error.brokerMayRun) {
      console.error(`Background engine could not start; this window runs Branch itself for now: ${message}`);
      return null;
    }
    if (!testHooksOn()) dialog.showErrorBox("Branch Agent could not start", `${message} Branch's background engine may still be starting. Open Branch again in a minute.`);
    throw error;
  }
}

/**
 * The key the window and main's own requests are signed with: the session key for the proved engine's process
 * (src/engine-proof.ts), never the window's key itself. Refused, before anything is sent, while the engine has not proved
 * itself.
 */
function gatedKey(access: EngineAccess, key: () => string): () => string {
  return () => {
    const boot = access.boot();
    if (!boot) throw new Error("Branch is starting its engine again. Try again in a moment.");
    return sessionKey(key(), boot);
  };
}

/**
 * The background engine the window joined: it proves itself before the key goes to it, and again after every stop.
 * Back at another address (its port was taken while it restarted), the app starts again to join it there.
 */
function joinedGate(dataDir: string, url: string, key: () => string): EngineGate {
  const gate = new EngineGate({ origin: url, key, log: (line) => console.error(line) });
  gate.start();
  if (testHooksOn()) (globalThis as { branchEngineGateForTests?: EngineGate }).branchEngineGateForTests = gate;
  let looking = false, leaving = false;
  const moved = setInterval(() => {
    if (gate.ready() || looking || leaving || quitting || handingOver()) return;
    looking = true;
    void readRunning(dataDir)
      .then(async (note) => {
        const verdict = joinedEngineVerdict(note, url);
        if (verdict === "moved" && note && (await proveOnce(note.url, key()))) { leaving = true; relaunchApp(); }
        // Nothing runs there any more (the owner turned the gateway off, or its broker ended): start again, as this
        // window was (shown or in the tray), to open Branch's own engine or a new broker instead of waiting forever.
        if (verdict !== "gone" || quitting) return;
        leaving = true;
        console.error("The background engine this window joined has stopped; starting Branch again.");
        if (testHooksOn()) (globalThis as { branchJoinedGoneForTests?: boolean }).branchJoinedGoneForTests = true;
        else relaunchApp(!(window?.isVisible() ?? false));
      })
      .catch(() => undefined)
      .finally(() => { looking = false; });
  }, 2000);
  moved.unref();
  return gate;
}

/**
 * Shutting down waits for the loopback server and open work, but never for long: an update
 * hand-over depends on this process actually ending.
 */
function shutDown(): void {
  quitting = true;
  const forUpdate = quitReason === "update";
  if (forUpdate) diagnose("updater", "info", "Stopping the engine so the update can be handed over");
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 8000).unref());
  void Promise.race([(stop?.() ?? Promise.resolve()), deadline])
    .catch((error) => console.error("Shutdown:", error.message))
    // The engine's process holds the program files open and a hand-over waits only for this process, so the engine is
    // ended first and this waits (briefly) until it has really gone.
    .finally(() => (engine?.end(2000) ?? Promise.resolve()))
    .finally(() => {
      if (forUpdate) diagnose("updater", "info", "The engine has stopped; the hand-over takes it from here");
      if (trayTimer) clearInterval(trayTimer);
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
async function engineSnapshot(url: string, token: string, call: typeof fetch): Promise<string> {
  const response = await call(`${url}/api/never-break/snapshot`, { method: "POST",
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
if (process.argv.includes(desktopGatewayFlag)) startDetachedGateway();
else if (process.argv.includes(refreshShortcutsFlag)) {
  // The installer's one-off request: put the shortcuts right and quit, touching nothing else.
  void app.whenReady().then(refreshWindowsShortcuts).finally(() => app.exit(0));
} else if (smokeReportPath(process.argv)) {
  // A Beta try-out of this version (src/desktop/beta-smoke.ts): its own engine, folder and hidden window, then quit.
  // It never takes the single-instance lock, so the version that started it keeps running.
  const report = smokeReportPath(process.argv)!;
  app.on("window-all-closed", () => undefined);
  // Loaded only in this separate launch: the engine it brings is never among the running window's own modules, so a
  // live update still tells engine changes from shell ones (src/hot-update/classify.ts).
  const trial = new URL("./beta-smoke-window.js", import.meta.url).href;
  void app.whenReady().then(async () => (await import(trial) as typeof import("./beta-smoke-window.js")).smokeMode(report, app.getVersion()))
    .then((code) => app.exit(code), () => app.exit(1));
} else {
  // Versioned app folders: a start of another version of this install goes to the version in use (guarded).
  const forward = app.isPackaged ? forwardTarget(appLayout(), appEntryName(process.platform), process.env, {
    readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } }, exists: existsSync }) : null;
  // Said once, to this start only: nothing this one starts later (the gateway, a relaunch) inherits it.
  delete process.env[forwardedVariable];
  if (!forward) startAsThis();
  else void forwardToVersionInUse(forward).then((outcome) => (outcome === "went-back" ? startAsThis() : app.exit(0)), () => startAsThis());
}

/** The window's own start: one copy at a time, then the app. */
function startAsThis(): void {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
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

/**
 * Versioned app folders: a start of a version that is not the one in use (a shortcut, the taskbar or "start with Windows"
 * still naming an older folder, or the version before after a switch made with no window open) starts the version in
 * use instead, with the same arguments. A version never seen up is watched first (shell-window.ts, guardedForward).
 */
async function forwardToVersionInUse(target: { program: string; version: string }): Promise<"forwarded" | "went-back"> {
  const layout = appLayout()!, exe = appEntryName(process.platform), scratch = updateScratchDir();
  const env: NodeJS.ProcessEnv = { ...process.env, [forwardedVariable]: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  return guardedForward(target, {
    start: (program) => {
      const child = spawn(program, process.argv.slice(1), { detached: true, stdio: "ignore", env });
      child.on("error", () => undefined);
      child.unref();
      return child.pid ?? null;
    },
    up: (version) => existsSync(shellUpMarker(scratch, version)),
    end: (pid) => new Promise((done) => execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 20_000 }, () => done())),
    safe: async () => (await goingBackIsSafe({ dataDir: (await folders(app.getPath("userData"))).dataDir, understood: storeMigrations.at(-1)?.version ?? null },
      { format: systemDeps("").format, note: async (line) => diagnose("updater", "warn", line) })).ok,
    rollBack: async () => (await rollBackPointer(layout.root, exe)) !== null,
    tell: async (tried) => {
      await mkdir(scratch, { recursive: true });
      await writeFile(join(scratch, failureName), JSON.stringify({ kept: app.getVersion(), tried, commit: null, at: new Date().toISOString(),
        message: `Version ${tried} did not open its window, so Branch went back to ${app.getVersion()} by itself. Your conversations are kept. The next change is tried as soon as it lands.` }));
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  });
}

/** The broker's lock is separate from its windows; closing or updating a shell leaves this owner running. */
function startDetachedGateway(): void {
  const base = app.getPath("userData");
  app.setPath("userData", join(base, "gateway-desktop"));
  // The gateway draws nothing but the small Stop notice, so it draws in software: its graphics process keeps about
  // 35 MB less (48 -> 14 MB private) for as long as Branch runs in the background. Must come before the app is ready.
  app.disableHardwareAcceleration();
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  let gateway: Awaited<ReturnType<typeof runDesktopGateway>> = null, ending = false;
  // UP-PLATFORM-002: Electron's own answer to a failure nobody caught is a dialog nobody sees, with the process left
  // hanging. It is written down and the gateway carries on; one that cannot (not running, or failing over and over)
  // exits with a failure code, which is what makes Task Scheduler (or the next sign-in) start it again.
  keepRunningThroughErrors(process, { healthy: async () => gateway !== null && !ending, log: (line) => console.error(line),
    // While it is already closing on purpose, it leaves as closing does, and nothing starts it again.
    end: (why) => { console.error(`The background engine cannot carry on (${why}); it stops so it can be started again.`); app.exit(ending ? 0 : 1); } });
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    if (ending) return;
    event.preventDefault(); ending = true;
    void gateway?.stop().finally(() => app.exit(0));
    if (!gateway) app.exit(0);
  });
  void app.whenReady().then(async () => {
    const where = await folders(base);
    // The windowless gateway is a main process too: its lines (updates with no window open among them) go to the same log.
    openMainLog(where.dataDir);
    gateway = await runDesktopGateway({ base, ...where, appRoot: liveAppRoot(),
      providerEnv: async () => desktopProviderEnv(await loadDesktopSettings(join(base, "model-settings.json"))) });
    if (testHooksOn()) (globalThis as { branchGatewayForTests?: unknown }).branchGatewayForTests = gateway;
    if (!gateway) app.exit(0);
  }).catch((error: Error) => { console.error("Background engine:", error.message); app.exit(1); });
}
