import { contextBridge, ipcRenderer, webUtils } from "electron";

// Native paths are captured only from a real drop. The page cannot supply paths to the copy handler.
addEventListener("drop", (event: DragEvent) => {
  if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest("#drop")) return;
  const incoming = [...(event.dataTransfer?.files ?? [])];
  const files = incoming.length <= 20 ? incoming : [];
  const paths = files.map(file => webUtils.getPathForFile(file)).filter(Boolean);
  void ipcRenderer.invoke("branch:island-drop", paths).catch(() => {});
}, true);
contextBridge.exposeInMainWorld("branchIsland", Object.freeze({
  stats: () => ipcRenderer.invoke("branch:island-stats"),
  copy: () => ipcRenderer.invoke("branch:island-copy"),
  clear: () => ipcRenderer.invoke("branch:island-clear"),
  open: () => ipcRenderer.invoke("branch:island-open"),
}));
