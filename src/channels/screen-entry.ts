import { createHash, randomBytes } from 'node:crypto';
import { ChatScreenSessions, ScreenRefusal, type ScreenChat, type ScreenSessionDesktop, type ScreenAction } from './screen-sessions.js';
import { NativeCaptureTargetSchema, type NativeCaptureTarget } from '../desktop/capture-lease.js';
import type { TelegramLaunch } from './telegram-init-data.js';
import { nativeWindowViewable } from '../integrations/native-view-target.js';

export interface ChatScreenEntryPorts {
  eligible(chat: ScreenChat): boolean;
  held(): string | null;
  verify(channel: string, initData: string): TelegramLaunch;
  confirmPin(pin: string): Promise<boolean>;
  windowOwner(): boolean;
  publicAddress(): string | null;
  link(chat: ScreenChat, url: string): Promise<void>;
  targets(guard: () => void, signal: AbortSignal): Promise<Record<string, unknown>>;
  open(target: NativeCaptureTarget, guard: () => void, stopped: () => void, signal: AbortSignal): Promise<ScreenSessionDesktop>;
  audit(event: 'requested' | 'confirmed' | 'started' | 'action' | 'control' | 'stopped', detail: Record<string, unknown>): void;
  now?: () => number;
}
interface Choice { request: string; chat: ScreenChat; target: NativeCaptureTarget; expires: number; excludedProcessId: number }
const keyHash = (key: string): string => createHash('sha256').update(key).digest('hex');
/** Owns opaque target choices and single-use input frame proofs; neither is a native handle supplied by a client. */
export class ChatScreenEntry {
  readonly sessions: ChatScreenSessions;
  private readonly choices = new Map<string, Choice>();
  private readonly frames = new Map<string, { token: string; expires: number }>();
  private busy = false;
  private activeChoice: Choice | null = null;
  constructor(private readonly ports: ChatScreenEntryPorts) {
    this.sessions = new ChatScreenSessions({ ...ports, open: (chat, stopped, signal, selection) => {
      const choice = selection ? this.choices.get(selection) : undefined;
      this.choices.delete(selection ?? '');
      if (!choice || choice.expires <= this.now() || !this.same(choice.chat, chat)) throw new ScreenRefusal('Choose a fresh screen target.');
      return ports.open(choice.target, () => this.guard(chat), stopped, signal);
    } });
  }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private same(a: ScreenChat, b: ScreenChat): boolean { return a.channel === b.channel && a.chatId === b.chatId && a.senderId === b.senderId; }
  private guard(chat: ScreenChat): void {
    const held = this.ports.held();
    if (held) throw new ScreenRefusal(held);
    if (!this.ports.eligible(chat)) throw new ScreenRefusal();
  }
  async command(chat: ScreenChat, argument: string): Promise<string> {
    if (argument.toLowerCase() === 'stop') {
      this.sessions.stopFromChat(chat);
      return 'The screen session stopped.';
    }
    if (argument) return 'Send /screen to open a screen session, or /screen stop to stop it.';
    this.guard(chat);
    const address = this.ports.publicAddress();
    if (!address) throw new ScreenRefusal('Open the secure door in Branch’s window before starting a screen session.');
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ScreenRefusal('Use the secure door’s HTTPS address.');
    const pending = this.sessions.request(chat);
    url.pathname = '/chat-screen'; url.searchParams.set('request', pending.id);
    this.guard(chat);
    await this.ports.link(chat, url.toString());
    return 'Open the screen button, confirm this session in Branch’s window or with your PIN, then choose what to see. Send /screen stop at any time.';
  }
  async targets(id: string, initData: string, pin?: string) {
    const chat = await this.sessions.prepare(id, initData, pin);
    const controller = new AbortController();
    const listed = await this.ports.targets(() => this.guard(chat), controller.signal);
    this.guard(chat);
    for (const [key, choice] of this.choices) if (choice.request === id || choice.expires <= this.now()) this.choices.delete(key);
    if (this.choices.size >= 64) throw new ScreenRefusal('Too many targets are waiting. Start again in two minutes.');
    if (!Number.isSafeInteger(listed.excludedProcessId) || Number(listed.excludedProcessId) <= 0) throw new ScreenRefusal('The desktop host could not prove its viewer identity.');
    // Monitor and browser-window capture stay closed until every viewer can prove its native exclusion identity.
    const records = (Array.isArray(listed.windows) ? listed.windows : []).flatMap(window => {
      if (!nativeWindowViewable(window, Number(listed.excludedProcessId))) return [];
      return [{ kind: 'window', handle: String(window.handle), processId: window.processId,
        bounds: { x: window.x, y: window.y, w: window.width, h: window.height }, label: window.title }];
    });
    return records.slice(0, Math.min(32, 64 - this.choices.size)).flatMap(record => {
      if (!record || typeof record !== 'object') return [];
      const value = NativeCaptureTargetSchema.safeParse(record);
      // Native targets are strict; the presentation label is never part of the identity.
      const { label, ...identity } = record;
      const parsed = value.success ? value : NativeCaptureTargetSchema.safeParse(identity);
      if (!parsed.success || (parsed.data.kind === 'window' && parsed.data.processId === listed.excludedProcessId)) return [];
      const key = randomBytes(24).toString('base64url');
      this.choices.set(key, { request: id, chat, target: parsed.data, expires: this.now() + 2 * 60_000, excludedProcessId: Number(listed.excludedProcessId) });
      return [{ id: key, label: typeof label === 'string' ? label.slice(0, 200) : parsed.data.kind === 'monitor' ? parsed.data.deviceName : 'Window', kind: parsed.data.kind }];
    });
  }
  async start(id: string, initData: string, selection: string, pin?: string) {
    const choice = this.choices.get(selection);
    if (!choice || choice.request !== id) throw new ScreenRefusal('Choose a fresh screen target.');
    const started = await this.sessions.start(id, initData, pin, selection);
    this.frames.clear();
    this.activeChoice = choice;
    return started;
  }
  async frame(key: string, width: number) {
    if (this.busy) throw new ScreenRefusal('The previous screen request is still finishing.');
    this.busy = true;
    try {
      const frame = await this.sessions.frame(key, width), token = randomBytes(24).toString('base64url');
      this.checkProvenance(frame);
      this.frames.set(keyHash(key), { token, expires: this.now() + 5000 });
      return { ...frame, inputFrame: token };
    } finally { this.busy = false; }
  }
  private checkProvenance(value: unknown): void {
    const frame = value as { windows?: unknown; after?: unknown };
    const choice = this.activeChoice;
    const selected = (records: unknown): boolean => Array.isArray(records) && records.some(value => value && typeof value === 'object'
      && choice?.target.kind === 'window' && String(value.handle) === choice.target.handle && value.processId === choice.target.processId
      && nativeWindowViewable(value, choice.excludedProcessId));
    if (!choice || !selected(frame.windows) || !selected(frame.after)) {
      this.revoke();
      throw new ScreenRefusal('The selected window’s native viewer identity changed. Choose it again.');
    }
  }
  async action(key: string, token: string, action: ScreenAction): Promise<void> {
    if (this.busy) throw new ScreenRefusal('The previous screen request is still finishing.');
    const frame = this.frames.get(keyHash(key));
    this.frames.delete(keyHash(key));
    if (!frame || frame.token !== token || frame.expires <= this.now()) throw new ScreenRefusal('Refresh the screen before using it.');
    this.busy = true;
    try { await this.sessions.action(key, action); } finally { this.busy = false; }
  }
  revoke(): void { this.choices.clear(); this.frames.clear(); this.activeChoice = null; this.sessions.revoke(); }
  close(): void { this.revoke(); this.sessions.close(); }
}
