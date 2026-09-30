/** The owner explicitly saves Branch browser pages; optional Branch history never reads an external browser. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.js';
import { redactLeaksIn } from '../leak-guard.js';

const entrySchema = z.object({ id: z.string().uuid(), url: z.string().max(2000), title: z.string().max(200), at: z.string().max(80) }).strict();
const schema = z.object({ bookmarks: z.array(entrySchema).max(50).default([]), history: z.array(entrySchema).max(100).default([]),
  historyEnabled: z.boolean().default(false), lastUrl: z.string().max(2000).default('') }).strict();
export type BrowserLibrary = z.infer<typeof schema>;
const key = (scope: string): string => `browser-library:${scope}`;

/** URLs with credentials or secret-bearing paths cannot become navigable saved entries. Queries/fragments are omitted. */
function safeAddress(store: Store, raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = ''; url.hash = '';
    const address = url.toString(), decoded = decodeURIComponent(address);
    const clean = (text: string) => redactLeaksIn(store.secrets.scrubber.deep(text)).value;
    return address.length <= 2000 && clean(address) === address && clean(decoded) === decoded ? address : null;
  } catch { return null; }
}
export function readBrowserLibrary(store: Store, owner: string, scope: string): BrowserLibrary {
  const parsed = schema.safeParse(store.get('settings', owner, key(scope))?.data ?? {});
  const found = parsed.success ? parsed.data : schema.parse({});
  const clean = (entries: BrowserLibrary['bookmarks']) => entries.flatMap(entry => {
    const url = safeAddress(store, entry.url);
    const title = String(redactLeaksIn(store.secrets.scrubber.deep(entry.title)).value).slice(0, 200);
    return url ? [{ ...entry, url, title }] : [];
  });
  return { ...found, bookmarks: clean(found.bookmarks), history: clean(found.history).filter(entry => Date.parse(entry.at) >= Date.now() - 30 * 24 * 60 * 60_000), lastUrl: safeAddress(store, found.lastUrl) ?? '' };
}
function save(store: Store, owner: string, scope: string, library: BrowserLibrary): BrowserLibrary {
  store.save('settings', owner, key(scope), { ...library }); return library;
}
export function saveBrowserPage(store: Store, owner: string, scope: string, page: { url: string; title: string }, bookmark: boolean): BrowserLibrary {
  const library = readBrowserLibrary(store, owner, scope), url = safeAddress(store, page.url);
  if (!url && bookmark) throw new Error('This page address cannot be saved safely.');
  if (!url || (!bookmark && (!library.historyEnabled || library.lastUrl === url))) return library;
  const title = String(redactLeaksIn(store.secrets.scrubber.deep(page.title)).value).slice(0, 200);
  const field = bookmark ? 'bookmarks' : 'history', before = library[field].find(one => one.url === url);
  const entry = { id: before?.id ?? randomUUID(), url, title, at: new Date().toISOString() };
  library[field] = [entry, ...library[field].filter(one => one.url !== url)].slice(0, bookmark ? 50 : 100);
  if (!bookmark) library.lastUrl = url;
  return save(store, owner, scope, library);
}
export function changeBrowserLibrary(store: Store, owner: string, scope: string, operation: 'remove' | 'clear' | 'history', value?: string | boolean): BrowserLibrary {
  const library = readBrowserLibrary(store, owner, scope);
  if (operation === 'remove') library.bookmarks = library.bookmarks.filter(entry => entry.id !== value);
  if (operation === 'clear') library.history = [];
  if (operation === 'history') {
    library.historyEnabled = value === true;
    if (!library.historyEnabled) { library.history = []; library.lastUrl = ''; }
  }
  return save(store, owner, scope, library);
}
