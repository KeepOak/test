import type { Frame, Locator, Page } from 'playwright';
import { z } from 'zod';

/**
 * The things the assistant does to one open page beyond clicking and typing: take a picture of it,
 * wait for something to appear, pull a table or a list of cards out of it, and save it as a PDF.
 * Everything here is bounded, and every secret on the page is covered before a picture is taken.
 */
export const ScreenshotSchema = z.object({
  fullPage: z.boolean().default(false),
  /** A picture of one element only: by selector, by its name, or by its number from browser.annotate. */
  selector: z.string().min(1).max(300).optional(),
  name: z.string().min(1).max(300).optional(),
  mark: z.number().int().min(1).max(500).optional(),
}).strict().refine(v => [v.selector, v.name, v.mark].filter(x => x !== undefined).length <= 1, 'Name at most one element to picture');
export const WaitSchema = z.object({
  text: z.string().min(1).max(300).optional(),
  /** Wait for these words to go (a "Loading…" line, a spinner's label). */
  textGone: z.string().min(1).max(300).optional(),
  selector: z.string().min(1).max(300).optional(),
  /** Wait until the address contains these words. */
  url: z.string().min(1).max(500).optional(),
  networkIdle: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
}).strict().refine(v => [v.text, v.textGone, v.selector, v.url].filter(Boolean).length === 1 || (!v.text && !v.textGone && !v.selector && !v.url && !!v.networkIdle),
  'Say what to wait for: some text, text to go, a selector, an address, or networkIdle');
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
/** The boxes a page marks as holding a one-time code. */
const CODE_BOXES = 'input[autocomplete~="one-time-code" i]';
/**
 * The rest of a split one-time code, from one box of it: the one-character boxes in the nearest of the box's three
 * closest enclosing blocks that holds more than one of them. A page spreads a code typed into one box across these.
 */
export const CODE_SIBLINGS = 'xpath=ancestor::*[position() <= 3][count(.//input[@maxlength="1"]) > 1][1]//input[@maxlength="1"]';

/** Every box of a frame somebody can type words into (not a button, a tick box, a file box or a hidden value). */
const TYPED_BOXES = 'textarea, input:not([type=hidden i]):not([type=submit i]):not([type=button i]):not([type=reset i])'
  + ':not([type=image i]):not([type=checkbox i]):not([type=radio i]):not([type=file i])';

/** The blocks of a frame somebody can type words into that are not boxes (a rich-text editor). */
const EDITABLE_BLOCKS = '[contenteditable]:not([contenteditable="false" i])';

/** Every box of one frame that holds a secret: the secret boxes, and the rest of a split code beside a code box. */
function secretBoxes(frame: Frame): [Locator, Locator] {
  return [frame.locator(SECRET_BOXES), frame.locator(CODE_BOXES).locator(CODE_SIBLINGS)];
}

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
  const mask = [...frames.flatMap(frame => (ok.has(frame) ? secretBoxes(frame) : [above(frame).locator(FRAME_OWNERS)])), ...filled];
  const unchanged = () => {
    const after = page.frames();
    if (after.length !== before.size || after.some(frame => before.get(frame) !== frame.url()))
      throw new Error('the page changed while its picture was taken');
  };
  return { mask, unchanged };
}

/** The assistant's own picture of the page (browser.screenshot), with every secret covered as `secretMask` says. */
export async function screenshot(page: Page, options: z.infer<typeof ScreenshotSchema>, filled: Locator[] = [], element?: Locator): Promise<Buffer> {
  const { mask, unchanged } = await secretMask(page, filled);
  const shot = { type: 'png', timeout: 15000, mask, maskColor: '#000' } as const;
  const png = element ? await element.screenshot(shot) : options.selector ? await page.locator(options.selector).first().screenshot(shot)
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
  const found = await Promise.all([...page.frames().map(async frame => (frame !== main && !(await reachable(frame)))
    || (await Promise.all(secretBoxes(frame).map(full))).some(Boolean)), ...filled.map(full)]);
  return found.some(Boolean);
}

/**
 * While a recording is kept: empties every box whose value page text handed to the assistant leaves out (the secret
 * boxes of every frame that can be searched and the rest of a split code beside a code box, as `secretValues` reads
 * them), before each step, so a step that reads the page (snapshot, extract) writes no such value into the recording.
 */
export async function clearSecretValues(page: Page): Promise<void> {
  const main = page.mainFrame();
  await Promise.all(page.frames().map(async frame => {
    if (frame !== main && !(await reachable(frame))) return;
    for (const boxes of secretBoxes(frame))
      await boxes.evaluateAll(found => { for (const box of found) { (box as HTMLInputElement).value = ''; box.removeAttribute('value'); } })
        .catch(() => undefined);
  }));
}

/** What stands in, in page text handed to the assistant, for a value a box holds that the assistant must not read. */
export const hiddenValue = '(hidden)';
/** A value the way page text shows it: the spaces run together, as the page's accessibility tree does. */
export const plainValue = (value: string): string => value.replace(/[​­]/g, '').trim().replace(/\s+/g, ' ');

/** What the boxes one locator finds hold; for the rest of a split code, the whole code as well. */
async function valuesIn(boxes: Locator, whole: boolean): Promise<string[]> {
  const values = (await boxes.evaluateAll(found => found.map(box => (box as HTMLInputElement).value ?? '')))
    .map(plainValue).filter(Boolean);
  return whole && values.length > 1 ? [...values, values.join('')] : values;
}

/**
 * The values the assistant must never read back out of the page as text (snapshot, extract, shaped readings, numbered
 * marks): what every secret box of every frame holds, with the rest of a split code beside a code box, and what the
 * boxes a saved sign-in typed into hold (`filled`, with their split-code siblings). In a borrowed window, `typed` is
 * what this task itself typed, and every other box's value, and every rich-text block's words, are added: the owner may have typed them. The page's own
 * frame must be read or nothing is handed back; a frame inside it that cannot be read is left out, because the text
 * tools read only the page's own frame, which a frame's value reaches only if the page copies it there.
 */
export async function secretValues(page: Page, filled: Locator[], typed: ReadonlySet<string> | null): Promise<string[]> {
  const main = page.mainFrame();
  const inFrame = async (frame: Frame): Promise<string[]> => {
    const [boxes, siblings] = secretBoxes(frame);
    const found = [...await valuesIn(boxes, false), ...await valuesIn(siblings, true)];
    if (typed) found.push(...(await valuesIn(frame.locator(TYPED_BOXES), false)).filter(value => !typed.has(value)),
      ...await editedIn(frame, typed));
    return found;
  };
  const frames = await Promise.all(page.frames().map(async frame => frame === main ? inFrame(frame)
    : (await reachable(frame)) ? inFrame(frame).catch(() => []) : []));
  const boxes = await Promise.all(filled.map(box => valuesIn(box, true)));
  return [...new Set([...frames.flat(), ...boxes.flat()])];
}

/**
 * In a borrowed window, what the outermost rich-text blocks of a frame hold that this task did not type itself: the
 * whole of each, and each of its lines, since page text shows a block's lines apart.
 */
async function editedIn(frame: Frame, typed: ReadonlySet<string>): Promise<string[]> {
  const blocks = await frame.locator(EDITABLE_BLOCKS).evaluateAll(found => found
    .filter(block => (block as HTMLElement).isContentEditable && !block.parentElement?.isContentEditable)
    .map(block => (block as HTMLElement).innerText ?? ''));
  return blocks.filter(text => !typed.has(plainValue(text)))
    .flatMap(text => [text, ...text.split('\n')].map(plainValue)).filter(Boolean);
}

/** The forms a value takes in page text: as it is, and escaped inside a quoted string (JSON, and the tree's YAML). */
function quotedForms(value: string): string[] {
  const yaml = value.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, c => c === '\\' || c === '"' ? `\\${c}`
    : c === '\b' ? '\\b' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return [...new Set([value, JSON.stringify(value).slice(1, -1), yaml])];
}
/**
 * Every secret value of four or more characters replaced wherever it appears (a shorter one would shred words), the
 * longest first, so no part of a longer one is left beside a shorter one inside it.
 */
function scrubAll(text: string, hidden: readonly string[]): string {
  let out = text;
  for (const value of [...hidden].sort((a, b) => b.length - a.length)) if (value.length >= 4) for (const form of quotedForms(value)) out = out.split(form).join(hiddenValue);
  return out;
}

/** One piece of page text with every secret value taken out; a piece that is exactly one becomes the stand-in. */
export function scrubText(text: string, hidden: readonly string[]): string {
  if (!hidden.length) return text;
  return hidden.includes(plainValue(text)) ? hiddenValue : scrubAll(text, hidden);
}

/**
 * A page's address with every secret value taken out, as it is and as an address carries it (percent-encoded, a space
 * as +). A page can copy what a box holds into its own address (?otp=...), or a form sent that way lands on one.
 * `hidden` null means the page could not be asked: only the site is kept, never the path, the ? or the # (a page can
 * put a code in its path as well); an address with no site (data:, about:) keeps only its scheme.
 */
export function scrubAddress(address: string, hidden: readonly string[] | null): string {
  if (hidden === null) { try { const at = new URL(address); return at.host ? at.origin : at.protocol; } catch { return ''; } }
  let out = address;
  for (const value of [...hidden].sort((a, b) => b.length - a.length)) if (value.length >= 4) {
    const encoded = encodeURIComponent(value);
    for (const form of [encoded, encoded.replace(/%20/g, '+'), encodeURI(value)]) out = out.split(form).join(encodeURIComponent(hiddenValue));
  }
  return scrubText(out, hidden);
}

/**
 * A browser tool's answer with every address (`url`) and page title (`title`) in it scrubbed, however deep (a tab list,
 * the downloads a step started). Titles are page text; `hidden` null (the page could not be asked) leaves none.
 */
export function scrubAddresses<T>(value: T, hidden: readonly string[] | null, depth = 0): T {
  if (depth > 4 || value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(each => scrubAddresses(each, hidden, depth + 1)) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([name, each]) => [name,
    name === 'url' && typeof each === 'string' ? scrubAddress(each, hidden)
      : name === 'title' && typeof each === 'string' ? (hidden === null ? '' : scrubText(each, hidden))
        : scrubAddresses(each, hidden, depth + 1)])) as T;
}

/**
 * A page library's error message with every secret value taken out. Such a message quotes the things it found, cut to
 * a length with an ellipsis, so a secret cut short there is taken out as well.
 */
export function scrubMessage(text: string, hidden: readonly string[]): string {
  let out = scrubText(text, hidden);
  for (const value of hidden) for (let end = value.length - 1; end >= 4; end--) out = out.split(`${value.slice(0, end)}…`).join(hiddenValue);
  return out;
}

/** The roles a box that holds typed words has in the accessibility tree. */
const BOX_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
/** One line of the tree: its indent, role, then name and attributes, and the value after the colon if any. */
const TREE_LINE = /^(\s*)- ([a-z]+)((?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)(?:: (.+)|:)?$/;

/** A value in the tree as the words it stands for: a quoted one has its escapes undone. */
function treeValue(token: string): string {
  if (!/^".*"$/.test(token)) return token;
  const plain: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  return token.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, c: string) =>
    c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : plain[c] ?? c);
}

/**
 * The page's accessibility tree with every secret value taken out. What a box holds shows either after its own name
 * or as a `text` line under it; either becomes the stand-in when it is a secret value, or, in a borrowed window
 * (`typed` given), whenever it is not exactly something this task typed. Then every secret value of four or more
 * characters is replaced wherever else it appears. The box's role, name and place are kept.
 */
export function scrubSnapshot(tree: string, hidden: readonly string[], typed: ReadonlySet<string> | null): string {
  const secret = (token: string) => { const value = plainValue(treeValue(token)); return hidden.includes(value) || (!!typed && !typed.has(value)); };
  let box = -1; // the indent of the box whose value lines come next, or -1
  const lines = tree.split('\n').map(line => {
    const found = TREE_LINE.exec(line);
    if (!found) return line;
    const [whole, indent = '', role = '', rest = '', value] = found;
    if (box >= 0 && indent.length <= box) box = -1;
    const holds = BOX_ROLES.has(role) || (box >= 0 && role === 'text');
    if (BOX_ROLES.has(role) && value === undefined && whole.endsWith(':')) box = indent.length;
    return holds && value !== undefined && secret(value) ? `${indent}- ${role}${rest}: ${hiddenValue}` : line;
  });
  return scrubAll(lines.join('\n'), hidden);
}

export async function waitFor(page: Page, options: z.infer<typeof WaitSchema>): Promise<{ waitedFor: string; url: string }> {
  const timeout = options.timeoutMs;
  if (options.text) { await page.getByText(options.text).first().waitFor({ state: 'visible', timeout }); }
  else if (options.textGone) { await page.getByText(options.textGone).first().waitFor({ state: 'hidden', timeout }); }
  else if (options.selector) { await page.locator(options.selector).first().waitFor({ state: 'visible', timeout }); }
  else if (options.url) { const part = options.url; await page.waitForURL(address => address.href.includes(part), { timeout, waitUntil: 'commit' }); }
  if (options.networkIdle) await page.waitForLoadState('networkidle', { timeout });
  const waitedFor = options.text ? `the words "${options.text}"` : options.textGone ? `the words "${options.textGone}" to go`
    : options.selector ? options.selector : options.url ? `an address with "${options.url}"` : 'the page to go quiet';
  return { waitedFor, url: page.url() };
}

/** Rows of a table or a repeated block of cards, as plain text, with a cap on how much comes back. */
export async function extract(page: Page, options: z.infer<typeof ExtractSchema>, hidden: readonly string[] = []): Promise<{
  rows: Record<string, string>[]; matched: number; truncated: boolean;
}> {
  const found = await page.$$eval(options.selector, (nodes, config) => {
    // Long enough that a secret in it is still whole when it is taken out; cut to 500 after that.
    const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
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
  const rows = found.rows.map(row => Object.fromEntries(Object.entries(row)
    .map(([name, text]) => [name, scrubText(text, hidden).slice(0, 500)])));
  return { rows: capped(rows), matched: found.matched, truncated: found.matched > found.rows.length };
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
