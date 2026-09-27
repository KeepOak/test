import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { placeOnFrame, type LiveFrameSource, type LivePointer } from '../live-screen.js';
import type { TelegramLaunch } from './telegram-init-data.js';

/** A separate capability: these keys never authorize Branch's other HTTP routes or tools. */
const lifetime = 5 * 60_000, idle = 60_000, waiting = 3 * 60_000;
const digest = (key: string): string => createHash('sha256').update(key).digest('hex');
const Window = z.string().trim().min(1).max(200);
export const ScreenAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), window: Window, x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  z.object({ action: z.literal('type'), window: Window, text: z.string().min(1).max(2000) }).strict(),
  z.object({ action: z.literal('key'), window: Window, chord: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal('scroll'), window: Window, steps: z.number().int().min(-10).max(10).refine((n) => n !== 0) }).strict(),
]);
export type ScreenAction = z.infer<typeof ScreenAction>;
export interface ScreenChat { channel: string; senderId: string; chatId: string; chatKind: 'direct' | 'group'; caughtUp?: boolean; trunk: string | null }
export class ScreenRefusal extends Error {
  constructor(message = 'This screen session is unavailable. Start again from your own paired direct chat.') { super(message); }
}
export interface ScreenSessionPorts {
  /** Rereads the off-by-default setting, pairing, exact owner ID and current sender access. */
  eligible(chat: ScreenChat): boolean;
  /** Current Lockdown, App lock, owner profile, screen switch and private sign-in state. */
  held(): string | null;
  verify(channel: string, initData: string): TelegramLaunch;
  /** Uses the existing rate-limited PIN checker, without unlocking the whole app. */
  confirmPin(pin: string): Promise<boolean>;
  /** The authenticated local owner window is the only caller of confirmInWindow. */
  windowOwner(): boolean;
  open(chat: ScreenChat, stopped: () => void, signal: AbortSignal): Promise<ScreenSessionDesktop>;
  audit(event: 'requested' | 'confirmed' | 'started' | 'action' | 'control' | 'stopped', detail: Record<string, unknown>): void;
  now?: () => number;
}
export interface ScreenSessionDesktop {
  frames: LiveFrameSource;
  visible(): boolean;
  act(action: ScreenAction, signal: AbortSignal): Promise<void>;
  takeOver(): void;
  handBack(): void;
  pointer(): LivePointer | null;
  close(): Promise<void>;
}
interface Pending { id: string; chat: ScreenChat; expires: number; confirmedUntil: number }
interface Active {
  id: string; chat: ScreenChat; keyHash: string; expires: number; touched: number;
  controller: AbortController; desktop: ScreenSessionDesktop; control: 'owner' | 'agent'; busy: boolean;
}

/**
 * One active screen session, bound to one pending paired-owner DM and signed Telegram launch.
 * Frames do not keep a session alive. The key lives in memory, is returned once, and is stored
 * only as a hash. Expiry and revocation abort outstanding I/O and remove the notice and reader.
 */
export class ChatScreenSessions {
  private readonly pending = new Map<string, Pending>();
  private readonly launches = new Map<string, number>();
  private active: Active | null = null;
  private opening = false;
  private openingController: AbortController | null = null;
  private openingChat: ScreenChat | null = null;
  private closing: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly ports: ScreenSessionPorts) {
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private allowed(chat: ScreenChat): void {
    const held = this.ports.held();
    if (held) throw new ScreenRefusal(held);
    if (chat.chatKind !== 'direct' || chat.caughtUp || !this.ports.eligible(chat)) throw new ScreenRefusal();
  }
  request(chat: ScreenChat): { id: string; expires: number } {
    this.sweep();
    this.allowed(chat);
    if (this.active || this.opening) throw new ScreenRefusal('Stop the current screen session first.');
    for (const [id, value] of this.pending) if (value.chat.channel === chat.channel && value.chat.senderId === chat.senderId) this.pending.delete(id);
    if (this.pending.size >= 4) throw new ScreenRefusal('Too many screen requests are waiting. Try again in three minutes.');
    const entry: Pending = { id: randomUUID(), chat: { ...chat }, expires: this.now() + waiting, confirmedUntil: 0 };
    this.pending.set(entry.id, entry);
    this.ports.audit('requested', { session: entry.id, channel: chat.channel, senderId: chat.senderId });
    return { id: entry.id, expires: entry.expires };
  }
  waiting(): { id: string; channel: string; senderId: string; expires: number }[] {
    if (!this.ports.windowOwner()) throw new ScreenRefusal();
    this.sweep();
    return [...this.pending.values()].map(({ id, chat, expires }) => ({ id, channel: chat.channel, senderId: chat.senderId, expires }));
  }
  confirmInWindow(id: string): void {
    if (!this.ports.windowOwner()) throw new ScreenRefusal();
    const pending = this.findPending(id);
    this.allowed(pending.chat);
    pending.confirmedUntil = Math.min(pending.expires, this.now() + 2 * 60_000);
    this.ports.audit('confirmed', { session: id, from: 'window' });
  }
  private findPending(id: string): Pending {
    const pending = this.pending.get(id);
    if (!pending || pending.expires <= this.now()) { this.pending.delete(id); throw new ScreenRefusal(); }
    return pending;
  }
  async start(id: string, initData: string, pin?: string): Promise<{ id: string; key: string; expires: number }> {
    const pending = this.findPending(id);
    this.allowed(pending.chat);
    if (this.active || this.opening) throw new ScreenRefusal('Stop the current screen session first.');
    const launch = this.ports.verify(pending.chat.channel, initData);
    if (launch.senderId !== pending.chat.senderId || this.launches.has(launch.hash)) throw new ScreenRefusal();
    this.opening = true;
    const controller = new AbortController();
    this.openingController = controller;
    this.openingChat = pending.chat;
    let desktop: ScreenSessionDesktop | undefined;
    try {
      await this.closing;
      if (pending.confirmedUntil <= this.now()) {
        if (typeof pin !== 'string' || !await this.ports.confirmPin(pin)) throw new ScreenRefusal('Confirm this session in Branch’s window, or enter your PIN.');
        this.ports.audit('confirmed', { session: id, from: 'pin' });
      }
      this.findPending(id);
      this.allowed(pending.chat);
      this.ports.verify(pending.chat.channel, initData); // PIN or window confirmation may have taken time.
      if (controller.signal.aborted) throw new ScreenRefusal();
      // Consume only after fresh confirmation. Failed guesses cannot burn the owner's launch.
      if (this.launches.size >= 128) throw new ScreenRefusal('Too many screen sessions started recently. Wait three minutes.');
      this.launches.set(launch.hash, this.now() + waiting);
      this.pending.delete(id);
      desktop = await this.ports.open(pending.chat, () => controller.abort(), controller.signal);
      this.allowed(pending.chat);
      this.ports.verify(pending.chat.channel, initData); // The launch must still be fresh at key issuance.
      if (pending.expires <= this.now()) throw new ScreenRefusal();
      if (controller.signal.aborted || !desktop.visible()) throw new ScreenRefusal('The Stop notice is not visible.');
      const key = randomBytes(32).toString('base64url'), expires = this.now() + lifetime;
      this.active = { id, chat: pending.chat, keyHash: digest(key), expires, touched: this.now(), controller, desktop, control: 'agent', busy: false };
      controller.signal.addEventListener('abort', () => this.stopActive('Stop'), { once: true });
      this.ports.audit('started', { session: id, channel: pending.chat.channel, expires });
      return { id, key, expires };
    } catch (error) {
      controller.abort();
      await desktop?.close();
      throw error;
    } finally { this.opening = false; this.openingController = null; this.openingChat = null; }
  }
  private authorized(key: string): Active {
    const active = this.active;
    if (!active || typeof key !== 'string' || !/^[\w-]{43}$/.test(key) || digest(key) !== active.keyHash) throw new ScreenRefusal();
    try {
      this.allowed(active.chat);
      if (active.expires <= this.now() || active.touched + idle <= this.now() || !active.desktop.visible() || active.controller.signal.aborted) throw new ScreenRefusal('The screen session stopped.');
    } catch (error) { this.stopActive('permission or expiry'); throw error; }
    return active;
  }
  async frame(key: string, maxWidth = 1280) {
    const active = this.authorized(key);
    if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 1920) throw new ScreenRefusal('Invalid screen size.');
    try {
      const frame = await active.desktop.frames.next(maxWidth, active.controller.signal);
      if (this.authorized(key) !== active) throw new ScreenRefusal();
      return { ...frame, session: active.id, control: active.control, cursor: placeOnFrame(active.desktop.pointer(), frame.screen) };
    } catch (error) { this.stopActive('frame refused'); throw error; }
  }
  async action(key: string, input: unknown): Promise<void> {
    const active = this.authorized(key), action = ScreenAction.parse(input);
    if (active.control !== 'owner') throw new ScreenRefusal('Take over before using the screen.');
    if (active.busy) throw new ScreenRefusal('The previous screen action is still finishing.');
    active.busy = true;
    try {
      active.touched = this.now();
      // No typed text, screen bytes, PIN, launch proof or session key goes into the audit.
      this.ports.audit('action', { session: active.id, action: action.action, ...(action.action === 'type' ? { characters: action.text.length } : {}) });
      await active.desktop.act(action, active.controller.signal);
      this.authorized(key);
    } catch (error) { this.stopActive('action refused'); throw error; }
    finally { active.busy = false; }
  }
  control(key: string, owner: boolean): void {
    const active = this.authorized(key);
    if (active.busy) throw new ScreenRefusal('The previous screen action is still finishing.');
    if (owner) active.desktop.takeOver(); else active.desktop.handBack();
    active.control = owner ? 'owner' : 'agent';
    active.touched = this.now();
    this.ports.audit('control', { session: active.id, control: active.control });
  }
  stop(key: string): void { this.authorized(key); this.stopActive('owner'); }
  stopFromChat(chat: ScreenChat): boolean {
    this.allowed(chat);
    const same = (other: ScreenChat) => other.channel === chat.channel && other.chatId === chat.chatId && other.senderId === chat.senderId;
    for (const [id, value] of this.pending) if (same(value.chat)) this.pending.delete(id);
    if (this.openingChat && same(this.openingChat)) this.openingController?.abort();
    const active = this.active;
    if (!active || !same(active.chat)) return false;
    this.stopActive('paired chat');
    return true;
  }
  stopFromWindow(): void {
    if (!this.ports.windowOwner()) throw new ScreenRefusal();
    this.pending.clear();
    this.openingController?.abort();
    this.stopActive('window');
  }
  private stopActive(reason: string): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.controller.abort();
    active.desktop.frames.close();
    active.desktop.handBack();
    this.closing = active.desktop.close();
    void this.closing.catch(() => undefined); // Keep the rejection: another session may not open after failed cleanup.
    this.ports.audit('stopped', { session: active.id, reason });
  }
  sweep(): void {
    const now = this.now();
    for (const [id, value] of this.pending) if (value.expires <= now) this.pending.delete(id);
    for (const [hash, expiry] of this.launches) if (expiry <= now) this.launches.delete(hash);
    const active = this.active;
    if (active) {
      if (active.expires <= now || active.touched + idle <= now || !active.desktop.visible() || this.ports.held() || !this.ports.eligible(active.chat)) this.stopActive('idle, permission or expiry');
    }
  }
  close(): void { clearInterval(this.timer); this.pending.clear(); this.openingController?.abort(); this.stopActive('Branch closed'); }
}
