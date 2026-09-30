import { readable } from "./integrations/web.js";

/**
 * w911 (A0743, A1452): one page read over plain HTTP, with every redirect hop checked against the
 * owner's network rules before a single byte is sent to it, and a check for "are you a person?"
 * pages. Nothing here retries, waits out, or works around such a page: it is reported and the
 * owner takes over.
 */
export interface PageFetchDeps {
  /**
   * The shared network rules (app.web.policy). Every hop, the first address and each redirect, goes
   * through its checked fetch: checked first, then connected to only at the addresses it judged.
   */
  policy: { guard(base: typeof fetch): typeof fetch };
  fetch: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

export interface RawPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
  hops: number;
}

const redirects = new Set([301, 302, 303, 307, 308]);
const maxHops = 5;
const textual = /^(text\/|application\/(xhtml\+xml|json|xml))/i;

/** Reads a response body up to a byte limit and lets go of the rest. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) break;
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * Fetches one address. Redirects are followed by hand so each new address is checked first. Any
 * status comes back (a 503 challenge page included); only a refused address or a network failure
 * throws. A body that is not text is not read.
 */
export async function fetchChecked(deps: PageFetchDeps, input: string, signal: AbortSignal): Promise<RawPage> {
  const checked = deps.policy.guard(deps.fetch);
  let url = new URL(input);
  for (let hops = 0; ; hops++) {
    const response = await checked(url, {
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs)]),
      headers: { "user-agent": deps.userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    });
    const location = response.headers.get("location");
    if (redirects.has(response.status) && location) {
      await response.body?.cancel().catch(() => undefined);
      if (hops + 1 > maxHops) throw new Error(`${url.host} redirected more than ${maxHops} times, so the page was not read`);
      url = new URL(location, url);
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = textual.test(contentType) ? await readBounded(response, deps.maxBytes) : "";
    if (!body) await response.body?.cancel().catch(() => undefined);
    return { url: url.toString(), status: response.status, contentType, body, hops };
  }
}

export const isHtml = (contentType: string): boolean => /html/i.test(contentType);

const challengeStatus = new Set([403, 429, 503]);
const challengeTitle = /<title[^>]*>\s*(just a moment|checking your browser|attention required|verify you are human)/i;
const challengeWords = /just a moment\.\.\.|checking your browser|verify you are (a )?human|cf-chl|cf_chl|challenge-platform/i;
const challengeWidget = /<iframe[^>]+src=["'][^"']*(challenges\.cloudflare\.com|hcaptcha\.com|google\.com\/recaptcha|recaptcha\.net)|class=["'][^"']*\b(cf-turnstile|h-captcha|g-recaptcha)\b/i;
const captchaWords = /captcha|turnstile/i;

/** Which kind of "are you a person?" check some page words describe, in the owner's words. */
export function challengeKind(body: string): string {
  if (/turnstile|cf-chl|cf_chl|challenges\.cloudflare\.com|just a moment/i.test(body)) return "a Cloudflare check that asks whether you are a person";
  if (captchaWords.test(body)) return "a captcha";
  return "a check that asks whether you are a person";
}

/**
 * What kind of "are you a person?" page this is, or null. A 403, 429 or 503 counts when its body
 * carries the usual signs. Any other page counts only when its title is such a check, or it is a
 * short page built around a captcha or Turnstile box (a long article with a comment captcha is not).
 */
export function detectChallenge(status: number, body: string): string | null {
  if (challengeStatus.has(status) && (challengeWords.test(body) || challengeWidget.test(body) || captchaWords.test(body)))
    return challengeKind(body);
  if (challengeTitle.test(body)) return challengeKind(body);
  if (challengeWidget.test(body) && readable(body).text.length < 600) return challengeKind(body);
  return null;
}

/** The same check on what a browser read out of a rendered page. */
export function detectRenderedChallenge(text: string): string | null {
  if (/just a moment|checking your browser|verify you are (a )?human/i.test(text)) return challengeKind(text);
  if (captchaWords.test(text) && text.length < 600) return challengeKind(text);
  return null;
}

/** The web links on an HTML page, made absolute, without their #part, each once. */
export function pageLinks(html: string, base: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), base);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      found.add(url.toString());
    } catch { /* not an address */ }
  }
  return [...found];
}

/** The same address with its #part taken off, for comparing two addresses. */
export function withoutFragment(input: string): string {
  const url = new URL(input);
  url.hash = "";
  return url.toString();
}
