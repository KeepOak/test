import { z } from 'zod';
import type { Store } from '../store.js';
import { audit } from '../audit.js';

const key = 'personal-main-thread';
const peer = z.object({ channel: z.string().min(1).max(64), sender: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
const binding = peer.extend({ sessionId: z.string().uuid(), trunkId: z.string().uuid() }).strict();
const input = z.discriminatedUnion('on', [z.object({ on: z.literal(false) }).strict(),
  peer.extend({ on: z.literal(true), sessionId: z.string().uuid(), trunkId: z.string().uuid() }).strict()]);
type Binding = z.infer<typeof binding>;
const activeTurns = new WeakMap<Store, Set<string>>();

/** One explicit account and exact current default-Trunk conversation; never match a title or merge history. */
export class PersonalMainThread {
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly main: () => { sessionId: string; trunkId: string } | null,
    private readonly eligible: (channel: string, sender: string) => boolean) {}
  saved(): Binding | null {
    const parsed = binding.safeParse(this.store.get('settings', this.owner, key)?.data);
    return parsed.success ? parsed.data : null;
  }
  private valid(value: Binding): boolean {
    const main = this.main();
    return main?.sessionId === value.sessionId && main.trunkId === value.trunkId
      && this.store.ownsSession(this.owner, value.sessionId) && !this.store.sessionTemporary(value.sessionId)
      && !this.store.conversations.inBin(value.sessionId) && this.eligible(value.channel, value.sender);
  }
  view() { const saved = this.saved(); return { binding: saved, active: !!saved && this.valid(saved), main: this.main() }; }
  set(raw: unknown) {
    this.store.profiles.requireOwner('Sharing your personal main thread');
    const value = input.parse(raw), prior = this.saved();
    if (prior && (this.store.conversations.busy([prior.sessionId]) || activeTurns.get(this.store)?.has(prior.sessionId)))
      throw new Error('Stop or finish the main thread before changing its routing.');
    if (!value.on) this.store.delete('settings', this.owner, key);
    else {
      const { on: _on, ...next } = value;
      if (!this.valid(next) || this.store.conversations.busy([next.sessionId]))
        throw new Error('Use an idle current default-Trunk conversation and an approved, named owner Telegram account with full-owner-chat access.');
      const others = this.store.sqlite.prepare(`SELECT 1 AS found FROM settings WHERE owner=?
        AND substr(id,1,16)='channel-session:' AND json_extract(data,'$.sessionId')=? AND id<>? LIMIT 1`)
        .get(this.owner, next.sessionId, `channel-session:${next.channel}:${next.sender}`);
      if (others) throw new Error('Another chat already points at that conversation. Disconnect it before sharing a personal thread.');
      this.store.save('settings', this.owner, key, next);
    }
    audit(this.store, this.owner, { action: 'channel.paired', actor: this.owner, subject: 'Personal main thread',
      reason: value.on ? 'You explicitly shared the exact owner default-Trunk conversation with your named Telegram DM.'
        : 'You stopped sharing the personal main thread; previous chat history remains intact.', outcome: 'saved' });
    return this.view();
  }
  matches(channel: string, chatId: string): boolean { const saved = this.saved(); return saved?.channel === channel && saved.sender === chatId; }
  session(channel: string, chatId: string): string | undefined {
    if (!this.matches(channel, chatId)) return undefined;
    const saved = this.saved()!;
    if (!this.valid(saved)) throw new Error('Personal main-thread routing is held. Review its account, access and default Trunk in the owner window.');
    return saved.sessionId;
  }
  assertMessage(message: { channel: string; chatId: string; senderId: string; chatKind: string; caughtUp?: boolean | undefined }): void {
    if (!this.matches(message.channel, message.chatId)) return;
    if (message.senderId !== message.chatId || message.chatKind !== 'direct' || message.caughtUp)
      throw new Error('Only a live message from the exact owner Telegram DM may use the personal main thread.');
    this.session(message.channel, message.chatId);
  }
}

/** Reject overlapping model turns rather than mixing steering or approvals between surfaces. */
export async function personalMainTurn<T>(store: Store, owner: string, sessionId: string | undefined, run: () => Promise<T>): Promise<T> {
  const parsed = binding.safeParse(store.get('settings', owner, key)?.data);
  if (!parsed.success || parsed.data.sessionId !== sessionId) return run();
  const turns = activeTurns.get(store) ?? new Set<string>();
  activeTurns.set(store, turns);
  const id = parsed.data.sessionId;
  if (turns.has(id) || store.conversations.busy([id])) throw new Error('The personal main thread has a task already. Finish or stop it before starting a turn on the other surface.');
  turns.add(id);
  try { return await run(); } finally { turns.delete(id); }
}
