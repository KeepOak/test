import type { Page } from 'playwright';
import type { BrowserControl } from '../browser-control.js';
import { challengeKind, detectRenderedChallenge } from '../web-page-fetch.js';

/**
 * UP-SCREEN-004: an "are you a person?" wall met by any browser.* step, not only by web.page. Branch never solves or
 * works around one. The step that meets it stops, the owner is told to take the browser over and finish the check, and
 * the task waits (hand-back gate) until they hand it back with the check gone. While one is on screen, no step of the
 * task touches the page.
 *
 * The title phrases are a subset of `_BOT_DETECTION_TITLE_PATTERNS` in Hermes Agent's tools/browser_tool.py
 * (NousResearch/hermes-agent, MIT; see THIRD_PARTY_NOTICES.md). The broad ones ("blocked", "access denied",
 * "cloudflare") are left out: they would park a task on an ordinary refusal page. The event-gated wait follows the idea
 * of browser-use's `wait_if_captcha_solving` (browser_use/browser/watchdogs/captcha_watchdog.py, MIT), without its
 * cloud solver; no code was copied from it.
 */
const botTitles = /bot detected|are you a robot|checking your browser|just a moment|ddos protection|attention required|access to this page has been denied/i;
/** Phrases that also name ordinary pages ("How to add a captcha"), so they count only on a short page. */
const shortPageTitles = /captcha|please verify|verification required/i;
/** The boxes the usual check services draw, found on the page itself rather than in its words. */
const widgets = 'iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], iframe[src*="google.com/recaptcha"], '
  + 'iframe[src*="recaptcha.net"], .cf-turnstile, .h-captcha, .g-recaptcha';

export interface PageChallenge { url: string; site: string; what: string }

/** The check this page shows, or null. A page that cannot be asked counts as showing none. */
export async function pageChallenge(page: Page): Promise<PageChallenge | null> {
  const seen = await page.evaluate(selector => ({
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, 4000),
    widget: document.querySelector(selector) !== null,
  }), widgets).catch(() => null);
  if (!seen) return null;
  const text = seen.text.trim();
  const titled = botTitles.test(seen.title) || (shortPageTitles.test(seen.title) && text.length < 1500);
  const what = titled ? challengeKind(`${seen.title}\n${text}`)
    : detectRenderedChallenge(`${seen.title}\n${text}`) ?? (seen.widget && text.length < 600 ? challengeKind(`${seen.title}\n${text} captcha`) : null);
  if (!what) return null;
  const url = page.url();
  return { url, site: URL.canParse(url) ? new URL(url).host : url, what };
}

/** What the owner is told: where the check is, that Branch will not do it, and how to hand the page back. */
export function takeOverWords(challenge: PageChallenge, borrowed: boolean): string {
  const how = borrowed
    ? `Finish it in that tab of your own browser; Branch carries on by itself once the check has gone.`
    : `Press Take over on Branch's browser, finish the check, then press Hand back; Branch carries on from there.`;
  return `${challenge.site} is showing ${challenge.what}, and Branch does not try to get past checks like that. ${how}`;
}

export interface GateView {
  runId: string;
  signal: AbortSignal;
  borrowed: boolean;
  /** The browser's control once the owner has taken it over (or it is the conversation's kept browser). */
  control: () => BrowserControl | undefined;
  /** The page the task is working in, looked at only to see whether the check has gone. */
  page: () => Page | undefined;
}
const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = (): void => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

/**
 * Waits until the owner has taken the browser over and handed it back with the check gone (in the owner's own
 * browser, until the check has gone), for at most `waitMs`. True when it has gone. It never touches the page beyond
 * reading its title and words, and never while the owner holds it. Cancelling the task ends the wait.
 */
export async function waitForOwner(view: GateView, waitMs: number, pollMs = 500): Promise<boolean> {
  const until = Date.now() + waitMs;
  // A Take over and Hand back can both happen between two looks, so what is watched is the control's epoch, which every
  // change of hands moves on. A task's own window has no control until the owner takes it over (it starts at epoch 1).
  let seen = view.control()?.view().epoch ?? 1;
  while (Date.now() < until) {
    await pause(Math.min(pollMs, Math.max(0, until - Date.now())), view.signal);
    const control = view.control()?.view();
    if (control?.state === 'stopped') return false;
    if (control && (control.state === 'transferring' || control.writer?.kind === 'owner' || control.paused === view.runId)) continue;
    // Branch's own window is headless: nobody can have finished the check without it changing hands first.
    if (!view.borrowed && (!control || control.epoch === seen)) continue;
    const page = view.page();
    if (!page || page.isClosed()) return false;
    if (!(await pageChallenge(page))) return true;
    seen = control?.epoch ?? seen; // handed back with the check still showing: wait for the next Take over
  }
  return false;
}
