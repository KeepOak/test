import type { Frame, Locator, Page } from 'playwright';
import { z } from 'zod';

/**
 * The things the assistant does to one open page beyond clicking and typing: take a picture of it,
 * wait for something to appear, pull a table or a list of cards out of it, and save it as a PDF.
 * Everything here is bounded, and every secret on the page is covered before a picture is taken.
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
 * What covers the secrets of every frame in a picture of the page (the page's own, each frame inside it and the frames
 * inside those, however late they were added): Playwright's mask, which is drawn outside the page's own rules and so
 * still applies under a strict style-src; the page itself is not changed. `filled` are the boxes a saved sign-in was
 * typed into, covered too whatever kind of box they are. A frame that cannot be searched is covered whole from the
 * frame above it. `unchanged` refuses the picture when a frame came or went, or went to another address, meanwhile.
 */
async function secretMask(page: Page, filled: Locator[]): Promise<{ mask: Locator[]; unchanged: () => void }> {
  const frames = page.frames(), before = new Map(frames.map(frame => [frame, frame.url()]));
  const main = page.mainFrame(), searched = await Promise.all(frames.map(frame => frame === main || reachable(frame)));
  const ok = new Set(frames.filter((_, index) => searched[index]));
  const above = (frame: Frame): Frame => { let up = frame.parentFrame() ?? main; while (!ok.has(up)) up = up.parentFrame() ?? main; return up; };
  const mask = [...frames.map(frame => (ok.has(frame) ? frame.locator(SECRET_BOXES) : above(frame).locator(FRAME_OWNERS))), ...filled];
  const unchanged = () => {
    const after = page.frames();
    if (after.length !== before.size || after.some(frame => before.get(frame) !== frame.url()))
      throw new Error('the page changed while its picture was taken');
  };
  return { mask, unchanged };
}

/** The assistant's own picture of the page (browser.screenshot), with every secret covered as `secretMask` says. */
export async function screenshot(page: Page, options: z.infer<typeof ScreenshotSchema>, filled: Locator[] = []): Promise<Buffer> {
  const { mask, unchanged } = await secretMask(page, filled);
  const shot = { type: 'png', timeout: 15000, mask, maskColor: '#000' } as const;
  const png = options.selector ? await page.locator(options.selector).first().screenshot(shot)
    : await page.screenshot({ ...shot, fullPage: options.fullPage });
  unchanged();
  return png;
}

/**
 * live-stage: one frame of the page for somebody watching the task, as a small JPEG, with every secret covered as
 * `secretMask` says. Never a full-page picture.
 */
export async function liveFrame(page: Page, filled: Locator[] = []): Promise<Buffer> {
  const { mask, unchanged } = await secretMask(page, filled);
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 4000, animations: 'allow', caret: 'initial', mask, maskColor: '#000' });
  unchanged();
  return jpeg;
}

/**
 * Whether any frame of the page holds a secret that a picture could not cover (a saved page is drawn by the browser
 * itself, with no mask): a secret box or a box a saved sign-in typed into that is not empty, or a frame that cannot be
 * searched.
 */
export async function holdsSecret(page: Page, filled: Locator[] = []): Promise<boolean> {
  const full = (boxes: Locator) => boxes.evaluateAll(found => found.some(box => !!(box as HTMLInputElement).value)).catch(() => true);
  const main = page.mainFrame();
  const found = await Promise.all([...page.frames().map(async frame =>
    (frame !== main && !(await reachable(frame))) || full(frame.locator(SECRET_BOXES))), ...filled.map(full)]);
  return found.some(Boolean);
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
