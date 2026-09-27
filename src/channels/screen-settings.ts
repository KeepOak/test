import { z } from 'zod';
import type { Store } from '../store.js';
import { audit } from '../audit.js';
import type { ScreenChat } from './screen-sessions.js';

const Account = z.object({ channel: z.string().trim().min(1).max(64),
  sender: z.string().regex(/^[1-9]\d{0,15}$/) }).strict();
export const ChatScreenSettingsSchema = z.object({ on: z.boolean().default(false),
  accounts: z.array(Account).max(10).default([]) }).strict();
export type ChatScreenSettings = z.infer<typeof ChatScreenSettingsSchema>;
const setting = 'chat-owner-screen';
export function chatScreenSettings(store: Pick<Store, 'get'>, owner: string): ChatScreenSettings {
  const value = ChatScreenSettingsSchema.safeParse(store.get('settings', owner, setting)?.data ?? {});
  return value.success ? value.data : ChatScreenSettingsSchema.parse({});
}
export function saveChatScreenSettings(store: Store, owner: string, input: unknown): ChatScreenSettings {
  store.profiles.requireOwner('Screen from your own chat');
  const next = ChatScreenSettingsSchema.parse(input);
  store.save('settings', owner, setting, next);
  audit(store, owner, { action: 'policy.changed', actor: owner, subject: 'screen from your own chat',
    reason: next.on ? `${next.accounts.length} exact Telegram account(s), with fresh confirmation for every session` : 'Chat screen sessions are off',
    outcome: next.on ? 'on' : 'off' });
  return next;
}
/** Signed Mini App launches are implemented only for Telegram; another adapter cannot claim this identity proof. */
export function chatScreenAccount(settings: ChatScreenSettings, chat: ScreenChat, kind: string): boolean {
  return settings.on && kind === 'telegram' && chat.chatKind === 'direct' && chat.caughtUp !== true
    && settings.accounts.some(account => account.channel === chat.channel && account.sender === chat.senderId);
}
