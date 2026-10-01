import { z } from 'zod';
import type { Locator, Page, Request } from 'playwright';

/**
 * The rest of what a Trunk's hands do in a page, taken from what Hermes Agent (browser_scroll, browser_press,
 * browser_back, browser_console) and OpenClaw (act hover/select/press, requests, errors, element screenshot, waiting
 * for text to go) give an agent, and each run through Branch's own browser like every other step: its network rules,
 * the owner's approval rules, Lockdown, the one-writer control and the task's limits (src/integrations/browser.ts).
 *
 * What a page logs and asks for is the website's own text, so it comes back as untrusted words with secrets taken out;
 * addresses lose their query (where keys travel), and no header, cookie or body is ever read.
 */
const target = {
  selector: z.string().min(1).max(300).optional(),
  name: z.string().min(1).max(300).optional(),
  mark: z.number().int().min(1).max(500).optional(),
};
const oneTarget = (value: { selector?: string | undefined; name?: string | undefined; mark?: number | undefined }) =>
  [value.selector, value.name, value.mark].filter(v => v !== undefined).length === 1;

export const ScrollSchema = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
  /** How far, in page pixels; one screen when left out. */
  amount: z.number().int().min(1).max(20_000).optional(),
  /** The very top or bottom of the page instead. */
  to: z.enum(['top', 'bottom']).optional(),
  ...target,
}).strict().refine(v => [v.selector, v.name, v.mark].filter(x => x !== undefined).length <= 1, 'Name at most one thing to scroll to');
export const HoverSchema = z.object(target).strict().refine(oneTarget, 'Name one thing to hover over: a selector, its name or its number');
const modifiers = ['Control', 'Meta', 'Alt', 'Shift'];
const named = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
/** One key or a combination such as Control+A or Shift+Tab. */
export const keyCombo = z.string().min(1).max(60).refine(value => {
  const parts = value.split('+'), last = parts.pop() ?? '';
  return parts.length <= 3 && new Set(parts).size === parts.length && parts.every(part => modifiers.includes(part))
    && (named.has(last) || /^[a-zA-Z0-9]$/.test(last) || /^[`\-=[\];',./\\]$/.test(last));
}, 'Name a key (Enter, Tab, Escape, ArrowDown, F5, a letter or digit) with up to three of Control, Meta, Alt and Shift before it, joined by +');
export const KeysSchema = z.object({ keys: keyCombo, repeat: z.number().int().min(1).max(20).default(1) }).strict();
export const SelectSchema = z.object({
  ...target,
  /** The option or options to choose, by their shown words or their value. */
  option: z.union([z.string().min(1).max(300), z.array(z.string().min(1).max(300)).min(1).max(20)]),
}).strict().refine(oneTarget, 'Name one list to choose from: a selector, its name or its number');
export const HistorySchema = z.object({ action: z.enum(['back', 'forward', 'reload']) }).strict();
export const ConsoleSchema = z.object({
  level: z.enum(['all', 'error', 'warning']).default('all'),
  limit: z.number().int().min(1).max(100).default(30),
  clear: z.boolean().default(false),
}).strict();
export const NetworkSchema = z.object({
  /** Only requests whose address or kind (document, script, fetch, xhr, image…) contains these words. */
  filter: z.string().min(1).max(200).optional(),
  failedOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  clear: z.boolean().default(false),
}).strict();

export const ImagesSchema = z.object({
  /** Only images whose address or words contain these. */
  filter: z.string().min(1).max(200).optional(),
  /** Only those at least this wide, in page pixels, to skip icons and spacers. */
  minWidth: z.number().int().min(0).max(4000).default(0),
  limit: z.number().int().min(1).max(100).default(40),
}).strict();
/** The images the page shows: address without its query, the words it gives for them, and their drawn size. */
export async function listImages(page: Page, input: z.infer<typeof ImagesSchema>) {
  const found = await page.evaluate(() => [...document.images].map(image => {
    const box = image.getBoundingClientRect();
    return { src: image.currentSrc || image.src, alt: (image.alt || image.title || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      width: Math.round(box.width), height: Math.round(box.height) };
  }).filter(image => /^https?:/.test(image.src)));
  const filter = input.filter?.toLowerCase();
  const wanted = found.filter(image => image.width >= input.minWidth
    && (!filter || image.src.toLowerCase().includes(filter) || image.alt.toLowerCase().includes(filter)));
  return { url: page.url(), images: wanted.slice(0, input.limit).map(image => ({ ...image, src: plainAddress(image.src) })),
    more: Math.max(0, wanted.length - input.limit) };
}

export interface ConsoleRecord { level: string; text: string; at: string }
export interface RequestRecord { method: string; url: string; kind: string; status: number | null; failure: string | null; at: string }
const KEPT = 200;
const push = <T>(list: T[], item: T): void => { list.push(item); if (list.length > KEPT) list.splice(0, list.length - KEPT); };
/** An address without its query or fragment, where keys and codes travel; "?…" says one was there. */
export function plainAddress(url: string): string {
  try { const at = new URL(url); return `${at.origin}${at.pathname}${at.search ? '?…' : ''}`; } catch { return ''; }
}

/** What each tab of a task has logged and asked the network for, the latest 200 of each, kept in memory only. */
export class PageLog {
  readonly console: ConsoleRecord[] = [];
  readonly requests: RequestRecord[] = [];
  watch(page: Page): void {
    page.on('console', message => {
      push(this.console, { level: message.type(), text: message.text().slice(0, 2000), at: new Date().toISOString() });
    });
    page.on('pageerror', error => {
      push(this.console, { level: 'error', text: `Uncaught ${error.name}: ${error.message}`.slice(0, 2000), at: new Date().toISOString() });
    });
    const record = (request: Request, status: number | null, failure: string | null) => push(this.requests, {
      method: request.method(), url: plainAddress(request.url()), kind: request.resourceType(), status, failure, at: new Date().toISOString() });
    page.on('requestfinished', request => { void request.response().then(answer => record(request, answer?.status() ?? null, null), () => record(request, null, null)); });
    page.on('requestfailed', request => record(request, null, (request.failure()?.errorText ?? 'failed').slice(0, 200)));
  }
  /** A connection the page asked for that is not a request the page sees finish or fail (a WebSocket Branch refused). */
  note(url: string, kind: string, failure: string | null): void {
    push(this.requests, { method: 'GET', url: plainAddress(url), kind, status: null, failure: failure?.slice(0, 200) ?? null, at: new Date().toISOString() });
  }
}

export async function scrollPage(page: Page, input: z.infer<typeof ScrollSchema>, found: Locator | null) {
  if (found) await found.scrollIntoViewIfNeeded({ timeout: 5000 });
  else if (input.to) await page.evaluate(to => window.scrollTo(0, to === 'top' ? 0 : document.documentElement.scrollHeight), input.to);
  else {
    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    const across = input.direction === 'left' || input.direction === 'right';
    const step = input.amount ?? Math.round((across ? size.width : size.height) * 0.85);
    const sign = input.direction === 'up' || input.direction === 'left' ? -1 : 1;
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(across ? sign * step : 0, across ? 0 : sign * step);
    await page.waitForTimeout(150);
  }
  const where = await page.evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY),
    atBottom: Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2, atTop: scrollY <= 0 }));
  return { url: page.url(), scrollX: where.x, scrollY: where.y, atTop: where.atTop, atBottom: where.atBottom };
}
export async function pressKeys(page: Page, input: z.infer<typeof KeysSchema>) {
  const keys = input.keys.replace(/(^|\+)Space$/, '$1 ');
  for (let i = 0; i < input.repeat; i++) await page.keyboard.press(keys);
  return { url: page.url(), pressed: input.keys, times: input.repeat };
}
export async function chooseOption(found: Locator, input: z.infer<typeof SelectSchema>) {
  const wanted = Array.isArray(input.option) ? input.option : [input.option];
  // Each is matched by the words shown first, then by its value, as a person would pick it.
  const options = await found.locator('option').evaluateAll(nodes => nodes.map(node => ({
    label: (node.textContent ?? '').trim(), value: (node as HTMLOptionElement).value })));
  const picks = wanted.map(want => options.find(option => option.label === want) ?? options.find(option => option.value === want)
    ?? options.find(option => option.label.toLowerCase() === want.toLowerCase()));
  const missing = wanted.filter((_, i) => !picks[i]);
  if (missing.length) throw new Error(`That list has no option called ${missing.map(m => `"${m}"`).join(', ')}.`);
  const chosen = await found.selectOption(picks.map(pick => ({ value: pick!.value })), { timeout: 5000 });
  return { chosen: picks.map(pick => pick!.label || pick!.value), values: chosen };
}
export async function goInHistory(page: Page, action: z.infer<typeof HistorySchema>['action']) {
  const options = { waitUntil: 'domcontentloaded' as const, timeout: 15000 };
  const answer = action === 'back' ? await page.goBack(options) : action === 'forward' ? await page.goForward(options) : await page.reload(options);
  if (!answer && action !== 'reload') throw new Error(`There is no page to go ${action} to in this tab.`);
  return { url: page.url(), title: await page.title() };
}
