import { BrowserWindow, WebContentsView, ipcMain, session, type IpcMainInvokeEvent, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { fromOwnPage } from "./clipboard-paths.js";
import { KeepOakWorkspace } from "./keepoak-workspace.js";

const ORIGIN = "https://keepoak.com";
const CHANNELS = ["branch:keepoak-view-status", "branch:keepoak-view-open", "branch:keepoak-view-disconnect"];
const TEAM_CHANNELS = ["branch:keepoak-team-read", "branch:keepoak-team-change"];
export function keepOakViewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

// Fixed cookie API used by the portal; never allow it as a document destination.
export function keepOakResourceUrl(value: string, resourceType: string): boolean {
  if (keepOakViewUrl(value)) return true;
  if (!["xhr", "other"].includes(resourceType)) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://api.keepoak.com" && !url.username && !url.password
      && url.pathname.startsWith("/v1/");
  } catch { return false; }
}

function lockPartition(partition: Session, enabled: () => boolean): void {
  partition.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  partition.setPermissionCheckHandler(() => false);
  partition.setDevicePermissionHandler(() => false);
  partition.on("will-download", (event) => event.preventDefault());
  partition.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, answer) =>
    answer({ cancel: !enabled() || !keepOakResourceUrl(details.url, details.resourceType) }));
}

function lockContents(view: WebContentsView): void {
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => { if (!keepOakViewUrl(event.url)) event.preventDefault(); });
  contents.on("will-redirect", (event) => { if (!keepOakViewUrl(event.url)) event.preventDefault(); });
  contents.on("will-frame-navigate", (event) => { if (!keepOakViewUrl(event.url)) event.preventDefault(); });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("select-bluetooth-device", (event, _devices, answer) => { event.preventDefault(); answer(""); });
}

async function clearPartition(partition: Session): Promise<void> {
  await partition.closeAllConnections();
  await partition.clearStorageData();
  await partition.clearData();
  await partition.clearCache();
  await partition.clearAuthCache();
}

interface ViewState {
  host: BrowserWindow | null; view: WebContentsView | null; partition: Session | null;
  enabled: boolean; timer: NodeJS.Timeout | null; clearing: Promise<void>;
}
const viewStatus = (state: ViewState) => ({ enabled: state.enabled, open: !!state.host && !state.host.isDestroyed(), origin: ORIGIN });
function closeView(state: ViewState): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const oldView = state.view, oldHost = state.host;
  state.view = null; state.host = null;
  if (oldView && !oldView.webContents.isDestroyed()) oldView.webContents.close({ waitForBeforeUnload: false });
  if (oldHost && !oldHost.isDestroyed()) oldHost.destroy();
}
async function disconnectView(state: ViewState) {
  state.enabled = false;
  closeView(state);
  const partition = state.partition;
  state.partition = null;
  if (partition) state.clearing = clearPartition(partition);
  await state.clearing;
  return viewStatus(state);
}

/** No Branch preload, engine key, agent tools, or shared browser storage. */
async function openView(state: ViewState, main: BrowserWindow, owner: () => Promise<void>) {
  await state.clearing;
  await owner();
  if (main.isDestroyed()) throw new Error("Branch window closed");
  if (state.host && !state.host.isDestroyed()) { state.host.show(); state.host.focus(); return viewStatus(state); }
  try {
    if (!state.partition) {
      const partition = session.fromPartition(`branch-keepoak-${randomUUID()}`, { cache: false });
      state.partition = partition;
      lockPartition(partition, () => state.enabled && state.partition === partition);
    }
    state.enabled = true;
    const preferences = { session: state.partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      devTools: false, navigateOnDragDrop: false, spellcheck: false, safeDialogs: true };
    const host = new BrowserWindow({ parent: main, width: 1060, height: 760, minWidth: 480, minHeight: 360,
      title: "KeepOak · Branch", show: false, webPreferences: preferences });
    const view = new WebContentsView({ webPreferences: preferences });
    state.host = host; state.view = view;
    host.setMenu(null); lockContents(view);
    host.contentView.addChildView(view);
    const resize = () => { if (!host.isDestroyed()) { const [width, height] = host.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); } };
    resize(); host.on("resize", resize);
    host.on("closed", () => { if (state.host === host) closeView(state); });
    host.on("page-title-updated", (event) => event.preventDefault());
    state.timer = setInterval(() => { void owner().catch(() => { if (state.host === host) void disconnectView(state).catch(() => {}); }); }, 2000);
    await view.webContents.loadURL(`${ORIGIN}/app/#computers`);
    await owner();
    if (state.host !== host || main.isDestroyed()) throw new Error("KeepOak view closed");
    host.show(); host.focus();
    return viewStatus(state);
  } catch (error) { await disconnectView(state); throw error; }
}

/** Off at every launch; the isolated memory partition is created only on an explicit owner open. */
function makeKeepOakView(main: BrowserWindow, origin: string, key: () => string, call: typeof fetch) {
  const state: ViewState = { host: null, view: null, partition: null, enabled: false, timer: null, clearing: Promise.resolve() };
  const owner = async () => {
    const headers = { authorization: `Bearer ${key()}`, "x-branch-origin": "window" };
    const [answer, lockdown, lock] = await Promise.all([call(`${origin}/api/profiles`, { headers, signal: AbortSignal.timeout(3000) }),
      call(`${origin}/api/lockdown`, { headers, signal: AbortSignal.timeout(3000) }),
      call(`${origin}/api/lock`, { headers, signal: AbortSignal.timeout(3000) })]);
    if (!answer.ok || ((await answer.json()) as { isOwner?: boolean }).isOwner !== true)
      throw new Error("Only the owner can open the KeepOak view");
    if (!lockdown.ok || ((await lockdown.json()) as { on?: boolean }).on !== false)
      throw new Error("KeepOak access is unavailable during Lockdown");
    if (!lock.ok || ((await lock.json()) as { locked?: boolean }).locked !== false)
      throw new Error("Unlock Branch before using its KeepOak session");
  };
  const ownPage = (event: IpcMainInvokeEvent) => {
    if (!fromOwnPage(event, main, origin)) throw new Error("KeepOak view access denied");
  };
  const workspace = new KeepOakWorkspace(main, { owner, session: () => state.enabled ? state.partition : null });
  return { ownPage, workspace, status: () => viewStatus(state), open: () => openView(state, main, owner), disconnect: () => disconnectView(state) };
}

export function registerKeepOakViewIpc(main: BrowserWindow, origin: string, key: () => string, call: typeof fetch = fetch): void {
  const { status, ownPage, open, disconnect, workspace } = makeKeepOakView(main, origin, key, call);
  let changing = false;
  ipcMain.handle(CHANNELS[0]!, (event: IpcMainInvokeEvent) => { ownPage(event); return status(); });
  ipcMain.handle(TEAM_CHANNELS[0]!, (event: IpcMainInvokeEvent) => { ownPage(event); return workspace.read(); });
  ipcMain.handle(TEAM_CHANNELS[1]!, (event: IpcMainInvokeEvent, input: unknown) => { ownPage(event); return workspace.update(input); });
  for (const [channel, action] of [[CHANNELS[1]!, open], [CHANNELS[2]!, disconnect]] as const) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent) => {
      ownPage(event);
      if (changing) throw new Error("KeepOak view is changing; try again when it finishes");
      changing = true;
      try { return await action(); } finally { changing = false; }
    });
  }
  main.on("closed", () => {
    for (const channel of [...CHANNELS, ...TEAM_CHANNELS]) ipcMain.removeHandler(channel);
    void disconnect().catch(() => {});
  });
}
