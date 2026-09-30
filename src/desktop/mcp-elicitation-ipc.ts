import { ipcMain, shell, type BrowserWindow } from 'electron';
import { fromOwnPage } from './clipboard-paths.js';

/** The renderer supplies an owner-approved opaque ticket, never a URL or completion claim. */
export function registerMcpElicitationIpc(window: BrowserWindow, origin: string, key: () => string,
  call: typeof fetch = fetch): void {
  const post = async (route: string, body: unknown): Promise<unknown> => {
    const response = await call(`${origin}/api/mcp/owner-requests/${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${key()}`, 'x-branch-origin': 'window',
        'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('The browser question is no longer available.');
    return response.json();
  };
  ipcMain.handle('branch:mcp-elicitation-open', async (event, ticket: unknown) => {
    if (!fromOwnPage(event, window, origin) || typeof ticket !== 'string'
      || !/^[a-f0-9-]{36}$/.test(ticket)) throw new Error('Browser question access denied.');
    const handoff = await post('url-open', { ticket }) as { url: string; proof: string };
    const url = new URL(handoff.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Browser question access denied.');
    let opened = false;
    try {
      if (window.isDestroyed() || !fromOwnPage(event, window, origin)) throw new Error('Owner window closed.');
      await shell.openExternal(url.href); opened = true;
    } catch { /* Report only a generic failure; authentication URLs must not enter logs. */ }
    await post('url-opened', { ticket, proof: handoff.proof, opened });
    if (!opened) throw new Error('The browser could not be opened.');
    return { opened: true };
  });
  window.on('closed', () => ipcMain.removeHandler('branch:mcp-elicitation-open'));
}
