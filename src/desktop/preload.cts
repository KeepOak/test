import { contextBridge, ipcRenderer } from "electron";

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
  // Talk live: a call the owner started is about to ask for the microphone (src/desktop/talk-live-mic.ts).
  talkLiveMic: () => ipcRenderer.invoke("branch:talk-live-mic"),
}));
