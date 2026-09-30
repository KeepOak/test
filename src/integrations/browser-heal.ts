import type { Locator, Page } from 'playwright';
import { markAttribute } from './browser-marks.js';

/**
 * Websites are rewritten all the time, and a selector that worked last week often points at
 * nothing today. Rather than give up, an action is tried again a few different ways: by the exact
 * selector it was given, then by what the thing is called, then by the words showing on it, and
 * last by the number it was given when the page was described. Which way worked is written into
 * the task's trace, so a step that keeps healing can be fixed properly later.
 *
 * It never looks anywhere but the page it was already on, and it never tries more than a handful
 * of times; a thing that is genuinely gone is reported as gone.
 */
export const healingWays = ['selector', 'role', 'text', 'mark'] as const;
export type HealingWay = (typeof healingWays)[number];
/** Most ways one action may be tried before it is reported as a failure. */
export const maxHealingAttempts = 4;

export interface HealTarget {
  /** The selector the assistant asked for, when it gave one. */
  selector?: string | undefined;
  /** What the thing is called: the words on the button, the label of the box. */
  name?: string | undefined;
  /** The number the thing was given when the page was last described. */
  mark?: number | undefined;
}
export interface HealResult { locator: Locator; way: HealingWay; attempts: number; tried: HealingWay[] }
/**
 * What is known about the numbers this task handed out, so a number can be checked rather than
 * trusted. `keyOf` is the stable name the number was given to; `liveKey` is the stable name of
 * whatever wears it on the page right now. Left out, a number is only checked for being there.
 */
export interface MarkChecks {
  keyOf?: ((mark: number) => string | undefined) | undefined;
  liveKey?: ((mark: number) => Promise<string | null>) | undefined;
}
/** Why a number could not be used, in the owner's words. Empty when the number was fine. */
export async function markProblem(mark: number, count: number, checks: MarkChecks): Promise<string> {
  const handed = checks.keyOf?.(mark);
  if (checks.keyOf && handed === undefined)
    return `Number ${mark} was never given out on this page.`;
  if (count === 0) return `Number ${mark} is no longer on this page.`;
  if (count > 1) return `Number ${mark} is on more than one thing, so it was not used.`;
  const live = await checks.liveKey?.(mark);
  if (handed !== undefined && live !== undefined && live !== handed)
    return `Number ${mark} is now on a different thing from the one it was given to, so it was not used.`;
  return '';
}

/**
 * The ways worth trying for this target, in the order they are tried. A number is the one way whose
 * answer comes off an attribute the page itself could write, so it is the one way that is checked
 * rather than trusted: it must be worn by exactly one thing, and by the same thing it was handed
 * to. A page that moves a number onto something else, or puts it on two things at once, is trying
 * to steer the press, and the number is refused instead.
 *
 * Every other way must find exactly one thing, by its exact name: "Delete" never finds "Delete account", and a name
 * two things share presses neither. Taking the first loose match is what let a press land on the wrong button. The
 * idea of healing from a fresh look at the page rather than from the first near miss follows Stagehand's
 * `selfHealAction` (browserbase/stagehand, packages/extension/services/actService.ts, MIT); no code was copied.
 */
function ways(target: HealTarget): { way: HealingWay; find: (page: Page) => Locator }[] {
  const plan: { way: HealingWay; find: (page: Page) => Locator }[] = [];
  if (target.selector) plan.push({ way: 'selector', find: page => page.locator(target.selector!) });
  if (target.name) {
    // What a thing is called, exactly: a button, a link, or a box by its label.
    plan.push({ way: 'role', find: page => page.getByRole('button', { name: target.name!, exact: true })
      .or(page.getByRole('link', { name: target.name!, exact: true })).or(labelled(page, target.name!)) });
    plan.push({ way: 'text', find: page => page.getByText(target.name!, { exact: true }) });
  }
  if (target.mark !== undefined)
    plan.push({ way: 'mark', find: page => page.locator(`[${markAttribute}="${target.mark}"]`) });
  return plan.slice(0, maxHealingAttempts);
}

/** A word as an XPath string, whatever quotes it holds. */
function xpathText(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value.split('"').map(part => `"${part}"`).join(`, '"', `)})`;
}
/**
 * A box by its label, exactly: a label tied to it by name, or a label wrapped round it whose own words (not the words
 * of the list inside it) are exactly the name, as in `<label>Size <select>…</select></label>`.
 */
function labelled(page: Page, name: string): Locator {
  const wrapped = `xpath=//label[normalize-space(text()[1])=${xpathText(name)}]//*[self::select or self::input or self::textarea]`;
  return page.getByLabel(name, { exact: true }).or(page.locator(wrapped));
}

/**
 * The thing could not be told apart: nothing matched, or a way matched more than one thing. Nothing was pressed. The
 * caller looks at the page afresh and hands the model numbers to choose from (browser.ts `healed`).
 */
export class HealMissError extends Error {
  constructor(message: string, readonly target: HealTarget, readonly ambiguous: boolean) { super(message); }
}

/**
 * Finds the thing an action is about, trying each way in turn until one finds exactly one thing. The
 * result says which way worked and how many were tried, so the trace can record it. A name that matches
 * several things is never narrowed by a looser way after it (the words could find one wrong thing), only
 * by the number, when one was given too. A selector that matches several goes on to the name.
 */
export async function resolve(page: Page, target: HealTarget, timeoutMs = 2000,
  checks: MarkChecks = {}): Promise<HealResult> {
  const plan = ways(target);
  if (!plan.length) throw new Error('Say which thing to act on: a selector, its name, or its number from the page description');
  const tried: HealingWay[] = [];
  let note = '', several = '';
  for (const step of plan) {
    if (step.way === 'text' && several.startsWith('"')) continue;
    tried.push(step.way);
    const locator = step.find(page);
    const count = await locator.count().catch(() => 0);
    if (step.way === 'mark') {
      note = await markProblem(target.mark!, count, checks);
      if (note) continue;
    } else if (count > 1) {
      // What the name matched outranks what the selector matched, since the name is what the model is asked about.
      if (step.way !== 'selector' || !several)
        several = `${step.way === 'selector' ? 'That selector' : `"${target.name}"`} matches ${count} things on this page, so nothing was pressed. `;
      continue;
    } else if (count === 0) continue;
    const ready = await locator.waitFor({ state: 'attached', timeout: timeoutMs }).then(() => true).catch(() => false);
    if (ready) return { locator, way: step.way, attempts: tried.length, tried };
  }
  if (several) throw new HealMissError(`${several}${note ? `${note} ` : ''}`, target, true);
  throw new HealMissError(`Nothing on this page matched exactly, after ${tried.length} ${tried.length === 1 ? 'try' : 'tries'} `
    + `(${tried.join(', ')}). ${note ? `${note} ` : ''}`, target, false);
}
