import { z } from 'zod';
import type { Store } from '../store.js';
import type { SessionLock } from '../session-lock.js';
import type { ChatScreenEntry } from './screen-entry.js';
import { chatScreenSettings, saveChatScreenSettings, ChatScreenSettingsSchema } from './screen-settings.js';
import { lockdownActive } from '../lockdown.js';

const paths = ['/api/channels/owner-screen', '/api/channels/screen-confirmations', '/api/channels/screen-confirmations/confirm', '/api/channels/screen-stop'];
export const handlesChatScreenWindowPath = (path: string): boolean => paths.includes(path);
export class ScreenWindowRefusal extends Error { readonly status = 403; }
/** These controls belong to the authenticated owner window and never to the dedicated phone session key. */
export async function chatScreenWindowApi(parts: { store: Store; owner: string; lock: SessionLock; entry: ChatScreenEntry;
  viaDoor: boolean; windowKeyCurrent(): boolean; readBody(): Promise<unknown> }, method: string, path: string): Promise<unknown> {
  const { store, owner, lock, entry } = parts;
  const requireWindow = (): void => {
    store.profiles.requireOwner('Screen sessions from your own chat');
    if (parts.viaDoor || !parts.windowKeyCurrent())
      throw new ScreenWindowRefusal('Screen sessions are configured and confirmed in Branch’s window on this computer.');
    if (lock.locked() || lockdownActive(store, owner))
      throw new ScreenWindowRefusal('Unlock Branch and leave Lockdown before changing screen sessions.');
  };
  requireWindow();
  if (method === 'GET' && path === '/api/channels/owner-screen') return { ownerScreen: chatScreenSettings(store, owner) };
  if (method === 'GET' && path === '/api/channels/screen-confirmations') return { waiting: entry.sessions.waiting(), active: entry.sessions.status() };
  if (method === 'POST' && path === '/api/channels/owner-screen') {
    const { pin, ...settings } = ChatScreenSettingsSchema.extend({ pin: z.string().max(64).optional() }).strict().parse(await parts.readBody());
    requireWindow();
    if (lock.pinSet() && !lock.confirmPin({ pin })) throw new ScreenWindowRefusal('Confirm with your PIN before changing screen sessions.');
    const saved = saveChatScreenSettings(store, owner, settings);
    entry.revoke(); return { ownerScreen: saved };
  }
  if (method === 'POST' && path === '/api/channels/screen-confirmations/confirm') {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(await parts.readBody());
    requireWindow();
    entry.sessions.confirmInWindow(id); return { confirmed: true };
  }
  if (method === 'POST' && path === '/api/channels/screen-stop') {
    z.object({}).strict().parse(await parts.readBody()); requireWindow();
    entry.sessions.stopFromWindow(); return { stopped: true };
  }
  throw new ScreenWindowRefusal('That screen control is unavailable.');
}
