import type { Frame, Page } from 'playwright';
import { z } from 'zod';

/**
 * The things the assistant does to one open page beyond clicking and typing: take a picture of it,
 * wait for something to appear, pull a table or a list of cards out of it, and save it as a PDF.
 * Everything here is bounded, and anything that looks like a password is blacked out before a
 * picture is taken.
 */
export const ScreenshotSchema = z.object({
  fullPage: z.boolean().default(false),
  selector: z.string().min(1).max(300).optional(),
}).strict();
export const WaitSchema = z.object({
  text: z.string().min(1).max(300).optional(),
  selector: z.string().min(1).max(300).optional(),
  networkIdle: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
}).strict().refine(v => !!v.text !== !!v.selector || !!v.networkIdle, 'Say what to wait for: some text, a selector, or networkIdle');
export const ExtractSchema = z.object({
  selector: z.string().min(1).max(300),
  /** Column name to a selector inside each row; leave it out to read every cell of a table row. */
  fields: z.record(z.string().min(1).max(60), z.string().min(1).max(300)).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

/**
 * Password boxes are blacked out in the page itself before the shutter, so the picture never holds
 * the characters. The rule is removed again straight after, so the page keeps working.
 */
const redaction = `input[type="password"], input[type="password" i] {
  color: transparent !important; text-shadow: none !important; caret-color: transparent !important;
  background-color: #000 !important; background-image: none !important; -webkit-text-security: none !important; }`;

export async function screenshot(page: Page, options: z.infer<typeof ScreenshotSchema>): Promise<Buffer> {
  const style = await page.addStyleTag({ content: redaction }).catch(() => null);
  try {
    const target = options.selector ? page.locator(options.selector).first() : page;
    return await target.screenshot({ type: 'png', timeout: 15000, ...(options.selector ? {} : { fullPage: options.fullPage }) });
  } finally { await style?.evaluate(node => (node as unknown as Element).remove()).catch(() => undefined); }
}

/** live-stage: every box that holds a secret: a password, or one the page marks as a password or a one-time code. */
const SECRET_BOXES = 'input[type="password" i], input[autocomplete~="current-password" i], '
  + 'input[autocomplete~="new-password" i], input[autocomplete~="one-time-code" i]';
/** What can hold another page inside a page. */
const FRAME_OWNERS = 'iframe, frame, object, embed';

/** Whether a frame inside the page can be searched for its secret boxes within a second. */
async function reachable(frame: Frame): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>(done => { timer = setTimeout(() => done(false), 1000); timer.unref?.(); });
  try { return await Promise.race([frame.locator(SECRET_BOXES).count().then(() => true), late]); }
  catch { return false; } // a frame that cannot be searched is covered whole, from the nearest frame above it that can
  finally { clearTimeout(timer); }
}

/**
 * live-stage: one frame of the page for somebody watching the task, as a small JPEG. The secret boxes of every frame in
 * it (the page's own, each frame inside it and the frames inside those, however late they were added) are covered with
 * Playwright's mask, which is drawn outside the page's own rules and so still applies under a strict style-src; the page
 * itself is not changed. A frame that cannot be searched is covered whole from the frame above it. When a frame comes
 * or goes, or goes to another address, while the picture is taken, no picture is given. Never a full-page picture.
 */
export async function liveFrame(page: Page): Promise<Buffer> {
  const frames = page.frames(), before = new Map(frames.map(frame => [frame, frame.url()]));
  const main = page.mainFrame(), searched = await Promise.all(frames.map(frame => frame === main || reachable(frame)));
  const ok = new Set(frames.filter((_, index) => searched[index]));
  const above = (frame: Frame): Frame => { let up = frame.parentFrame() ?? main; while (!ok.has(up)) up = up.parentFrame() ?? main; return up; };
  const mask = frames.map(frame => (ok.has(frame) ? frame.locator(SECRET_BOXES) : above(frame).locator(FRAME_OWNERS)));
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 4000, animations: 'allow', caret: 'initial', mask, maskColor: '#000' });
  const after = page.frames();
  if (after.length !== before.size || after.some(frame => before.get(frame) !== frame.url()))
    throw new Error('the page changed while its picture was taken');
  return jpeg;
}

export async function waitFor(page: Page, options: z.infer<typeof WaitSchema>): Promise<{ waitedFor: string; url: string }> {
  const timeout = options.timeoutMs;
  if (options.text) { await page.getByText(options.text).first().waitFor({ state: 'visible', timeout }); }
  else if (options.selector) { await page.locator(options.selector).first().waitFor({ state: 'visible', timeout }); }
  if (options.networkIdle) await page.waitForLoadState('networkidle', { timeout });
  const waitedFor = options.text ? `the words "${options.text}"` : options.selector ? options.selector : 'the page to go quiet';
  return { waitedFor, url: page.url() };
}

/** Rows of a table or a repeated block of cards, as plain text, with a cap on how much comes back. */
export async function extract(page: Page, options: z.infer<typeof ExtractSchema>): Promise<{
  rows: Record<string, string>[]; matched: number; truncated: boolean;
}> {
  const found = await page.$$eval(options.selector, (nodes, config) => {
    const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    return {
      matched: nodes.length,
      rows: nodes.slice(0, config.limit).map(node => {
        const element = node as HTMLElement;
        if (config.fields) {
          const row: Record<string, string> = {};
          for (const [name, selector] of Object.entries(config.fields))
            row[name] = clean(element.querySelector(selector)?.textContent);
          return row;
        }
        const cells = [...element.querySelectorAll('th,td')];
        if (!cells.length) return { text: clean(element.textContent) };
        return Object.fromEntries(cells.map((cell, index) => [`column${index + 1}`, clean(cell.textContent)]));
      }),
    };
  }, { limit: options.limit, fields: options.fields ?? null });
  return { rows: capped(found.rows), matched: found.matched, truncated: found.matched > found.rows.length };
}
/** Stops a very wide table from filling the whole conversation. */
function capped(rows: Record<string, string>[]): Record<string, string>[] {
  const kept: Record<string, string>[] = [];
  let size = 0;
  for (const row of rows) {
    size += JSON.stringify(row).length;
    if (size > 32000) break;
    kept.push(row);
  }
  return kept;
}

/** A file name a website suggested is untrusted text; only the plain part of it is kept. */
export function safeDownloadName(suggested: string): string {
  const base = suggested.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, 80);
  return cleaned || 'download';
}
