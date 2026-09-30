import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { z } from 'zod';

/**
 * Numbered labels drawn over the things on a page you can press or type into — the "set of marks"
 * way of describing a page. The assistant gets a short list such as `[3] button "Save"`, and can
 * then say "press 3" instead of guessing at a selector.
 *
 * A number belongs to the *thing*, not to its place on the page: it is worked out from what the
 * thing is and what it is called, so a page that redraws itself keeps its numbers. The numbers last
 * for one task and are forgotten when the task ends.
 */
export const AnnotateSchema = z.object({
  /** Draw the labels on the page as well as listing them. Off leaves the page untouched. */
  draw: z.boolean().default(true),
  /** Most things to number. */
  limit: z.number().int().min(1).max(200).default(60),
}).strict();

/** One numbered thing on the page. */
export interface Mark { id: number; role: string; name: string; key: string }
/** The attribute the number is written onto, so a later press can find the same thing again. */
export const markAttribute = 'data-branch-mark';
/** The box the labels are drawn in. It is hidden from the page's own description of itself. */
export const markLayerId = 'branch-mark-layer';
/** A scratch attribute used only while one round of numbering is under way. */
const passAttribute = 'data-branch-mark-pass';

/** What the page reports about one thing it can be asked about, before it is given a number. */
interface Candidate { role: string; name: string; path: string; detail: string }

/**
 * The stable name of one thing on the page. Built from what it is, what it is called and the kinds
 * of boxes it sits inside — never from its position, so moving it or redrawing its neighbours
 * leaves the name, and therefore its number, alone.
 */
export function markKey(candidate: Candidate): string {
  const parts = [candidate.role, candidate.name.toLowerCase(), candidate.path, candidate.detail];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/** Numbers handed out during one task, so the same thing keeps the same number all the way through. */
export class MarkRegistry {
  private readonly byKey = new Map<string, number>();
  private readonly byId = new Map<number, string>();
  private next = 1;
  /** The number this thing already has, or the next free one. */
  number(key: string): number {
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.next++;
    this.byKey.set(key, id);
    this.byId.set(id, key);
    return id;
  }
  keyOf(id: number): string | undefined { return this.byId.get(id); }
  get size(): number { return this.byKey.size; }
}

/** The one-line description of a numbered thing, as the assistant sees it. */
export const markLine = (mark: Mark): string => `[${mark.id}] ${mark.role}${mark.name ? ` "${mark.name}"` : ''}`;

/**
 * Finds every thing on the page that can be pressed or typed into, names them, and — when asked —
 * draws a numbered label beside each one. The drawing is put in its own box marked as decoration,
 * so it never turns up in the page's description or in anything pulled out of the page.
 */
export async function annotate(page: Page, options: z.infer<typeof AnnotateSchema>,
  registry: MarkRegistry): Promise<{ url: string; marks: Mark[]; map: string; truncated: boolean }> {
  const found = await page.evaluate(describeElements,
    { limit: options.limit, layerId: markLayerId, attribute: passAttribute, only: '' });
  const marks: Mark[] = found.candidates.map(candidate => ({
    role: candidate.role, name: candidate.name, key: markKey(candidate), id: 0,
  })).map(mark => ({ ...mark, id: registry.number(mark.key) }));
  await page.evaluate(drawMarks, { layerId: markLayerId, attribute: markAttribute, pass: passAttribute,
    draw: options.draw, numbers: marks.map(mark => mark.id) });
  return { url: page.url(), marks, map: marks.map(markLine).join('\n'), truncated: found.truncated };
}

/**
 * The stable name of whatever is wearing a number on the page right now, or nothing when no single
 * thing wears it. A page can take a number off one thing and put it on another between the moment
 * the page was described and the moment a press is asked for; comparing this against the name the
 * number was handed to is what stops that press landing on the wrong thing.
 */
export async function liveMarkKey(page: Page, mark: number): Promise<string | null> {
  const empty = { candidates: [] as Candidate[], truncated: false };
  const found = await page.evaluate(describeElements, { limit: 3, layerId: markLayerId,
    attribute: passAttribute, only: `[${markAttribute}="${mark}"]` }).catch(() => empty);
  return found.candidates.length === 1 ? markKey(found.candidates[0]!) : null;
}

/** Takes the labels off again, so a picture or a saved page looks the way the website meant it to. */
export async function clearMarks(page: Page): Promise<void> {
  await page.evaluate(id => {
    document.getElementById(id)?.remove();
    for (const node of document.querySelectorAll('[data-branch-mark], [data-branch-mark-pass]')) {
      node.removeAttribute('data-branch-mark'); node.removeAttribute('data-branch-mark-pass');
    }
  }, markLayerId).catch(() => undefined);
}

/** What one round of describing asks for. `only` names things to describe without touching them. */
interface DescribeOptions { limit: number; layerId: string; attribute: string; only: string }

/**
 * Runs inside the page. Describes the things worth numbering, in the order the page lists them, and
 * marks each one with its place in that order so the drawing step can find it again. Given `only`,
 * it describes just those things and changes nothing at all — which is how a number is checked,
 * later on, to be still worn by the very thing it was handed to.
 */
function describeElements(options: DescribeOptions): { candidates: Candidate[]; truncated: boolean } {
  const pressable = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [contenteditable=""], [contenteditable="true"]';
  const clean = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 120);
  const describe = (element: Element): Candidate => {
    const tag = element.tagName.toLowerCase(), explicit = element.getAttribute('role');
    const role = explicit ? explicit.trim().toLowerCase().slice(0, 30)
      : tag === 'a' ? 'link'
      : tag === 'input' ? `input:${(element.getAttribute('type') ?? 'text').toLowerCase().slice(0, 20)}` : tag;
    const own = (element as HTMLElement).innerText ?? element.textContent ?? '';
    // Its label, whether it names the box by id or wraps it (<label>Attach <input type=file></label>).
    const labels = (element as HTMLInputElement).labels;
    const label = labels?.length ? [...labels].map(one => one.textContent ?? '').join(' ')
      : element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent ?? '' : '';
    const name = clean(element.getAttribute('aria-label') || own.trim() || label.trim()
      || element.getAttribute('placeholder') || element.getAttribute('title')
      || element.getAttribute('alt') || element.getAttribute('name') || '');
    // The kinds of boxes it sits inside, without any counting, so reordering changes nothing.
    const boxes: string[] = [];
    for (let node = element.parentElement; node && boxes.length < 4; node = node.parentElement)
      boxes.push(node.tagName.toLowerCase());
    return { role, name, path: boxes.join('>'), detail: `${tag}|${element.getAttribute('type') ?? ''}` };
  };
  if (options.only)
    return { candidates: [...document.querySelectorAll(options.only)].slice(0, options.limit).map(describe), truncated: false };
  // A number must never be something the page can claim for itself. Anything already wearing one of
  // these attributes — left over from a previous round, or written by the page to lure a press onto
  // the wrong thing — has it taken off before any number is handed out.
  for (const node of document.querySelectorAll('[data-branch-mark], [data-branch-mark-pass]')) {
    node.removeAttribute('data-branch-mark'); node.removeAttribute('data-branch-mark-pass');
  }
  const all = [...document.querySelectorAll(pressable)].filter(element => {
    const box = element.getBoundingClientRect();
    return !element.closest(`#${options.layerId}`) && box.width > 0 && box.height > 0;
  });
  const candidates = all.slice(0, options.limit).map((element, index) => {
    element.setAttribute(options.attribute, String(index));
    return describe(element);
  });
  return { candidates, truncated: all.length > candidates.length };
}

/**
 * Runs inside the page. Writes each thing's real number onto it — the places found a moment ago
 * were only numbered in the order they were found — and, when asked, draws a small label beside it.
 */
function drawMarks(options: { layerId: string; attribute: string; pass: string; draw: boolean; numbers: number[] }): void {
  document.getElementById(options.layerId)?.remove();
  // Exactly one thing may wear each place in the round. Two would mean the page put one there
  // itself between the counting and the numbering, so neither is given the number.
  const found = options.numbers.map((number, index) => {
    const claimants = document.querySelectorAll(`[${options.pass}="${index}"]`);
    return { number, element: claimants.length === 1 ? claimants[0]! : null };
  });
  for (const { number, element } of found) {
    element?.setAttribute(options.attribute, String(number));
    element?.removeAttribute(options.pass);
  }
  if (!options.draw) return;
  const layer = document.createElement('div');
  layer.id = options.layerId;
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const { number, element } of found) {
    if (!element) continue;
    const box = element.getBoundingClientRect();
    const badge = document.createElement('span');
    badge.textContent = String(number);
    badge.setAttribute('aria-hidden', 'true');
    badge.style.cssText = `position:absolute;left:${Math.max(0, box.left)}px;top:${Math.max(0, box.top)}px;`
      + 'background:#b91c1c;color:#fff;font:700 11px/1.4 system-ui,sans-serif;padding:0 4px;border-radius:3px';
    layer.append(badge);
  }
  document.body.append(layer);
}
