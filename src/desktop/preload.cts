import { contextBridge, ipcRenderer } from "electron";

// A shell update (src/desktop/shell-switch.ts): what the old version's window had open, handed to this page once, before
// any of its scripts run, where a live reload keeps it (public/app/shell/liveupdate.js restoreOpen).
try {
  const kept: unknown = ipcRenderer.sendSync("branch:shell-kept");
  if (typeof kept === "string") sessionStorage.setItem("branch-live-restore", kept);
} catch { /* nothing kept, or no storage: an ordinary start */ }

contextBridge.exposeInMainWorld("branchDesktop", Object.freeze({
  modelSettings: () => ipcRenderer.invoke("branch:model-settings"),
  saveModelSettings: (settings: unknown) =>
    ipcRenderer.invoke("branch:save-model-settings", settings),
  exportConversation: (text: unknown) =>
    ipcRenderer.invoke("branch:export-conversation", text),
  exportMemory: (text: unknown) => ipcRenderer.invoke("branch:export-memory", text),
  exportMemoryLines: (text: unknown) => ipcRenderer.invoke("branch:export-memory-lines", text),
  exportBackup: (text: unknown) => ipcRenderer.invoke("branch:export-backup", text),
  updateStatus: () => ipcRenderer.invoke("branch:update-status"),
  // Update by itself runs in the app (src/desktop/update-loop.ts): what it last planned, and what it says, for the page to show.
  updateLoop: () => ipcRenderer.invoke("branch:update-loop"),
  onUpdateSaid: (listener: (words: string) => void) => ipcRenderer.on("branch:update-said", (_event, words: unknown) => { if (typeof words === "string") listener(words); }),
  checkForUpdates: () => ipcRenderer.invoke("branch:update-check"),
  // Dogfood F1: true only when "update by itself" starts it, so turning that off while it builds stops it.
  // The second value is the exact Dev change of another line of work the owner confirmed (updater-ipc.ts refuses it with automatic).
  installUpdate: (automatic?: unknown, confirm?: unknown) =>
    ipcRenderer.invoke("branch:update-install", automatic === true, typeof confirm === "string" ? confirm : undefined),
  // The update screen: each change to an update under way, as it happens (src/desktop/updater-ipc.ts statusSender).
  onUpdateStatus: (callback: unknown) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("branch:update-changed", (_event, status: unknown) => (callback as (status: unknown) => void)(status));
  },
  openExternal: (url: unknown) => ipcRenderer.invoke("branch:open-external", url),
  restartBranch: () => ipcRenderer.invoke("branch:restart"),
  // Light, dark, or the title row's own colour (#rrggbb): the window controls' glyphs follow it (window-chrome-ipc.ts).
  windowLook: (look: unknown) => ipcRenderer.invoke("branch:window-look", look),
  // Pass 17: the quick-ask keys pressed in any app open the box; the page never sees the event itself.
  onQuickAsk: (callback: unknown) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("branch:quick-ask", () => (callback as () => void)());
  },
  quickAskKeysChanged: () => ipcRenderer.invoke("branch:quick-ask-keys"),
  // attach-4: the menu bar's Help, "What can Branch do" or "About Branch" (src/desktop/app-menu.ts helpItems).
  onHelp: (callback: unknown) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("branch:help", (_event, item: unknown) => {
      if (item === "whatcan" || item === "about") (callback as (item: string) => void)(item);
    });
  },
  // Talk live: a call the owner started is about to ask for the microphone (src/desktop/talk-live-mic.ts).
  talkLiveMic: () => ipcRenderer.invoke("branch:talk-live-mic"),
  // attach-anything: files copied in Explorer or Finder, sent by the app itself; the page names no path.
  clipboardFiles: () => ipcRenderer.invoke("branch:clipboard-files"),
  // hot-update: a live update reached the window (src/desktop/live-window-ipc.ts): stylesheets to swap in place, or a
  // reload that keeps what is open; `engine` while the engine is handed over, so the window reconnects quietly.
  onWindowUpdated: (callback: unknown) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("branch:window-updated", (_event, update: unknown) => (callback as (update: unknown) => void)(update));
  },
  reloadLive: (commit: unknown) => ipcRenderer.invoke("branch:reload-live", commit),
  windowRestored: (commit: unknown) => ipcRenderer.invoke("branch:window-restored", commit),
  windowUpdateResult: (result: unknown) => ipcRenderer.invoke("branch:window-update-result", result),
  // dogfood-ux-3: shows a file Branch kept in Explorer or Finder; the app reveals only a path the engine lists.
  showInFolder: (path: unknown) => ipcRenderer.invoke("branch:show-in-folder", path),
}));
