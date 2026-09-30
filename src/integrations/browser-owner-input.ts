import { z } from 'zod';
import type { Page } from 'playwright';

const point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
const keys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Space']);
const key = z.string().max(80).refine(value => {
  const parts = value.split('+'), last = parts.pop() ?? '';
  return parts.length <= 3 && new Set(parts).size === parts.length
    && parts.every(part => ['Control', 'Meta', 'Alt', 'Shift'].includes(part)) && (keys.has(last) || /^[a-zA-Z0-9]$/.test(last));
}, 'This page key is not supported.');
export const OwnerInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), ...point, button: z.enum(['left', 'middle', 'right']).default('left'), count: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ kind: z.literal('move'), ...point }).strict(),
  z.object({ kind: z.literal('drag'), ...point, toX: point.x, toY: point.y }).strict(),
  z.object({ kind: z.literal('wheel'), dx: z.number().min(-4000).max(4000), dy: z.number().min(-4000).max(4000) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal('key'), key }).strict(),
  z.object({ kind: z.literal('find'), text: z.string().min(1).max(300), backwards: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('zoom'), factor: z.number().min(0.5).max(2) }).strict(),
  z.object({ kind: z.enum(['back', 'forward', 'reload']) }).strict(),
  /** The words the owner selected on the page, for the owner's own clipboard. */
  z.object({ kind: z.literal('copy') }).strict(),
]);
export type OwnerInput = z.infer<typeof OwnerInputSchema>;

async function findOnPage(page: Page, input: Extract<OwnerInput, { kind: 'find' }>): Promise<boolean> {
  return page.evaluate(({ text, backwards }) => {
    const find = (window as unknown as { find?: (text: string, caseSensitive: boolean, backwards: boolean,
      wrap: boolean, whole: boolean, frames: boolean, dialog: boolean) => boolean }).find;
    if (!find) throw new Error('Find in page is unavailable in this browser.');
    return find.call(window, text, false, backwards, true, false, false, false);
  }, input);
}

/** Page input only. A drag is one ordered write, and releases its button even when control is revoked. */
export async function ownerPageInput(page: Page, input: OwnerInput, check: () => void): Promise<{ done: true; found?: boolean; zoom?: number; text?: string }> {
  const size = page.viewportSize();
  if (!size) throw new Error('This page has no supported input viewport.');
  const at = (x: number, y: number) => ({ x: Math.min(size.width - 1, x * size.width), y: Math.min(size.height - 1, y * size.height) });
  const url = page.url(), liveCheck = (): void => {
    check();
    if (page.url() !== url) throw new Error('The page changed while the pointer was moving.');
  };
  liveCheck();
  if (input.kind === 'find') {
    return { done: true, found: await findOnPage(page, input) };
  }
  if (input.kind === 'zoom') {
    await page.evaluate(factor => { document.documentElement.style.zoom = String(factor); }, input.factor);
    return { done: true, zoom: input.factor };
  }
  if (input.kind === 'click' || input.kind === 'move' || input.kind === 'drag') {
    const from = at(input.x, input.y);
    await page.mouse.move(from.x, from.y); liveCheck();
    if (input.kind === 'click') await page.mouse.click(from.x, from.y, { button: input.button, clickCount: input.count });
    if (input.kind === 'drag') {
      const to = at(input.toX, input.toY);
      try {
        await page.mouse.down(); liveCheck();
        await page.mouse.move(to.x, to.y, { steps: 8 }); liveCheck();
        await page.mouse.up();
      } catch (error) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
        throw error;
      }
    }
  } else if (input.kind === 'wheel') await page.mouse.wheel(input.dx, input.dy);
  else if (input.kind === 'text') await page.keyboard.insertText(input.text);
  else if (input.kind === 'key') await page.keyboard.press(input.key);
  else if (input.kind === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
  else if (input.kind === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
  else if (input.kind === 'copy') {
    // Selected page words only: a box's own value (a password among them) is never part of a selection.
    const text = await page.evaluate(() => String(globalThis.getSelection?.()?.toString() ?? '').slice(0, 20_000));
    return { done: true, text };
  } else await page.reload({ waitUntil: 'domcontentloaded' });
  return { done: true };
}
