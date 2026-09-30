import type { Locator, Page } from 'playwright';

/** Exact, privacy-preserving choices only: no accept, close, settings or save fallback. */
const refusal = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|(?:only |use |allow |accept )?(?:strictly )?(?:necessary|essential) cookies(?: only)?|continue without accepting|refuser(?: tout| les cookies)?|tout refuser|alle ablehnen|nur notwendige cookies|rechazar(?: todas| todo| las cookies)?|solo cookies necesarias)$/i;
export interface ConsentNotice { status: 'not-found' | 'available' | 'ambiguous' | 'unavailable'; choice?: 'reject-non-essential' }
interface ConsentTarget { notice: ConsentNotice; button?: Locator }

/** A labeled choice must belong to a bounded cookie/privacy notice, never an unrelated form. */
function inspectNotice(node: Element): boolean {
  let container = node.parentElement;
  for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
    if (container === document.body || container === document.documentElement) return false;
    const role = container.getAttribute('role') ?? '';
    const marked = role === 'dialog' || role === 'alertdialog' || container.getAttribute('aria-modal') === 'true';
    if (!marked) continue;
    const words = container.textContent ?? '';
    if (words.length > 4000 || container.querySelector('input[type="password"], form[action]')) return false;
    if (/cookie|privacy|tracking|consent|confidentialit|datenschutz|privacidad/i.test(words)) return true;
  }
  return false;
}
async function inNotice(button: Locator): Promise<boolean> {
  return button.evaluate(inspectNotice, undefined, { timeout: 1000 }).catch(() => false);
}

/** No per-site selectors and no cross-origin frame access; ambiguous choices are left for the owner. */
async function findConsent(page: Page): Promise<ConsentTarget> {
  const buttons = page.getByRole('button', { name: refusal });
  const count = await buttons.count().catch(() => 0);
  if (count > 20) return { notice: { status: 'ambiguous' } };
  const visible: Locator[] = [];
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false) && await inNotice(button)) visible.push(button);
  }
  if (visible.length > 1) return { notice: { status: 'ambiguous' } };
  return visible[0] ? { notice: { status: 'available', choice: 'reject-non-essential' }, button: visible[0] }
    : { notice: { status: 'not-found' } };
}

/** Read-only discovery after navigation. Any press remains a separately permission-checked browser.act. */
export async function consentNotice(page: Page): Promise<ConsentNotice> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([findConsent(page).then(found => found.notice), new Promise<ConsentNotice>(done => {
      timer = setTimeout(() => done({ status: 'unavailable' }), 1000); timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function rejectConsent(page: Page, check: () => void): Promise<ConsentNotice & { rejected: boolean }> {
  const url = page.url(), documentId = await page.evaluate(() => performance.timeOrigin);
  const found = await findConsent(page);
  if (!found.button) return { ...found.notice, rejected: false };
  const button = await found.button.elementHandle();
  if (!button) throw new Error('The cookie choice is no longer on the page.');
  try {
    check();
    if (page.url() !== url || await page.evaluate(() => performance.timeOrigin) !== documentId)
      throw new Error('The page changed before its cookie choice could be pressed.');
    const named = await button.evaluate((node, pattern) => node.isConnected
      && new RegExp(pattern, 'i').test((node.getAttribute('aria-label') || node.textContent || '').trim()), refusal.source);
    if (!named || !await button.evaluate(inspectNotice))
      throw new Error('The cookie notice changed before its choice could be pressed.');
    check();
    // Click this exact element rather than re-resolving an index after the page changes.
    await button.click({ timeout: 2000 });
    return { ...found.notice, rejected: true };
  } finally { await button.dispose().catch(() => undefined); }
}
