import type { Locator, Page } from "playwright";
import type { ToolContext } from "./contracts.js";

export const browserCategories = ["password-change", "captcha", "security-warning", "camera", "microphone", "location", "download", "extension-install"] as const;
export type BrowserCategory = typeof browserCategories[number];
export const ownerHandoffCategories = new Set<BrowserCategory>(["password-change", "captcha", "security-warning"]);
const holds = new WeakMap<ToolContext, BrowserCategory>();

/** Engine-only observations can tighten policy. Neither page text nor model arguments can grant authority. */
export function withBrowserCategory<T>(context: ToolContext, category: BrowserCategory, judge: () => T): T {
  holds.set(context, category);
  try { return judge(); } finally { holds.delete(context); }
}
export function browserCategoryHold(tool: string, context: ToolContext, args: unknown) {
  const permission = (args as { permission?: unknown } | null)?.permission;
  const namedPermission = permission === "camera" ? "camera" : permission === "microphone" ? "microphone" : permission === "geolocation" ? "location" : "browser permission";
  const category = holds.get(context) ?? (tool === "browser.download" ? "download" : tool === "browser.permission" ? namedPermission : null);
  return category ? { reason: `Confirm this ${category} browser action with the owner, just this once`, onceOnly: true as const } : null;
}
export function browserDialogHandoff(message: string): BrowserCategory | null {
  return /(?:certificate|connection).{0,30}(?:unsafe|invalid|not private|not secure)|security warning/i.test(message)
    ? "security-warning" : /(?:change|reset).{0,20}password/i.test(message) ? "password-change"
    : /captcha|verify.{0,15}(?:human|robot)/i.test(message) ? "captcha" : null;
}

/** Bounded signals, not a universal prompt classifier. Missing signals never authorize a step. */
export async function observeBrowserCategory(page: Page, target: Locator | null): Promise<{ category: BrowserCategory | null; document: number }> {
  const facts = await page.evaluate(() => ({
    document: Math.floor(performance.timeOrigin),
    newPassword: !!document.querySelector('input[autocomplete="new-password"]'),
    challenge: Array.from(document.querySelectorAll("iframe[src]")).some(frame => {
      try { const url = new URL(frame.getAttribute("src") ?? "", location.href);
        return url.hostname === "challenges.cloudflare.com" || url.hostname === "hcaptcha.com" || url.hostname === "newassets.hcaptcha.com"
          || ((url.hostname === "www.google.com" || url.hostname === "www.recaptcha.net") && url.pathname.startsWith("/recaptcha/"));
      } catch { return false; }
    }),
  }));
  if (facts.newPassword) return { category: "password-change", document: facts.document };
  if (facts.challenge) return { category: "captcha", document: facts.document };
  if (page.url().startsWith("chrome-error:")) return { category: "security-warning", document: facts.document };
  if (!target) return { category: null, document: facts.document };
  const signal = await target.evaluate(element => ({
    download: element.hasAttribute("download"),
    label: [element.getAttribute("aria-label"), element.textContent].filter(Boolean).join(" ").slice(0, 300),
  }));
  // These untrusted labels may cause extra questions, never an allow or an exemption from ordinary policy.
  const category: BrowserCategory | null = signal.download ? "download"
    : /(?:proceed|continue|ignore).{0,30}(?:unsafe|certificate|security warning)/i.test(signal.label) ? "security-warning"
    : /(?:install|add).{0,30}(?:extension|chrome|firefox|edge)/i.test(signal.label) ? "extension-install"
    : /(?:change|reset|new).{0,20}password/i.test(signal.label) ? "password-change"
    : /(?:allow|enable|use|share).{0,25}(?:camera|video)/i.test(signal.label) ? "camera"
    : /(?:allow|enable|use|share).{0,25}(?:microphone|mic\b)/i.test(signal.label) ? "microphone"
    : /(?:allow|enable|use|share).{0,25}location/i.test(signal.label) ? "location" : null;
  return { category, document: facts.document };
}
