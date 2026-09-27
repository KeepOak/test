import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { saveBackupExport, saveConversationExport, saveMemoryExport, saveMemoryLinesExport } from './conversation-export.js';

const jsonArchive = { name: 'JSON archive', extensions: ['json'] };

export function registerConversationExportIpc(window: BrowserWindow, origin: string): void {
  let saving = false;
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error('Conversation export access denied');
  };
  // Every channel shares the one guard (the main window's own page on the app's origin) and the one export at a time.
  const types = [
    { channel: 'branch:export-conversation', label: 'conversation history', file: 'branch-conversation.json', filter: jsonArchive, save: saveConversationExport },
    { channel: 'branch:export-memory', label: 'saved memory', file: 'branch-memory.json', filter: jsonArchive, save: saveMemoryExport },
    { channel: 'branch:export-backup', label: 'backup', file: 'branch-backup.json', filter: jsonArchive, save: saveBackupExport },
    // rw4: Library › Memory's "Export what it remembers", one fact per line.
    { channel: 'branch:export-memory-lines', label: 'saved memory', file: 'memory.jsonl', filter: { name: 'JSON Lines', extensions: ['jsonl'] }, save: saveMemoryLinesExport },
  ];
  for (const type of types) ipcMain.handle(type.channel, async (event, text: unknown) => {
    authorized(event);
    if (saving) throw new Error('An archive export is already in progress');
    saving = true;
    try {
      return await type.save(text, async () => {
        const result = await dialog.showSaveDialog(window, {
          title: `Export ${type.label}`, defaultPath: type.file,
          filters: [type.filter],
          properties: ['showOverwriteConfirmation'],
        });
        authorized(event);
        return result.canceled ? undefined : result.filePath;
      });
    } finally { saving = false; }
  });
  window.on('closed', () => { for (const type of types) ipcMain.removeHandler(type.channel); });
}
