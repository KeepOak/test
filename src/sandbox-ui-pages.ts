import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { Plugins } from './plugins.js';
import { appHeaders, appPage } from './mcp-apps.js';
import { lockdownActive } from './lockdown.js';
import { scriptedProxyHeaders, scriptedProxyPage } from './scripted-mcp-proxy.js';

const digest = (html: string): string => createHash('sha256').update(html).digest('hex');
interface HeldPage {
  owner: string; sessionId: string; source: string; html: string; hash: string; nonce: string;
  scripts: boolean; used: boolean; until: number; messageId?: number;
}
/** Only an explicit HTML block in an already-saved assistant reply becomes a canvas. */
export function replyCanvas(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const match = /(?:^|\n)```html[ \t]*\r?\n([\s\S]*?)\r?\n```(?:[ \t]*\n|[ \t]*$)/i.exec(content);
  if (!match?.[1]?.trim() || Buffer.byteLength(match[1]) > 200000) return null;
  return match[1];
}

export class SandboxUiPages {
  private readonly held = new Map<string, HeldPage>();
  constructor(private readonly store: Store, private readonly owner: () => string, private readonly plugins: Plugins,
    private readonly unlocked: () => boolean) {}
  private guard(sessionId: string): void {
    this.store.profiles.requireOwner('Sandboxed UI pages');
    if (!this.store.ownsSession(this.owner(), sessionId)) throw new Error('Conversation not found');
    if (!this.unlocked() || lockdownActive(this.store, this.owner())) throw new Error('Unlock the owner window to view UI pages.');
  }
  private reply(sessionId: string, messageId: number): string {
    const message = this.store.sessionView(this.owner(), sessionId).messages.find(item => item.messageId === messageId && item.role === 'assistant');
    const html = replyCanvas(message?.content);
    if (!html) throw new Error('This saved reply has no supported HTML canvas.');
    return html;
  }
  private hold(page: Omit<HeldPage, 'owner' | 'hash' | 'nonce' | 'used' | 'until'>) {
    for (const [id, held] of this.held) if (held.until <= Date.now() || held.owner !== this.owner()) this.held.delete(id);
    const existing = [...this.held.entries()].find(([, held]) => !held.used && !page.scripts && held.sessionId === page.sessionId
      && held.source === page.source && held.html === page.html && held.messageId === page.messageId && held.until > Date.now() + 30000);
    if (existing) return { id: existing[0], page: existing[1] };
    if (this.held.size >= 64) throw new Error('Too many UI pages are open. Close a page and try again.');
    const id = randomUUID(), held: HeldPage = { ...page, owner: this.owner(), hash: digest(page.html), nonce: randomUUID(), used: false, until: Date.now() + 300000 };
    this.held.set(id, held); return { id, page: held };
  }
  pluginPages(sessionId: string) {
    this.guard(sessionId);
    return this.plugins.pageContributions(sessionId).map(entry => {
      try {
        const held = this.hold({ sessionId, source: entry.id, html: entry.html, scripts: false });
        return { id: entry.id, slot: entry.slot, title: entry.title, pluginName: entry.pluginName, url: `/sandbox-ui/${held.id}` };
      } catch { return { id: entry.id, slot: entry.slot, title: entry.title, pluginName: entry.pluginName, error: 'This contribution could not be displayed.' }; }
    });
  }
  open(input: unknown) {
    const value = z.object({ sessionId: z.string().uuid(), messageId: z.number().int().positive(), scripts: z.boolean().default(false),
      confirmed: z.boolean().default(false), previewCapability: z.string().uuid().optional() }).strict().parse(input);
    this.guard(value.sessionId);
    if (value.scripts && !value.confirmed) throw new Error('The owner must approve scripts for this exact saved reply.');
    const html = this.reply(value.sessionId, value.messageId);
    if (value.scripts) {
      const preview = value.previewCapability ? this.held.get(value.previewCapability) : undefined;
      if (!preview || preview.scripts || preview.owner !== this.owner() || preview.until <= Date.now()
        || preview.sessionId !== value.sessionId || preview.messageId !== value.messageId || preview.hash !== digest(html))
        throw new Error('The preview changed or expired. Preview this saved reply again before approving scripts.');
    }
    const held = this.hold({ sessionId: value.sessionId, source: 'reply', messageId: value.messageId, html, scripts: value.scripts });
    return { capability: held.id, nonce: held.page.nonce, url: `/sandbox-ui/${held.id}`, scripts: value.scripts, ...(value.scripts ? { html } : {}) };
  }
  close(id: string): void { this.held.delete(id); }
  page(id: string): { body: string; headers: Record<string, string> } | null {
    const page = this.held.get(id);
    if (!page || page.used || page.until <= Date.now() || page.owner !== this.owner()) return null;
    try {
      this.guard(page.sessionId);
      const current = page.source === 'reply' ? this.reply(page.sessionId, page.messageId!)
        : this.plugins.pageContributions(page.sessionId).find(entry => entry.id === page.source)?.html;
      if (!current || digest(current) !== page.hash) { this.held.delete(id); return null; }
      // Static pages can reload during this bounded lease; scripted proxy addresses are one-use.
      if (page.scripts) { page.used = true; return { body: scriptedProxyPage(page.nonce), headers: scriptedProxyHeaders }; }
      return { body: appPage({ server: page.source === 'reply' ? 'Reply canvas' : page.source, uri: page.sessionId, html: page.html }).body, headers: appHeaders() };
    } catch { return null; }
  }
}
