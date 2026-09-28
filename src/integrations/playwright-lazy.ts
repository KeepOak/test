import type { BrowserType } from 'playwright';

/**
 * Playwright is several megabytes of code. It is loaded the first time a browser starts or is joined, not when the
 * engine starts, so an engine that never opens a browser never holds it in memory.
 */
export async function chromium(): Promise<BrowserType> {
  return (await import('playwright')).chromium;
}
