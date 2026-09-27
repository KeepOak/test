import type { Store } from '../store.js';
import type { ChannelRouter } from './router.js';
import type { DesktopControl } from '../integrations/desktop.js';
import type { SessionLock } from '../session-lock.js';
import { ChatScreenEntry } from './screen-entry.js';
import { ScreenRefusal } from './screen-sessions.js';
import { lockdownActive } from '../lockdown.js';
import { signInShowing } from '../sign-in-showing.js';
import { audit } from '../audit.js';

/** Installs only trusted engine dependencies; HTTP bodies supply neither desktop services nor owner identity. */
export function installChatScreenEntry(parts: { store: Store; owner: string; channels: ChannelRouter; desktop: DesktopControl;
  lock: SessionLock; publicAddress: () => string | null }): ChatScreenEntry {
  const { store, owner, channels, desktop, lock } = parts;
  const held = (): string | null => !store.profiles.isOwner() ? 'Switch Branch to your owner profile first.'
    : lockdownActive(store, owner) ? 'Leave Lockdown before starting a screen session.'
    : lock.locked() ? 'Unlock Branch before starting a screen session.'
    : signInShowing() ? 'Branch is handling a sign-in. Try again when it finishes.' : null;
  const entry = new ChatScreenEntry({
    eligible: chat => channels.screenEligible(chat), held,
    verify: (channel, initData) => {
      const adapter = channels.adapter(channel);
      if (adapter?.kind !== 'telegram' || !adapter.verifyMiniApp) throw new ScreenRefusal();
      return adapter.verifyMiniApp(initData);
    },
    confirmPin: async pin => lock.confirmPin({ pin }), windowOwner: () => store.profiles.isOwner() && !held(),
    publicAddress: parts.publicAddress,
    link: async (chat, url) => {
      const adapter = channels.adapter(chat.channel);
      if (!channels.screenEligible(chat) || adapter?.kind !== 'telegram' || !adapter.sendScreenLink || held()) throw new ScreenRefusal();
      await adapter.sendScreenLink(chat.chatId, url);
    },
    targets: (guard, signal) => desktop.captureTargets(owner, guard, signal),
    open: (target, guard, stopped, signal) => desktop.chatScreen(owner, { target, guard, stopped, signal }),
    audit: (event, detail) => audit(store, owner, { action: 'screen.session', actor: 'your paired direct chat',
      subject: typeof detail.session === 'string' ? detail.session : 'screen session', reason: event,
      outcome: JSON.stringify(detail) }),
  });
  channels.screenCommand = (chat, argument) => entry.command(chat, argument);
  return entry;
}
