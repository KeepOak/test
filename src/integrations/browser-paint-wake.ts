import type { CDPSession, Page } from 'playwright';

/* Paced CDP acknowledgements adapted from OpenClaw's screencast/session.ts (MIT).
 * Copyright (c) 2026 OpenClaw Foundation. Full notice: LICENSE.browser-paint-wake.
 * CDP image data is deliberately ignored: only Branch's separately masked watch() may supply pixels. */
const attached = new Set<Page>();
const MAX_TARGETS = 4, ACK_MS = 200;

/** One lightweight paint wake per page; unsupported/busy targets use the stream's ordinary masked capture fallback. */
export async function browserPaintWake(page: Page, painted: () => void, signal: AbortSignal,
  current: () => boolean): Promise<{ close(): Promise<void>; current(): boolean } | null> {
  if (signal.aborted || !current() || page.isClosed() || attached.has(page) || attached.size >= MAX_TARGETS) return null;
  attached.add(page);
  let cdp: CDPSession | undefined, opening: Promise<CDPSession> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  let stopping: Promise<void> | undefined;
  const close = (): Promise<void> => stopping ??= (async () => {
    closed = true; if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', aborted); page.off('close', aborted);
    const retired = cdp ?? await opening?.catch(() => undefined);
    if (retired) { retired.off('Page.screencastFrame', frame); await retired.detach().catch(() => undefined); }
    attached.delete(page);
  })();
  const aborted = (): void => { void close(); };
  const frame = (event: { sessionId: number }): void => {
    if (closed || signal.aborted || !current() || !Number.isSafeInteger(event.sessionId)) { void close(); return; }
    painted();
    if (timer) return; // Chrome retains an unacknowledged frame; never queue pixels or acknowledgements.
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || signal.aborted || !current()) { void close(); return; }
      void cdp?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(aborted);
    }, ACK_MS);
    timer.unref?.();
  };
  try {
    opening = page.context().newCDPSession(page);
    signal.addEventListener('abort', aborted, { once: true }); page.on('close', aborted);
    cdp = await opening;
    if (closed || signal.aborted || !current()) { await cdp.detach().catch(() => undefined); await close(); return null; }
    cdp.on('Page.screencastFrame', frame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 1, maxHeight: 1, everyNthFrame: 1 });
    if (closed || signal.aborted || !current()) { await close(); return null; }
    return { close, current: () => !closed && current() };
  } catch { await close(); return null; }
}
